import {
  InvestigationAuditStep,
  InvestigationAuditTrail,
  type ConclusionTag,
  type InvestigationAuditStep as InvestigationAuditStepType,
  type InvestigationAuditTrail as InvestigationAuditTrailType,
  type InvestigationRequestV1,
  type InvestigationRunFailureCode,
} from "@control-tower/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { incidents, investigationRuns, investigationSteps } from "../db/schema.js";
import type { InvestigationActor, InvestigationAuditStore } from "./audit.js";

type Database = typeof db;

export type RunRecord = {
  runId: string;
  incidentId: string | null;
  actor: InvestigationActor;
  status: "running" | "completed" | "failed" | "timed_out" | "exhausted";
  modelId: string | null;
  promptVersion: string | null;
  requestSnapshot: InvestigationRequestV1;
  startedAt: string;
  completedAt: string | null;
  failureCode: string | null;
  conclusionTag: ConclusionTag | null;
  conclusionSummary: string | null;
  supportingStepNos: number[];
};

export type IncidentRecord = {
  incidentId: string;
  fingerprint: string;
  status: string;
  detectedAt: string;
  startedAt: string;
  narrativeOps: string | null;
  narrativeExec: string | null;
  playbookId: string | null;
};

export interface InvestigationRunRepository extends InvestigationAuditStore {
  createAuditStore(runId: string, actor: InvestigationActor): InvestigationAuditStore;
  createRun(input: {
    runId: string;
    actor: InvestigationActor;
    modelId: string | null;
    promptVersion: string;
    requestSnapshot: InvestigationRequestV1;
    startedAt: string;
  }): Promise<void>;
  completeRun(input: {
    runId: string;
    completedAt: string;
    conclusionTag: ConclusionTag;
    conclusionSummary: string;
    supportingStepNos: number[];
  }): Promise<void>;
  failRun(input: {
    runId: string;
    completedAt: string;
    status: "failed" | "timed_out" | "exhausted";
    failureCode: InvestigationRunFailureCode;
  }): Promise<void>;
  linkRunToIncident(runId: string, incidentId: string): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRunsByIncident(incidentId: string): Promise<RunRecord[]>;
  listSteps(runId: string): Promise<InvestigationAuditStepType[]>;
  listOrphanRuns(): Promise<RunRecord[]>;
  listIncidents(limit?: number): Promise<IncidentRecord[]>;
}

type RepositoryEvents = {
  onStep?: (step: InvestigationAuditStepType) => void;
  onRun?: (run: RunRecord) => void;
};

function toRunRecord(row: typeof investigationRuns.$inferSelect): RunRecord {
  return {
    runId: row.runId,
    incidentId: row.incidentId,
    actor: row.actor as InvestigationActor,
    status: row.status as RunRecord["status"],
    modelId: row.modelId,
    promptVersion: row.promptVersion,
    requestSnapshot: row.requestSnapshot as InvestigationRequestV1,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    conclusionTag: (row.conclusionTag as ConclusionTag | null) ?? null,
    conclusionSummary: row.conclusionSummary,
    supportingStepNos: row.supportingStepNos ?? [],
  };
}

function toStepRecord(row: typeof investigationSteps.$inferSelect): InvestigationAuditStepType {
  return InvestigationAuditStep.parse({
    stepNo: row.stepNo,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    toolArgs: row.toolArgs,
    toolResult: row.toolResult,
    status: row.status,
    errorCode: row.errorCode,
    decisionTag: row.decisionTag,
    decisionSummary: row.decisionSummary,
    hypothesis: row.hypothesis,
    evidenceStepNos: row.evidenceStepNos ?? [],
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
  });
}

export class InMemoryInvestigationRunRepository implements InvestigationRunRepository {
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, InvestigationAuditStepType[]>();
  private readonly incidentRows = new Map<string, IncidentRecord>();

  async createRun(input: {
    runId: string;
    actor: InvestigationActor;
    modelId: string | null;
    promptVersion: string;
    requestSnapshot: InvestigationRequestV1;
    startedAt: string;
  }): Promise<void> {
    this.runs.set(input.runId, {
      runId: input.runId,
      incidentId: null,
      actor: input.actor,
      status: "running",
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      requestSnapshot: input.requestSnapshot,
      startedAt: input.startedAt,
      completedAt: null,
      failureCode: null,
      conclusionTag: null,
      conclusionSummary: null,
      supportingStepNos: [],
    });
  }

