# AGENTE — Cancelamento de Contrato por Inadimplência (IXC)

> **O que é este documento:** procedimento operacional para o agente que executa cancelamento de contrato por inadimplência no ERP IXC (`erp.atplus.cloud`) via tools MCP do `ixc-mcp-server`.
> **Última verificação:** 2026-10-23 (E2E validado em produção: contrato cancelado, data ISO, status confirmado "I").

---

## 1. Objetivo e gatilho

Ativar este procedimento quando o usuário pedir cancelamento de contrato por inadimplência, em qualquer formulação:

- "Cancelar por inadimplência o contrato de NOME"
- "Cancela o contrato do cliente X"
- "Preciso cancelar o contrato de NOME"

O fluxo usa exclusivamente as tools MCP do servidor IXC (nomes lógicos, sem prefixo de servidor):

| Tool | Uso |
|---|---|
| `ixc_cancelar_inadimplencia_por_nome` | **Ponto de entrada.** Pipeline completo: busca cliente → contratos → rede neutra → (com `confirmar: true`) abre o atendimento Cancelamento (assunto 55) **sempre**, o atendimento Rede Neutra (assunto 108) quando for rede neutra, e cancela. |
| `ixc_buscar_cliente` | Busca cliente por nome (`razao`) para desambiguar homônimos. |
| `ixc_listar_contratos` | Lista contratos (ativos primeiro) quando o pipeline para por múltiplos contratos. |
| `ixc_consultar_rede_neutra` | Validação pontual: `radusuarios` com projeto 6 e transmissor 6. |
| `ixc_abrir_atendimento_cancelamento` | Abertura direta do `su_ticket` "Cancelamento" (assunto 55/processo 5/setor 7) por `id_cliente`+`id_contrato` — sem validação de rede neutra. |
| `ixc_cancelar_financeiro_nao_vencido` | Execução direta por `id_contrato` (somente pós-confirmação). |

## 2. Regra de ouro

**Sempre SIMULAR antes de executar.** Primeira chamada é sempre `ixc_cancelar_inadimplencia_por_nome` com `confirmar: false`. Nenhuma execução destrutiva acontece sem passar pela árvore do item 3 e sem confirmação explícita do usuário.

## 3. Fluxo e árvore de decisão

### Passo 1 — Simular (dry-run)

```json
{ "nome": "<NOME COMPLETO DO CLIENTE>", "confirmar": false }
```

**Use o nome exatamente como o usuário enviou.** Não normalize, não abrevie.

### Passo 2 — Interpretar a resposta

```
resposta do dry-run
│
├─ Cliente não encontrado
│   └─ Informar ao usuário e pedir o nome como está no IXC (ou CPF/CNPJ).
│
├─ Homônimos (mais de um cliente)
│   └─ Listar (razão + CPF/CNPJ + telefone) e PERGUNTAR qual é o cliente.
│      Não prosseguir sem resposta.
│
├─ Múltiplos contratos ativos
│   └─ Listar (id, status, endereço, data ativação) e PERGUNTAR qual contrato.
│      Não escolher sozinho.
│
├─ "cancelado": false + motivo de contrato inativo
│   └─ BLOQUEIO: contrato inativo não pode ser cancelado novamente.
│      Informar e encerrar sem executar nada.
│
└─ Simulação limpa (cliente único + contrato ativo único)
    └─ Apresentar o resumo (cliente, contrato, rede neutra, plano) e EXECUTAR
       com confirmar: true — desde que o usuário tenha pedido explicitamente
       o cancelamento. Se houver qualquer dúvida sobre qual contrato, parar
       e perguntar.
```

### Passo 3 — Executar

- `ixc_cancelar_inadimplencia_por_nome` com `confirmar: true` (mesmos `nome`/`id_contrato` validados no dry-run).
- Em **qualquer contrato**: a tool abre o atendimento **Cancelamento** (assunto 55) antes de cancelar — se falhar, **NÃO cancela nada** e devolve o motivo.
- Em contrato **rede neutra**: além do 55, abre também o atendimento Rede Neutra (assunto 108) — se falhar, **NÃO cancela nada** e devolve o motivo.
- Falha em **qualquer** atendimento → cancelamento não executado; relate o motivo, não repita sem nova orientação.

