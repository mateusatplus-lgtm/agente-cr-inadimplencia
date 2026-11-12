import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
	ATENDIMENTO_CANCELAMENTO_ASSUNTO,
	ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT,
	ATENDIMENTO_CANCELAMENTO_PROCESSO,
	ATENDIMENTO_CANCELAMENTO_SETOR,
	ATENDIMENTO_CANCELAMENTO_TITULO,
	asciiPostAcao,
	CANCELAMENTO_MOTIVO_DEFAULT,
	CANCELAMENTO_OBS_DEFAULT,
	MOTIVO_SLUG_PARA_ID,
	montarMensagem,
	montarMensagemSuTicket,
	montarPayloadAtendimento,
	montarPayloadAtendimentoCancelamento,
	montarPayloadCancelamento,
	montarPayloadPreenchimentoContrato,
	normalizarDataCancelamento,
	normalizarNome,
	regraRedeNeutra,
	resolverMotivoId,
} from "../src/tools.js";
import {
	JSON_CONTENT_TYPE,
	parseData,
	serializarJson,
	serializarJsonUtf8,
} from "../src/ixc-client.js";
describe("loadConfig", () => {
	it("falha sem IXC_BASE_URL e IXC_TOKEN", () => {
		expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/IXC_BASE_URL/);
	});

	it("aceita só as obrigatórias (id_tecnico default vazio)", () => {
		const cfg = loadConfig({
			IXC_BASE_URL: "https://erp.atplus.cloud/",
			IXC_TOKEN: "x",
		} as NodeJS.ProcessEnv);
		expect(cfg.baseUrl).toBe("https://erp.atplus.cloud");
		expect(cfg.idTecnicoDefault).toBe("");
		expect(cfg.dryRun).toBe(false);
	});

	it("normaliza dry-run e timeout", () => {
		const cfg = loadConfig({
			IXC_BASE_URL: "https://x",
			IXC_TOKEN: "x",
			IXC_DRY_RUN: "1",
			IXC_TIMEOUT_MS: "5000",
		} as NodeJS.ProcessEnv);
		expect(cfg.dryRun).toBe(true);
		expect(cfg.timeoutMs).toBe(5000);
	});
});

describe("parseData — tolerante a string/objeto", () => {
	it("parseia data como string JSON", () => {
		const payload = JSON.stringify({
			data: JSON.stringify({ total: 2, registros: [{ id: 1 }, { id: 2 }] }),
		});
		const parsed = parseData(payload);
		expect(parsed.total).toBe(2);
		expect(parsed.registros).toHaveLength(2);
	});

	it("parseia data como objeto", () => {
		const parsed = parseData({ data: { total: 1, registros: [{ id: 9 }] } });
		expect(parsed.total).toBe(1);
		expect(parsed.registros).toHaveLength(1);
	});

	it("data string inválida → registros vazios (sem throw)", () => {
		const parsed = parseData({ data: "não é json" });
		expect(parsed.registros).toEqual([]);
	});

	it("payload de criação (su_ticket) com id direto", () => {
		const parsed = parseData({ data: { id: 123 } });
		expect(parsed.id).toBe(123);
	});
});

describe("regraRedeNeutra — id_df_projeto 6 E id_transmissor 6", () => {
	it("sim quando 6/6", () => {
		expect(
			regraRedeNeutra([{ id_df_projeto: 6, id_transmissor: 6 }]).redeNeutra,
		).toBe(true);
	});

	it("nao quando projeto 6 e transmissor outro", () => {
		expect(
			regraRedeNeutra([{ id_df_projeto: 6, id_transmissor: 3 }]).redeNeutra,
		).toBe(false);
	});

	it("nao com múltiplos radusuarios se nenhum for 6/6", () => {
		expect(
			regraRedeNeutra([
				{ id_df_projeto: 1, id_transmissor: 6 },
				{ id_df_projeto: 6, id_transmissor: 1 },
			]).redeNeutra,
		).toBe(false);
	});

	it("sim se QUALQUER radusuario for 6/6", () => {
		expect(
			regraRedeNeutra([
				{ id_df_projeto: 2, id_transmissor: 2 },
				{ id_df_projeto: "6", id_transmissor: "6" },
			]).redeNeutra,
		).toBe(true);
	});

	it("nao com lista vazia (contrato sem radusuario)", () => {
		expect(regraRedeNeutra([]).redeNeutra).toBe(false);
	});
});

