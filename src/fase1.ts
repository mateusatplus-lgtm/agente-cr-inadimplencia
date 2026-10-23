/**
 * FASE 1 — v5 (FINAL): pipeline completo SOMENTE LEITURA + dry-run da criação.
 *
 * Usa o IxcClient REAL (mesmo código das tools) contra o cliente conhecido
 * (ODILON ALMEIDA DE PAIVA, id 7666, contrato ativo 1642 — validados em v3/v4).
 *
 * Passos:
 *  1. ixc_buscar_cliente("ODILON ALMEIDA DE PAIVA") — estratégia `=`
 *  2. contratos do cliente → ativos
 *  3. radusuarios do contrato ativo → regra 6/6
 *  4. su_ticket do contrato (dedupe) — formato da resposta
 *  5. montarPayloadAtendimento + criarTicket em DRY-RUN (não grava nada)
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { IxcClient } from "./ixc-client.js";
import {
	clienteResumo,
	contratoResumo,
	montarMensagem,
	montarPayloadAtendimento,
	normalizarNome,
	regraRedeNeutra,
} from "./tools.js";

async function main(): Promise<void> {
	const config = loadConfig();
	// Força dry-run para a etapa de criação (nunca grava).
	const cfgDry = { ...config, dryRun: true };
	const client = new IxcClient(cfgDry);
	const log: unknown[] = [];
	const out: Record<string, unknown> = { quando: new Date().toISOString(), dry_run: true, passos: log };

	// 1. Busca por nome (mesma estratégia da tool)
	const nome = normalizarNome("ODILON ALMEIDA DE PAIVA");
	const estrategias = [nome, nome.split(/\s+/).slice(0, 2).join(" "), nome.split(/\s+/)[0]];
	let cliente = null as ReturnType<typeof clienteResumo> | null;
	let estrategiaUsada = "nenhuma";
	for (const q of estrategias) {
		const r = await client.listar("cliente", {
			qtype: "cliente.razao", query: q, rp: 10, sortname: "cliente.razao",
		});
		const lista = r.registros.map(clienteResumo).filter((c) => c.id > 0);
		if (lista.length > 0) {
			cliente = lista[0];
			estrategiaUsada = q;
			log.push({ passo: "1. buscar por nome", estrategia: q, total: r.total, primeiro: { id: lista[0].id, razao: lista[0].razao } });
			break;
		}
	}
	if (!cliente) {
		log.push({ passo: "1. buscar por nome", ok: false, tentativas: estrategias });
		writeFileSync(arquivo(), JSON.stringify(out, null, 2));
		return;
	}

	// 2. Contratos
	const contratosR = await client.listar("cliente_contrato", {
		qtype: "cliente_contrato.id_cliente", query: String(cliente.id), rp: 50,
	});
	const contratos = contratosR.registros.map(contratoResumo).filter((c) => c.id > 0);
	const ativos = contratos.filter((c) => c.status === "A");
	log.push({
		passo: "2. contratos", total: contratosR.total,
		todos: contratos.map((c) => ({ id: c.id, status: c.status })),
		ativos: ativos.map((c) => c.id),
	});

	if (ativos.length === 0) {
		writeFileSync(arquivo(), JSON.stringify(out, null, 2));
		return;
	}
	const contrato = ativos[0];

	// 3. Rede neutra (radusuarios 6/6)
	const rad = await client.listar("radusuarios", {
		qtype: "radusuarios.id_contrato", query: String(contrato.id), rp: 10,
	});
	const { redeNeutra, detalhe } = regraRedeNeutra(rad.registros);
	log.push({
		passo: "3. rede neutra",
		total_radusuarios: rad.total,
		amostra: rad.registros.slice(0, 3).map((r) => ({
			id: (r as Record<string, unknown>).id,
			id_df_projeto: (r as Record<string, unknown>).id_df_projeto,
			id_transmissor: (r as Record<string, unknown>).id_transmissor,
		})),
		rede_neutra: redeNeutra ? "sim" : "nao",
		detalhe,
	});

	// 4. su_ticket dedupe (formato)
	const tickets = await client.listar("su_ticket", {
		qtype: "su_ticket.id_contrato", query: String(contrato.id), rp: 30, sortorder: "desc",
	});
	const regTickets = tickets.registros as Array<Record<string, unknown>>;
	log.push({
		passo: "4. su_ticket (dedupe)",
		total: tickets.total,
		amostra: regTickets.slice(0, 3).map((t) => ({
			id: t.id, id_assunto: t.id_assunto, su_status: t.su_status, status: t.status,
		})),
	});

	// 5. Payload + criarTicket em DRY-RUN (id -1, nada gravado)
	const payload = montarPayloadAtendimento({
		idCliente: cliente.id,
		idContrato: contrato.id,
		mensagem: montarMensagem(),
		idResponsavelTecnico: cfgDry.idTecnicoDefault,
	});
	const criacao = await client.criarTicket(payload);
	log.push({
		passo: "5. criar su_ticket (DRY-RUN)",
		id_retornado: criacao.id,
		payload_campos: Object.keys(payload).length,
		mensagem: payload.menssagem,
		id_responsavel_tecnico: payload.id_responsavel_tecnico === "" ? "(vazio — decisão Fase 0)" : payload.id_responsavel_tecnico,
	});

	out.estrategia_usada = estrategiaUsada;
	out.cliente = cliente;
	out.contrato_ativo = contrato;
	out.rede_neutra = redeNeutra ? "sim" : "nao";
	out.dry_run_criacao = { id: criacao.id, gravou: false };

	writeFileSync(arquivo(), JSON.stringify(out, null, 2));
	console.error("[fase1v5] concluído");
}

function arquivo(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "fase1-resultado.json");
}

main().catch((e) => {
	writeFileSync(arquivo(), JSON.stringify({ quando: new Date().toISOString(), fatal: String(e) }, null, 2));
	console.error(`[fase1v5] fatal: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
