# ixc-mcp-server (agente-cr-inadimplencia)

Servidor MCP (stdio) para o ERP IXC Soft da Atplus (`erp.atplus.cloud`). Expõe tools para buscar clientes, listar contratos, consultar rede neutra, abrir o atendimento **Cancelamento** (`su_ticket`, assunto 55 / processo 5 / setor 7 — **todo** contrato cancelado por inadimplência), abrir o atendimento **Rede Neutra** (`su_ticket`, assunto 108 / processo 54 / setor 11 — só contratos de rede neutra) e **cancelar financeiro não vencido** (`desativar_cancelar_financeiro_nao_vencido`) — paridade campo a campo com os nodes do workflow n8n de referência.

Plano de origem: `crm-frontend/implementacao-agente-cr/docs/superpowers/specs/2026-10-21-mcp-ixc-atendimento-rede-neutra.md`.

## Tools

| Tool | O que faz |
|---|---|
| `ixc_buscar_cliente` | Busca cliente por nome (campo `razao`). Estratégia `=` exato: nome completo → 2 primeiras palavras → 1ª palavra (o grid desta instância não aceita LIKE em `razao`). |
| `ixc_listar_contratos` | Lista `cliente_contrato` do cliente, ativos primeiro. |
| `ixc_consultar_rede_neutra` | `radusuarios` do contrato: `id_df_projeto=6` E `id_transmissor=6` → `sim`. Mesma regra do CRM (`fetchRedeNeutraDoContrato`). |
| `ixc_abrir_atendimento_cancelamento` | Abre o `su_ticket` "Cancelamento" (assunto 55/processo 5/setor 7, mensagem default "Cliente inadimplente."). **Sem validação de rede neutra**: vale para todo contrato cancelado. **Dedupe**: se já houver assunto 55 em aberto para o contrato, devolve o id existente. |
| `ixc_abrir_atendimento_rede_neutra` | Abre o `su_ticket` (assunto 108). **Dedupe**: se já houver assunto 108 em aberto para o contrato, devolve o id existente. |
| `ixc_cancelar_financeiro_nao_vencido` | **2 etapas com paridade ao n8n** (`enviar-cancelamento` → workflow `3WxPhXScLXILwm8e`): **(1)** `PUT /webservice/v1/cliente_contrato/{id}` — preenche `data_cancelamento` (BR `dd/mm/yyyy`), `motivo_cancelamento` (id IXC; slugs do CRM mapeados, default 12/inadimplência) e `obs_cancelamento` no contrato, com os 140 campos do node (valores atuais preservados; datas ISO→BR; endereço zerado se `endereco_padrao_cliente=S`); **(2)** `POST /webservice/v1/desativar_cancelar_financeiro_nao_vencido` com `id_contrato`, `data_cancelamento` (**ISO `yyyy-mm-dd`** — o IXC rejeita `dd/mm/yyyy` neste endpoint, validado 2026-10-23), `motivo_cancelamento`, `obs_cancelamento`. O IXC recusa o POST sem a pré-condição do PUT (validado 2026-10-23). |
| `ixc_cancelar_inadimplencia_por_nome` | **Orquestradora** por nome: busca cliente → contratos ativos → rede neutra → **sempre** abre o atendimento Cancelamento (assunto 55); rede neutra: também abre o atendimento 108 → cancela financeiro. `confirmar=false` (default) só simula e devolve o resumo; `true` executa. Para em homônimos/múltiplos contratos ativos devolvendo opções. |

## Comportamento do fluxo (decisão do time)

| Cliente | O que acontece |
|---|---|
| **Qualquer cancelamento** | Atendimento Cancelamento (assunto 55) — **sem** validação de rede neutra |
| **Rede neutra** (`id_df_projeto=6` E `id_transmissor=6`) | Atendimento Cancelamento (55) **+** Atendimento Rede Neutra (assunto 108) **+** cancelamento do financeiro não vencido |
| **NÃO rede neutra** | Atendimento Cancelamento (55) **+** cancelamento do financeiro não vencido (sem o atendimento 108) |

Guard da orquestradora: falha ao abrir **qualquer** atendimento → **nada é cancelado** (motivo devolvido na resposta).