  async recordStep(step: InvestigationAuditStepType): Promise<void> {
    const parsed = InvestigationAuditStep.parse(step);
    const runId = extractRunId(parsed.toolCallId);
    const current = this.steps.get(runId) ?? [];
    const index = current.findIndex((entry) => entry.toolCallId === parsed.toolCallId);
    if (index >= 0) current[index] = parsed;
    else current.push(parsed);
    current.sort((left, right) => left.stepNo - right.stepNo);
    this.steps.set(runId, current);
  }

  async getTrail(): Promise<InvestigationAuditTrailType> {
    throw new Error("Use createAuditStore(runId, actor) for run-scoped in-memory trails");
  }

  createAuditStore(runId: string, actor: InvestigationActor): InvestigationAuditStore {
    return {
      recordStep: (step) => this.recordStep(step),
      getTrail: async () =>
        InvestigationAuditTrail.parse({
          runId,
          actor,
          steps: this.steps.get(runId) ?? [],
        }),
    };
  }

  async completeRun(input: {
    runId: string;
    completedAt: string;
    conclusionTag: ConclusionTag;
    conclusionSummary: string;
    supportingStepNos: number[];
  }): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) return;
    this.runs.set(input.runId, {
      ...run,
      status: "completed",
      completedAt: input.completedAt,
      conclusionTag: input.conclusionTag,
      conclusionSummary: input.conclusionSummary,
      supportingStepNos: input.supportingStepNos,
    });
  }

  async failRun(input: {
    runId: string;
    completedAt: string;
    status: "failed" | "timed_out" | "exhausted";
    failureCode: InvestigationRunFailureCode;
  }): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) return;
    this.runs.set(input.runId, {
      ...run,
      status: input.status,
      completedAt: input.completedAt,
      failureCode: input.failureCode,
    });
  }

  async linkRunToIncident(runId: string, incidentId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.set(runId, { ...run, incidentId });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRunsByIncident(incidentId: string): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((run) => run.incidentId === incidentId);
  }

  async listSteps(runId: string): Promise<InvestigationAuditStepType[]> {
    return this.steps.get(runId) ?? [];
  }

  async listOrphanRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((run) => run.status === "running");
  }

  // Test-double seeding, deliberately absent from InvestigationRunRepository:
  // the real incident writer lives in orchestrate/incidents.ts, and this exists
  // only so API route tests can populate listIncidents without a database.
  seedIncident(record: IncidentRecord): void {
    this.incidentRows.set(record.incidentId, record);
  }

  async listIncidents(limit = 50): Promise<IncidentRecord[]> {
    return [...this.incidentRows.values()]
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt))
      .slice(0, limit);
  }
}

export class PostgresInvestigationRunRepository implements InvestigationRunRepository {
  constructor(
    private readonly database: Database = db,
    private readonly events: RepositoryEvents = {},
  ) {}

  async createRun(input: {
    runId: string;
    actor: InvestigationActor;
    modelId: string | null;
    promptVersion: string;
    requestSnapshot: InvestigationRequestV1;
    startedAt: string;
  }): Promise<void> {
    await this.database.insert(investigationRuns).values({
      runId: input.runId,
      incidentId: null,
      actor: input.actor,
      status: "running",
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      requestSnapshot: input.requestSnapshot,
      startedAt: new Date(input.startedAt),
      completedAt: null,
      failureCode: null,
      conclusionTag: null,
      conclusionSummary: null,
      supportingStepNos: [],
    });
    const created = await this.getRun(input.runId);
    if (created) this.events.onRun?.(created);
  }

  async recordStep(step: InvestigationAuditStepType): Promise<void> {
    const parsed = InvestigationAuditStep.parse(step);
    await this.database
      .insert(investigationSteps)
      .values({
        runId: extractRunId(parsed.toolCallId),
        stepNo: parsed.stepNo,
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        toolArgs: parsed.toolArgs,
        toolResult: parsed.toolResult,
        status: parsed.status,
        errorCode: parsed.errorCode,
        decisionTag: parsed.decisionTag,
        decisionSummary: parsed.decisionSummary,
        hypothesis: parsed.hypothesis,
        evidenceStepNos: parsed.evidenceStepNos,
        createdAt: new Date(parsed.createdAt),
        completedAt: new Date(parsed.completedAt),
      })
      .onConflictDoUpdate({
        target: investigationSteps.toolCallId,
        set: {
          toolResult: parsed.toolResult,
          status: parsed.status,
          errorCode: parsed.errorCode,
          decisionTag: parsed.decisionTag,
          decisionSummary: parsed.decisionSummary,
          hypothesis: parsed.hypothesis,
          evidenceStepNos: parsed.evidenceStepNos,
          completedAt: new Date(parsed.completedAt),
        },
      });
    this.events.onStep?.(parsed);
  }

