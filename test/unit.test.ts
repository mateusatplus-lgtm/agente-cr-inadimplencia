import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
	CANCELAMENTO_MOTIVO_DEFAULT,
	CANCELAMENTO_OBS_DEFAULT,
	montarMensagem,
	montarPayloadAtendimento,
	montarPayloadCancelamento,
	normalizarDataCancelamento,
	normalizarNome,
	regraRedeNeutra,
} from "../src/tools.js";
import { parseData } from "../src/ixc-client.js";

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

	it("payload com os 4 campos do endpoint", () => {
		const payload = montarPayloadCancelamento({
			idContrato: 25924,
			dataCancelamento: "05/06/2026",
			motivoCancelamento: "12",
			obsCancelamento: "Inadimplência",
		});
		expect(payload).toEqual({
			id_contrato: "25924",
			data_cancelamento: "05/06/2026",
			motivo_cancelamento: "12",
			obs_cancelamento: "Inadimplência",
		});
	});

	it("payload contém exatamente os 4 campos do endpoint", () => {
		const payload = montarPayloadCancelamento({
			idContrato: 1,
			dataCancelamento: "01/01/2026",
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
	it("vazio → hoje (dd/mm/yyyy)", () => {
		const d = new Date();
		const esperado = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
		expect(normalizarDataCancelamento()).toBe(esperado);
		expect(normalizarDataCancelamento("  ")).toBe(esperado);
	});

	it("dd/mm/yyyy passa direto (com normalização de zeros)", () => {
		expect(normalizarDataCancelamento("5/6/2026")).toBe("05/06/2026");
		expect(normalizarDataCancelamento("05/06/2026")).toBe("05/06/2026");
	});

	it("dd/mm/yy vira dd/mm/yyyy (século 20/21)", () => {
		expect(normalizarDataCancelamento("05/06/26")).toBe("05/06/2026");
	});

	it("yyyy-mm-dd vira dd/mm/yyyy", () => {
		expect(normalizarDataCancelamento("2026-06-05")).toBe("05/06/2026");
	});

	it("formato desconhecido → hoje", () => {
		const d = new Date();
		const esperado = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
		expect(normalizarDataCancelamento("amanhã")).toBe(esperado);
	});
});
