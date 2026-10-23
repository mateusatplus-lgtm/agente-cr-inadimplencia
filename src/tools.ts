/**
 * Tools do servidor MCP do IXC.
 *
 * Pipeline "Cancelamento por Inadimplência por nome" (v1.0.0 — 2026-06-05):
 *   ixc_buscar_cliente → ixc_listar_contratos → ixc_consultar_rede_neutra
 *     → rede neutra: ixc_abrir_atendimento_rede_neutra → ixc_cancelar_financeiro_nao_vencido
 *     → não rede neutra: ixc_cancelar_financeiro_nao_vencido (sem atendimento)
 *   orquestrado por ixc_cancelar_inadimplencia_por_nome.
 *
 * Regra de rede neutra (fonte única — CRM, cancelamento-criacao-service.ts):
 *   radusuarios do contrato com id_df_projeto === 6 E id_transmissor === 6 → "sim".
 */

import { z } from "zod";
import { GridOper, type IxcClient } from "./ixc-client.js";
import type { IxcConfig } from "./config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Constantes do atendimento Rede Neutra (node "Atendimento - Rede Neutra" do
// n8n 8IPK4MF1ZiaqpOzf, com as decisões da Fase 0 — 2026-10-21)
// ---------------------------------------------------------------------------

export const REDE_NEUTRA_ASSUNTO = "108";
export const REDE_NEUTRA_PROCESSO = "54";
export const REDE_NEUTRA_SETOR = "11";
export const REDE_NEUTRA_TITULO = "Cancelamento Rede Neutra";
export const REDE_NEUTRA_MENSAGEM_DEFAULT =
	"Atendimento gerado referente a um cancelamento de um cliente inadimplente da Rede Ultra";

/** Status de su_ticket considerados "em aberto" para dedupe. */
const STATUS_ABERTOS = new Set(["N", "T", "A", "P", "R"]);

// ---------------------------------------------------------------------------
// Schemas (input) — shapes ZodRawShape declarados inline em cada registerTool
// (constantes abaixo mantidas apenas para referência de tipos)
// ---------------------------------------------------------------------------

