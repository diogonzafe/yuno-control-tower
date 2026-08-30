import assert from "node:assert/strict";
import test from "node:test";

import { buildTransactionCells, defaultGeneratorCatalog } from "./catalog.ts";

const testTrafficWeights = { "merchant-a": 3, "merchant-b": 2, "merchant-c": 1 };

test("default catalog produces the 90 valid DD13 cells", () => {
  const cells = buildTransactionCells(defaultGeneratorCatalog, testTrafficWeights);

  assert.equal(cells.length, 90);
  assert.equal(cells.filter((cell) => cell.paymentMethod === "CARD").length, 81);
  assert.equal(cells.filter((cell) => cell.paymentMethod === "PIX").length, 9);
  assert.equal(cells.filter((cell) => cell.merchantId === "merchant-a").length, 30);
  assert.ok(cells.every((cell) => cell.paymentMethod !== "PIX" || (
    cell.country === "BR" && cell.issuerId === "NA"
  )));
  assert.ok(cells.some((cell) => cell.country === "MX" && cell.paymentMethod === "CARD"
    && cell.baselineConversion < 0.92));
  const merchantCells = cells.filter((cell) => cell.merchantId === "merchant-a");
  const weightedBaseline = merchantCells.reduce((total, cell) => total + cell.baselineConversion * cell.trafficWeight, 0);
  const merchantTrafficWeight = merchantCells.reduce((total, cell) => total + cell.trafficWeight, 0);
  assert.ok(Math.abs(weightedBaseline / merchantTrafficWeight - 0.92) < 1e-12);
});