describe("montarMensagem", () => {
	it("default sem observação", () => {
		expect(montarMensagem()).toBe(
			"Atendimento gerado referente a um cancelamento de um cliente inadimplente da Rede Ultra",
		);
	});

	it("observação prefixada", () => {
		expect(montarMensagem(undefined, "solicitação do financeiro")).toBe(
			"Observação: solicitação do financeiro\nAtendimento gerado referente a um cancelamento de um cliente inadimplente da Rede Ultra",
		);
	});

	it("mensagem customizada vence", () => {
		expect(montarMensagem("texto próprio", "obs")).toBe(
			"Observação: obs\ntexto próprio",
		);
	});
});

describe("montarPayloadAtendimento — paridade com o node n8n", () => {
	const payload = montarPayloadAtendimento({
		idCliente: 123,
		idContrato: 456,
		mensagem: "msg",
		idResponsavelTecnico: "",
	});

	it("campos fixos idênticos ao node", () => {
		expect(payload.tipo).toBe("C");
		expect(payload.id_assunto).toBe("108");
		expect(payload.titulo).toBe("Cancelamento Rede Neutra");
		expect(payload.origem_endereco).toBe("CC");
		expect(payload.id_wfl_processo).toBe("54");
		expect(payload.id_ticket_setor).toBe("11");
		expect(payload.prioridade).toBe("M");
		expect(payload.su_status).toBe("N");
	});

	it("ids e mensagem dinâmicos", () => {
		expect(payload.id_cliente).toBe("123");
		expect(payload.id_contrato).toBe("456");
		expect(payload.menssagem).toBe("msg");
		expect(payload.id_responsavel_tecnico).toBe("");
	});

	it("contém exatamente os 55 campos do node (nenhum a mais, nenhum a menos)", () => {
		const camposNode = [
			"tipo", "id_estrutura", "protocolo", "id_circuito", "id_cliente", "id_login",
			"id_contrato", "id_filial", "id_assunto", "titulo", "origem_endereco",
			"origem_endereco_estrutura", "endereco", "latitude", "longitude",
			"id_wfl_processo", "id_ticket_setor", "id_responsavel_tecnico",
			"data_criacao", "data_ultima_alteracao", "prioridade", "data_reservada",
			"melhor_horario_reserva", "id_ticket_origem", "id_usuarios", "id_resposta",
			"menssagem", "interacao_pendente", "su_status", "id_evento_status_processo",
			"id_canal_atendimento", "status", "mensagens_nao_lida_cli",
			"mensagens_nao_lida_sup", "token", "finalizar_atendimento", "id_su_diagnostico",
			"status_sla", "origem_cadastro", "ultima_atualizacao", "cliente_fone",
			"cliente_telefone_comercial", "cliente_id_operadora_celular",
			"cliente_telefone_celular", "cliente_whatsapp", "cliente_ramal",
			"cliente_email", "cliente_contato", "cliente_website", "cliente_skype",
			"cliente_facebook", "latitude_cli", "longitude_cli", "latitude_login",
			"longitude_login",
		];
		expect(Object.keys(payload).sort()).toEqual([...camposNode].sort());
	});
});

