---
title: "The Control Tower — Design do refactor agêntico (Mastra, orquestração, evidências e UI)"
doc_id: "YCT-AGENT-003"
doc_related:
  - "YCT-RULES-001"
  - "YCT-AGENT-002"
  - "YCT-ORCH-001"
  - "YCT-DIAG-001"
  - "YCT-DETECT-001"
domain: "agentic-orchestration"
dimension_schema: []
time: "2026-09-10T18:52:00Z"
---

# Design do refactor agêntico

## 1. Problema

O `ai_agent_module.md` escolheu Mastra por tipagem de tools, workflows,
observabilidade e avaliações. Nada disso está sendo colhido. O que existe hoje
é um wrapper de `generate()` em volta de um modelo, com a orquestração escrita
à mão em volta dele. Os achados, verificados no código:

**Mastra não está instanciado.** Não existe `new Mastra()` em lugar nenhum.
`new Agent()` é construído *dentro* de cada chamada — `createInvestigatorAgent`
roda dentro de `runInvestigation` (`agent/investigator.ts`), `createNarratorAgent`
roda a cada narração (`agent/narrator.ts`). Sem raiz não há registry, storage,
logger, AI tracing, Studio nem scorers. A justificativa da escolha do framework
não tem contrapartida no repositório.

**Não existe workflow.** A orquestração inteira é código promise em
`agent/coordinator.ts`: um arquivo que faz construção de request, recall de
memória, persistência de run, investigação, materialização, montagem de
evidência, narração, escrita de incidente, ligação de run, fallback e
recuperação de órfãs. Não há como testar uma etapa isoladamente.

**O agente não decide nada.** `materializeAgentDiagnosis`
(`agent/coordinator.ts:97`) roda o beam search determinístico inteiro e depois
procura, na lista de candidatos, a célula que o agente escolheu. Se não bater,
erro e fallback. O agente seleciona um item de uma lista já computada que ele
não influenciou.

**A evidência do agente nunca chega à tela.** `BuildEvidenceInput.investigationTrail`
existe (`diagnose/evidence.ts:20`) e **nenhum dos dois call sites passa o campo**
(`detect/scheduler.ts:124`, `agent/coordinator.ts:135`). Cai sempre no
`?? buildTrail(rows, diagnosis)`, que é o replay determinístico — o próprio
docstring de `diagnose/trail.ts` o descreve como "the deterministic counterpart
of the agent's investigation trail", e ele carimba `toolCallId: "fallback:..."`.
A UI não lê esse carimbo e rotula o bloco como `agent`. Todo drill-down path
já exibido foi sintético. Os `investigation_steps` reais ficam no Postgres sem
leitor.

**A UI não faz streaming.** `packages/web/src/app/api/stream/route.ts` é um
`setInterval(4000)` que refaz `getIncidents()` e devolve o snapshot inteiro. O
app tem `createSseHub` emitindo `investigation-run`, `investigation-step`,
`evidence`, `narrative` e `incident-transitions`, e **nenhum desses eventos é
consumido pelo web**. O sinal em tempo real é produzido e descartado.

**LLM serializado atrás da ingestão.** `orchestrationTail` (`run.ts:85`) é uma
fila global única e a investigação roda dentro dela. O comentário em
`agent/investigator.ts:140` registra uma run de 44 minutos que travou a fila
inteira; o `withDeadline` + `AbortController` foi a contenção.

**Dedup que vaza e não sobrevive a restart.** `agent/coordinator.ts:213` é um
`Set<incidentId>` em memória, nunca limpo.

**Aprovação humana é uma legenda.** `humanApprovalRequired: z.literal(true)`
(`contracts/investigation.ts:266`) é um literal que nunca pode ser `false`,
repetido nos quatro playbooks, cujo único consumidor é uma linha de texto
estática em `evidence-panel.tsx:140`. Não há tabela de decisão, coluna,
endpoint nem botão.

## 2. Escopo

**Dentro:** a raiz Mastra e o registro de agentes; três agentes (investigador,
verificador, narrador); um workflow por incidente com suspensão para decisão
humana; a montagem de evidência com trail real e proveniência; a tabela e o
endpoint de decisão; a ligação do web ao stream real do app; a superfície de
decisão e o bloco de dissenso na UI; a remoção de `agent/coordinator.ts`.