Na orquestradora, se houver **apenas um** contrato ativo o `id_contrato` é usado direto; havendo **mais de um**, ela para e devolve as opções para confirmação no chat antes de executar (`confirmar=true`).

## Fluxo recomendado para o agente

1. **Simule sempre primeiro**: `ixc_cancelar_inadimplencia_por_nome` com `confirmar=false` devolve o resumo sem efeitos.
2. **Execute só com confirmação explícita do usuário no chat** (`confirmar=true`) — nunca por inferência.
3. **Verifique depois**: `ixc_listar_contratos` deve mostrar o contrato com `status: "I"`; relate o resultado com as respostas das tools (evidência).
4. **Não contorne bloqueios** (contrato inativo, não rede neutra, ambiguidade de homônimos/contratos) e **não execute ações fora do pedido** (alterar código, versões, workflows n8n).

Procedimento completo: `AGENTE-CANCELAMENTO-INADIMPLENCIA.md` (cancelamento) e `AGENTE-ATENDIMENTO-REDE-NEUTRA.md` (abertura de atendimento).

## Requisitos

- Node.js ≥ 20 (validado no 24)
- pnpm ≥ 10 (Windows: `corepack enable` — ver seção Windows)

## Variáveis de ambiente

| Var | Obrigatória | Descrição |
|---|---|---|
| `IXC_BASE_URL` | ✅ | `https://erp.atplus.cloud` |
| `IXC_TOKEN` | ✅ | **base64 de `usuario:token`** do webservice IXC (ver "Formato do token" abaixo) |
| `IXC_ID_TECNICO_DEFAULT` | ❌ | Default vazio (o IXC aceita `id_responsavel_tecnico` vazio). Se definido, preenche o campo. |
| `IXC_DRY_RUN` | ❌ | `1`/`true` = mocka **todos** os POSTs (`su_ticket` e cancelamento financeiro): nada é gravado no IXC, respostas simuladas. Para demos/treino/validação de fluxo. |
| `IXC_TIMEOUT_MS` | ❌ | Timeout HTTP em ms. Default 15000. |

### Formato do token (importante)

O `erp.atplus.cloud` tem **HTTP Basic Auth na camada do webserver** (o 401 vem do nginx/apache ANTES da aplicação, com `WWW-Authenticate: Basic realm="Acesso restrito"`). Portanto o valor de `IXC_TOKEN` não é o token cru: é o **base64 de `usuario:token`**, usado direto em `Authorization: Basic <valor>`.

Como gerar o token: IXC → Configurações → Usuários → Webservice → Gerar Token.

Como converter para base64:

```bash
# Linux/macOS
echo -n 'USUARIO_WEBSERVICE:TOKEN_WEBSERVICE' | base64
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("USUARIO_WEBSERVICE:TOKEN_WEBSERVICE"))
```

O header de modo da aplicação é separado e já vai embutido no código: `ixcsoft: listar` (listagens) / criação usa JSON POST.

### Comportamento da API IXC (descobertas — para não redescobrir)

- Listagens: `POST /webservice/v1/<tabela>` com **multipart/form-data** + header `ixcsoft: listar` + campos grid (`qtype`/`query`/`oper`/`page`/`rp`/`sortname`/`sortorder`) — igual ao n8n.
- `oper` suportado (comprovado): `=`. **LIKE em `cliente.razao` NÃO funciona** nesta instância (erro "Ocorreu um erro ao processar") — por isso a estratégia de fallback por nome exato.
- Resposta: `data` pode vir como string JSON **ou** objeto; `total` vem como **string**. O client faz parse tolerante dos dois.
- HTTP 200 com `{"type":"error","message":...}` = erro de aplicação (o client converte em exceção com a mensagem limpa).
- Sem o header `ixcsoft: listar`, o POST em `/cliente` é interpretado como **inserção** (validação de formulário) — nunca omita o header.

## Desenvolvimento

```bash
pnpm install
pnpm build    # tsc → dist/
pnpm test     # vitest (47 testes)
```

## Registro no ATP Work

O token nunca vai para o chat nem para commits: fica no **cofre** e entra por referência.

