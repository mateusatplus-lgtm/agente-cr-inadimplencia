/**
 * Configuração do servidor MCP do IXC — validada na inicialização (fail-fast).
 *
 * Obrigatórias:
 * - IXC_BASE_URL: base do webservice (ex.: https://erp.atplus.cloud)
 * - IXC_TOKEN: token de webservice dedicado (nunca em commit; no ATP Work vive no cofre como $secret:ixc_token)
 *
 * Opcionais:
 * - IXC_ID_TECNICO_DEFAULT: default para id_responsavel_tecnico (decisão 2026-10-21: vazio)
 * - IXC_DRY_RUN (1/true): mocka o POST de criação de su_ticket (Fase 1/testes)
 * - IXC_TIMEOUT_MS: timeout das chamadas HTTP (default 15000)
 */

export interface IxcConfig {
	baseUrl: string;
	token: string;
	idTecnicoDefault: string;
	dryRun: boolean;
	timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IxcConfig {
	const baseUrl = (env.IXC_BASE_URL || "").replace(/\/+$/, "");
	const token = env.IXC_TOKEN || "";

	const missing: string[] = [];
	if (!baseUrl) missing.push("IXC_BASE_URL");
	if (!token) missing.push("IXC_TOKEN");
	if (missing.length > 0) {
		throw new Error(
			`[ixc-mcp-server] Variáveis obrigatórias ausentes: ${missing.join(", ")}. ` +
				"Defina IXC_BASE_URL e IXC_TOKEN (no ATP Work, o token fica no cofre como $secret:ixc_token).",
		);
	}

	if (!/^https?:\/\//.test(baseUrl)) {
		throw new Error(
			`[ixc-mcp-server] IXC_BASE_URL inválido: "${baseUrl}" (esperado http(s)://...)`,
		);
	}

	const timeoutRaw = Number(env.IXC_TIMEOUT_MS || 15000);
	if (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
		throw new Error("[ixc-mcp-server] IXC_TIMEOUT_MS deve ser um número > 0");
	}

	return {
		baseUrl,
		token,
		// Decisão 2026-10-21: o IXC aceita id_responsavel_tecnico vazio — default é string vazia.
		idTecnicoDefault: env.IXC_ID_TECNICO_DEFAULT || "",
		dryRun: ["1", "true", "TRUE", "yes"].includes(env.IXC_DRY_RUN || ""),
		timeoutMs: timeoutRaw,
	};
}
