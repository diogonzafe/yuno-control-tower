import type { EvidenceObject } from "@control-tower/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAgentCoordinator } from "./coordinator.js";
import { InMemoryInvestigationRunRepository } from "./persistence.js";
import {
  BR_CAUSAL,
  BR_ROOT,
  BUCKET,
  DECLINE_CATALOG,
  DIAGNOSE_MERCHANTS,
  brCardGrid,
  confirmedDrop,
} from "../diagnose/fixtures.js";
import type { RoutingCoverage } from "../detect/types.js";

const COVERAGE: RoutingCoverage = ["stripe", "adyen", "mercado_pago"].map((providerId) => ({
  providerId,
  country: "BR",
  paymentMethod: "CARD",
}));

const INCIDENT_ID = "11111111-2222-3333-4444-555555555555";
const FINGERPRINT = "country=BR|merchantId=BR_STORE_01|providerId=adyen#91";

function deps(overrides: Partial<Parameters<typeof createAgentCoordinator>[0]> = {}) {
  const evidence: EvidenceObject[] = [];
  const attached: Array<{ incidentId: string; playbookId: string | null }> = [];
  const repository = new InMemoryInvestigationRunRepository();
  const rows = brCardGrid();

  return {
    evidence,
    attached,
    repository,
    built: {
      source: {
        getWindowRollups: async () => rows,
        getHistory: async () => rows,
      },
      declineSource: { getHistory: async () => [] },
      loadMerchants: async () => DIAGNOSE_MERCHANTS,
      loadCoverage: async () => COVERAGE,
      loadDeclineCatalog: async () => DECLINE_CATALOG,
      repository,
      incidentWriter: {
        async openOrUpdate() {
          return { incidentId: INCIDENT_ID, status: "open" as const };
        },
        async attachNarrative(input: { incidentId: string; playbookId: string | null }) {
          attached.push(input);
        },
      },
      config: {
        investigatorModel: "openai/gpt-5.4",
        narratorModel: "openai/gpt-5.4",
        narratorFallbackModel: "openai/gpt-5.4",
        maxToolCalls: 12,
        // Short on purpose: with no API key the investigator would otherwise sit
        // on a network call. This drives the timeout -> fallback path, which is
        // the one boundary #3 exists to guarantee.
        timeoutMs: 50,
        fallbackEnabled: true,
      },
      onEvidence: (item: EvidenceObject) => { evidence.push(item); },
      memory: { async recallByFingerprint() { return []; } },
      ...overrides,
    } as Parameters<typeof createAgentCoordinator>[0],
  };
}

// rules.md §3 boundary #3: "Every agentic path has a deterministic fallback."
// Without an API key every investigator run fails, which is exactly the path
// these tests exercise — the demo has to survive it.
describe("createAgentCoordinator fallback (rules.md §3 boundary #3)", () => {
  it("still produces evidence when the investigator cannot run at all", async () => {
    const { built, evidence } = deps();
    const coordinator = createAgentCoordinator(built);

    await coordinator.handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.diagnosisSource).toBe("beam_search");
    // The fallback drilled past the merchant×country root instead of just
    // echoing the signal back — that is the whole point of the beam search.
    expect(evidence[0]?.dimensions.merchantId).toBe(BR_CAUSAL.merchantId);
    expect(evidence[0]?.dimensions.providerId).toBe(BR_CAUSAL.providerId);
    // The fallback still carries a trail, so the UI can show what was tried
    // even when the agent never got off the ground.
    expect(Array.isArray(evidence[0]?.investigationTrail)).toBe(true);
  });

  it("carries the cost figures the executive narrative needs", async () => {
    const { built, evidence } = deps();

    await createAgentCoordinator(built).handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    expect(evidence[0]?.costUsdPerMin).toBeGreaterThan(0);
    expect(evidence[0]?.lostApprovals).toBeGreaterThan(0);
  });

  it("enriches the incident the tick already opened instead of creating one", async () => {
    const { built, attached } = deps();

    await createAgentCoordinator(built).handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    expect(attached).toHaveLength(1);
    expect(attached[0]?.incidentId).toBe(INCIDENT_ID);
  });

  it("investigates an incident once, not on every window that re-confirms it", async () => {
    const { built, evidence } = deps();
    const coordinator = createAgentCoordinator(built);
    const signal = confirmedDrop(BR_ROOT);

    // The detector re-emits a live incident every tick by design, and
    // openOrUpdate hands back the same incident id each time; a fresh agent run
    // per tick would be unbounded LLM spend during the demo.
    const input = { signal, incidentId: INCIDENT_ID, fingerprint: FINGERPRINT };
    await coordinator.handleSignal(input);
    await coordinator.handleSignal(input);
    await coordinator.handleSignal(input);

    expect(evidence).toHaveLength(1);
  });

  // Two full fallback runs, each waiting out the investigator timeout.
  it("investigates again when the tick hands it a new incident id", { timeout: 20_000 }, async () => {
    const { built, evidence } = deps();
    const coordinator = createAgentCoordinator(built);

    await coordinator.handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });
    // A later onset resolves the first incident and opens a second, so the tick
    // hands the coordinator a fresh id — which is what makes it investigate again.
    await coordinator.handleSignal({
      signal: { ...confirmedDrop(BR_ROOT), startedAt: "2026-08-30T18:00:00.000Z" },
      incidentId: "99999999-8888-7777-6666-555555555555",
      fingerprint: FINGERPRINT,
    });

    expect(evidence).toHaveLength(2);
  });

  it("does not let a repository failure escape into the scheduler tick", async () => {
    const { built } = deps({
      repository: {
        ...new InMemoryInvestigationRunRepository(),
        createRun: vi.fn().mockRejectedValue(new Error("database is gone")),
      } as unknown as Parameters<typeof createAgentCoordinator>[0]["repository"],
    });

    // run.ts only .catch()es this promise; a rejection here is logged, never
    // allowed to take the detector down with it.
    await expect(
      createAgentCoordinator(built).handleSignal({
        signal: confirmedDrop(BR_ROOT),
        incidentId: INCIDENT_ID,
        fingerprint: FINGERPRINT,
      }),
    ).rejects.toThrow();
  });
});

