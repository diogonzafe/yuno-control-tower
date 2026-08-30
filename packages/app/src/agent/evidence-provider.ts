import {
  type InvestigationRequestV0,
  ProvisionalEvidenceObjectV0,
  type ProvisionalEvidenceObjectV0 as ProvisionalEvidenceObjectV0Type,
} from "@control-tower/contracts";
import { defaultMockScenario, type MockScenario } from "./fixtures.js";

export interface EvidenceProvider {
  getEvidence(input: InvestigationRequestV0): Promise<ProvisionalEvidenceObjectV0Type>;
}

export class MockEvidenceProvider implements EvidenceProvider {
  constructor(private readonly scenario: MockScenario = defaultMockScenario) {}

  async getEvidence(input: InvestigationRequestV0): Promise<ProvisionalEvidenceObjectV0Type> {
    if (input.incident.incidentId !== this.scenario.request.incident.incidentId) {
      throw new Error(`No mock evidence registered for incident ${input.incident.incidentId}`);
    }

    return ProvisionalEvidenceObjectV0.parse(this.scenario.evidence);
  }
}
