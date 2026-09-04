import { describe, expect, test } from "vitest";
import { BR_CAUSAL, BR_ROOT, BUCKET, DECLINE_CATALOG, declineRow, minutesBefore } from "./fixtures.js";
import { declineMixShift, disambiguateOutage } from "./decline-mix.js";
import type { DeclineRollupRow } from "./types.js";

const pixCell = { merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX" } as const;

describe("declineMixShift", () => {
  test("reports the shift of a code against its catalogue baseline", () => {
    const declines = [
      declineRow({ declineCode: "05", count: 78 }),
      declineRow({ declineCode: "51", count: 20 }),
      declineRow({ declineCode: "91", count: 2 }),
    ];

    const mix = declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG);

    expect(mix.totalDeclines).toBe(100);
    expect(mix.windowUsed).toBe(1);
    expect(mix.referenceSource).toBe("catalog");
    expect(mix.dominantCode).toBe("05");
    expect(mix.shifts[0]).toMatchObject({ code: "05", observedShare: 0.78, referenceShare: 0.32 });
    expect(mix.shifts[0]!.deltaPp).toBeCloseTo(46, 6);
  });

  test("widens the window when one minute carries too few declines to read", () => {
    const declines: DeclineRollupRow[] = [0, 1, 2, 3, 4].flatMap((back) => [
      declineRow({ bucket: minutesBefore(BUCKET, back), paymentMethod: "PIX", issuerId: "NA", declineCode: "AM05", count: 3 }),
      declineRow({ bucket: minutesBefore(BUCKET, back), paymentMethod: "PIX", issuerId: "NA", declineCode: "AB03", count: 2 }),
    ]);

    const mix = declineMixShift(declines, pixCell, BUCKET, DECLINE_CATALOG);

    expect(mix.windowUsed).toBe(5);
    expect(mix.totalDeclines).toBe(25);
    expect(mix.dominantCode).toBe("AB03");
  });

  // The dominant code keys the incident fingerprint (evidence.ts), so whichever
  // code wins has to be stable across windows for one ongoing fault. Ranking by
  // how far a code rose above its own baseline is not: a rare code doubling from
  // 2% to 10% "rose the most" while explaining a tenth of the failures, and
  // which rare code does that flips on sampling noise alone. One injected fault
  // produced #01, #62, #65 and #91 this way, opening a new incident each time.
  test("ignores a rare code that rose sharply but explains almost nothing", () => {
    const declines = [
      declineRow({ declineCode: "51", count: 11 }), // 55%, not diagnostic
      declineRow({ declineCode: "05", count: 7 }), //  35% against a 32% baseline — barely moved
      declineRow({ declineCode: "91", count: 2 }), //  10% against a 2% baseline — the old winner
    ];

    expect(declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG).dominantCode).toBeNull();
  });

  test("names the code that carries the failures once its rise is supported", () => {
    const declines = [
      declineRow({ declineCode: "05", count: 60 }),
      declineRow({ declineCode: "51", count: 20 }),
    ];

    expect(declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG).dominantCode).toBe("05");
  });

  test("names no dominant code when only non-diagnostic noise moved", () => {
    const declines = [
      declineRow({ declineCode: "51", count: 90 }),
      declineRow({ declineCode: "05", count: 10 }),
    ];

    expect(declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG).dominantCode).toBeNull();
  });
});

describe("disambiguateOutage", () => {
  test("blames the provider when 91 spans issuers inside one provider", () => {
    const declines = ["itau", "nubank", "bradesco"].map((issuerId) =>
      declineRow({ declineCode: "91", issuerId, count: 30 }),
    );

    expect(disambiguateOutage(declines, BR_ROOT, "91")).toBe("PROVIDER");
  });

  test("blames the issuer when 91 spans providers inside one issuer", () => {
    const declines = ["stripe", "adyen", "mercado_pago"].map((providerId) =>
      declineRow({ declineCode: "91", providerId, count: 30 }),
    );

    expect(disambiguateOutage(declines, BR_ROOT, "91")).toBe("ISSUER");
  });

  test("blames the rail when AB03 is spread across every PIX provider", () => {
    const declines = ["stripe", "adyen", "mercado_pago"].map((providerId) =>
      declineRow({ declineCode: "AB03", providerId, paymentMethod: "PIX", issuerId: "NA", count: 30 }),
    );

    expect(disambiguateOutage(declines, BR_ROOT, "AB03")).toBe("RAIL");
  });

  test("stays inconclusive when the code sits in a single provider and issuer", () => {
    expect(disambiguateOutage([declineRow({ declineCode: "91", count: 30 })], BR_ROOT, "91")).toBe(
      "INCONCLUSIVE",
    );
  });
});

describe("declineMixShift reference", () => {
  test("prefers the cell's own mixture once its history carries enough declines", () => {
    // 120 historical declines split evenly, so this cell normally runs 05 at
    // 50%, well above the catalogue's 32%.
    const history = [
      declineRow({ declineCode: "05", count: 60 }),
      declineRow({ declineCode: "51", count: 60 }),
    ];
    const declines = [
      declineRow({ declineCode: "05", count: 90 }),
      declineRow({ declineCode: "51", count: 10 }),
    ];

    const mix = declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG, history);

    expect(mix.referenceSource).toBe("temporal");
    expect(mix.shifts[0]).toMatchObject({ code: "05", referenceShare: 0.5 });
    expect(mix.shifts[0]!.deltaPp).toBeCloseTo(40, 6);
  });

  test("keeps the catalogue baseline when the cell's history is too thin", () => {
    const history = [declineRow({ declineCode: "05", count: 10 })];
    const declines = [declineRow({ declineCode: "05", count: 90 }), declineRow({ declineCode: "51", count: 10 })];

    const mix = declineMixShift(declines, BR_CAUSAL, BUCKET, DECLINE_CATALOG, history);

    expect(mix.referenceSource).toBe("catalog");
    expect(mix.shifts[0]).toMatchObject({ code: "05", referenceShare: 0.32 });
  });
});
