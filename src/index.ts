/**
 * Servidor MCP (stdio) do IXC — entrypoint.
 *
 * Ferramentas: busca de cliente, contratos, rede neutra, abertura de
 * atendimento Rede Neutra e orquestradora por nome (plano 2026-10-21).
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
		{ name: "ixc-mcp-server", version: "1.0.0" },
		{
			instructions:
				"Ferramentas do ERP IXC Soft (Atplus). Para cancelamento por inadimplência por nome, use ixc_cancelar_inadimplencia_por_nome com confirmar=false primeiro; revise o resumo com o usuário e repita com confirmar=true. Rede neutra abre atendimento (assunto 108) e depois cancela o financeiro; não rede neutra apenas cancela.",
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
