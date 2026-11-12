/**
 * Tools do servidor MCP do IXC.
 *
 * Pipeline "Cancelamento por Inadimplência por nome" (v1.2.1 — 2026-11-12):
 *   ixc_buscar_cliente → ixc_listar_contratos → ixc_consultar_rede_neutra
 *     → SEMPRE: ixc_abrir_atendimento_cancelamento (su_ticket assunto 55)
 *     → rede neutra: + ixc_abrir_atendimento_rede_neutra (su_ticket assunto 108)
 *     → ixc_cancelar_financeiro_nao_vencido
 *   orquestrado por ixc_cancelar_inadimplencia_por_nome.
 *
 * Regra de rede neutra (fonte única — CRM, cancelamento-criacao-service.ts):
 *   radusuarios do contrato com id_df_projeto === 6 E id_transmissor === 6 → "sim".
 */

import { z } from "zod";
import { GridOper, IxcClient, IxcError } from "./ixc-client.js";
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

// ---------------------------------------------------------------------------
// Constantes do atendimento "Cancelamento" — aberto para TODO contrato
// cancelado por inadimplência, SEM a validação de rede neutra (payload
// definido pelo time; estrutura igual ao su_ticket dos nodes do n8n
// 8IPK4MF1ZiaqpOzf)
// ---------------------------------------------------------------------------

export const ATENDIMENTO_CANCELAMENTO_ASSUNTO = "55";
export const ATENDIMENTO_CANCELAMENTO_PROCESSO = "5";
export const ATENDIMENTO_CANCELAMENTO_SETOR = "7";
export const ATENDIMENTO_CANCELAMENTO_TITULO = "Cancelamento";
export const ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT = "Cliente inadimplente.";

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

/** Monta a mensagem final de um su_ticket (default + observação opcional). */
export function montarMensagemSuTicket(
	mensagemDefault: string,
	mensagem?: string,
	observacao?: string,
): string {
	const base = mensagem?.trim() || mensagemDefault;
	if (observacao && observacao.trim()) {
		return `Observação: ${observacao.trim()}\n${base}`;
	}
	return base;
}

/** Mensagem do atendimento Rede Neutra (compat com assinatura anterior). */
export function montarMensagem(mensagem?: string, observacao?: string): string {
	return montarMensagemSuTicket(REDE_NEUTRA_MENSAGEM_DEFAULT, mensagem, observacao);
}

// ---------------------------------------------------------------------------
// Cancelamento de financeiro não vencido (desativar contrato)
// ---------------------------------------------------------------------------

export const CANCELAMENTO_ENDPOINT = "/webservice/v1/desativar_cancelar_financeiro_nao_vencido";
/** Motivo 12 = Inadimplência (definição do time, 2026-06-05). */
export const CANCELAMENTO_MOTIVO_DEFAULT = "12";
export const CANCELAMENTO_OBS_DEFAULT = "Inadimplência";

/**
 * Normaliza a data de cancelamento para o formato aceito pelo endpoint do IXC
 * (ISO: yyyy-mm-dd — validado em produção 2026-10-23, contrato 25924: o IXC
 * rejeita dd/mm/yyyy com "Preencha uma data válida (YYYY-MM-DD)").
 * Aceita dd/mm/yyyy, dd/mm/yy e yyyy-mm-dd; default = hoje (local).
 */
