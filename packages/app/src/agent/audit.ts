import {
  InvestigationAuditStep,
  InvestigationAuditTrail,
  type InvestigationAuditStep as InvestigationAuditStepType,
  type InvestigationAuditTrail as InvestigationAuditTrailType,
} from "@control-tower/contracts";

export type InvestigationActor = "agent" | "fallback";

export interface InvestigationAuditStore {
  recordStep(step: InvestigationAuditStepType): Promise<void>;
  getTrail(): Promise<InvestigationAuditTrailType>;
}

export class InMemoryInvestigationAuditStore implements InvestigationAuditStore {
  private readonly steps: InvestigationAuditStepType[] = [];

  constructor(
    private readonly runId: string,
    private readonly actor: InvestigationActor,
  ) {}

  async recordStep(step: InvestigationAuditStepType): Promise<void> {
    const parsed = InvestigationAuditStep.parse(step);
    const index = this.steps.findIndex((entry) => entry.toolCallId === parsed.toolCallId);
    if (index >= 0) {
      this.steps[index] = parsed;
      return;
    }
    this.steps.push(parsed);
    this.steps.sort((left, right) => left.stepNo - right.stepNo);
  }

  async getTrail(): Promise<InvestigationAuditTrailType> {
    return InvestigationAuditTrail.parse({
      runId: this.runId,
      actor: this.actor,
      steps: this.steps,
    });
  }
}
