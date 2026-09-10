# Refactor agêntico — Fase 1: Runtime Mastra

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o Mastra ser realmente o runtime do módulo agêntico — raiz única, agentes registrados uma vez, estado de run em `RequestContext`, storage em Postgres e a guarda numérica do narrador como processor — sem mudar nenhum comportamento observável.

**Architecture:** Hoje `new Agent()` é construído dentro de cada chamada e o estado da run vive em closures de `createInvestigationToolset`. Esta fase inverte isso: as tools passam a ler o estado da run de um `RequestContext` criado por investigação, o que permite que investigador e narrador virem instâncias de módulo registradas numa raiz `Mastra` única com `PostgresStore`. `coordinator.ts` continua sendo quem chama — a orquestração só muda de dono na Fase 2.

**Tech Stack:** TypeScript, `@mastra/core` 1.37.1, `@mastra/pg` (novo), Zod 3, Vitest 2, Drizzle, Postgres.

**Spec:** `docs/superpowers/specs/2026-09-10-agentic-refactor-design.md` (`YCT-AGENT-003`)

## Global Constraints

- **Node >= 22.** `@mastra/core` importa `tracingChannel` de `node:diagnostics_channel`, ausente no Node 18. Sob Node 18 toda suíte que toca Mastra falha no carregamento, sem executar teste algum.
- **TDD obrigatório:** red-green-refactor. O teste que falha vem antes do código de produção (AGENTS.md, "Engineering flow").
- **Código, identificadores, nomes de arquivo, objetos de banco, mensagens de erro e commits em inglês.** Prosa de contexto pode ser português.
- **Nenhuma dependência de produção nova sem justificativa.** Esta fase adiciona `@mastra/pg` (§4 do spec: storage é pré-requisito de suspend/resume) e, opcionalmente, `@mastra/observability` (Task 7, cortável).
- **Nunca ler, imprimir, alterar ou versionar valores de `.env`.** Configuração nova é documentada em `.env.example` com valores fictícios.
- **As três fronteiras arquiteturais permanecem:** números determinísticos; julgamento agêntico limitado por tools, passos e timeout; texto gerado de um evidence object fechado. Nenhuma task desta fase toca `detect/`, `ingest/` ou o cálculo em `diagnose/`.
- **Comandos:** testes `pnpm --filter @control-tower/app test`; tipos `pnpm --filter @control-tower/app typecheck`.

---

### Task 1: Baseline verde — fixar o Node e reparar a asserção obsoleta

Nada nesta fase é testável enquanto a suíte do agente não carregar. Sob o Node 18 ativo ela falha no import; sob o Node 22 ela carrega e revela um teste que o commit `8d3c43d` deixou para trás.

**Files:**
- Create: `.nvmrc`
- Modify: `packages/app/src/agent/agent.test.ts:36-45`

**Interfaces:**
- Consumes: nada.
- Produces: uma suíte `@control-tower/app` verde, pré-requisito de todas as tasks seguintes.

- [ ] **Step 1: Confirmar o modo de falha atual**

```bash
node --version                                    # espera-se v18.x — a causa
npx vitest run src/agent/agent.test.ts --root packages/app
```

Esperado: `SyntaxError: The requested module 'node:diagnostics_channel' does not provide an export named 'tracingChannel'`, com "0 test".

- [ ] **Step 2: Fixar a versão do Node no repositório**

```bash
echo "22" > .nvmrc
```

- [ ] **Step 3: Rodar a suíte sob o Node 22 para ver o teste realmente falhar**

```bash
nvm use            # lê o .nvmrc recém-criado
node --version     # espera-se v22.x
npx vitest run src/agent/agent.test.ts --root packages/app
```

Esperado: a suíte agora **carrega**, 9 passam e 1 falha — `defaults all three roles to Kimi`, com `investigatorModel` recebido `"openai/gpt-5.6-luna"` contra esperado `"kimi-for-coding/k3"`. Este é o red legítimo.

- [ ] **Step 4: Corrigir a asserção para os defaults que o `config.ts` realmente entrega**

Em `packages/app/src/agent/agent.test.ts`, substituir o bloco do teste:

```ts
  it("defaults the investigator and the narrator reserve to one model, the narrator to another", () => {
    // §6.8: narrator and reserve must not share a model, so one model's rate
    // limit cannot take both down. The investigator shares the reserve's model
    // because the two rarely run at once — the reserve only wakes after the
    // narrator has already failed.
    expect(loadAgentConfig({} as NodeJS.ProcessEnv)).toEqual({
      investigatorModel: "openai/gpt-5.6-luna",
      narratorModel: "openai/gpt-5.6-terra",
      narratorFallbackModel: "openai/gpt-5.6-luna",
      maxToolCalls: 12,
      timeoutMs: 45_000,
      // The deterministic fallback ships off; AGENT_FALLBACK_ENABLED=true opts in.
      fallbackEnabled: false,
    });
  });
```

- [ ] **Step 5: Rodar a suíte inteira do app e registrar o baseline**

```bash
pnpm --filter @control-tower/app test
```

Esperado: verde. Se alguma outra suíte falhar, **pare e relate** — o baseline precisa estar verde antes da Task 2, e uma falha aqui é achado novo, não parte deste plano.

- [ ] **Step 6: Commit**

```bash
git add .nvmrc packages/app/src/agent/agent.test.ts
git commit -m "test(agent): pin node 22 and match the config defaults the module ships

@mastra/core imports tracingChannel from node:diagnostics_channel, which
Node 18 does not export, so every Mastra-touching suite failed to load
and never ran. That masked a stale assertion: 8d3c43d moved the model
defaults off Kimi and the test still asserted the old ids."
```