describe("createAgentCoordinator memory recall (spec.md §5 bonus)", () => {
  it("passes recalled incidents to the investigator", async () => {
    const recalled = [
      {
        incidentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#91",
        rootCauseDimension: "provider" as const,
        dominantDecline: "91",
        summary: "Same cell was down from 1970-01-01T00:07:00.000Z until 1970-01-01T00:47:00.000Z.",
      },
    ];
    const { built, repository } = deps({
      memory: {
        async recallByFingerprint() {
          return recalled;
        },
      },
    });

    await createAgentCoordinator(built).handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    // Every run for this incident carries the request snapshot the investigator
    // was given, so the history reached the prompt rather than being dropped.
    const runs = await repository.listRunsByIncident(INCIDENT_ID);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.requestSnapshot.context.similarIncidents).toEqual(recalled);
  });

  it("investigates anyway when the memory lookup fails", async () => {
    // Memory is never on the critical path: a repeat incident is a bonus
    // (spec.md §5), not a precondition for diagnosing the live one.
    const memoryError = new Error("memory unavailable");
    const onMemoryError = vi.fn();
    const { built, evidence } = deps({
      memory: {
        async recallByFingerprint() {
          throw memoryError;
        },
      },
      onMemoryError,
    });

    await createAgentCoordinator(built).handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    expect(evidence).toHaveLength(1);
    expect(onMemoryError).toHaveBeenCalledWith(memoryError);
  });
});

describe("createAgentCoordinator evidence assembly (rules.md §3 consequence)", () => {
  it("uses buildEvidence for the fallback path, never a second assembler", async () => {
    const { built, evidence } = deps();

    await createAgentCoordinator(built).handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    // Shape check: every field buildEvidence is responsible for is present, so
    // a divergent assembly path inside agent/ would fail here.
    const item = evidence[0]!;
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining([
        "fingerprint", "dimensions", "observedRate", "expectedRate", "ci",
        "startedAt", "declineMix", "suppressedEchoes", "costUsdPerMin",
        "diagnosisSource", "investigationTrail",
      ]),
    );
    expect(item.windowBucket).toBe(BUCKET);
  });
});

// The kill switch, for an operator watching the fallback itself misbehave.
// Default-on is the shipped behaviour, and every test above depends on it.
describe("createAgentCoordinator with the fallback disabled", () => {
  it("records the failed agent run and never starts a beam search", async () => {
    const { built, evidence, attached, repository } = deps();
    const createRun = vi.spyOn(repository, "createRun");
    const onFallbackSkipped = vi.fn();
    const coordinator = createAgentCoordinator({
      ...built,
      config: { ...built.config, fallbackEnabled: false },
      onFallbackSkipped,
    });

    await coordinator.handleSignal({
      signal: confirmedDrop(BR_ROOT),
      incidentId: INCIDENT_ID,
      fingerprint: FINGERPRINT,
    });

    // No deterministic diagnosis: no evidence, no narrative. The incident keeps
    // only what orchestrate/incidents.ts already wrote at tick time.
    expect(evidence).toHaveLength(0);
    expect(attached).toHaveLength(0);

    // Exactly one run, the agent's — a second one with actor "fallback" is the
    // thing the flag turns off.
    expect(createRun).toHaveBeenCalledTimes(1);
    const { runId, actor } = createRun.mock.calls[0]![0];
    expect(actor).toBe("agent");
    const run = await repository.getRun(runId);
    expect(run?.status).toBe("timed_out");
    expect(run?.failureCode).toBe("TIMEOUT");

    // A skipped fallback must not be silent: run.ts turns this into a warning.
    expect(onFallbackSkipped).toHaveBeenCalledWith({ incidentId: INCIDENT_ID, runId });
  });
});