**Fora:** ingestão, rollups, detector, Wilson, residual test, custo,
prioridade, `orchestrate/lifecycle.ts` e `orchestrate/memory.ts` — nenhum deles
muda. `diagnose/` muda apenas no ponto de montagem da evidência. Sem pgvector
(DD15 mantém fingerprint exato como único caminho de reconhecimento). Sem
redesign visual do dashboard: gráfico, feed e console de injeção ficam como
estão.

## 3. Decisões que este design toma

| # | Decisão | Alternativas descartadas |
| --- | --- | --- |
| D1 | Três agentes: investigador dirige a busca, verificador contesta a conclusão, narrador só escreve | Agente único selecionando saída do beam search (o estado atual); agente como segunda opinião sem consequência |
| D2 | Um workflow Mastra por incidente, começando na abertura do incidente | Workflow só no segmento agêntico (deixa de pé o coordinator e a fila); workflow do pipeline inteiro (puxa detecção determinística para dentro do framework sem ganho) |
| D3 | Um ponto de suspensão, no fim, para a decisão humana | Suspensão adicional no meio quando os agentes divergem; decisão registrada fora do workflow |
| D4 | `@mastra/pg` no Postgres existente para o estado do workflow | `@mastra/libsql` em arquivo (não sobrevive a redeploy no Railway); sem storage do Mastra |
| D5 | A decisão humana é gravada em tabela de domínio; o snapshot Mastra é só o veículo | Snapshot como fonte da verdade da decisão |

D4 e D5 executam o que o `ai_agent_module.md` já fixou por escrito: *"Mastra
runtime data and observability traces may use the same PostgreSQL instance as
the product, but they remain in framework-owned storage structures and are
never the source of truth for incidents or audit."*

## 4. Runtime Mastra

Raiz única em `agent/mastra.ts`:

```ts
export const mastra = new Mastra({
  agents:    { investigator, verifier, narrator },
  workflows: { investigateIncident },
  storage:   new PostgresStore({ id: "mastra", connectionString: DATABASE_URL }),
  logger:    createLogger("mastra"),
  observability: new Observability({ configs: { default: {
    serviceName: "control-tower",
    exporters: [new MastraStorageExporter()],
  }}}),
});
```

Layout de módulos, preservando a separação exigida pela AGENTS.md entre código
determinístico, agêntico e de narração:

| arquivo | responsabilidade |
| --- | --- |
| `agent/mastra.ts` | a raiz, instanciada uma vez |
| `agent/agents/investigator.ts` | agente A, criado uma vez |
| `agent/agents/verifier.ts` | agente B, criado uma vez |
| `agent/agents/narrator.ts` | agente C, criado uma vez |
| `agent/workflows/investigate-incident.ts` | o grafo |
| `agent/processors/evidence-numbers.ts` | guarda numérica do narrador como output processor |
| `agent/tools.ts` | seis tools e schemas mantidos; o estado por-run sai da closure e passa a viajar no `RequestContext` (§4.1) |
| `agent/persistence.ts` | inalterado — `investigation_runs`/`investigation_steps` continuam sendo auditoria de domínio |
| `agent/coordinator.ts` | **apagado** |
| `agent/investigator.ts` | **apagado** (o `withDeadline` migra para limite de passo) |

Agentes deixam de ser construídos por chamada e passam a ser resolvidos por
`mastra.getAgent()`. É o que liga tracing, storage e Studio.

A guarda "o narrador não inventa número" sai do regex à mão em
`agent/narrator.ts:83` e vira `Processor`. Hoje a falha dela some num `catch {}`
e degrada em silêncio para o template — o mesmo modo de falha que fez uma
narrativa parecer narrada quando nenhum modelo tinha respondido (registrado em
`agent/config.ts`). Como processor ela roda no pipeline do framework, aparece no
trace, e pode usar `abort(reason, { retry: true })` para devolver ao modelo
*"você usou um número ausente da evidência"* antes de desistir.

### 4.1 O estado por-run sai da closure

`createInvestigationToolset` fecha hoje sobre `runId`, `auditStore`, `dataSource`,
`maxToolCalls` e um `StepCounter`, o que obriga um toolset novo — e portanto um
`Agent` novo — a cada investigação. É a causa mecânica de os agentes serem
construídos por chamada, e não dá para removê-la sem mover esse estado.