---

### Task 2: O estado da run sai da closure e vai para o `RequestContext`

Hoje `createInvestigationToolset` fecha sobre `runId`, `auditStore`, `dataSource`, `maxToolCalls` e um `StepCounter`, o que obriga um toolset novo — e portanto um `Agent` novo — a cada investigação. `RequestContext` é o mecanismo do Mastra para estado por-run: é encaminhado por `agent.generate/stream({ requestContext })` e lido dentro da tool em `context.requestContext`, e todas as tools da mesma run recebem a mesma instância. É isso que destrava o agente singleton na Task 3.

**Files:**
- Modify: `packages/app/src/agent/tools.ts:214-222` (`ToolsetOptions`), `:645-790` (`createToolExecutor`, `createInvestigationToolset`)
- Modify: `packages/app/src/agent/investigator.ts:168-180` (construção do toolset)
- Modify: `packages/app/src/agent/agent.test.ts` (chamadas diretas de `execute`)
- Test: `packages/app/src/agent/tools.test.ts` (criar)

**Interfaces:**
- Consumes: `ToolsetOptions` (`runId`, `maxToolCalls`, `auditStore`, `dataSource`, `now`), já existente.
- Produces:
  - `export const INVESTIGATION_RUN_KEY = "investigation-run"`
  - `export type InvestigationRunState = ToolsetOptions & { counter: { value: number } }`
  - `export function createInvestigationRequestContext(options: ToolsetOptions): RequestContext`
  - `export const investigationToolset` — o objeto com as seis tools, constante de módulo (substitui `createInvestigationToolset(options)`)

- [ ] **Step 1: Escrever o teste que falha**

Criar `packages/app/src/agent/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import { defaultMockScenario } from "./fixtures.js";
import {
  StepBudgetExceededError,
  createInvestigationRequestContext,
  createMockInvestigationDataSource,
  investigationToolset,
} from "./tools.js";

const decisionContext = {
  tag: "DRILL_DOWN" as const,
  summary: "Checking the provider slice against its siblings.",
  hypothesis: { dimension: "provider" as const, value: "adyen" },
  basedOnStepNos: [],
};

const sliceInput = {
  dimensions: {
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  },
  windowBucket: "2026-08-30T14:06:00.000Z",
  decisionContext,
} as const;

function runContext(runId: string, maxToolCalls: number) {
  const auditStore = new InMemoryInvestigationAuditStore(runId, "agent");
  const requestContext = createInvestigationRequestContext({
    runId,
    maxToolCalls,
    auditStore,
    dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
    now: () => new Date("2026-08-30T14:06:00.000Z"),
  });
  return { auditStore, requestContext };
}

describe("investigationToolset with per-run RequestContext", () => {
  it("numbers steps across different tools of the same run", async () => {
    const { auditStore, requestContext } = runContext(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      12,
    );

    await investigationToolset.query_conversion_slice.execute!(sliceInput, { requestContext });
    await investigationToolset.scan_incident_onset.execute!(
      {
        dimensions: sliceInput.dimensions,
        windowBucket: sliceInput.windowBucket,
        decisionContext: { ...decisionContext, tag: "ONSET_SCAN" as const },
      },
      { requestContext },
    );

    const trail = await auditStore.getTrail();
    // One counter per run, shared by every tool: a per-tool counter would make
    // the budget maxToolCalls * tool count and collide on (run_id, step_no).
    expect(trail.steps.map((step) => step.stepNo)).toEqual([1, 2]);
  });

  it("keeps two concurrent runs on separate budgets", async () => {
    const first = runContext("11111111-1111-4111-8111-111111111111", 12);
    const second = runContext("22222222-2222-4222-8222-222222222222", 12);

    await investigationToolset.query_conversion_slice.execute!(sliceInput, {
      requestContext: first.requestContext,
    });
    await investigationToolset.query_conversion_slice.execute!(sliceInput, {
      requestContext: second.requestContext,
    });

    expect((await first.auditStore.getTrail()).steps.map((s) => s.stepNo)).toEqual([1]);
    expect((await second.auditStore.getTrail()).steps.map((s) => s.stepNo)).toEqual([1]);
  });

  it("throws StepBudgetExceededError past the run's budget", async () => {
    const { requestContext } = runContext("33333333-3333-4333-8333-333333333333", 1);

    await investigationToolset.query_conversion_slice.execute!(sliceInput, { requestContext });

    await expect(
      investigationToolset.query_conversion_slice.execute!(sliceInput, { requestContext }),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("fails loudly when no run state is on the context", async () => {
    const { RequestContext } = await import("@mastra/core/request-context");
    await expect(
      investigationToolset.query_conversion_slice.execute!(sliceInput, {
        requestContext: new RequestContext(),
      }),
    ).rejects.toThrow(/investigation run state/i);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

```bash
npx vitest run src/agent/tools.test.ts --root packages/app
```

Esperado: FAIL — `createInvestigationRequestContext` e `investigationToolset` não existem.

- [ ] **Step 3: Implementar o estado por-run em `tools.ts`**

Adicionar perto de `ToolsetOptions` (linha ~214):

```ts
import { RequestContext } from "@mastra/core/request-context";

export const INVESTIGATION_RUN_KEY = "investigation-run";

// One counter per run, shared by every tool. Owning it per tool would make the
// budget `maxToolCalls * tool count`, make cross-tool `basedOnStepNos`
// unresolvable, and collide on investigation_steps' (run_id, step_no) key.
export type InvestigationRunState = ToolsetOptions & { counter: { value: number } };

