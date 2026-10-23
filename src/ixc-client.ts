/**
 * Cliente HTTP para o webservice do IXC Soft.
 *
 * Formato VALIDADO EM PRODUÇÃO pela Fase 1 (2026-10-21, erp.atplus.cloud):
 *  - Auth: `Authorization: Basic <base64>` — o valor de IXC_TOKEN já é o base64
 *    de "usuario:token" (webserver IXC tem Basic Auth na frente da aplicação).
 *  - Listar: POST multipart/form-data + header `ixcsoft: listar` com campos grid
 *    (qtype/query/oper/page/rp/sortname/sortorder). Resposta: JSON com `data`
 *    podendo vir como string JSON ou objeto; `total` vem como STRING.
 *  - LIKE em cliente.razao NÃO é suportado por esta instância (erro de
 *    processamento) — buscas por nome usam oper `=` com nome exato/normalizado.
 *
 * Criação de su_ticket: POST /webservice/v1/su_ticket com body JSON (mesmo
 * formato do node "Atendimento - Rede Neutra" do n8n 8IPK4MF1ZiaqpOzf).
 */

import type { IxcConfig } from "./config.js";

// Endpoint de desativação/cancelamento do financeiro não vencido (ver tools.ts).
const CANCELAMENTO_ENDPOINT_PLACEHOLDER = "/webservice/v1/desativar_cancelar_financeiro_nao_vencido";

export interface GridParams {
	qtype: string;
	query: string;
	oper?: string;
	rp?: number;
	page?: number;
	sortname?: string;
	sortorder?: "asc" | "desc";
}

export interface GridResult<T = Record<string, unknown>> {
	total: number;
	registros: T[];
	raw: unknown;
}

/** Operadores suportados (comprovados) por esta instância do IXC. */
export const GridOper = {
	IGUAL: "=",
} as const;

export class IxcError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "IxcError";
	}
}

/**
 * Serializa o payload como JSON 100% ASCII: todo caractere não-ASCII vira
 * \uXXXX. O webservice do IXC (PHP) interpreta bytes UTF-8 como Latin-1 na
 * escrita quando o charset não é declarado no Content-Type — o JSON escapado
 * elimina a ambiguidade: o parser decodifica o texto original
 * independentemente do charset assumido (validado 2026-10-23: PUT com
 * acentos gravou "InadimplÃªncia"; com \uXXXX o texto chega correto).
 */