export type BuscarClienteInput = { nome: string; limite?: number };
export type ListarContratosInput = { id_cliente: number };
export type ConsultarRedeNeutraInput = { id_contrato: number };
export type AbrirAtendimentoInput = {
	id_cliente: number;
	id_contrato: number;
	mensagem?: string;
	observacao?: string;
	ignorar_duplicado?: boolean;
};
export type CancelarFinanceiroInput = {
	id_contrato: number;
	data_cancelamento?: string;
	motivo_cancelamento?: string;
	obs_cancelamento?: string;
};
export type CancelarPorNomeInput = {
	nome: string;
	id_contrato?: number;
	data_cancelamento?: string;
	motivo_cancelamento?: string;
	obs_cancelamento?: string;
	confirmar?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ClienteResumo {
	id: number;
	razao: string;
	cnpj_cpf: string;
	fone: string;
	situacao: string;
}

export interface ContratoResumo {
	id: number;
	id_cliente: number;
	status: string;
	endereco: string;
	data_ativacao: string;
}

function toNum(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** Normaliza nome para busca: trim + uppercase (a base do IXC guarda maiúsculas). */
export function normalizarNome(nome: string): string {
	return nome.trim().toUpperCase();
}

/**
 * Estratégia de busca por nome (Fase 1): esta instância do IXC NÃO aceita LIKE
 * em cliente.razao (erro de processamento); só `=` exato. A busca tenta, em
 * ordem: nome completo normalizado → primeiras duas palavras → primeira
 * palavra. Cada nível só se o anterior não retornar nada.
 */
export const ESTRATEGIA_NOME = {
	completo: (nome: string) => nome,
	duasPalavras: (nome: string) => nome.split(/\s+/).slice(0, 2).join(" "),
	primeiraPalavra: (nome: string) => nome.split(/\s+/)[0] ?? nome,
} as const;

export function clienteResumo(reg: Record<string, unknown>): ClienteResumo {
	return {
		id: toNum(reg.id) ?? 0,
		razao: str(reg.razao),
		cnpj_cpf: str(reg.cnpj_cpf),
		fone: str(reg.fone),
		situacao: str(reg.situacao),
	};
}

export function contratoResumo(reg: Record<string, unknown>): ContratoResumo {
	return {
		id: toNum(reg.id) ?? 0,
		id_cliente: toNum(reg.id_cliente) ?? 0,
		status: str(reg.status),
		endereco: str(reg.endereco),
		data_ativacao: str(reg.data_ativacao),
	};
}

/** Regra de rede neutra (id_df_projeto 6 E id_transmissor 6) — testável pura. */
export function regraRedeNeutra(
	radusuarios: Array<{ id_df_projeto?: unknown; id_transmissor?: unknown }>,
): { redeNeutra: boolean; detalhe?: { id_df_projeto: number; id_transmissor: number } } {
	for (const rad of radusuarios) {
		const projeto = toNum(rad.id_df_projeto);
		const transmissor = toNum(rad.id_transmissor);
		if (projeto === 6 && transmissor === 6) {
			return {
				redeNeutra: true,
				detalhe: { id_df_projeto: projeto, id_transmissor: transmissor },
			};
		}
	}
	return { redeNeutra: false };
}

/** Monta a mensagem final do atendimento (default + observação opcional). */
export function montarMensagem(mensagem?: string, observacao?: string): string {
	const base = mensagem?.trim() || REDE_NEUTRA_MENSAGEM_DEFAULT;
	if (observacao && observacao.trim()) {
		return `Observação: ${observacao.trim()}\n${base}`;
	}
	return base;
}

// ---------------------------------------------------------------------------
// Cancelamento de financeiro não vencido (desativar contrato)
// ---------------------------------------------------------------------------

export const CANCELAMENTO_ENDPOINT = "/webservice/v1/desativar_cancelar_financeiro_nao_vencido";
/** Motivo 12 = Inadimplência (definição do time, 2026-06-05). */
export const CANCELAMENTO_MOTIVO_DEFAULT = "12";
export const CANCELAMENTO_OBS_DEFAULT = "Inadimplência";

/**
 * Normaliza a data de cancelamento para o formato do IXC (dd/mm/yyyy).
 * Aceita dd/mm/yyyy, yyyy-mm-dd e "dd/mm/yy"; default = hoje (local).
 */
export function normalizarDataCancelamento(data?: string): string {
	const hoje = () => {
		const d = new Date();
		const dd = String(d.getDate()).padStart(2, "0");
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		return `${dd}/${mm}/${d.getFullYear()}`;
	};
	if (!data || !data.trim()) return hoje();
	const raw = data.trim();

	// dd/mm/yyyy ou dd/mm/yy
	const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (br) {
		const [, d, m, y] = br;
		const ano = y.length === 2 ? `20${y}` : y;
		return `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${ano}`;
	}

	// yyyy-mm-dd (ISO)
	const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) {
		const [, y, m, d] = iso;
		return `${d}/${m}/${y}`;
	}

	return hoje();
}

/** Payload do POST de desativar/cancelar financeiro não vencido. */
export function montarPayloadCancelamento(input: {
	idContrato: number;
	dataCancelamento: string;
	motivoCancelamento: string;
	obsCancelamento: string;
}): Record<string, string> {
	return {
		id_contrato: String(input.idContrato),
		data_cancelamento: input.dataCancelamento,
		motivo_cancelamento: input.motivoCancelamento,
		obs_cancelamento: input.obsCancelamento,
	};
}

/** Payload do su_ticket — campo a campo igual ao node (decisões Fase 0 aplicadas). */
export function montarPayloadAtendimento(input: {
	idCliente: number;
	idContrato: number;
	mensagem: string;
	idResponsavelTecnico: string;
}): Record<string, string> {
	return {
		tipo: "C",
		id_estrutura: "",
		protocolo: "",
		id_circuito: "",
		id_cliente: String(input.idCliente),
		id_login: "",
		id_contrato: String(input.idContrato),
		id_filial: "",
		id_assunto: REDE_NEUTRA_ASSUNTO,
		titulo: REDE_NEUTRA_TITULO,
		origem_endereco: "CC",
		origem_endereco_estrutura: "",
		endereco: "",
		latitude: "",
		longitude: "",
		id_wfl_processo: REDE_NEUTRA_PROCESSO,
		id_ticket_setor: REDE_NEUTRA_SETOR,
		id_responsavel_tecnico: input.idResponsavelTecnico,
		data_criacao: "",
		data_ultima_alteracao: "",
		prioridade: "M",
		data_reservada: "",
		melhor_horario_reserva: "",
		id_ticket_origem: "",
		id_usuarios: "",
		id_resposta: "",
		menssagem: input.mensagem,
		interacao_pendente: "",
		su_status: "N",
		id_evento_status_processo: "",
		id_canal_atendimento: "",
		status: "",
		mensagens_nao_lida_cli: "",
		mensagens_nao_lida_sup: "",
		token: "",
		finalizar_atendimento: "",
		id_su_diagnostico: "",
		status_sla: "",
		origem_cadastro: "",
		ultima_atualizacao: "",
		cliente_fone: "",
		cliente_telefone_comercial: "",
		cliente_id_operadora_celular: "",
		cliente_telefone_celular: "",
		cliente_whatsapp: "",
		cliente_ramal: "",
		cliente_email: "",
		cliente_contato: "",
		cliente_website: "",
		cliente_skype: "",
		cliente_facebook: "",
		latitude_cli: "",
		longitude_cli: "",
		latitude_login: "",
		longitude_login: "",
	};
}

// ---------------------------------------------------------------------------
// Registro das tools
// ---------------------------------------------------------------------------

export interface ToolDeps {
	client: IxcClient;
	config: IxcConfig;
}

/** Busca cliente por nome com estratégia de fallback (completo → 2 palavras → 1 palavra). */
async function buscarClientesPorNome(
	client: IxcClient,
	nomeNormalizado: string,
	limite: number,
): Promise<{ estrategiaUsada: string; clientes: ClienteResumo[] }> {
	const tentativas: Array<[string, string]> = [
		["nome-completo", ESTRATEGIA_NOME.completo(nomeNormalizado)],
		["duas-palavras", ESTRATEGIA_NOME.duasPalavras(nomeNormalizado)],
		["primeira-palavra", ESTRATEGIA_NOME.primeiraPalavra(nomeNormalizado)],
	];
	for (const [estrategia, query] of tentativas) {
		const result = await client.listar("cliente", {
			qtype: "cliente.razao",
			query,
			oper: GridOper.IGUAL,
			rp: limite,
			sortname: "cliente.razao",
		});
		const clientes = result.registros.map(clienteResumo).filter((c) => c.id > 0);
		if (clientes.length > 0) {
			return { estrategiaUsada: estrategia, clientes };
		}
	}
	return { estrategiaUsada: "nenhuma", clientes: [] };
}

/**
 * Abre o atendimento Rede Neutra (com dedupe) — usada pela tool granular e
 * pela orquestradora `ixc_cancelar_inadimplencia_por_nome`.
 */
async function abrirAtendimentoRedeNeutra(
	client: IxcClient,
	config: IxcConfig,
	args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	},
): Promise<{
	aberto: boolean;
	duplicado: boolean;
	id_atendimento: number | null;
	url_erp: string | null;
	dry_run: boolean;
	motivo?: string;
}> {
	// Dedupe: assunto 108 em aberto para o contrato
	if (!args.ignorar_duplicado) {
		const tickets = await client.listar("su_ticket", {
			qtype: "su_ticket.id_contrato",
			query: String(args.id_contrato),
			oper: GridOper.IGUAL,
			rp: 30,
			sortorder: "desc",
		});
		const duplicado = tickets.registros.find((t) => {
			const reg = t as Record<string, unknown>;
			return (
				str(reg.id_assunto) === REDE_NEUTRA_ASSUNTO &&
				STATUS_ABERTOS.has(str(reg.su_status || reg.status).toUpperCase())
			);
		});
		if (duplicado) {
			const reg = duplicado as Record<string, unknown>;
			return {
				aberto: false,
				duplicado: true,
				id_atendimento: toNum(reg.id),
				url_erp: null,
				dry_run: config.dryRun,
				motivo: "Já existe atendimento Rede Neutra (assunto 108) em aberto para este contrato",
			};
		}
	}

	const payload = montarPayloadAtendimento({
		idCliente: args.id_cliente,
		idContrato: args.id_contrato,
		mensagem: montarMensagem(args.mensagem, args.observacao),
		idResponsavelTecnico: config.idTecnicoDefault,
	});
	const { id } = await client.criarTicket(payload);
	return {
		aberto: true,
		duplicado: false,
		id_atendimento: id,
		url_erp: id > 0 ? `${config.baseUrl}/suporte/atendimento/${id}` : null,
		dry_run: config.dryRun,
	};
}