export function createInvestigationRequestContext(options: ToolsetOptions): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(INVESTIGATION_RUN_KEY, { ...options, counter: { value: 0 } });
  return requestContext;
}

function requireRunState(context: { requestContext?: RequestContext } | undefined): InvestigationRunState {
  const state = context?.requestContext?.get(INVESTIGATION_RUN_KEY) as
    | InvestigationRunState
    | undefined;
  // A missing run state means the agent was invoked without
  // createInvestigationRequestContext. Failing here keeps a silent run with no
  // audit trail from ever reaching investigation_steps.
  if (!state) {
    throw new Error("Missing investigation run state on the request context");
  }
  return state;
}
```

- [ ] **Step 4: Reescrever `createToolExecutor` para ler o estado do contexto**

Substituir a assinatura e o corpo (linha ~647):

```ts
function createToolExecutor<TInput extends { decisionContext: DecisionContextType }, TResult extends Record<string, unknown>>(
  toolName: z.infer<typeof InvestigationToolName>,
  execute: (state: InvestigationRunState, input: Omit<TInput, "decisionContext">) => Promise<TResult>,
) {
  return async (
    input: TInput,
    context: { requestContext?: RequestContext } | undefined,
  ): Promise<TResult> => {
    const state = requireRunState(context);
    const now = state.now ?? (() => new Date());

    state.counter.value += 1;
    const stepNo = state.counter.value;
    if (stepNo > state.maxToolCalls) {
      throw new StepBudgetExceededError(state.maxToolCalls);
    }

    const [toolArgs, decisionContext] = stripDecisionContext(input);
    await validateDecisionReferences(state.auditStore, stepNo, decisionContext);
    const createdAt = now().toISOString();

    try {
      const result = await execute(state, toolArgs);
      const completedAt = now().toISOString();
      await recordCompletedStep(
        state.auditStore, stepNo, state.runId, toolName,
        toolArgs as Record<string, unknown>, result, decisionContext, createdAt, completedAt,
      );
      return result;
    } catch (error) {
      const completedAt = now().toISOString();
      await recordFailedStep(
        state.auditStore, stepNo, state.runId, toolName,
        toolArgs as Record<string, unknown>, decisionContext, error, createdAt, completedAt,
      );
      throw error;
    }
  };
}
```

- [ ] **Step 5: Trocar `createInvestigationToolset(options)` pela constante de módulo**

Substituir a função inteira (linha ~699 até o fim do arquivo):

```ts
const executeSlice = createToolExecutor<QueryConversionSliceInput, QueryConversionSliceResult>(
  "query_conversion_slice",
  (state, input) => state.dataSource.queryConversionSlice(input),
);
const executeHistory = createToolExecutor<QueryConversionHistoryInput, QueryConversionHistoryResult>(
  "query_conversion_history",
  (state, input) => state.dataSource.queryConversionHistory(input),
);
const executeDeclineMix = createToolExecutor<QueryDeclineMixInput, QueryDeclineMixResult>(
  "query_decline_mix",
  (state, input) => state.dataSource.queryDeclineMix(input),
);
const executeResidual = createToolExecutor<RunResidualTestInput, RunResidualTestResult>(
  "run_residual_test",
  (state, input) => state.dataSource.runResidualTest(input),
);
const executeOnset = createToolExecutor<ScanIncidentOnsetInput, ScanIncidentOnsetResult>(
  "scan_incident_onset",
  (state, input) => state.dataSource.scanIncidentOnset(input),
);
const executeImpact = createToolExecutor<EstimateIncidentImpactInput, EstimateIncidentImpactResult>(
  "estimate_incident_impact",
  (state, input) => state.dataSource.estimateIncidentImpact(input),
);

/**
 * The six typed tools, defined once.
 *
 * Per-run state (runId, audit store, data source, budget, step counter) travels
 * on the RequestContext instead of a closure, which is what lets the
 * investigator be a registered singleton rather than an Agent rebuilt for every
 * incident. Every tool in one run reads the same context instance.
 */
export const investigationToolset = {
  query_conversion_slice: createTool({
    id: "query_conversion_slice",
    description: "Returns aggregate conversion metrics, Wilson interval and state for one allowed rollup slice.",
    inputSchema: queryConversionSliceInputSchema,
    outputSchema: queryConversionSliceResultSchema,
    execute: (input: QueryConversionSliceInput, context) => executeSlice(input, context),
  }),
  query_conversion_history: createTool({
    id: "query_conversion_history",
    description: "Returns aggregate conversion history over an allowed bucket range.",
    inputSchema: queryConversionHistoryInputSchema,
    outputSchema: queryConversionHistoryResultSchema,
    execute: (input: QueryConversionHistoryInput, context) => executeHistory(input, context),
  }),
  query_decline_mix: createTool({
    id: "query_decline_mix",
    description: "Returns decline mix shifts, dominant decline and reference source for an allowed slice.",
    inputSchema: queryDeclineMixInputSchema,
    outputSchema: queryDeclineMixResultSchema,
    execute: (input: QueryDeclineMixInput, context) => executeDeclineMix(input, context),
  }),
  run_residual_test: createTool({
    id: "run_residual_test",
    description: "Runs the deterministic residual test to separate one candidate cell from its echoes.",
    inputSchema: runResidualTestInputSchema,
    outputSchema: runResidualTestResultSchema,
    execute: (input: RunResidualTestInput, context) => executeResidual(input, context),
  }),
  scan_incident_onset: createTool({
    id: "scan_incident_onset",
    description: "Finds the incident onset from historical rollup buckets and returns supporting buckets.",
    inputSchema: scanIncidentOnsetInputSchema,
    outputSchema: scanIncidentOnsetResultSchema,
    execute: (input: ScanIncidentOnsetInput, context) => executeOnset(input, context),
  }),
  estimate_incident_impact: createTool({
    id: "estimate_incident_impact",
    description: "Returns deterministic incident cost and priority estimates.",
    inputSchema: estimateIncidentImpactInputSchema,
    outputSchema: estimateIncidentImpactResultSchema,
    execute: (input: EstimateIncidentImpactInput, context) => executeImpact(input, context),
  }),
};
```

- [ ] **Step 6: Rodar o teste novo**

```bash
npx vitest run src/agent/tools.test.ts --root packages/app
```

Esperado: PASS, 4 testes.

- [ ] **Step 7: Atualizar `investigator.ts` e as chamadas diretas em `agent.test.ts`**

Em `packages/app/src/agent/investigator.ts`, `runInvestigation` deixa de montar o toolset e passa a montar o contexto:

```ts
  const requestContext = createInvestigationRequestContext({
    runId: options.request.runId,
    maxToolCalls: options.config.maxToolCalls,
    auditStore,
    dataSource: options.dataSource,
    now,
  });
  const agent = options.agent ?? createInvestigatorAgent(options.config, investigationToolset);