export function serializarJson(payload: unknown): string {
	return JSON.stringify(payload).replace(/[^\x20-\x7E]/g, (ch) =>
		`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** Parse tolerante do campo `data` da resposta (string JSON ou objeto). */
export function parseData(payload: unknown): {
	total?: number;
	registros?: unknown[];
	[key: string]: unknown;
} {
	if (payload === null || payload === undefined) return {};
	let obj = payload;
	if (typeof obj === "string") {
		try {
			obj = JSON.parse(obj);
		} catch {
			return { registros: [] };
		}
	}
	if (typeof obj !== "object" || obj === null) return {};
	const record = obj as Record<string, unknown>;
	if ("data" in record) return parseData(record.data);
	return record;
}

export class IxcClient {
	constructor(private readonly config: IxcConfig) {}

	private authHeaders(): Record<string, string> {
		return {
			// Fase 1: Basic <base64> + ixcsoft: listar. IXC_TOKEN já é o base64.
			Authorization: `Basic ${this.config.token}`,
		};
	}

	private async http(
		path: string,
		init: RequestInit & { headers: Record<string, string> },
	): Promise<unknown> {
		const url = `${this.config.baseUrl}${path}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			const text = await response.text();
			let body: unknown = text;
			try {
				body = JSON.parse(text);
			} catch {
				/* resposta não-JSON (ex.: HTML de erro) — mantém texto */
			}

			if (!response.ok) {
				throw new IxcError(`HTTP ${response.status} em ${path}`, response.status, body);
			}
			// HTTP 200 mas erro de aplicação: {"type":"error","message":...}
			if (
				typeof body === "object" &&
				body !== null &&
				(body as Record<string, unknown>).type === "error"
			) {
				const msg = String((body as Record<string, unknown>).message ?? "").replace(/<br\s*\/?>/gi, " ").trim();
				throw new IxcError(msg || "Erro de aplicação no IXC", 200, body);
			}
			return body;
		} catch (error) {
			if (error instanceof IxcError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new IxcError(`Timeout (${this.config.timeoutMs}ms) em ${path}`, undefined, {
					cause: "timeout",
				});
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Listagem no formato grid do IXC (multipart, como o n8n comprovado).
	 * IMPORTANTE: token NUNCA em log — logger recebe só path/params públicos.
	 */
	async listar<T = Record<string, unknown>>(
		tabela: string,
		params: GridParams,
	): Promise<GridResult<T>> {
		const form = new FormData();
		form.append("qtype", params.qtype);
		form.append("query", params.query);
		form.append("oper", params.oper ?? GridOper.IGUAL);
		form.append("page", String(params.page ?? 1));
		form.append("rp", String(params.rp ?? 15));
		form.append("sortname", params.sortname ?? params.qtype);
		form.append("sortorder", params.sortorder ?? "asc");

		const body = await this.http(`/webservice/v1/${tabela}`, {
			method: "POST",
			headers: { ...this.authHeaders(), ixcsoft: "listar" },
			body: form,
		});

		const parsed = parseData(body);
		const registros = Array.isArray(parsed.registros) ? (parsed.registros as T[]) : [];
		const total = Number(parsed.total ?? registros.length);

		return { total: Number.isFinite(total) ? total : registros.length, registros, raw: body };
	}

	/** Cria um su_ticket (body JSON, igual ao node do n8n). */
	async criarTicket(
		payload: Record<string, string>,
	): Promise<{ id: number; raw: unknown }> {
		if (this.config.dryRun) {
			// Dry-run: simula sucesso e devolve id negativo simbólico (não grava nada no IXC)
			return { id: -1, raw: { dryRun: true, payload } };
		}
		const body = await this.http("/webservice/v1/su_ticket", {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"Content-Type": "application/json",
			},
			body: serializarJson(payload),
		});
		const parsed = parseData(body);
		const id = Number(parsed.id);
		if (!Number.isFinite(id) || id <= 0) {
			throw new IxcError("Resposta do su_ticket sem id válido", undefined, body);
		}
		return { id, raw: body };
	}

	/**
	 * Desativa o contrato e cancela o financeiro não vencido
	 * (endpoint de ação do fluxo "Cancelar contrato e financeiro não vencido" do ERP).
	 * Sem doc pública no IXC — formato validado no teste real (contrato 25924).
	 */
	async desativarCancelarFinanceiroNaoVencido(
		payload: Record<string, string>,
	): Promise<{ ok: boolean; resposta: unknown }> {
		if (this.config.dryRun) {
			return { ok: true, resposta: { dryRun: true, payload } };
		}
		const body = await this.http(CANCELAMENTO_ENDPOINT_PLACEHOLDER, {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"Content-Type": "application/json",
			},
			body: serializarJson(payload),
		});
		return { ok: true, resposta: body };
	}

	/**
	 * Atualiza o cliente_contrato (PUT) — paridade com o node
	 * "Insere Infos Cancelamento no Contrato" do workflow n8n 3WxPhXScLXILwm8e:
	 * payload com os 140 campos (valores atuais + dados de cancelamento),
	 * enviado no formato JSON do IXC.
	 */
	async atualizarClienteContrato(
		id_contrato: number,
		payload: Record<string, unknown>,
	): Promise<{ ok: boolean; resposta: unknown }> {
		if (this.config.dryRun) {
			return { ok: true, resposta: { dryRun: true, payload } };
		}
		const body = await this.http(`/webservice/v1/cliente_contrato/${id_contrato}`, {
			method: "PUT",
			headers: {
				...this.authHeaders(),
				"Content-Type": "application/json",
			},
			body: serializarJson(payload),
		});
		return { ok: true, resposta: body };
	}
}