`RequestContext` é o canal por-run do Mastra: é encaminhado por
`agent.generate/stream({ requestContext })` e por `run.start/resume({ requestContext })`,
lido dentro da tool em `context.requestContext`, e todas as tools da mesma run
recebem a mesma instância. As seis tools passam a ser definidas uma vez, e o
orçamento, a numeração de passos e a auditoria seguem idênticos — inclusive a
garantia de um contador por run, que agora é dada pelo escopo do contexto em vez
do escopo da closure.

**Dependências novas**, ambas exigindo justificativa pela AGENTS.md:

- `@mastra/pg` — obrigatório para suspender e retomar workflow. A documentação
  do Mastra é explícita: *"Storage is required to persist workflow execution
  state across suspension and resumption."* Usa o Postgres que já existe.
- `@mastra/observability` — o AI tracing. Estritamente opcional para o
  funcionamento, mas sem ele o argumento de observabilidade que motivou a
  escolha do framework continua sem contrapartida.

## 5. Agentes e grafo

```
investigateIncident(incidentId, signal)
  ├─ prepare         [determinístico] request + recall por fingerprint
  ├─ investigate     [agente A]  dirige o drill-down pelas 6 tools, .stream()
  ├─ gateEvidence    [determinístico] tools obrigatórias rodaram? steps completos?
  ├─ verify          [agente B]  a conclusão é sustentada pelo trail?
  ├─ branch
  │    ├─ concorda → materialize [determinístico] valida a célula no beam search
  │    └─ discorda → beamSearch  [determinístico] + registra o dissenso
  ├─ buildEvidence   [determinístico] EvidenceObject fechado, com o trail REAL
  ├─ narrate         [agente C]  só texto, com o processor numérico
  ├─ awaitDecision   [suspend()]
  └─ recordDecision  [determinístico] grava, emite, nunca executa
```

### 5.0 Quando a run começa, e quantas existem

A run é disparada por `run.ts` logo depois de `incidentWriter.openOrUpdate`,
dentro do mesmo tick, e o `enqueueOrchestration` **não a aguarda**: ele dispara
e retorna. É isso que tira o LLM da fila de ticks.

A identidade da run é o `incidentId`. **No máximo uma run viva por incidente**,
garantido por consulta ao storage do workflow, não por estado de processo — é o
que substitui o `Set` em memória de `agent/coordinator.ts:213` e o que faz a
garantia sobreviver a restart. Um incidente reconfirmado a cada janela (a
persistência de três janelas, por design) não abre run nova enquanto a anterior
estiver viva ou suspensa.

### 5.1 Investigador (A)

O papel que a AGENTS.md já autoriza: *"the investigator chooses which
aggregated slice to inspect next"*. Continua com as seis tools e o orçamento de
tool calls. Passa a rodar com `.stream()` em vez de `.generate()`, para que
`tool-call` e `tool-result` cheguem à UI enquanto acontecem.

### 5.2 Verificador (B)

O trabalho dele **não** é refazer o residual test — isso é determinístico e a
tool já responde. Se fosse, ele seria teatro. O trabalho dele é de raciocínio:
**a conclusão do A é implicada pelo trail que o próprio A produziu?** Ele checa
se o passo citado sustenta a afirmação, se havia explicação mais simples pulada
(parcimônia), se um `CONCLUSIVE` se apoia em passo que não fecha. Ele não
recalcula número nenhum: recebe o trail e as mesmas tools em leitura.

`validateConclusiveDiagnosis` (hoje em `agent/investigator.ts`) continua
existindo como `gateEvidence`, portão barato e mecânico **antes** do B: tool
obrigatória presente, step referenciado completo. O B é a camada de julgamento
acima dele.

Contrato de saída:

```ts
VerifierVerdict = { agrees: boolean; objection: string | null; citedStepNos: number[] }
```

### 5.3 Consequência determinística do desacordo

Como D3 não prevê pergunta ao humano no meio, o desacordo precisa de efeito
dentro do grafo, senão o verificador vira texto que ninguém lê. Se
`agrees === false`:

1. a célula do agente **não** é aceita;
2. o ramo `beamSearch` produz o diagnóstico;
3. a evidência sai com `diagnosisSource: "beam_search"` e `dissent` preenchido;
4. a confiança não é promovida a `CONFIRMED` pelo caminho agêntico.

### 5.4 Modelos

O verificador ganha `VERIFIER_MODEL` próprio, com default em modelo **diferente**
do investigador, pela mesma razão que `agent/config.ts` já separa narrador e
reserva: o limite de taxa de um modelo não pode derrubar o investigador e seu
revisor juntos, e um revisor no mesmo modelo do revisado concorda demais.

## 6. Evidências

Quatro mudanças, todas em `diagnose/evidence.ts` e no contrato:

**6.1 O trail real chega.** `buildEvidence` vira passo do grafo, executado
depois de `verify`, com acesso ao `auditStore.getTrail()` da run. O
`InvestigationAuditStore` já coleta os passos reais hoje — o defeito é
exclusivamente que o coordinator nunca os repassou. `investigationTrail` deixa
de ser opcional-e-nunca-passado.

**6.2 Proveniência explícita.** `EvidenceObject` ganha
`trailSource: "agent" | "replay"`. Passos que o agente deu e reconstrução do
caminho determinístico não podem parecer a mesma coisa: uma é auditoria, a
outra é ilustração.

**6.3 `diagnosisSource` deixa de ser inferido.** Sai o
`runIds.length > 1 ? "beam_search" : "agent"` de `agent/coordinator.ts:139`.
A origem passa a vir do ramo que o grafo tomou.

**6.4 Dissenso vira campo.**

```ts
Dissent = {
  agentCell: Dimensions;
  objection: string;
  citedStepNos: number[];
}
EvidenceObject.dissent: Dissent | null
```

O campo não carrega "quem resolveu": isso já é `diagnosisSource`. Um campo de
valor único seria o mesmo defeito que §7.5 remove.

**Explicitamente inalterado:** `emitDeterministicEvidence: true` no tick
continua. É o que faz o incidente existir sem o agente — fronteira
não-negociável #3 da AGENTS.md, e o comentário em `run.ts:150` documenta que é
isso que mantém `agent/` cortável pelo roadmap §7. O workflow **enriquece** uma
linha que já existe; nunca é ele quem a cria.

## 7. Decisão humana

### 7.1 Suspensão

```ts
resumeSchema: z.object({
  decision: z.enum(["accepted", "rejected", "escalated"]),
  actor: z.string().min(1),
  note: z.string().max(1000).nullable(),
})
```

`POST /api/incidents/:id/decision` localiza a run suspensa e chama
`run.resume({ resumeData })`. `recordDecision` grava e emite. **Nada é executado
contra roteamento de pagamento**: a saída é o registro (quem, quando, sobre qual
evidência) e o payload de escalação renderizado do playbook.

### 7.2 Fonte da verdade

A decisão é gravada em `incident_decisions` no Postgres do produto, e
`incidents.decision_state` carrega o estado corrente. O snapshot Mastra guarda a
**run suspensa**; a tabela guarda a **decisão**. Decisão humana é auditoria, e
auditoria é de domínio (D5).

### 7.3 A decisão nunca é bloqueada pelo workflow

Se o snapshot sumiu, corrompeu ou a run expirou, o endpoint grava a decisão no
domínio do mesmo jeito e apenas pula o `resume`. O workflow é o veículo, não o
cartório. Um operador não pode ficar impedido de decidir sobre um incidente real
porque um snapshot de framework se perdeu.

### 7.4 Expiração não decide por ninguém

Uma run parada além de `AGENT_DECISION_TTL_MS` é marcada `expired` e o incidente
permanece visivelmente `awaiting`. Não existe aprovação por decurso de prazo:
auto-aprovar seria o sistema tomando exatamente a decisão que a regra de produto
existe para impedir.

### 7.5 `humanApprovalRequired` é removido

Um literal que nunca pode ser `false` não é um flag, é um comentário com sintaxe
de tipo. O significado passa a ser carregado por `decision_state`.

## 8. UX/UI

Aditivo à linguagem visual existente — `SplitShell`, `Term` e as classes `ct-*`
continuam. Não é redesign.