  async getTrail(runId?: string, actor?: InvestigationActor): Promise<InvestigationAuditTrailType> {
    if (!runId || !actor) {
      throw new Error("PostgresInvestigationRunRepository.getTrail requires a scoped audit store");
    }
    return InvestigationAuditTrail.parse({
      runId,
      actor,
      steps: await this.listSteps(runId),
    });
  }

  createAuditStore(runId: string, actor: InvestigationActor): InvestigationAuditStore {
    return {
      recordStep: (step) => this.recordStep(step),
      getTrail: () => this.getTrail(runId, actor),
    };
  }

  async completeRun(input: {
    runId: string;
    completedAt: string;
    conclusionTag: ConclusionTag;
    conclusionSummary: string;
    supportingStepNos: number[];
  }): Promise<void> {
    await this.database
      .update(investigationRuns)
      .set({
        status: "completed",
        completedAt: new Date(input.completedAt),
        conclusionTag: input.conclusionTag,
        conclusionSummary: input.conclusionSummary,
        supportingStepNos: input.supportingStepNos,
      })
      .where(eq(investigationRuns.runId, input.runId));
    const updated = await this.getRun(input.runId);
    if (updated) this.events.onRun?.(updated);
  }

  async failRun(input: {
    runId: string;
    completedAt: string;
    status: "failed" | "timed_out" | "exhausted";
    failureCode: InvestigationRunFailureCode;
  }): Promise<void> {
    await this.database
      .update(investigationRuns)
      .set({
        status: input.status,
        completedAt: new Date(input.completedAt),
        failureCode: input.failureCode,
      })
      .where(eq(investigationRuns.runId, input.runId));
    const updated = await this.getRun(input.runId);
    if (updated) this.events.onRun?.(updated);
  }

  async linkRunToIncident(runId: string, incidentId: string): Promise<void> {
    await this.database
      .update(investigationRuns)
      .set({ incidentId })
      .where(eq(investigationRuns.runId, runId));
    const updated = await this.getRun(runId);
    if (updated) this.events.onRun?.(updated);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const [row] = await this.database
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.runId, runId));
    return row ? toRunRecord(row) : null;
  }

  async listRunsByIncident(incidentId: string): Promise<RunRecord[]> {
    const rows = await this.database
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.incidentId, incidentId))
      .orderBy(desc(investigationRuns.startedAt));
    return rows.map(toRunRecord);
  }

  async listSteps(runId: string): Promise<InvestigationAuditStepType[]> {
    const rows = await this.database
      .select()
      .from(investigationSteps)
      .where(eq(investigationSteps.runId, runId))
      .orderBy(investigationSteps.stepNo);
    return rows.map(toStepRecord);
  }

  async listOrphanRuns(): Promise<RunRecord[]> {
    const rows = await this.database
      .select()
      .from(investigationRuns)
      .where(and(eq(investigationRuns.actor, "agent"), eq(investigationRuns.status, "running")));
    return rows.map(toRunRecord);
  }

  async listIncidents(limit = 50): Promise<IncidentRecord[]> {
    const rows = await this.database
      .select()
      .from(incidents)
      .where(isNull(incidents.resolvedAt))
      .orderBy(desc(incidents.detectedAt))
      .limit(limit);
    return rows.map((row) => ({
      incidentId: row.incidentId,
      fingerprint: row.fingerprint,
      status: row.status,
      detectedAt: row.detectedAt.toISOString(),
      startedAt: row.startedAt.toISOString(),
      narrativeOps: row.narrativeOps,
      narrativeExec: row.narrativeExec,
      playbookId: row.playbookId,
    }));
  }
}

function extractRunId(toolCallId: string): string {
  const [runId] = toolCallId.split(":");
  if (!runId) {
    throw new Error(`Invalid toolCallId: ${toolCallId}`);
  }
  return runId;
}