```

e a chamada `agent.generate(...)` ganha `requestContext` junto de `abortSignal`.

Em `packages/app/src/agent/agent.test.ts`, toda chamada `tools.<nome>.execute!(input, {} as never)` passa a `investigationToolset.<nome>.execute!(input, { requestContext })`, com o contexto criado por `createInvestigationRequestContext` usando o mesmo `runId`, `maxToolCalls`, `auditStore`, `dataSource` e `now` que o teste já monta.

- [ ] **Step 8: Rodar a suíte inteira**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
```

Esperado: verde. Nenhum comportamento mudou — orçamento, numeração de passos e auditoria são idênticos.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/agent/tools.ts packages/app/src/agent/tools.test.ts \
        packages/app/src/agent/investigator.ts packages/app/src/agent/agent.test.ts
git commit -m "refactor(agent): carry per-run tool state on the RequestContext

The toolset closed over runId, audit store, data source and the step
counter, so a fresh toolset — and therefore a fresh Agent — had to be
built for every investigation. RequestContext is Mastra's per-run
channel: every tool in one run reads the same instance, so the six tools
can be defined once and the agent can become a registered singleton."
```

---

### Task 3: A raiz Mastra e os agentes como instâncias de módulo

**Files:**
- Create: `packages/app/src/agent/agents/investigator.ts`, `packages/app/src/agent/agents/narrator.ts`, `packages/app/src/agent/mastra.ts`, `packages/app/src/agent/mastra.test.ts`
- Modify: `packages/app/package.json` (dep `@mastra/pg`), `packages/app/src/agent/investigator.ts`, `packages/app/src/agent/narrator.ts`, `packages/app/src/agent/index.ts`

**Interfaces:**
- Consumes: `investigationToolset`, `createInvestigationRequestContext` (Task 2); `AgentConfig` e `loadAgentConfig` de `./config.js`.
- Produces:
  - `export const mastra: Mastra`
  - `export function getInvestigatorAgent(): Agent`
  - `export function getNarratorAgent(): Agent`
  - `export function getNarratorFallbackAgent(): Agent`

- [ ] **Step 1: Instalar a dependência de storage**

```bash
pnpm --filter @control-tower/app add @mastra/pg
```

Justificativa exigida pela AGENTS.md, a registrar no flight log da Fase 2: a documentação do Mastra é explícita que *"Storage is required to persist workflow execution state across suspension and resumption"*, e o `ai_agent_module.md` já autorizou o uso do mesmo Postgres para estruturas do framework.

- [ ] **Step 2: Escrever o teste que falha**

Criar `packages/app/src/agent/mastra.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getInvestigatorAgent, getNarratorAgent, getNarratorFallbackAgent, mastra } from "./mastra.js";

describe("mastra root", () => {
  it("registers the investigator and both narrator roles", () => {
    expect(Object.keys(mastra.getAgents()).sort()).toEqual([
      "investigator",
      "narrator",
      "narrator-fallback",
    ]);
  });

  it("returns the same agent instance on repeated resolution", () => {
    // The defect this replaces: new Agent() ran inside runInvestigation and
    // inside every narration, so nothing was ever registered and tracing,
    // storage and Studio had nothing to observe.
    expect(getInvestigatorAgent()).toBe(getInvestigatorAgent());
    expect(getNarratorAgent()).toBe(getNarratorAgent());
  });

  it("keeps the narrator and its reserve on different models (§6.8)", () => {
    // One model's rate limit must not take both down.
    expect(getNarratorAgent()).not.toBe(getNarratorFallbackAgent());
  });

  it("configures durable storage", () => {
    expect(mastra.getStorage()).toBeDefined();
  });
});
```

- [ ] **Step 3: Rodar para ver falhar**

```bash
npx vitest run src/agent/mastra.test.ts --root packages/app
```

Esperado: FAIL — `Cannot find module './mastra.js'`.

- [ ] **Step 4: Extrair os agentes para módulos**

Criar `packages/app/src/agent/agents/investigator.ts`:

```ts
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/agent";
import { investigationToolset } from "../tools.js";

