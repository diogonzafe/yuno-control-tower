import { describe, expect, test } from "vitest";
import { BR_CAUSAL, BR_ROOT, brCardGrid } from "./fixtures.js";
import { residualDeficit } from "./residual.js";

describe("residualDeficit", () => {
  test("reports the deficit in lost approvals when nothing is excluded", () => {
    const result = residualDeficit(brCardGrid(), BR_ROOT, 0.9, 3);

    expect(result.attempts).toBe(1100);
    expect(result.approved).toBe(790);
    expect(result.deficit).toBeCloseTo(200, 6);
    expect(result.state).toBe("MATERIAL_DROP");
  });

  test("clears the root once the causal cell is excluded", () => {
    const result = residualDeficit(brCardGrid(), BR_ROOT, 0.9, 3, [BR_CAUSAL]);

    expect(result.attempts).toBe(800);
    expect(result.approved).toBe(760);
    expect(result.deficit).toBe(0);
    expect(result.state).toBe("HEALTHY");
  });

  test("leaves the root material when a healthy sibling is excluded instead", () => {
    const healthySibling = { ...BR_CAUSAL, issuerId: "nubank" };

    const result = residualDeficit(brCardGrid(), BR_ROOT, 0.9, 3, [healthySibling]);

    expect(result.attempts).toBe(1000);
    expect(result.state).toBe("MATERIAL_DROP");
  });
});