**8.1 Ligar o web ao hub real.** A rota Next passa a repassar o event stream do
app em vez de reconsultar o Postgres a cada 4s. O snapshot continua existindo
para estado inicial e reconexão — o cap de `maxDuration` do serverless não muda
— mas os deltas passam a vir por evento. Sem isso, nada abaixo é possível.

**8.2 Investigação ao vivo.** Cada `tool-call`/`tool-result` do investigador
aparece conforme acontece. Hoje o agente trabalha em silêncio por até 45s e o
painel só muda no fim.

**8.3 Trail com proveniência.** O painel distingue passos do agente de
reconstrução determinística, usando `trailSource`. Passa a exibir o `hypothesis`
de cada passo, que existe em `contracts/investigation.ts:157` e a UI ignora.

**8.4 Bloco de dissenso.** O que o agente propôs, qual foi a objeção do
verificador, como foi resolvido.

**8.5 Superfície de decisão.** O rodapé do playbook troca a linha estática por
Aceitar / Rejeitar / Escalar com nota; depois de decidido, exibe autor e
horário. O feed ganha o estado `awaiting decision`.

## 9. Falhas e fallback

**9.1 O deadline fica, e muda de lugar.** O `withDeadline` de
`agent/investigator.ts:140` não é redundância a ser deletada: ele documenta um
incidente real — socket pendurado, SDK engolindo o signal, uma run de 44
minutos — em que o `modelSettings.timeout` nativo não bastou. Ele deixa de ser
corrida montada à mão dentro da chamada do agente e vira limite do passo do
workflow. O que muda de verdade é o raio de explosão: com D2, uma run pendurada
custa um incidente, não a fila de ticks.

**9.2 `maxSteps` deixa de ser `maxToolCalls`.** Hoje os dois são o mesmo número
e o comentário no código já admite que são grandezas diferentes (um passo pode
emitir várias tool calls). Passam a ser `AGENT_MAX_STEPS` e
`AGENT_MAX_TOOL_CALLS`, com o orçamento de tools seguindo como teto duro via
`StepBudgetExceededError`.

**9.3 O `Set` de dedup morre.** Vira identidade de run durável chaveada por
incidente. `recoverOrphanRuns` vira `listWorkflowRuns({ status })`.

**9.4 Classificação de falha.** `classifyFailure` hoje casa regex em mensagem de
erro (`/\b(timed out|timeout|aborted)\b/i`). Com passos tipados, a classificação
passa a vir do passo que falhou.

**9.5 Default do fallback — pendente de confirmação.** Hoje `AGENT_FALLBACK_ENABLED`
está desligado por padrão, então o caminho normal de uma investigação falha é um
incidente sem narrativa e um `logger.warn`. Recomendação: inverter o default.
Isso contraria `flight_logs/fallback_kill_switch.md` e **não é implementado sem
confirmação explícita**; o kill switch permanece em qualquer caso.

## 10. Testes

TDD red-green-refactor, conforme AGENTS.md. Determinístico com LLM mockado; e2e
com LLM à parte.

**10.1 O mock passa a ser do modelo.** `InvestigatorAgentLike` e
`NarratorAgentLike` são interfaces duck-typed que existem só para os testes
fingirem ser um `Agent` inteiro. `Agent.model` aceita um `LanguageModelV2`
direto (objeto com `doGenerate`/`doStream`), então o teste injeta um modelo stub
na fronteira certa e exercita o `Agent` real — tools, processors e schema
incluídos. As duas interfaces são removidas.

**10.2 Cada passo do grafo testa sozinho.** É o ganho concreto de D2: hoje
`coordinator.handleSignal` só é testável como blob de ponta a ponta.

**10.3 Testes novos exigidos:**

- suspender, asserir `suspended`, `resume` com resumeData, asserir decisão
  gravada — sem LLM;
- ramo de dissenso: verificador stub que objeta produz evidência `beam_search`
  com `dissent` preenchido;
- **regressão do trail**: evidência do caminho agêntico carrega os passos reais
  e `trailSource: "agent"` — é o teste que teria pego o defeito atual;
- decisão gravada com o snapshot ausente (§7.3);
- expiração não altera `decision_state` (§7.4).

**10.4 Suítes reescritas, não remendadas:** `agent/agent.test.ts`,
`agent/coordinator.test.ts`, `agent/agent.e2e.test.ts`,
`orchestrate/full-flow.e2e.test.ts` e os cenários Playwright.