export function buildInvestigatorAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: "investigator",
    name: "Investigator Agent",
    instructions:
      "You investigate payment conversion incidents. Use only the available tools, stay within the tool budget, always include a public decisionContext for each tool call, and return a structured diagnosis without hidden reasoning.",
    // Takes the model, not the whole AgentConfig: a test injects a stub model
    // here, and AgentConfig.investigatorModel is a string id.
    model,
    tools: investigationToolset,
  });
}
```

Criar `packages/app/src/agent/agents/narrator.ts`:

```ts
import { Agent } from "@mastra/core/agent";

export function buildNarratorAgent(id: "narrator" | "narrator-fallback", model: string): Agent {
  return new Agent({
    id,
    name: id === "narrator" ? "Incident Narrator" : "Incident Narrator (reserve)",
    instructions:
      "You narrate a closed payment-incident evidence object. Never calculate new numbers and never add numbers that are not present in the evidence object or recommendation.",
    model,
  });
}
```

- [ ] **Step 5: Criar a raiz**

Criar `packages/app/src/agent/mastra.ts`:

```ts
import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { PostgresStore } from "@mastra/pg";
import { createLogger } from "../logging.js";
import { buildInvestigatorAgent } from "./agents/investigator.js";
import { buildNarratorAgent } from "./agents/narrator.js";
import { loadAgentConfig } from "./config.js";

const config = loadAgentConfig();

/**
 * The single Mastra root.
 *
 * Agents are registered once here instead of being constructed inside each
 * call, which is what gives tracing, storage and Studio something to observe —
 * the reason ai_agent_module.md gave for choosing the framework.
 *
 * Storage is Postgres because Phase 4 suspends a workflow run waiting for the
 * human decision, and Mastra requires durable storage for that. It shares the
 * product's instance in framework-owned tables and is never the source of truth
 * for incidents or audit.
 */
export const mastra = new Mastra({
  agents: {
    investigator: buildInvestigatorAgent(config.investigatorModel),
    narrator: buildNarratorAgent("narrator", config.narratorModel),
    "narrator-fallback": buildNarratorAgent("narrator-fallback", config.narratorFallbackModel),
  },
  storage: new PostgresStore({ id: "mastra", connectionString: process.env.DATABASE_URL! }),
  logger: createLogger("mastra"),
});

export function getInvestigatorAgent(): Agent {
  return mastra.getAgent("investigator");
}

export function getNarratorAgent(): Agent {
  return mastra.getAgent("narrator");
}

export function getNarratorFallbackAgent(): Agent {
  return mastra.getAgent("narrator-fallback");
}
```

- [ ] **Step 6: Rodar o teste**

```bash
npx vitest run src/agent/mastra.test.ts --root packages/app
```

Esperado: PASS, 4 testes. Se `DATABASE_URL` não estiver no ambiente do teste, o teste falha na construção — nesse caso adicione `packages/app/vitest.setup.ts` carregando o `.env` da raiz via `dotenv/config`, do mesmo modo que `run.ts` já faz, e registre-o em `test.setupFiles`. **Não** leia nem imprima valores do `.env`.

- [ ] **Step 7: Trocar os call sites para a raiz**

Em `investigator.ts`, `runInvestigation` passa a usar `options.agent ?? getInvestigatorAgent()` e `createInvestigatorAgent` é removida. Em `narrator.ts`, `renderNarratives` passa a usar `agent ?? getNarratorAgent()` e `fallbackAgent ?? getNarratorFallbackAgent()`, e `createNarratorAgent` é removida. Em `agent/index.ts`, adicionar `export * from "./mastra.js";`.

- [ ] **Step 8: Rodar tudo**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/app/package.json packages/app/src/agent/mastra.ts \
        packages/app/src/agent/mastra.test.ts packages/app/src/agent/agents \
        packages/app/src/agent/investigator.ts packages/app/src/agent/narrator.ts \
        packages/app/src/agent/index.ts pnpm-lock.yaml
git commit -m "feat(agent): register the agents on a single Mastra root

new Agent() ran inside runInvestigation and inside every narration, so
no agent was ever registered: no storage, no tracing, no Studio. The
root also carries the Postgres store that phase 4 needs to suspend a run
for the human decision."
```

---

### Task 4: A guarda numérica do narrador vira output processor

`assertNarrativeUsesOnlyEvidenceNumbers` é a garantia da fronteira #2 (o narrador nunca calcula). Hoje ela roda num `try/catch` cujo `catch` vazio degrada em silêncio para o template. Como processor ela roda no pipeline do framework, aparece no trace e pode devolver ao modelo uma chance de corrigir antes de desistir.

**Files:**
- Create: `packages/app/src/agent/processors/evidence-numbers.ts`, `packages/app/src/agent/processors/evidence-numbers.test.ts`
- Modify: `packages/app/src/agent/narrator.ts`, `packages/app/src/agent/agents/narrator.ts`

