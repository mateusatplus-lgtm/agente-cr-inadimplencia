/**
 * Servidor MCP (stdio) do IXC — entrypoint.
 *
 * Ferramentas: busca de cliente, contratos, rede neutra, abertura dos
 * atendimentos (Cancelamento 55 — sempre; Rede Neutra 108 — só rede neutra)
 * e orquestradora por nome (v1.2.0 — 2026-11-12).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { IxcClient } from "./ixc-client.js";
import { registrarTools } from "./tools.js";

async function main(): Promise<void> {
	const config = loadConfig();
	const client = new IxcClient(config);

	const server = new McpServer(
		{ name: "ixc-mcp-server", version: "1.2.0" },
		{
			instructions:
				"Ferramentas do ERP IXC Soft (Atplus). Para cancelamento por inadimplência por nome, use ixc_cancelar_inadimplencia_por_nome com confirmar=false primeiro; revise o resumo com o usuário e repita com confirmar=true. O atendimento Cancelamento (assunto 55) é aberto para TODO cancelamento; se o contrato for rede neutra, também abre o atendimento Rede Neutra (assunto 108); depois cancela o financeiro não vencido. Falha em qualquer atendimento → nada é cancelado.",
		},
	);

	registrarTools(server, { client, config });

	await server.connect(new StdioServerTransport());
}

main().catch((error) => {
	// stdio: erros fatais vão para stderr (stdout é o canal MCP)
	console.error(
		`[ixc-mcp-server] Falha ao iniciar: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