export function normalizarDataCancelamento(data?: string): string {
	const hoje = () => {
		const d = new Date();
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		return `${d.getFullYear()}-${mm}-${dd}`;
	};
	if (!data || !data.trim()) return hoje();
	const raw = data.trim();

	// dd/mm/yyyy ou dd/mm/yy
	const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (br) {
		const [, d, m, y] = br;
		const ano = y.length === 2 ? `20${y}` : y;
		return `${ano}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}

	// yyyy-mm-dd (ISO)
	const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) {
		const [, y, m, d] = iso;
		return `${y}-${m}-${d}`;
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

// ---------------------------------------------------------------------------
// Preenchimento prévio do contrato (PUT cliente_contrato) — paridade campo a
// campo com o node "Insere Infos Cancelamento no Contrato" do workflow n8n
// 3WxPhXScLXILwm8e ("Insere Informações de Cancelamento no Contrato").
// O IXC exige motivo/descrição de cancelamento preenchidos no contrato antes
// de aceitar o endpoint de cancelamento financeiro (validado 2026-10-23).
// ---------------------------------------------------------------------------

export const CLIENTE_CONTRATO_UPDATE_ENDPOINT = "/webservice/v1/cliente_contrato";

/** Motivo de cancelamento (slug do CRM) → id no IXC (node "Mapeia Cancelamentos do IXC"). */
export const MOTIVO_SLUG_PARA_ID: Record<string, number> = {
	"inviabilidade-no-endereco": 32,
	"contrato-temporario": 31,
	"isencao-acerto-financeiro": 30,
	"erro-de-importacao-no-sistema": 28,
	"devolucao-de-equipamento": 27,
	"desistiu-da-compra": 26,
	"obito-do-titular": 25,
	inviabilidade: 24,
	insatisfacao: 23,
	preco: 22,
	"problemas-financeiro-do-cliente": 21,
	"migrou-para-concorrencia": 20,
	"encerrou-as-atividades": 19,
	"troca-de-titularidade": 18,
	"cancelamento-devolucao-compra": 17,
	"suspensao-temporaria": 14,
	inadimplencia: 12,
	"troca-de-endereco": 3,
	"alteracao-de-contrato": 1,
};

/**
 * Monta o payload de PUT do cliente_contrato (140 campos) com paridade
 * campo a campo ao node do n8n: valores atuais do contrato + dados de
 * cancelamento. Reproduz inclusive os tratamentos de expressão do n8n
 * (datas ISO→dd/mm/yyyy, sanitização de quebras/aspas em obs, campos de
 * endereço zerados quando endereco_padrao_cliente === "S").
 */
export function montarPayloadPreenchimentoContrato(input: {
	reg: Record<string, unknown>; // registro atual do cliente_contrato (consulta)
	dataCancelamento: string; // ISO yyyy-mm-dd
	motivoCancelamentoId: number; // id do motivo no IXC (mapa acima)
	obsCancelamento: string; // descrição livre (sanitizada como no n8n)
}): Record<string, unknown> {
	const r = input.reg;
	const isoParaBr = (iso: unknown): string => {
		const m = String(str(iso)).match(/^(\d{4})-(\d{2})-(\d{2})/);
		return m ? `${m[3]}/${m[2]}/${m[1]}` : str(iso);
	};
	const sanitizeObs = (s: string): string =>
		s.replaceAll("\n", " - ").replaceAll('"', "").replaceAll("'", "");
	const sanitizarQuebras = (s: unknown): string => str(s).replace(/\r?\n/g, " ");
	const sanitizarQuebrasEspaco = (s: unknown): string => str(s).replace(/\r?\n/g, " - ");
	const enderecoPadrao = str(r.endereco_padrao_cliente) === "S";
	const campoEndereco = (campo: string): string => (enderecoPadrao ? "" : str(r[campo]));

	return {
		// valores atuais do contrato (expressões do n8n)
		tipo: str(r.tipo),
		id_cliente: toNum(r.id_cliente) ?? 0,
		id_vd_contrato: toNum(r.id_vd_contrato) ?? 0,
		descricao_aux_plano_venda: "",
		contrato: str(r.contrato),
		id_tipo_contrato: toNum(r.id_tipo_contrato) ?? 0,
		id_modelo: 5,
		assinatura_digital: "N",
		integracao_assinatura_digital: "N",
		liberacao_bloqueio_manual: "P",
		id_filial: 1,
		indicacao_contrato_id: "",
		data_assinatura: "",
		data_ativacao: isoParaBr(r.data_ativacao),
		data: isoParaBr(r.data),
		data_renovacao: isoParaBr(r.data_renovacao),
		pago_ate_data: "",
		/**
		 * status/status_internet: preserva o valor atual do registro — em
		 * contrato ativo é "A" de qualquer forma (paridade com o node n8n);
		 * em contrato já cancelado, evita que o PUT reative o cancelamento
		 * se o POST seguinte falhar.
		 */
		status: str(r.status) || "A",
		status_internet: str(r.status) || "A",
		status_velocidade: "N",
		tipo_produtos_plano: "P",
		id_motivo_inclusao: toNum(r.id_motivo_inclusao) ?? "",
		id_indexador_reajuste: "",
		url_assinatura_digital: "",
		token_assinatura_digital: "",
		id_tipo_documento: 501,
		id_carteira_cobranca: toNum(r.id_carteira_cobranca) ?? 0,
		id_vendedor: toNum(r.id_vendedor) ?? 0,
		comissao: 0.0,
		cc_previsao: "P",
		tipo_cobranca: "P",
		isentar_contrato: str(r.isentar_contrato),
		id_contrato_principal: "",
		renovacao_automatica: str(r.renovacao_automatica),
		gerar_finan_assin_digital_contrato: "P",
		agrupar_financeiro_contrato: "P",
		num_parcelas_atraso: 0,
		credit_card_recorrente_bandeira_cartao: "",
		credit_card_recorrente_token: "",
		ids_contratos_recorrencia: "",
		base_geracao_tipo_doc: "P",
		tipo_doc_opc: toNum(r.tipo_doc_opc) ?? 0,
		tipo_doc_opc2: 900,
		tipo_doc_opc3: 13,
		tipo_doc_opc4: 512,
		nf_info_adicionais: "",
		id_tipo_doc_ativ: "",
		id_produto_ativ: "",
		taxa_instalacao: "",
		id_cond_pag_ativ: "",
		id_responsavel: "",
		id_vendedor_ativ: "",
		ativacao_numero_parcelas: "",
		ativacao_vencimentos: "",
		ativacao_valor_parcela: "",
		fidelidade: toNum(r.fidelidade) ?? 0,
		data_expiracao: isoParaBr(r.data_expiracao),
		desconto_fidelidade: "",
		id_instalador: "",
		taxa_improdutiva: "",
		venc_personalizado: "",
		com_entrada: "",
		dia_fixo_vencimento: "",
		tipo_condicao_pag: "",
		bloqueio_automatico: str(r.bloqueio_automatico),
		nao_bloquear_ate: "",
		aviso_atraso: str(r.aviso_atraso),
		nao_avisar_ate: "",
		desbloqueio_confianca: "P",
		desbloqueio_confianca_ativo: "N",
		restricao_auto_desbloqueio: "N",
		obs: "",
		nao_susp_parc_ate: "",
		liberacao_suspensao_parcial: "P",
		utilizando_auto_libera_susp_parc: "N",
		restricao_auto_libera_susp_parcial: "N",
		motivo_restri_auto_libera_parc: "",
		contrato_suspenso: "N",
		data_inicial_suspensao: "",
		data_final_suspensao: "",
		data_acesso_desativado: "",
		// dados do cancelamento (o objetivo deste PUT)
		data_cancelamento: isoParaBr(input.dataCancelamento),
		id_responsavel_cancelamento: "",
		motivo_cancelamento: String(input.motivoCancelamentoId),
		obs_cancelamento: sanitizeObs(input.obsCancelamento),
		origem_cancelamento: "",
		data_negativacao: "",
		id_responsavel_negativacao: "",
		protocolo_negativacao: "",
		id_motivo_negativacao: "",
		obs_negativacao: "",
		data_desistencia: "",
		id_responsavel_desistencia: "",
		motivo_desistencia: "",
		obs_desistencia: "",
		q: "",
		obs_contrato: sanitizarQuebras(r.obs_contrato),
		alerta_contrato: sanitizarQuebrasEspaco(r.alerta_contrato),
		dt_ult_bloq_auto: "",
		dt_ult_bloq_manual: "",
		dt_ult_finan_atraso: "",
		dt_ult_des_bloq_conf: "",
		dt_ult_liberacao_susp_parc: "",
		dt_ult_ativacao: "",
		dt_utl_negativacao: "",
		dt_ult_desiste: "",
		data_cadastro_sistema: "",
		ultima_atualizacao: "",
		data_retomada_contrato: "",
		endereco_padrao_cliente: str(r.endereco_padrao_cliente),
		id_condominio: "",
		condominio_novo: "",
		bloco: "",
		bloco_novo: "",
		apartamento: "",
		apartamento_novo: "",
		cep: campoEndereco("cep"),
		cep_novo: campoEndereco("cep"),
		endereco: campoEndereco("endereco"),
		endereco_novo: campoEndereco("endereco"),
		numero: campoEndereco("numero"),
		numero_novo: campoEndereco("numero"),
		bairro: campoEndereco("bairro"),
		bairro_novo: campoEndereco("bairro"),
		cidade: campoEndereco("cidade"),
		cidade_novo: campoEndereco("cidade"),
		complemento: campoEndereco("complemento"),
		complemento_novo: campoEndereco("complemento"),
		referencia: campoEndereco("referencia"),
		referencia_novo: campoEndereco("referencia"),
		latitude: "",
		latitude_novo: "",
		longitude: "",
		longitude_novo: "",
		tipo_localidade: "U",
		avalista_1: "",
		avalista_2: "",
		testemunha_assinatura_digital: "",
		document_photo: "",
		selfie_photo: "",
	};
}

/** Payload do su_ticket — campo a campo igual aos nodes do n8n (mesmos 55 campos). */
function montarPayloadSuTicket(input: {
	idCliente: number;
	idContrato: number;
	mensagem: string;
	idResponsavelTecnico: string;
	assunto: string;
	titulo: string;
	processo: string;
	setor: string;
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
		id_assunto: input.assunto,
		titulo: input.titulo,
		origem_endereco: "CC",
		origem_endereco_estrutura: "",
		endereco: "",
		latitude: "",
		longitude: "",
		id_wfl_processo: input.processo,
		id_ticket_setor: input.setor,
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

/** Payload do su_ticket Rede Neutra (assunto 108) — assinatura histórica. */
export function montarPayloadAtendimento(input: {
	idCliente: number;
	idContrato: number;
	mensagem: string;
	idResponsavelTecnico: string;
}): Record<string, string> {
	return montarPayloadSuTicket({
		...input,
		assunto: REDE_NEUTRA_ASSUNTO,
		titulo: REDE_NEUTRA_TITULO,
		processo: REDE_NEUTRA_PROCESSO,
		setor: REDE_NEUTRA_SETOR,
	});
}

/**
 * Payload do su_ticket "Cancelamento" (assunto 55) — aberto para TODO
 * contrato cancelado por inadimplência, sem validação de rede neutra.
 */
export function montarPayloadAtendimentoCancelamento(input: {
	idCliente: number;
	idContrato: number;
	mensagem: string;
	idResponsavelTecnico: string;
}): Record<string, string> {
	return montarPayloadSuTicket({
		...input,
		assunto: ATENDIMENTO_CANCELAMENTO_ASSUNTO,
		titulo: ATENDIMENTO_CANCELAMENTO_TITULO,
		processo: ATENDIMENTO_CANCELAMENTO_PROCESSO,
		setor: ATENDIMENTO_CANCELAMENTO_SETOR,
	});
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
 * Abre um su_ticket genérico (com dedupe por assunto) — usada pelos wrappers
 * de Rede Neutra e Cancelamento, tanto pelas tools granulares quanto pela
 * orquestradora `ixc_cancelar_inadimplencia_por_nome`.
 */
async function abrirAtendimentoSuTicket(
	client: IxcClient,
	config: IxcConfig,
	args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	},
	opts: {
		assunto: string;
		titulo: string;
		processo: string;
		setor: string;
		rotulo: string;
		mensagemDefault: string;
	},
): Promise<{
	aberto: boolean;
	duplicado: boolean;
	id_atendimento: number | null;
	dry_run: boolean;
	motivo?: string;
}> {
	// Dedupe: assunto específico em aberto para o contrato
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
				str(reg.id_assunto) === opts.assunto &&
				STATUS_ABERTOS.has(str(reg.su_status || reg.status).toUpperCase())
			);
		});
		if (duplicado) {
			const reg = duplicado as Record<string, unknown>;
			return {
				aberto: false,
				duplicado: true,
				id_atendimento: toNum(reg.id),
				dry_run: config.dryRun,
				motivo: `Já existe atendimento ${opts.rotulo} em aberto para este contrato`,
			};
		}
	}

	const payload = montarPayloadSuTicket({
		idCliente: args.id_cliente,
		idContrato: args.id_contrato,
		mensagem: montarMensagemSuTicket(opts.mensagemDefault, args.mensagem, args.observacao),
		idResponsavelTecnico: config.idTecnicoDefault,
		assunto: opts.assunto,
		titulo: opts.titulo,
		processo: opts.processo,
		setor: opts.setor,
	});
	const { id } = await client.criarTicket(payload);
	return {
		aberto: true,
		duplicado: false,
		id_atendimento: id,
		dry_run: config.dryRun,
	};
}

/** Atendimento Rede Neutra (assunto 108) — somente contratos de rede neutra. */
function abrirAtendimentoRedeNeutra(
	client: IxcClient,
	config: IxcConfig,
	args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	},
): ReturnType<typeof abrirAtendimentoSuTicket> {
	return abrirAtendimentoSuTicket(client, config, args, {
		assunto: REDE_NEUTRA_ASSUNTO,
		titulo: REDE_NEUTRA_TITULO,
		processo: REDE_NEUTRA_PROCESSO,
		setor: REDE_NEUTRA_SETOR,
		rotulo: "Rede Neutra (assunto 108)",
		mensagemDefault: REDE_NEUTRA_MENSAGEM_DEFAULT,
	});
}

/**
 * Atendimento "Cancelamento" (assunto 55) — aberto para TODO contrato
 * cancelado por inadimplência, SEM a validação de rede neutra.
 */
function abrirAtendimentoCancelamento(
	client: IxcClient,
	config: IxcConfig,
	args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	},
): ReturnType<typeof abrirAtendimentoSuTicket> {
	return abrirAtendimentoSuTicket(client, config, args, {
		assunto: ATENDIMENTO_CANCELAMENTO_ASSUNTO,
		titulo: ATENDIMENTO_CANCELAMENTO_TITULO,
		processo: ATENDIMENTO_CANCELAMENTO_PROCESSO,
		setor: ATENDIMENTO_CANCELAMENTO_SETOR,
		rotulo: "Cancelamento (assunto 55)",
		mensagemDefault: ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT,
	});
}

/**
 * Resolve o id do motivo no IXC: aceita id numérico em string ("12"), slug do
 * CRM ("inadimplencia") ou nome. Erro claro se não houver mapeamento.
 */
export function resolverMotivoId(motivo?: string): number {
	const raw = motivo?.trim() ?? "";
	if (!raw) return MOTIVO_SLUG_PARA_ID.inadimplencia; // default do fluxo
	if (/^\d+$/.test(raw)) return Number(raw);
	const id = MOTIVO_SLUG_PARA_ID[raw.toLowerCase()];
	if (id === undefined) {
		throw new Error(
			`Motivo de cancelamento sem mapeamento no IXC: "${raw}" — use o id numérico ou slug conhecido`,
		);
	}
	return id;
}

/**
 * Cancela o financeiro não vencido e desativa o contrato — usada pela tool
 * granular e pela orquestradora. Defaults: motivo 12 (Inadimplência),
 * obs "Inadimplência", data de hoje.
 *
 * Ordem com paridade ao n8n (enviar-cancelamento → 3WxPhXScLXILwm8e):
 *   1. PUT cliente_contrato — preenche data/motivo/obs de cancelamento no
 *      contrato (140 campos, valores atuais preservados). O IXC recusa o
 *      endpoint de cancelamento sem essa pré-condição (validado 2026-10-23).
 *   2. POST desativar_cancelar_financeiro_nao_vencido — desativa o contrato
 *      e cancela o financeiro não vencido.
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
): Promise<{
	ok: boolean;
	payload_enviado: Record<string, string>;
	resposta: unknown;
	dry_run: boolean;
	preenchimento: { ok: boolean; resposta: unknown };
}> {
	const dataCancelamento = normalizarDataCancelamento(args.data_cancelamento);
	const motivoId = resolverMotivoId(args.motivo_cancelamento);
	const obsCancelamento = args.obs_cancelamento?.trim() || CANCELAMENTO_OBS_DEFAULT;

	// Etapa 1: preencher os dados de cancelamento no contrato (PUT)
	const consulta = await client.listar("cliente_contrato", {
		qtype: "cliente_contrato.id",
		query: String(args.id_contrato),
		oper: GridOper.IGUAL,
		rp: 1,
	});
	const reg = consulta.registros[0] as Record<string, unknown> | undefined;
	if (!reg) {
		throw new IxcError(
			`Contrato ${args.id_contrato} não encontrado para preenchimento de cancelamento`,
			undefined,
			consulta.raw,
		);
	}
	// Guard: o IXC recusa PUT cliente_contrato em contrato inativo ("Contrato
	// inativo não pode ser alterado!") — recusar aqui com mensagem clara,
	// antes de qualquer escrita no IXC.
	const statusAtual = str(reg.status).toUpperCase();
	if (statusAtual !== "A") {
		throw new IxcError(
			`Contrato ${args.id_contrato} está inativo (status ${statusAtual}) — não pode ser alterado/cancelado novamente. Correção manual no ERP, se necessário.`,
			undefined,
			consulta.raw,
		);
	}
	const payloadPreenchimento = montarPayloadPreenchimentoContrato({
		reg,
		dataCancelamento,
		motivoCancelamentoId: motivoId,
		obsCancelamento,
	});
	const preenchimento = await client.atualizarClienteContrato(args.id_contrato, payloadPreenchimento);

	// Etapa 2: desativar contrato + cancelar financeiro não vencido (POST)
	const payload = montarPayloadCancelamento({
		idContrato: args.id_contrato,
		dataCancelamento,
		motivoCancelamento: String(motivoId),
		obsCancelamento,
	});
	const { ok, resposta } = await client.desativarCancelarFinanceiroNaoVencido(payload);
	return { ok, payload_enviado: payload, resposta, dry_run: config.dryRun, preenchimento };
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
			dry_run: resultado.dry_run,
			...(resultado.motivo ? { motivo: resultado.motivo } : {}),
		});
	});

	server.registerTool("ixc_abrir_atendimento_cancelamento", {
		description:
			"Abre atendimento su_ticket \"Cancelamento\" (assunto 55/processo 5/setor 7) para cliente+contrato. O atendimento de cancelamento é aberto para TODO contrato cancelado por inadimplência — não depende de rede neutra. Dedupe: se já existir atendimento Cancelamento em aberto para o contrato, devolve o id existente.",
		inputSchema: {
			id_cliente: z.number().int().positive(),
			id_contrato: z.number().int().positive(),
			mensagem: z.string().max(2000).optional().describe("Substitui a mensagem default ('Cliente inadimplente.')"),
			observacao: z.string().max(500).optional().describe("Prefixada como 'Observação: ...' na mensagem"),
			ignorar_duplicado: z.boolean().default(false).describe("true para abrir mesmo se já existir atendimento Cancelamento em aberto"),
		},
	}, async (args: {
		id_cliente: number;
		id_contrato: number;
		mensagem?: string;
		observacao?: string;
		ignorar_duplicado?: boolean;
	}) => {
		const resultado = await abrirAtendimentoCancelamento(client, config, args);
		return reply({
			aberto: resultado.aberto,
			duplicado: resultado.duplicado,
			id_atendimento: resultado.id_atendimento,
			dry_run: resultado.dry_run,
			...(resultado.motivo ? { motivo: resultado.motivo } : {}),
		});
	});

	server.registerTool("ixc_cancelar_financeiro_nao_vencido", {
		description:
			"Desativa o contrato e cancela o financeiro NÃO VENCIDO no IXC (2 etapas: PUT cliente_contrato + POST desativar_cancelar_financeiro_nao_vencido). Defaults: motivo 12 (Inadimplência), obs 'Inadimplência', data de hoje (yyyy-mm-dd). Sempre simule antes via ixc_cancelar_inadimplencia_por_nome com confirmar=false; execute somente com confirmação explícita do usuário no chat. Recusa contrato inativo. Ação destrutiva — nunca executar sem confirmação.",
		inputSchema: {
			id_contrato: z.number().int().positive().describe("ID do contrato no IXC"),
			data_cancelamento: z.string().optional().describe("Data do cancelamento (yyyy-mm-dd ou dd/mm/yyyy); default = hoje"),
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
			"Pipeline completo de CANCELAMENTO POR INADIMPLÊNCIA por nome do cliente: busca cliente → contrato ativo → rede neutra → SEMPRE abre o atendimento Cancelamento (assunto 55); se rede neutra, também abre o atendimento Rede Neutra (assunto 108); depois cancela o financeiro não vencido. SEMPRE comece com confirmar=false (simulação) e execute com confirmar=true somente após confirmação explícita do usuário no chat; depois verifique o status do contrato e reporte com as respostas das tools. Recusa contrato inativo. Para em ambiguidade (homônimos, múltiplos contratos ativos) devolvendo as opções — nunca escolha sozinho.",
		inputSchema: {
			nome: z.string().min(3).describe("Nome (ou parte) do cliente como está na base (campo razao)"),
			id_contrato: z.number().int().positive().optional().describe("Contrato escolhido pelo usuário quando a execução anterior parou em múltiplos contratos ativos"),
			data_cancelamento: z.string().optional().describe("Data do cancelamento (yyyy-mm-dd ou dd/mm/yyyy); default = hoje"),
			motivo_cancelamento: z.string().optional().describe("Default 12 (Inadimplência)"),
			obs_cancelamento: z.string().optional().describe("Default 'Inadimplência'"),
			confirmar: z.boolean().default(false).describe("false (default): apenas simula e devolve o resumo; true: abre os atendimentos e cancela o financeiro"),
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
					? "Abrir atendimento Cancelamento (assunto 55) + atendimento Rede Neutra (assunto 108) e depois cancelar financeiro não vencido"
					: "Abrir atendimento Cancelamento (assunto 55) e depois cancelar financeiro não vencido",
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

		// Guard: contrato inativo não pode ser cancelado novamente (o IXC
		// também recusa o PUT em contrato inativo) — recusar antes de executar.
		if (contrato.status !== "A") {
			return reply({
				...resposta,
				cancelado: false,
				motivo: `Contrato ${contrato.id} está inativo (status ${contrato.status}) — não pode ser cancelado novamente`,
			});
		}

		// Atendimento "Cancelamento" (assunto 55): aberto para TODO cancelamento
		// por inadimplência, sem depender da validação de rede neutra.
		const atCancelamento = await abrirAtendimentoCancelamento(client, config, {
			id_cliente: cliente.id,
			id_contrato: contrato.id,
		});
		resposta.atendimento_cancelamento = atCancelamento;

		// Ordem preservada: falha na criação de qualquer atendimento → NÃO cancela nada
		if (!(atCancelamento.aberto || atCancelamento.duplicado)) {
			return reply({
				...resposta,
				cancelado: false,
				motivo: "Falha ao abrir o atendimento Cancelamento (assunto 55) — cancelamento NÃO executado",
			});
		}

		if (redeNeutra) {
			const at = await abrirAtendimentoRedeNeutra(client, config, {
				id_cliente: cliente.id,
				id_contrato: contrato.id,
			});
			resposta.atendimento = at;
			if (!(at.aberto || at.duplicado)) {
				return reply({
					...resposta,
					cancelado: false,
					motivo: "Falha ao abrir o atendimento de rede neutra — cancelamento NÃO executado",
				});
			}
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