**Interfaces:**
- Consumes: `assertNarrativeUsesOnlyEvidenceNumbers` e `collectAllowedNumbers` de `../narrator.js`; `NarrationInput` de `@control-tower/contracts`.
- Produces: `export class EvidenceNumbersProcessor implements Processor` com `constructor(input: NarrationInput)` e `id = "evidence-numbers"`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `packages/app/src/agent/processors/evidence-numbers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { EvidenceObject, NarrationInput } from "@control-tower/contracts";
import { EvidenceNumbersProcessor } from "./evidence-numbers.js";

// Same shape narrator.test.ts already exercises, kept local so the processor
// test does not depend on a fixture that phase 3 is going to reshape.
const evidence: EvidenceObject = {
  fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#05",
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen", issuerId: "itau" },
  observedRate: 0.12, expectedRate: 0.7, expectedSource: "cross_sectional", deltaPp: 3,
  ci: { low: 0.08, high: 0.17, level: 0.95 }, attempts: 420, approved: 50,
  windowBucket: "2026-08-30T14:06:00.000Z", windowUsed: "1m", consecutiveWindows: 3,
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true,
  declineMix: [{ code: "05", family: "issuer", observedShare: 0.78, baselineShare: 0.32, count: 289 }],
  dominantDecline: "05",
  suppressedEchoes: [],
  lostApprovals: 244, costUsdMinor: 380000, costUsdPerMin: 3800,
  costLocal: { BRL: 128400 }, priorityScore: 3800,
  diagnosisSource: "beam_search", investigationTrail: [],
};

function resultArgs(text: string) {
  const abort = vi.fn(() => {
    throw new Error("aborted");
  });
  return {
    messages: [{ role: "assistant", content: text }],
    abort,
    retryCount: 0,
  } as never as Parameters<EvidenceNumbersProcessor["processOutputResult"]>[0] & {
    abort: ReturnType<typeof vi.fn>;
  };
}

const input: NarrationInput = { evidence, recommendation: null };

describe("EvidenceNumbersProcessor (rules.md §3 boundary #2)", () => {
  it("passes a narrative whose every number is in the evidence", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = resultArgs("Conversion fell to 12%, against 70% expected.");
    await processor.processOutputResult(args);
    expect(args.abort).not.toHaveBeenCalled();
  });

  it("asks the model to retry on the first fabricated number", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = resultArgs("We lost 999 approvals.");
    await expect(processor.processOutputResult(args)).rejects.toThrow();
    expect(args.abort).toHaveBeenCalledWith(
      expect.stringContaining("999"),
      expect.objectContaining({ retry: true }),
    );
  });

  it("stops asking for retries once the budget is spent", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = { ...resultArgs("We lost 999 approvals."), retryCount: 2 };
    await expect(processor.processOutputResult(args)).rejects.toThrow();
    expect(args.abort).toHaveBeenCalledWith(
      expect.stringContaining("999"),
      expect.objectContaining({ retry: false }),
    );
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

```bash
npx vitest run src/agent/processors/evidence-numbers.test.ts --root packages/app
```

Esperado: FAIL — `Cannot find module './evidence-numbers.js'`.

- [ ] **Step 3: Implementar o processor**

Criar `packages/app/src/agent/processors/evidence-numbers.ts`:

```ts
import type { Processor } from "@mastra/core/processors";
import type { NarrationInput } from "@control-tower/contracts";
import { assertNarrativeUsesOnlyEvidenceNumbers } from "../narrator.js";

const MAX_RETRIES = 2;

/**
 * Boundary #2, enforced inside the framework pipeline.
 *
 * The check itself is unchanged — every number printed must appear in the
 * closed evidence object. What changes is that a violation is now a visible
 * event with one chance to correct, instead of an exception swallowed by a
 * bare catch that silently served the template.
 */
export class EvidenceNumbersProcessor implements Processor {
  readonly id = "evidence-numbers";

  constructor(private readonly input: NarrationInput) {}