describe("atendimento Cancelamento (assunto 55) — novo fluxo em todo cancelamento", () => {
	it("constantes fixas do payload definido pelo time", () => {
		expect(ATENDIMENTO_CANCELAMENTO_ASSUNTO).toBe("55");
		expect(ATENDIMENTO_CANCELAMENTO_PROCESSO).toBe("5");
		expect(ATENDIMENTO_CANCELAMENTO_SETOR).toBe("7");
		expect(ATENDIMENTO_CANCELAMENTO_TITULO).toBe("Cancelamento");
		expect(ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT).toBe("Cliente inadimplente.");
	});

	it("payload com os valores do atendimento Cancelamento", () => {
		const payload = montarPayloadAtendimentoCancelamento({
			idCliente: 123,
			idContrato: 456,
			mensagem: ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT,
			idResponsavelTecnico: "",
		});
		expect(payload.id_assunto).toBe("55");
		expect(payload.titulo).toBe("Cancelamento");
		expect(payload.id_wfl_processo).toBe("5");
		expect(payload.id_ticket_setor).toBe("7");
		expect(payload.menssagem).toBe("Cliente inadimplente.");
		expect(payload.id_cliente).toBe("123");
		expect(payload.id_contrato).toBe("456");
		expect(payload.id_responsavel_tecnico).toBe("");
		// campos fixos compartilhados com o su_ticket dos nodes do n8n
		expect(payload.tipo).toBe("C");
		expect(payload.origem_endereco).toBe("CC");
		expect(payload.prioridade).toBe("M");
		expect(payload.su_status).toBe("N");
	});

	it("tem exatamente os mesmos 55 campos do su_ticket Rede Neutra", () => {
		const p55 = montarPayloadAtendimentoCancelamento({
			idCliente: 1,
			idContrato: 2,
			mensagem: "m",
			idResponsavelTecnico: "",
		});
		const p108 = montarPayloadAtendimento({
			idCliente: 1,
			idContrato: 2,
			mensagem: "m",
			idResponsavelTecnico: "",
		});
		expect(Object.keys(p55).sort()).toEqual(Object.keys(p108).sort());
	});

	it("mensagem default e observação prefixada via montarMensagemSuTicket", () => {
		expect(montarMensagemSuTicket(ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT)).toBe(
			"Cliente inadimplente.",
		);
		expect(
			montarMensagemSuTicket(
				ATENDIMENTO_CANCELAMENTO_MENSAGEM_DEFAULT,
				undefined,
				"cliente confirmou por telefone",
			),
		).toBe("Observação: cliente confirmou por telefone\nCliente inadimplente.");
	});
});

describe("normalizarNome", () => {
	it("trim + uppercase", () => {
		expect(normalizarNome(" joao francisco moreira pinto ")).toBe(
			"JOAO FRANCISCO MOREIRA PINTO",
		);
	});
});

describe("cancelamento por inadimplência — defaults e payload", () => {
	it("defaults de motivo e observação são 12 / Inadimplência", () => {
		expect(CANCELAMENTO_MOTIVO_DEFAULT).toBe("12");
		expect(CANCELAMENTO_OBS_DEFAULT).toBe("Inadimplência");
	});

	it("payload com os 4 campos do endpoint — obs transliterada para ASCII (endpoint de ação grava Latin-1)", () => {
		const payload = montarPayloadCancelamento({
			idContrato: 25924,
			dataCancelamento: "2026-06-05",
			motivoCancelamento: "12",
			obsCancelamento: "Inadimplência",
		});
		expect(payload).toEqual({
			id_contrato: "25924",
			data_cancelamento: "2026-06-05",
			motivo_cancelamento: "12",
			obs_cancelamento: "Inadimplencia",
		});
		expect(payload.obs_cancelamento).toMatch(/^[\x20-\x7E]*$/);
	});

	it("payload contém exatamente os 4 campos do endpoint", () => {
		const payload = montarPayloadCancelamento({
			idContrato: 1,
			dataCancelamento: "2026-01-01",
			motivoCancelamento: "12",
			obsCancelamento: "Inadimplência",
		});
		expect(Object.keys(payload).sort()).toEqual([
			"data_cancelamento",
			"id_contrato",
			"motivo_cancelamento",
			"obs_cancelamento",
		]);
	});
});

describe("normalizarDataCancelamento", () => {
	it("vazio → hoje (yyyy-mm-dd)", () => {
		const d = new Date();
		const esperado = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		expect(normalizarDataCancelamento()).toBe(esperado);
		expect(normalizarDataCancelamento("  ")).toBe(esperado);
	});

	it("dd/mm/yyyy vira yyyy-mm-dd (formato aceito pelo endpoint)", () => {
		expect(normalizarDataCancelamento("5/6/2026")).toBe("2026-06-05");
		expect(normalizarDataCancelamento("05/06/2026")).toBe("2026-06-05");
	});

	it("dd/mm/yy vira yyyy-mm-dd (século 20/21)", () => {
		expect(normalizarDataCancelamento("05/06/26")).toBe("2026-06-05");
	});

	it("yyyy-mm-dd passa direto", () => {
		expect(normalizarDataCancelamento("2026-06-05")).toBe("2026-06-05");
	});

	it("formato desconhecido → hoje", () => {
		const d = new Date();
		const esperado = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		expect(normalizarDataCancelamento("amanhã")).toBe(esperado);
	});
});

