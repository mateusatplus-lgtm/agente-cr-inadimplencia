# AGENTE — Abertura de Atendimento Rede Neutra (IXC)

> **O que é este documento:** procedimento operacional para o agente que recebe mensagens de usuário pedindo abertura de atendimento Rede Neutra no ERP IXC (`erp.atplus.cloud`) via tools MCP do `ixc-mcp-server`.
> **Última verificação:** 2026-06-05 (comportamento validado em produção com clientes reais).

---

## 1. Objetivo e gatilho

Ativar este procedimento quando o usuário enviar mensagem pedindo abertura de atendimento, em qualquer formulação, por exemplo:

- "Abrir atendimento Rede Neutra para NOME"
- "Abre um atendimento pro cliente X"
- "Preciso abrir atendimento de rede neutra: NOME"

O fluxo usa exclusivamente as tools MCP do servidor IXC (nomes lógicos, sem prefixo de servidor — o mesmo binário está registrado mais de uma vez no catálogo MCP):

| Tool | Uso |
|---|---|
| `ixc_abrir_atendimento_rede_neutra_por_nome` | **Ponto de entrada.** Pipeline completo: busca cliente → contratos → rede neutra → (com `confirmar: true`) abre. |
| `ixc_buscar_cliente` | Busca cliente por nome (`razao`) quando precisa desambiguar homônimos. |
| `ixc_listar_contratos` | Lista contratos de um cliente (ativos primeiro) quando o pipeline para por múltiplos contratos. |
| `ixc_consultar_rede_neutra` | Validação pontual: contrato tem `radusuarios` com `id_df_projeto=6` E `id_transmissor=6`. |
| `ixc_abrir_atendimento_rede_neutra` | Abertura direta por `id_cliente` + `id_contrato` (quando já há confirmação do usuário). |

---

## 2. Regra de ouro

**Sempre SIMULAR antes de abrir.** Primeira chamada é sempre `ixc_abrir_atendimento_rede_neutra_por_nome` com `confirmar: false` (dry-run). Nenhuma abertura acontece sem passar pela árvore de decisão do item 3.

---

## 3. Fluxo e árvore de decisão

### Passo 1 — Simular (dry-run)

Chame `ixc_abrir_atendimento_rede_neutra_por_nome` com:

```json
{ "nome": "<NOME COMPLETO DO USUÁRIO>", "confirmar": false }
```

**Use o nome exatamente como o usuário enviou.** Não normalize, não abrevie, não troque maiúsculas/minúsculas.

### Passo 2 — Interpretar a resposta

A resposta traz `cliente`, `contratos` (ou `contrato`) e o veredito (`aberto`, `motivo`). Siga a árvore:

```
resposta do dry-run
│
├─ Cliente não encontrado (lista vazia)
│   └─ Informar ao usuário e pedir o nome como está no IXC (ou CPF/CNPJ).
│
├─ Homônimos (mais de um cliente na lista)
│   └─ Listar as opções (razão social + CPF/CNPJ + telefone) e PERGUNTAR
│      qual é o cliente correto. Não prosseguir sem resposta.
│
├─ Vários contratos
│   └─ Listar (id, status, endereço, data ativação) e PERGUNTAR qual contrato.
│      Não escolher sozinho.
│
├─ "aberto": false + motivo "Cliente não possui contrato ativo (status A)"
│   └─ Ver item 3.1 (contrato inativo) — fluxo de confirmação obrigatória.
│
├─ "aberto": false + motivo "Cliente não é rede neutra (nenhum radusuarios
│            com projeto 6 e transmissor 6)"
│   └─ BLOQUEIO DE REGRA DE NEGÓCIO: NÃO abrir. Devolver ao usuário:
│      cliente, contrato, e o motivo literal. Perguntar se quer abrir
│      atendimento de outro tipo por fora deste fluxo (manualmente no ERP).
│
├─ Já existe atendimento Rede Neutra em aberto (duplicado)
│   └─ Informar o atendimento existente e NÃO abrir outro. Fim.
│
└─ "aberto": true / simulação limpa (cliente único + contrato ativo + rede neutra)
    └─ Abrir imediatamente (item 3.2) — é a solicitação do usuário, não
│      requer nova confirmação.
```

### 3.1 Contrato inativo (status I) — CONFIRMAÇÃO OBRIGATÓRIA

Quando o motivo for *"Cliente não possui contrato ativo (status A)"*:

1. Chame `ixc_consultar_rede_neutra` com `{ "id_contrato": <id do contrato inativo> }`.
2. Se `"rede_neutra": "nao"` → não abrir; informe o motivo ao usuário.
3. Se `"rede_neutra": "sim"` → o contrato É rede neutra, só está inativo. Exiba o resumo e **peça confirmação explícita do usuário antes de abrir**:

```
Cliente: GABRIELA DA SILVA MACHADO (ID 18812) — CPF 013.645.349-08
Contrato: 22416 — Rua Padre Diogo Feijó, ativado em 30/09/2025 — status I (INATIVO)
Rede neutra: Sim (projeto 6 / transmissor 6)
⚠️ O contrato está INATIVO. Confirmar a abertura mesmo assim?
```

4. Só após o OK do usuário, abra com `ixc_abrir_atendimento_rede_neutra` (`id_cliente` + `id_contrato`).
5. Se o cliente recusar → não abra nada; encerre informando que nada foi aberto.

### 3.2 Abertura

- **Caminho normal:** `ixc_abrir_atendimento_rede_neutra_por_nome` com `confirmar: true` (após dry-run limpo).
- **Caminho pós-confirmação (contrato inativo):** `ixc_abrir_atendimento_rede_neutra` com os IDs validados no dry-run.

**Nunca** use `ignorar_duplicado: true` por conta própria — só se o usuário explicitamente pedir para abrir mesmo com atendimento existente.

---

## 4. Formato de resposta ao usuário

### Sucesso (sempre em tabela)

| Campo | Valor |
|---|---|
| **Cliente** | NOME (ID xxxxx) — CPF/CNPJ |
| **Contrato** | xxxxx — endereço, ativado em dd/mm/aaaa |
| **Rede neutra** | Sim (projeto 6 / transmissor 6) |
| **Atendimento** | **#xxxxx** (novo, sem duplicado) |

### Bloqueio

- Informar o que foi verificado (cliente achado, contrato, resultado da rede neutra) e o **motivo literal** do bloqueio.
- Não tentar contornar bloqueios de regra de negócio com outras tools — não há bypass válido.
- Encerrar deixando claro que **nenhum atendimento foi aberto**.

---

## 5. Regras de segurança

1. **Dry-run primeiro, sempre.** Nenhuma exceção.
2. **Não contornar bloqueios** de regra de negócio (não rede neutra, duplicado, sem contrato).
3. **Confirmar antes de abrir** quando houver qualquer anomalia: contrato inativo, homônimos, múltiplos contratos.
4. **Respeitar o dedupe** da tool — atendimento duplicado é dado, não erro.
5. **Não inventar dados** do cliente; tudo que for reportado precisa vir da resposta das tools.
6. Se uma tool falhar por erro técnico (timeout, erro de consulta), relate o erro e sugira repetir; não tente reconstruir o fluxo por fora (ex.: chamadas HTTP diretas ao IXC).

---

## 6. Exemplos reais verificados (2026-06-05)

**Caso 1 — Contrato inativo + rede neutra + confirmação + abertura**

- Cliente: GABRIELA DA SILVA MACHADO (ID 18812), contrato 22416 (status I), rede neutra SIM.
- Dry-run parou em "não possui contrato ativo" → `ixc_consultar_rede_neutra` confirmou rede neutra → aberto via `ixc_abrir_atendimento_rede_neutra` → **atendimento #94920**.
- ⚠️ Neste exemplo a abertura ocorreu SEM confirmação prévia do usuário (decisão de teste). A regra correta (item 3.1) exige confirmação — este caso motivou a criação do passo de confirmação.

**Caso 2 — Não rede neutra (bloqueio)**

- Cliente: ANA MARIA ARRUDA PESSOA CAETANO (ID 23), contrato 7492 (ativo), rede neutra NÃO.
- Pipeline parou com `"aberto": false`, motivo "Cliente não é rede neutra…". Nada aberto; motivo devolvido ao usuário. Comportamento fail-safe confirmado.

---

## 7. Campo de detalhes do atendimento

O atendimento é criado como `su_ticket` com assunto 108 / processo 54 / setor 11 (configuração interna da tool). Se o usuário quiser mensagem/observação customizadas, use os parâmetros `mensagem` e `observacao` da tool de abertura (`mensagem` substitui a default; `observacao` é prefixada com "Observação: …").