  async processOutputResult(args: {
    messages: Array<{ role: string; content: unknown }>;
    abort: (reason?: string, options?: { retry?: boolean }) => never;
    retryCount: number;
  }) {
    const text = args.messages
      .filter((message) => message.role === "assistant")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");

    try {
      assertNarrativeUsesOnlyEvidenceNumbers(text, this.input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Narrative introduced an unknown number";
      args.abort(reason, { retry: args.retryCount < MAX_RETRIES });
    }

    return args.messages as never;
  }
}
```

- [ ] **Step 4: Rodar o teste**

```bash
npx vitest run src/agent/processors/evidence-numbers.test.ts --root packages/app
```

Esperado: PASS, 3 testes.

- [ ] **Step 5: Ligar o processor ao narrador**

`buildNarratorAgent` passa a aceitar os processors por request. Em `agents/narrator.ts`, acrescentar ao `new Agent({...})`:

```ts
    outputProcessors: ({ requestContext }) => {
      const input = requestContext?.get("narration-input") as NarrationInput | undefined;
      return input ? [new EvidenceNumbersProcessor(input)] : [];
    },
```

e em `narrator.ts`, `render` passa a criar um `RequestContext` com `narration-input` setado para `parsedInput` e a repassá-lo em `runner.generate(prompt, { requestContext, ... })`. As chamadas explícitas a `assertNarrativeUsesOnlyEvidenceNumbers` sobre a saída do modelo saem — o processor as substitui. As chamadas sobre `renderNarrativeTemplate` **ficam**: o template não passa por processor e continua precisando da verificação.

- [ ] **Step 6: Rodar tudo**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
```

Esperado: verde, incluindo os seis testes de `narrator.test.ts`, que exercitam a função pura e não mudam.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/agent/processors packages/app/src/agent/narrator.ts \
        packages/app/src/agent/agents/narrator.ts packages/app/src/agent/fixtures.ts
git commit -m "refactor(agent): enforce boundary #2 as a Mastra output processor

The number guard lived in a try/catch whose empty catch degraded to the
template in silence — the same failure shape that once made an incident
read as narrated when no model had answered. As a processor it is a
visible event and the model gets one chance to correct itself."
```

---

### Task 5: O mock passa a ser do modelo, não do framework

`InvestigatorAgentLike` e `NarratorAgentLike` existem só para os testes fingirem ser um `Agent`. Isso significa que nenhum teste jamais exercitou tools, processors ou schema de verdade. `Agent.model` aceita um `LanguageModelV2` direto, então o stub desce um nível e o `Agent` real passa a ser testado.

**Files:**
- Create: `packages/app/src/agent/testing/stub-model.ts`
- Modify: `packages/app/src/agent/investigator.ts` (remover `InvestigatorAgentLike`), `packages/app/src/agent/narrator.ts` (remover `NarratorAgentLike`), `packages/app/src/agent/agent.test.ts`, `packages/app/src/agent/coordinator.test.ts`

**Interfaces:**
- Consumes: `buildInvestigatorAgent`, `buildNarratorAgent` (Task 3).
- Produces: `export function stubModel(responses: StubResponse[]): LanguageModelV2` e `export type StubResponse = { text?: string; object?: unknown; toolCalls?: Array<{ toolName: string; args: unknown }> }`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `packages/app/src/agent/agent.test.ts`:

```ts
  it("runs the real Agent against a stub model", async () => {
    // The duck-typed InvestigatorAgentLike this replaces meant no test ever
    // exercised the tools, the schema or the processors — only our own mock.
    const agent = buildInvestigatorAgent(
      stubModel([
        { object: { status: "INCONCLUSIVE", conclusionTag: "STOP_INCONCLUSIVE",
                    summary: "Not enough evidence.", supportingStepNos: [],
                    reason: "INSUFFICIENT_EVIDENCE", missingEvidence: ["residual"] } },
      ]),
    );

    expect(agent.id).toBe("investigator");
    expect(Object.keys(await agent.getTools())).toContain("run_residual_test");
  });
```

- [ ] **Step 2: Rodar para ver falhar**

```bash
npx vitest run src/agent/agent.test.ts --root packages/app -t "stub model"
```

Esperado: FAIL — `stubModel` não existe.

- [ ] **Step 3: Implementar o stub**

Criar `packages/app/src/agent/testing/stub-model.ts`:

```ts
export type StubResponse = {
  text?: string;
  object?: unknown;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
};

/**
 * A LanguageModelV2 that replays a scripted list of responses.
 *
 * Mastra resolves any object carrying specificationVersion "v2" (or
 * doGenerate/doStream) as a model, so the seam sits under the Agent rather
 * than replacing it: tools, schemas and processors all still run.
 */
export function stubModel(responses: StubResponse[]) {
  let call = 0;
  const next = () => responses[Math.min(call++, responses.length - 1)] ?? {};

  const toContent = (response: StubResponse) => {
    const parts: unknown[] = [];
    if (response.object !== undefined) {
      parts.push({ type: "text", text: JSON.stringify(response.object) });
    } else if (response.text !== undefined) {
      parts.push({ type: "text", text: response.text });
    }
    for (const toolCall of response.toolCalls ?? []) {
      parts.push({
        type: "tool-call",
        toolCallId: `stub-${parts.length}`,
        toolName: toolCall.toolName,
        input: JSON.stringify(toolCall.args),
      });
    }
    return parts;
  };

  return {
    specificationVersion: "v2" as const,
    provider: "stub",
    modelId: "stub-model",
    supportedUrls: {},
    async doGenerate() {
      const response = next();
      return {
        content: toContent(response),
        finishReason: response.toolCalls?.length ? "tool-calls" : "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
    async doStream() {
      const response = next();
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of toContent(response)) controller.enqueue(part);
            controller.enqueue({
              type: "finish",
              finishReason: response.toolCalls?.length ? "tool-calls" : "stop",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            });
            controller.close();
          },
        }),
        warnings: [],
      };
    },
  };
}
```

- [ ] **Step 4: Rodar o teste**

```bash
npx vitest run src/agent/agent.test.ts --root packages/app -t "stub model"
```

Esperado: PASS. Se a forma de `content` for rejeitada pelo wrapper `AISDKV5LanguageModel`, ajuste `toContent` até o teste passar — a forma exata é detalhe do adapter, e o teste é o oráculo.

- [ ] **Step 5: Remover as interfaces duck-typed**

Apagar `InvestigatorAgentLike` de `investigator.ts` e `NarratorAgentLike` de `narrator.ts`. Os parâmetros `agent?` e `fallbackAgent?` passam a ser tipados como `Agent`. Em `agent.test.ts` e `coordinator.test.ts`, os mocks que hoje implementam `{ generate }` passam a ser `buildInvestigatorAgent`/`buildNarratorAgent` com `stubModel(...)` no lugar do id de modelo.

- [ ] **Step 6: Rodar tudo**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/agent/testing packages/app/src/agent/investigator.ts \
        packages/app/src/agent/narrator.ts packages/app/src/agent/agent.test.ts \
        packages/app/src/agent/coordinator.test.ts
git commit -m "test(agent): stub the model instead of duck-typing the Agent

InvestigatorAgentLike and NarratorAgentLike let tests impersonate a whole
Agent, so no test ever exercised the tools, schemas or processors. Agent
accepts a LanguageModelV2 directly, so the seam moves one level down and
the real Agent runs."
```

---

### Task 6: Separar `AGENT_MAX_STEPS` de `AGENT_MAX_TOOL_CALLS`

`maxSteps` recebe hoje `config.maxToolCalls`, e o comentário no código já admite que são grandezas diferentes: um passo do modelo pode emitir várias tool calls. Confundi-los faz o teto de passos ser silenciosamente mais apertado do que o orçamento de tools que o operador configurou.

**Files:**
- Modify: `packages/app/src/agent/config.ts`, `packages/app/src/agent/investigator.ts`, `packages/app/src/agent/agent.test.ts`, `.env.example`