describe("preenchimento prévio do contrato (PUT 140 campos, paridade n8n 3WxPhXScLXILwm8e)", () => {
	const regBase: Record<string, unknown> = {
		id: 25924,
		tipo: "F",
		id_cliente: 6485,
		id_vd_contrato: 123,
		contrato: "2025.1234",
		id_tipo_contrato: 7,
		id_motivo_inclusao: 2,
		id_carteira_cobranca: 3,
		id_vendedor: 456,
		isentar_contrato: "N",
		renovacao_automatica: "S",
		fidelidade: 12,
		data_ativacao: "2026-10-23",
		data: "2026-10-20",
		data_renovacao: "2027-10-23",
		data_expiracao: "2027-10-23",
		bloqueio_automatico: "S",
		aviso_atraso: "S",
		endereco_padrao_cliente: "N",
		cep: "89800-000",
		endereco: "Rua Anápolis",
		numero: "123",
		bairro: "Centro",
		cidade: "Chapecó",
		complemento: "",
		referencia: "",
		obs_contrato: "linha1\nlinha2",
		alerta_contrato: "alerta1\nalerta2",
	};

	it("tem exatamente os 140 campos do node n8n (nenhum a mais, nenhum a menos)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(Object.keys(payload).length).toBe(140);
	});

	it("campos de cancelamento preenchidos (data BR, motivo id, obs sanitizada)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Cliente sem pagamento\ncom aspas \"' e quebra",
		});
		expect(payload.data_cancelamento).toBe("23/10/2026");
		expect(payload.motivo_cancelamento).toBe("12"); // string, como no n8n
		expect(payload.obs_cancelamento).toBe('Cliente sem pagamento - com aspas  e quebra');
	});

	it("datas do contrato ISO→dd/mm/yyyy (expressões do n8n)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.data_ativacao).toBe("23/10/2026");
		expect(payload.data).toBe("20/10/2026");
		expect(payload.data_renovacao).toBe("23/10/2027");
		expect(payload.data_expiracao).toBe("23/10/2027");
	});

	it("endereço zerado quando endereco_padrao_cliente === 'S' (regra do n8n)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: { ...regBase, endereco_padrao_cliente: "S" },
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.cep).toBe("");
		expect(payload.endereco).toBe("");
		expect(payload.endereco_novo).toBe("");
		expect(payload.numero).toBe("");
		expect(payload.bairro).toBe("");
		expect(payload.cidade).toBe("");
	});

	it("endereço preservado quando endereco_padrao_cliente !== 'S'", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.cep).toBe("89800-000");
		expect(payload.endereco).toBe("Rua Anápolis");
		expect(payload.numero).toBe("123");
		expect(payload.cidade).toBe("Chapecó");
	});

	it("status permanece A e valores estáticos com paridade ao n8n", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.status).toBe("A");
		expect(payload.status_internet).toBe("A");
		expect(payload.id_modelo).toBe(5);
		expect(payload.id_tipo_documento).toBe(501);
		expect(payload.tipo_doc_opc2).toBe(900);
		expect(payload.tipo_doc_opc3).toBe(13);
		expect(payload.tipo_doc_opc4).toBe(512);
		expect(payload.comissao).toBe(0.0);
		expect(payload.tipo).toBe("F");
		expect(payload.id_cliente).toBe(6485);
		expect(payload.contrato).toBe("2025.1234");
	});

	it("obs_contrato e alerta_contrato com quebras sanitizadas (como no n8n)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: regBase,
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.obs_contrato).toBe("linha1 linha2");
		expect(payload.alerta_contrato).toBe("alerta1 - alerta2");
	});

	it("preserva o status atual do contrato (não reativa contrato cancelado)", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: { ...regBase, status: "I", status_internet: "I" },
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		expect(payload.status).toBe("I");
		expect(payload.status_internet).toBe("I");
	});
});

