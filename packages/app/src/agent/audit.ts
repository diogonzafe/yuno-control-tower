import {
  InvestigationAuditStepV0,
  InvestigationAuditTrailV0,
  type InvestigationAuditStepV0 as InvestigationAuditStepV0Type,
  type InvestigationAuditTrailV0 as InvestigationAuditTrailV0Type,
} from "@control-tower/contracts";

export interface InvestigationAuditStore {
  recordStep(step: InvestigationAuditStepV0Type): Promise<void>;
  getTrail(): Promise<InvestigationAuditTrailV0Type>;
}

export class InMemoryInvestigationAuditStore implements InvestigationAuditStore {
  private readonly steps: InvestigationAuditStepV0Type[] = [];

  constructor(
    private readonly runId: string,
    private readonly actor: "agent" | "fallback",
  ) {}

  async recordStep(step: InvestigationAuditStepV0Type): Promise<void> {
    this.steps.push(InvestigationAuditStepV0.parse(step));
  }

  async getTrail(): Promise<InvestigationAuditTrailV0Type> {
    return InvestigationAuditTrailV0.parse({
      runId: this.runId,
      actor: this.actor,
      steps: this.steps,
    });
  }
}