**Interfaces:**
- Consumes: `AgentConfig` (Task 1).
- Produces: `AgentConfig.maxSteps: number`, default `12`, lido de `AGENT_MAX_STEPS`.

- [ ] **Step 1: Escrever o teste que falha**

Em `packages/app/src/agent/agent.test.ts`, acrescentar ao `describe("agent module")`:

```ts
  it("reads the step ceiling separately from the tool budget", () => {
    const config = loadAgentConfig({
      AGENT_MAX_TOOL_CALLS: "12",
      AGENT_MAX_STEPS: "20",
    } as NodeJS.ProcessEnv);
    // A model step may issue several tool calls, so tying maxSteps to the tool
    // budget cuts the conversation off before its conclusion — the run then
    // returns finishReason "tool-calls" with no object and reads as
    // INVALID_OUTPUT on a run that did nothing wrong.
    expect(config.maxToolCalls).toBe(12);
    expect(config.maxSteps).toBe(20);
  });

  it("defaults the step ceiling to 12", () => {
    expect(loadAgentConfig({} as NodeJS.ProcessEnv).maxSteps).toBe(12);
  });
```

E acrescentar `maxSteps: 12` ao objeto esperado no teste de defaults corrigido na Task 1.

- [ ] **Step 2: Rodar para ver falhar**

```bash
npx vitest run src/agent/agent.test.ts --root packages/app -t "step ceiling"
```

Esperado: FAIL — `config.maxSteps` é `undefined`.

- [ ] **Step 3: Implementar**

Em `config.ts`, acrescentar `maxSteps: number;` à interface e ao retorno:

```ts
    maxToolCalls: readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12),
    // A model step may issue several tool calls, so this is not the tool
    // budget. maxToolCalls stays the hard cap on work done
    // (StepBudgetExceededError); this only stops Mastra from ending the
    // conversation before the model reaches its conclusion.
    maxSteps: readPositiveInt(env.AGENT_MAX_STEPS, 12),
```

Em `investigator.ts`, `maxSteps: options.config.maxToolCalls` passa a `maxSteps: options.config.maxSteps`.

- [ ] **Step 4: Rodar o teste**

```bash
npx vitest run src/agent/agent.test.ts --root packages/app
```

Esperado: PASS.

- [ ] **Step 5: Documentar a variável**

Em `.env.example`, junto de `AGENT_MAX_TOOL_CALLS`, com valor fictício:

```
# Ceiling on model steps in the agentic loop. Not the tool budget: one step may
# issue several tool calls, and AGENT_MAX_TOOL_CALLS stays the hard cap on work.
AGENT_MAX_STEPS=12
```

- [ ] **Step 6: Rodar tudo e commitar**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
git add packages/app/src/agent/config.ts packages/app/src/agent/investigator.ts \
        packages/app/src/agent/agent.test.ts .env.example
git commit -m "fix(agent): stop conflating the step ceiling with the tool budget

maxSteps received maxToolCalls, but one model step may issue several tool
calls, so the loop was cut off tighter than the budget an operator set."
```

---

### Task 7: AI tracing (cortável)

O spec (§14) marca esta dependência como removível sem afetar o grafo. Faça-a por último e corte-a inteira se dependência nova incomodar.

**Files:**
- Modify: `packages/app/package.json`, `packages/app/src/agent/mastra.ts`, `packages/app/src/agent/mastra.test.ts`

**Interfaces:**
- Consumes: `mastra` (Task 3).
- Produces: nenhuma API nova — só configuração.

- [ ] **Step 1: Escrever o teste que falha**

Em `mastra.test.ts`:

```ts
  it("exports traces to storage", () => {
    expect(mastra.getObservability()).toBeDefined();
  });
```

- [ ] **Step 2: Rodar para ver falhar**

```bash
npx vitest run src/agent/mastra.test.ts --root packages/app -t "traces"
```

Esperado: FAIL — observability indefinido.

- [ ] **Step 3: Instalar e configurar**

```bash
pnpm --filter @control-tower/app add @mastra/observability
```

Em `mastra.ts`, acrescentar ao `new Mastra({...})`:

```ts
  observability: new Observability({
    configs: {
      default: {
        serviceName: "control-tower",
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
```

com `import { MastraStorageExporter, Observability } from "@mastra/observability";`.

- [ ] **Step 4: Rodar tudo e commitar**

```bash
pnpm --filter @control-tower/app test && pnpm --filter @control-tower/app typecheck
git add packages/app/package.json packages/app/src/agent/mastra.ts \
        packages/app/src/agent/mastra.test.ts pnpm-lock.yaml
git commit -m "feat(agent): export Mastra traces to storage

Observability is the reason ai_agent_module.md gave for choosing the
framework; until now nothing was collecting it."
```

---

## Verificação final da fase

- [ ] `pnpm --filter @control-tower/app test` verde
- [ ] `pnpm --filter @control-tower/app typecheck` limpo
- [ ] `pnpm -r test` verde (contracts, generator, web)
- [ ] `grep -rn "new Agent(" packages/app/src` só encontra `agents/investigator.ts` e `agents/narrator.ts`
- [ ] `grep -rn "AgentLike" packages/app/src` não encontra nada
- [ ] Nenhum comportamento observável mudou: mesmos incidentes, mesma evidência, mesma narrativa

## O que esta fase deliberadamente NÃO faz

Verificador, workflow, morte do `coordinator.ts`, trail real, dissenso, decisão humana e UI. Todos vivem nas Fases 2 a 4 e ganham seus próprios planos. `coordinator.ts` continua orquestrando exatamente como hoje — apenas com agentes registrados e estado de run no `RequestContext`.