describe("resolverMotivoId", () => {
	it("default vazio → 12 (inadimplência)", () => {
		expect(resolverMotivoId()).toBe(12);
		expect(resolverMotivoId("")).toBe(12);
	});

	it("id numérico em string passa direto", () => {
		expect(resolverMotivoId("21")).toBe(21);
	});

	it("slug do CRM resolve no mapa do IXC", () => {
		expect(resolverMotivoId("inadimplencia")).toBe(12);
		expect(resolverMotivoId("problemas-financeiro-do-cliente")).toBe(21);
	});

	it("slug desconhecido lança erro claro", () => {
		expect(() => resolverMotivoId("motivo-inexistente")).toThrow(/sem mapeamento/);
	});

	it("mapa tem os 19 slugs do n8n", () => {
		expect(Object.keys(MOTIVO_SLUG_PARA_ID).length).toBe(19);
	});
});

describe("serialização JSON das escritas — UTF-8 com charset declarado (v1.2.1, anti-mojibake no IXC)", () => {
	it("serializarJson mantém caracteres latin1 LITERAIS (≤ U+00FF)", () => {
		expect(serializarJson({ obs_cancelamento: "Inadimplência" })).toBe(
			'{"obs_cancelamento":"Inadimplência"}',
		);
	});

	it("serializarJson preserva o escape \\uXXXX para caracteres > U+00FF", () => {
		expect(serializarJson({ msg: "em dash — aqui" })).toBe(
			'{"msg":"em dash \\u2014 aqui"}',
		);
	});

	it("serializarJsonUtf8: 'Inadimplência' vira UTF-8 (par C3 AA presente — validado no ERP com charset=utf-8)", () => {
		const bytes = serializarJsonUtf8({ obs_cancelamento: "Inadimplência" });
		const lista = Array.from(bytes);
		const pos = lista.findIndex((b, i) => b === 0xaa && lista[i - 1] === 0xc3);
		expect(pos).toBeGreaterThan(0);
		const texto = new TextDecoder("utf-8").decode(bytes);
		expect(texto).toBe('{"obs_cancelamento":"Inadimplência"}');
	});

	it("serializarJsonUtf8: payload ASCII puro sai inalterado", () => {
		const bytes = serializarJsonUtf8({ ok: "cancelado", motivo: "12" });
		const esperado = '{"ok":"cancelado","motivo":"12"}';
		const texto = new TextDecoder("utf-8").decode(bytes);
		expect(texto).toBe(esperado);
		expect(Array.from(bytes).every((b) => b <= 0x7f)).toBe(true);
	});

	it("round-trip: bytes UTF-8 → JSON.parse devolve o texto original", () => {
		const original = { msg: "Correção de çãõ ênfase — não-latin1: ✓" };
		const bytes = serializarJsonUtf8(original);
		const texto = new TextDecoder("utf-8").decode(bytes);
		expect(JSON.parse(texto)).toEqual(original);
	});

	it("payload dos 140 campos íntegro após o corpo UTF-8", () => {
		const payload = montarPayloadPreenchimentoContrato({
			reg: {
				tipo: "F",
				id_cliente: 6485,
				contrato: "2025.1234",
				data_ativacao: "2026-10-23",
				data: "2026-10-20",
				obs_contrato: "Cliente com acentuação çã",
				alerta_contrato: "Alerta — ênfase",
			},
			dataCancelamento: "2026-10-23",
			motivoCancelamentoId: 12,
			obsCancelamento: "Inadimplência",
		});
		const bytes = serializarJsonUtf8(payload);
		const texto = new TextDecoder("utf-8").decode(bytes);
		const parsed = JSON.parse(texto) as Record<string, unknown>;
		expect(Object.keys(parsed).length).toBe(140);
		expect(parsed.obs_contrato).toBe("Cliente com acentuação çã");
		expect(parsed.obs_cancelamento).toBe("Inadimplência");
	});

	it("Content-Type das escritas declara charset UTF-8 (charset=iso-8859-1 é RECUSADO pelo IXC)", () => {
		expect(JSON_CONTENT_TYPE).toBe("application/json; charset=utf-8");
	});

	it("asciiPostAcao: 'Inadimplência' → 'Inadimplencia' (POST de ação grava Latin-1 — probe 26028)", () => {
		expect(asciiPostAcao("Inadimplência")).toBe("Inadimplencia");
		expect(asciiPostAcao("Cliente ãéíóú ç ÃÉÍÓÚ")).toBe("Cliente aeiou c AEIOU");
		expect(asciiPostAcao("Coração ✓ — ok")).toBe("Coracao ? ? ok");
		expect(asciiPostAcao("já ASCII")).toBe("ja ASCII");
	});
});