/**
 * Cancela o financeiro não vencido e desativa o contrato — usada pela tool
 * granular e pela orquestradora. Defaults: motivo 12 (Inadimplência),
 * obs "Inadimplência", data de hoje.
 */
async function cancelarFinanceiroNaoVencido(
	client: IxcClient,
	config: IxcConfig,
	args: {
		id_contrato: number;
		data_cancelamento?: string;
		motivo_cancelamento?: string;
		obs_cancelamento?: string;
	},
): Promise<{ ok: boolean; payload_enviado: Record<string, string>; resposta: unknown; dry_run: boolean }> {
	const payload = montarPayloadCancelamento({
		idContrato: args.id_contrato,
		dataCancelamento: normalizarDataCancelamento(args.data_cancelamento),
		motivoCancelamento: args.motivo_cancelamento?.trim() || CANCELAMENTO_MOTIVO_DEFAULT,
		obsCancelamento: args.obs_cancelamento?.trim() || CANCELAMENTO_OBS_DEFAULT,
	});
	const { ok, resposta } = await client.desativarCancelarFinanceiroNaoVencido(payload);
	return { ok, payload_enviado: payload, resposta, dry_run: config.dryRun };
}

/** Registro das tools no servidor MCP (API McpServer#registerTool do SDK 1.12+). */
export function registrarTools(server: McpServer, deps: ToolDeps): void {
	const { client, config } = deps;

	server.registerTool("ixc_buscar_cliente", {
		description:
			"Busca cliente no IXC pelo nome (campo razao). Retorna lista para desambiguação em caso de homônimos.",
		inputSchema: {
			nome: z.string().min(3).describe("Nome (ou parte) do cliente como está na base (campo razao)"),
			limite: z.number().int().min(1).max(50).default(10).describe("Máximo de resultados"),
		},
	}, async ({ nome, limite }: { nome: string; limite?: number }) => {
		const { estrategiaUsada, clientes } = await buscarClientesPorNome(
			client,
			normalizarNome(nome),
			limite ?? 10,
		);
		return reply({ estrategia_usada: estrategiaUsada, total: clientes.length, clientes });
	});

	server.registerTool("ixc_listar_contratos", {
		description:
			"Lista contratos (cliente_contrato) de um cliente do IXC, ordenados: ativos primeiro.",
		inputSchema: {
			id_cliente: z.number().int().positive().describe("ID do cliente no IXC"),
		},
	}, async ({ id_cliente }: { id_cliente: number }) => {
		const result = await client.listar("cliente_contrato", {
			qtype: "cliente_contrato.id_cliente",
			query: String(id_cliente),
			oper: GridOper.IGUAL,
			rp: 50,
		});
		const contratos = result.registros
			.map(contratoResumo)
			.filter((c) => c.id > 0)
			.sort((a, b) => Number(b.status === "A") - Number(a.status === "A"));
		return reply({ total: result.total, contratos });
	});

	server.registerTool("ixc_consultar_rede_neutra", {
		description:
			"Consulta se o contrato é rede neutra (radusuarios com id_df_projeto=6 E id_transmissor=6). Propaga erro de consulta.",
		inputSchema: {
			id_contrato: z.number().int().positive().describe("ID do contrato no IXC"),
		},
	}, async ({ id_contrato }: { id_contrato: number }) => {
		const result = await client.listar("radusuarios", {
			qtype: "radusuarios.id_contrato",
			query: String(id_contrato),
			oper: GridOper.IGUAL,
			rp: 10,
		});
		const { redeNeutra, detalhe } = regraRedeNeutra(result.registros);
		return reply({
			id_contrato,
			rede_neutra: redeNeutra ? "sim" : "nao",
			detalhe: detalhe ?? null,
		});
	});

	server.registerTool("ixc_abrir_atendimento_rede_neutra", {
		description:
			"Abre atendimento su_ticket Rede Neutra (assunto 108/processo 54/setor 11) para cliente+contrato. Dedupe: se já existir atendimento Rede Neutra em aberto para o contrato, devolve o id existente.",
		inputSchema: {
			id_cliente: z.number().int().positive(),
			id_contrato: z.number().int().positive(),
			mensagem: z.string().max(2000).optional().describe("Substitui a mensagem default do atendimento"),
			observacao: z.string().max(500).optional().describe("Prefixada como 'Observação: ...' na mensagem"),
			ignorar_duplicado: z.boolean().default(false).describe("true para abrir mesmo se já existir atendimento Rede Neutra em aberto"),
		},
	}, async (args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	}) => {
		const resultado = await abrirAtendimentoRedeNeutra(client, config, args);
		return reply({
			aberto: resultado.aberto,
			duplicado: resultado.duplicado,
			id_atendimento: resultado.id_atendimento,
			url_erp: resultado.url_erp,
			dry_run: resultado.dry_run,
			...(resultado.motivo ? { motivo: resultado.motivo } : {}),
		});
	});

	server.registerTool("ixc_cancelar_financeiro_nao_vencido", {
		description:
			"Desativa o contrato e cancela o financeiro NÃO VENCIDO no IXC (POST desativar_cancelar_financeiro_nao_vencido). Defaults: motivo 12 (Inadimplência), obs 'Inadimplência', data de hoje (dd/mm/yyyy). Ação destrutiva — o chamador deve confirmar com o usuário antes.",
		inputSchema: {
			id_contrato: z.number().int().positive().describe("ID do contrato no IXC"),
			data_cancelamento: z.string().optional().describe("Data do cancelamento (dd/mm/yyyy ou yyyy-mm-dd); default = hoje"),
			motivo_cancelamento: z.string().optional().describe("Motivo do cancelamento; default = 12 (Inadimplência)"),
			obs_cancelamento: z.string().optional().describe("Observação do cancelamento; default = 'Inadimplência'"),
		},
	}, async (args: {
		id_contrato: number;
		data_cancelamento?: string;
		motivo_cancelamento?: string;
		obs_cancelamento?: string;
	}) => {
		const resultado = await cancelarFinanceiroNaoVencido(client, config, args);
		return reply({
			cancelado: resultado.ok,
			id_contrato: args.id_contrato,
			payload_enviado: resultado.payload_enviado,
			resposta: resultado.resposta,
			dry_run: resultado.dry_run,
		});
	});

	server.registerTool("ixc_cancelar_inadimplencia_por_nome", {
		description:
			"Pipeline completo de CANCELAMENTO POR INADIMPLÊNCIA por nome do cliente: busca cliente → contrato ativo → rede neutra → rede neutra: abre atendimento 108 e depois cancela o financeiro não vencido; não rede neutra: apenas cancela o financeiro. Requer confirmar=true para efeitos reais. Para em ambiguidade (homônimos, múltiplos contratos ativos) devolvendo as opções.",
		inputSchema: {
			nome: z.string().min(3).describe("Nome (ou parte) do cliente como está na base (campo razao)"),
			id_contrato: z.number().int().positive().optional().describe("Contrato escolhido pelo usuário quando a execução anterior parou em múltiplos contratos ativos"),
			data_cancelamento: z.string().optional().describe("Data do cancelamento (dd/mm/yyyy); default = hoje"),
			motivo_cancelamento: z.string().optional().describe("Default 12 (Inadimplência)"),
			obs_cancelamento: z.string().optional().describe("Default 'Inadimplência'"),
			confirmar: z.boolean().default(false).describe("false (default): apenas simula e devolve o resumo; true: abre atendimento (se rede neutra) e cancela o financeiro"),
		},
	}, async (args: {
		nome: string;
		id_contrato?: number;
		data_cancelamento?: string;
		motivo_cancelamento?: string;
		obs_cancelamento?: string;
		confirmar?: boolean;
	}) => {
		// 1. Contrato alvo: explícito (pós-desambiguação) ou busca por nome
		let cliente: ClienteResumo;
		let contrato: ContratoResumo;

		if (args.id_contrato) {
			const result = await client.listar("cliente_contrato", {
				qtype: "cliente_contrato.id",
				query: String(args.id_contrato),
				oper: GridOper.IGUAL,
				rp: 1,
			});
			const reg = result.registros[0] as Record<string, unknown> | undefined;
			if (!reg || toNum(reg.id) !== args.id_contrato) {
				return reply({ cancelado: false, motivo: `Contrato ${args.id_contrato} não encontrado` });
			}
			contrato = contratoResumo(reg);
			const clienteResult = await client.listar("cliente", {
				qtype: "cliente.id",
				query: String(contrato.id_cliente),
				oper: GridOper.IGUAL,
				rp: 1,
			});
			const clienteReg = clienteResult.registros[0] as Record<string, unknown> | undefined;
			if (!clienteReg || toNum(clienteReg.id) !== contrato.id_cliente) {
				return reply({ cancelado: false, motivo: `Cliente ${contrato.id_cliente} do contrato ${args.id_contrato} não encontrado` });
			}
			cliente = clienteResumo(clienteReg);
		} else {
			const { clientes } = await buscarClientesPorNome(
				client,
				normalizarNome(args.nome),
				10,
			);
			if (clientes.length === 0) {
				return reply({ cancelado: false, motivo: `Cliente não encontrado: ${args.nome}` });
			}
			if (clientes.length > 1) {
				return reply({
					cancelado: false,
					motivo: "Mais de um cliente encontrado — desambiguar",
					clientes,
				});
			}
			cliente = clientes[0];

			// 2. Contratos (ativos primeiro)
			const contratosResult = await client.listar("cliente_contrato", {
				qtype: "cliente_contrato.id_cliente",
				query: String(cliente.id),
				oper: GridOper.IGUAL,
				rp: 50,
			});
			const contratos = contratosResult.registros.map(contratoResumo).filter((c) => c.id > 0);
			if (contratos.length === 0) {
				return reply({ cliente, cancelado: false, motivo: "Cliente sem contratos" });
			}
			const ativos = contratos.filter((c) => c.status === "A");
			if (ativos.length === 0) {
				return reply({
					cliente,
					contratos,
					cancelado: false,
					motivo: "Cliente não possui contrato ativo (status A)",
				});
			}
			if (ativos.length > 1) {
				return reply({
					cliente,
					contratos: ativos,
					cancelado: false,
					motivo: "Múltiplos contratos ativos — desambiguar",
				});
			}
			contrato = ativos[0];
		}

		// 3. Rede neutra
		const rad = await client.listar("radusuarios", {
			qtype: "radusuarios.id_contrato",
			query: String(contrato.id),
			oper: GridOper.IGUAL,
			rp: 10,
		});
		const { redeNeutra, detalhe } = regraRedeNeutra(rad.registros);

		// 4. Simulação (confirmar=false): resumo do que será feito, sem efeitos
		if (!args.confirmar) {
			return reply({
				cliente,
				contrato,
				rede_neutra: redeNeutra ? "sim" : "nao",
				detalhe: detalhe ?? null,
				plano: redeNeutra
					? "Rede neutra: abrir atendimento (assunto 108) e depois cancelar financeiro não vencido"
					: "Não rede neutra: cancelar financeiro não vencido (sem atendimento)",
				confirmado: false,
				cancelado: false,
				motivo: "Simulação concluída — chame novamente com confirmar=true para executar",
			});
		}

		// 5. Execução
		const resposta: Record<string, unknown> = {
			cliente,
			contrato,
			rede_neutra: redeNeutra ? "sim" : "nao",
			detalhe: detalhe ?? null,
			confirmado: true,
		};

		let atendimentoAberto = false; // false = não-rede-neutra: cancela direto (sem atendimento)
		if (redeNeutra) {
			const at = await abrirAtendimentoRedeNeutra(client, config, {
				id_cliente: cliente.id,
				id_contrato: contrato.id,
			});
			resposta.atendimento = at;
			atendimentoAberto = at.aberto || at.duplicado;
		}

		// Ordem preservada: falha na criação do atendimento → NÃO cancela nada
		if (redeNeutra && !atendimentoAberto) {
			return reply({
				...resposta,
				cancelado: false,
				motivo: "Falha ao abrir o atendimento de rede neutra — cancelamento NÃO executado",
			});
		}

		const cancelamento = await cancelarFinanceiroNaoVencido(client, config, {
			id_contrato: contrato.id,
			data_cancelamento: args.data_cancelamento,
			motivo_cancelamento: args.motivo_cancelamento,
			obs_cancelamento: args.obs_cancelamento,
		});
		return reply({
			...resposta,
			cancelado: cancelamento.ok,
			cancelamento: {
				payload_enviado: cancelamento.payload_enviado,
				resposta: cancelamento.resposta,
				dry_run: cancelamento.dry_run,
			},
			dry_run: config.dryRun,
		});
	});
}

function reply(payload: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}
