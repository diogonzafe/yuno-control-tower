import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MatchedRecommendation, type MatchedRecommendation as MatchedRecommendationType } from "@control-tower/contracts";
import type { Diagnosis } from "../diagnose/run.js";

type PlaybookDefinition = {
  playbookId: string;
  causalDimension: "provider" | "issuer" | "payment_method" | "merchant";
  title: string;
  owner: string;
  summary: string;
  declineFamily: string | null;
  humanApprovalRequired: true;
  actions: string[];
};

const PLAYBOOK_FILES = [
  "provider.yaml",
  "issuer.yaml",
  "method-country.yaml",
  "merchant.yaml",
] as const;

function loadPlaybook(fileName: string): PlaybookDefinition {
  const filePath = resolve(import.meta.dirname, "playbooks", fileName);
  return parse(readFileSync(filePath, "utf8")) as PlaybookDefinition;
}

const PLAYBOOKS = PLAYBOOK_FILES.map(loadPlaybook);

function normalizeDimension(dimension: Diagnosis["causalDimension"]): PlaybookDefinition["causalDimension"] {
  return dimension === "method" ? "payment_method" : dimension;
}

export function matchRecommendation(diagnosis: Diagnosis): MatchedRecommendationType | null {
  const dimension = normalizeDimension(diagnosis.causalDimension);
  const declineFamily = diagnosis.declineMix?.shifts.find((shift) => shift.code === diagnosis.declineMix?.dominantCode)?.family ?? null;
  const matched =
    PLAYBOOKS.find(
      (playbook) =>
        playbook.causalDimension === dimension &&
        (playbook.declineFamily === null || playbook.declineFamily === declineFamily),
    ) ??
    PLAYBOOKS.find((playbook) => playbook.causalDimension === dimension);

  if (!matched) {
    return null;
  }

  return MatchedRecommendation.parse({
    playbookId: matched.playbookId,
    owner: matched.owner,
    title: matched.title,
    summary: matched.summary,
    actions: matched.actions,
    humanApprovalRequired: true,
  });
}