## 11. Mudanças de contrato, schema e configuração

**`packages/contracts`:**

- `EvidenceObject` += `trailSource: "agent" | "replay"`
- `EvidenceObject` += `dissent: Dissent | null`
- `MatchedRecommendation` −= `humanApprovalRequired`
- novo `VerifierVerdict`
- novo `IncidentDecision`
- novo `DecisionState = "awaiting" | "accepted" | "rejected" | "escalated"`

**Migrations drizzle:**

- nova tabela `incident_decisions` (incident_id, decision, actor, note,
  decided_at, evidence_fingerprint)
- `incidents.decision_state` + check constraint
- as tabelas do `@mastra/pg` são criadas pelo framework e **não** entram nas
  migrations do produto (D4/D5: estrutura do framework, nunca fonte da verdade)

**Configuração** — documentada em `.env.example` com valores fictícios; `.env`
não é lido nem alterado:

- `VERIFIER_MODEL`
- `AGENT_MAX_STEPS` (separado de `AGENT_MAX_TOOL_CALLS`)
- `AGENT_DECISION_TTL_MS`

## 12. Flight logs exigidos

Pela AGENTS.md, cada um destes fixa dependência de produção ou fronteira
arquitetural e precisa do seu registro **no momento da decisão**:

1. `mastra_workflow_owns_the_investigation.md` — D2 e D3: onde o workflow começa,
   por que a detecção fica de fora, por que um só ponto de suspensão.
2. `workflow_state_in_product_postgres.md` — D4 e D5: `@mastra/pg`, e por que a
   decisão humana é de domínio e não do snapshot.
3. `the_verifier_that_reads_the_trail.md` — D1: por que o verificador não refaz
   o residual test, e qual é a consequência determinística do desacordo.

Se §9.5 for aceito, um quarto atualizando `fallback_kill_switch.md`.

## 13. Decomposição em fases

O escopo não cabe num único plano de implementação. Ele quebra em quatro fases,
cada uma entregável e verificável sozinha, na ordem em que uma depende da
anterior:

**Fase 1 — Runtime.** O estado por-run das tools movido para `RequestContext`
(§4.1), a raiz Mastra, os agentes como módulos registrados, o `PostgresStore`, o
processor numérico do narrador, o mock por modelo nos testes, e a separação de
`AGENT_MAX_STEPS` (§9.2).
Nenhuma mudança de comportamento visível: o `coordinator.ts` continua chamando,
só que agentes registrados. É a fase que pode ser validada com a suíte atual
praticamente intacta.

**Fase 2 — Grafo.** O workflow, os três agentes, `gateEvidence`, o ramo de
dissenso, a morte do `coordinator.ts` e do `Set` de dedup, `run.ts` disparando
sem aguardar. Aqui a orquestração muda de dono.

**Fase 3 — Evidências.** Trail real, `trailSource`, `dissent`, `diagnosisSource`
vindo do ramo. Inclui o teste de regressão do trail — o defeito que motivou boa
parte deste design.

**Fase 4 — Decisão e UI.** `incident_decisions`, o endpoint, a suspensão, o web
ligado ao stream real do app, investigação ao vivo, bloco de dissenso e a
superfície de decisão.

As fases 3 e 4 são as que entregam valor visível; as 1 e 2 são as que tornam
elas possíveis. Se o tempo apertar, o corte natural é a fase 4 perder a
investigação ao vivo (§8.2) e manter a superfície de decisão (§8.5) — o
contrário deixaria a aprovação humana como legenda, que é o problema de origem.

## 14. Riscos e o que não está decidido

- **§9.5 está aberto.** O default do fallback não muda sem confirmação.
- **Latência.** Três agentes em série aumentam o tempo até a narrativa. O
  investigador domina o custo, mas o verificador soma um round-trip. Mitigação:
  o verificador recebe o trail, não a investigação inteira, e roda com orçamento
  próprio; se estourar, o comportamento é o de desacordo (cai no beam search),
  que é o lado seguro.
- **Run suspensa acumulando.** Coberto por §7.4, mas a TTL correta só se conhece
  em operação; começa conservadora e é configuração, não constante.
- **`@mastra/observability` é cortável.** Se a dependência incomodar, ela sai
  sem afetar o grafo — apenas o tracing se perde.