### Passo 4 — Verificar depois

- Consulte `ixc_listar_contratos` do cliente e confirme que o contrato ficou com `status: "I"`.
- A resposta da execução traz `payload_enviado` e `resposta` do IXC — relate-os ao usuário (evidência).

### Passo 5 — Reportar com evidência

Formato sugerido ao usuário:

| Campo | Valor |
|---|---|
| **Cliente** | NOME (ID xxxxx) — CPF/CNPJ |
| **Contrato** | xxxxx — endereço, status antes → depois |
| **Rede neutra** | Sim/Não |
| **Cancelamento** | `cancelado: true/false` + mensagem do IXC |
| **Atendimento Cancelamento** | #id (sempre; assunto 55) |
| **Atendimento Rede Neutra** | #id (quando rede neutra; assunto 108) |

## 4. Regras de segurança (obrigatórias)

1. **Dry-run primeiro, sempre.** Nenhuma exceção.
2. **Execução destrutiva só com confirmação explícita do usuário no chat** (pedido direto do pedido ou resposta a pergunta sua). Nunca por inferência.
3. **Não contornar bloqueios** de regra de negócio: contrato inativo (a tool recusa — não tente alternativas para "fazer passar"), não rede neutra, homônimos, múltiplos contratos — parar e perguntar/informar.
4. **Não cancelar contrato que o usuário não pediu** — mesmo que a simulação sugira outros contratos ativos.
5. **Não reexecutar ação destrutiva após erro** sem relatar o erro e obter nova orientação. Após timeout, confira o estado (listagem de contratos) antes de repetir.
6. **Não inventar dados**: tudo que for reportado precisa vir da resposta das tools.
7. **Não fazer chamadas HTTP diretas ao IXC** por fora das tools.
8. **Não alterar código, repositório, versões, tags ou workflows n8n** como parte de uma execução de cancelamento — isso é tarefa de desenvolvimento, não de operação; relate e encerre.
9. **Não modificar o workflow n8n de referência** para "consertar" o fluxo durante a operação.
10. Se uma tool falhar por erro técnico (timeout, erro de consulta), relate o erro e sugira repetir; não reconstrua o fluxo por fora.

## 5. Exemplo real verificado (2026-10-23)

- Cliente: MATEUS SALOMÃO DE BARROS NETO (ID 6485), contrato 25924 (ativo, sem endereço na listagem), rede neutra NÃO.
- Dry-run → simulação limpa → execução com `confirmar: true` → resposta IXC `{type:"success"}`: "Contrato ID 25924 cancelado, mas nenhum financeiro encontrado. Ação executada com sucesso". Status confirmado "I" na listagem posterior.
- Formatos: PUT de preenchimento usa datas `dd/mm/yyyy`; POST de cancelamento exige data **ISO `yyyy-mm-dd`** (o IXC rejeita `dd/mm/yyyy` no POST — validado).
- ⚠️ Aprendizado do mesmo E2E: o **PUT não funciona em contrato inativo** ("Contrato inativo não pode ser alterado!") — motivo do guard: a tool recusa contratos com status ≠ "A" antes de bater no IXC.

---

## 6. Mensagens dos atendimentos

Dois `su_ticket` podem ser abertos no cancelamento:

| Atendimento | Assunto | Processo | Setor | Quando | Mensagem default |
|---|---|---|---|---|---|
| **Cancelamento** | 55 | 5 | 7 | **todo** cancelamento (sem validação de rede neutra) | "Cliente inadimplente." |
| **Rede Neutra** | 108 | 54 | 11 | só contrato de rede neutra | "Atendimento gerado referente a um cancelamento de um cliente inadimplente da Rede Ultra" |

Ambos: `id_responsavel_tecnico` = `IXC_ID_TECNICO_DEFAULT` (vazio se não definida — o IXC aceita), prioridade `M`, `su_status` inicial `N`, com dedupe (assunto em aberto para o contrato → devolve o id existente). Para mensagem/observação customizadas, use os parâmetros `mensagem` e `observacao` da tool de abertura (`mensagem` substitui a default; `observacao` é prefixada com "Observação: …").
