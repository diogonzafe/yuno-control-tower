import { z } from "zod";
import { EvidenceObject } from "./incident.js";
import { MatchedRecommendation } from "./investigation.js";

export const NarrationInput = z.object({
  evidence: EvidenceObject,
  recommendation: MatchedRecommendation.nullable(),
});
export type NarrationInput = z.infer<typeof NarrationInput>;