1. Pedir a credencial pelo card seguro do ATP Work (nome sugerido: `ixc_token`, valor = o base64 acima).
2. Registrar o servidor (Ajustes → MCP, ou na conversa com a tool de registro):

```json
{
  "id": "ixc",
  "name": "IXC (Atplus)",
  "transport": "stdio",
  "command": "node",
  "args": ["/CAMINHO/DO/CLONE/ixc-mcp-server/dist/index.js"],
  "env": {
    "IXC_BASE_URL": "https://erp.atplus.cloud",
    "IXC_TOKEN": "$secret:ixc_token"
  }
}
```

3. Depois de registrar, **selecione o servidor na conversa/tarefa** (a seleção de MCP é por conversa) e teste:
   - *"busque o cliente ODILON ALMEIDA DE PAIVA"* → deve listar id 7666.
   - *"simule o cancelamento por inadimplência para <cliente>"* → `confirmar=false` devolve o resumo sem gravar nada.
   - Para executar de verdade: *"cancele a inadimplência de <cliente>"* e confirme o `confirmar=true` no card.

## Instalação no Windows

> MCP stdio roda **no host local** — cada máquina registra o seu servidor.

```powershell
# 1) Clonar e construir (PowerShell)
git clone https://github.com/mateusatplus-lgtm/agente-cr-inadimplencia.git
cd agente-cr-inadimplencia
corepack enable        # ativa o pnpm (já vem com o Node ≥ 20)
pnpm install
pnpm build
pnpm test              # 47 testes devem passar
```

```powershell
# 2) Gerar o token base64 (se ainda não tiver)
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("USUARIO_WEBSERVICE:TOKEN_WEBSERVICE"))
```

3) Registrar no ATP Work com **forward slashes** no caminho (evita escapar `\` no JSON — o Node no Windows aceita os dois):

```json
{
  "id": "ixc",
  "name": "IXC (Atplus)",
  "transport": "stdio",
  "command": "node",
  "args": ["C:/Users/SEU_USUARIO/projetos/agente-cr-inadimplencia/dist/index.js"],
  "env": {
    "IXC_BASE_URL": "https://erp.atplus.cloud",
    "IXC_TOKEN": "$secret:ixc_token"
  }
}
```

> Alternativa ao `$secret:`: definir `IXC_TOKEN` como variável de ambiente do **usuário** no Windows (`setx IXC_TOKEN "valor"`, abra novo terminal depois) e omiti-la do JSON — o servidor herda o ambiente do processo pai. O `setx` grava no registro do usuário: não use em máquina compartilhada.

Observações Windows:

- `corepack enable` precisa de terminal **aberto como administrador** na primeira vez.
- Se `pnpm install` reclamar de scripts bloqueados: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- O build sai em `dist/` com caminhos POSIX internos — nada a ajustar: o Node resolve no Windows.
- Smoke test rápido no PowerShell (deve imprimir os nomes das 7 tools):
  ```powershell
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | python -c "import sys" 2>$null
  node --input-type=module -e "import {spawn} from 'node:child_process';const p=spawn('node',['dist/index.js'],{env:{...process.env,IXC_TOKEN:'x'}});let o='';p.stdout.on('data',d=>o+=d);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s',version:'0'}}})+String.fromCharCode(10));setTimeout(()=>{p.kill();console.log(o.includes('ixc_mcp_server')?'OK':'FALHOU')},1500)"
  ```

## Atualizar

```bash
git pull && pnpm install && pnpm build && pnpm test
```

Depois reinicie o servidor no ATP Work (`mcp_restart`) para recarregar o `dist/` novo.

## Segurança

- `IXC_TOKEN` (base64 com credenciais) só no cofre do ATP Work ou env da máquina — nunca em commit/chat/logs.
- A orquestradora exige `confirmar: true` para mutações; com `confirmar=false` nada é gravado no IXC.
- `IXC_DRY_RUN=1` mocka todos os POSTs — para demonstrações e treino.
- `.gitignore` bloqueia `.env*`, artefatos de teste (`*-resultado.json`, `probe-*.json`) e `dist/`.
