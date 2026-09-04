import { expect, test } from "@playwright/test";
import {
  cellsOnScreen,
  incidentCards,
  injectFault,
  listInjections,
  removeNewInjections,
  waitForConsole,
  waitForFeed,
} from "./helpers";

/**
 * The slow half of the suite: it injects real faults into the deployment and
 * waits for the pipeline to confirm them.
 *
 * These tests change what the dashboard shows while they run, and they take
 * minutes rather than seconds — the detector needs 3 persisted windows before a
 * drop becomes a signal at all. Run them deliberately:
 *
 *   npx playwright test --project=scenarios
 */

// A severe drop confirms in a couple of windows; a moderate one on a thinner
// cell can take several more, and the orchestrator tick is on top of that.
const DETECTION_BUDGET_MS = 6 * 60 * 1000;

test.describe.configure({ mode: "serial" });

test.describe("acceptance scenarios", () => {
  let preExisting: string[] = [];

  test.beforeEach(async ({ request }) => {
    preExisting = (await listInjections(request)).map((injection) => injection.id);
  });

  test.afterEach(async ({ request }) => {
    await removeNewInjections(request, preExisting);
  });

  // spec.md §4 criterion 5 and the mandatory minimum case: two causes at once
  // under one merchant, separated and ranked rather than collapsed into the
  // CARD slice they share.
  test("separates and ranks two simultaneous causes", async ({ page, request }) => {
    const stamp = Date.now();
    const root = { merchantId: "BR_STORE_01", country: "BR", paymentMethod: "CARD" };

    await injectFault(request, {
      id: `e2e-dual-severe-${stamp}`,
      dimensions: { ...root, providerId: "stripe", issuerId: "itau" },
      conversionMultiplier: 0.15,
      declineWeights: { "05": 2 },
    });
    await injectFault(request, {
      id: `e2e-dual-moderate-${stamp}`,
      dimensions: { ...root, providerId: "adyen", issuerId: "nubank" },
      conversionMultiplier: 0.35,
      declineWeights: { "05": 2 },
    });

    await waitForConsole(
      page,
      async (current) => (await incidentCards(current).count()) >= 2,
      { timeoutMs: DETECTION_BUDGET_MS, label: "two confirmed incidents on the dashboard" },
    );

    const cells = await cellsOnScreen(page);
    expect(new Set(cells).size).toBe(cells.length);

    // Ordered by cost per minute, so the severe cause is the one an operator
    // reads first (incident-feed.tsx sorts on it).
    const costs = await page.locator(".ct-incident__cost strong").allInnerTexts();
    const numeric = costs.map((cost) => Number(cost.replace(/[^0-9.]/g, "")));
    expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
  });

  /**
   * The regression that this whole branch exists for, measured the way it
   * actually failed: not "does an incident appear" but "does it stay the same
   * incident while the fault stands still".
   *
   * Before identity became containment of the cell, one continuous 44-minute
   * fault produced seven incidents — each opened as the re-estimated key churned
   * (the dominant decline code by decline-mix.ts's Wilson bound, the causal cell
   * by parsimony.ts's 2% band) and each resolved three quiet windows later.
   */
  test("one continuous fault stays one incident", async ({ page, request }) => {
    const stamp = Date.now();
    await injectFault(request, {
      id: `e2e-stability-${stamp}`,
      dimensions: {
        merchantId: "BR_STORE_02",
        country: "BR",
        paymentMethod: "CARD",
        providerId: "stripe",
        issuerId: "itau",
      },
      conversionMultiplier: 0.15,
      declineWeights: { "05": 2 },
    });

    await waitForConsole(
      page,
      async (current) => (await incidentCards(current).count()) >= 1,
      { timeoutMs: DETECTION_BUDGET_MS, label: "the injected fault to be confirmed" },
    );

    // Watch the identity, not the count. A card silently replaced by a fresh
    // incident for the same cell keeps the count at one, and that replacement is
    // precisely the bug — which is why the card carries its incidentId.
    const identities = new Set<string>();
    const cells = new Set<string>();

    for (let minute = 0; minute < 8; minute++) {
      const cards = page.locator('.ct-incident[data-incident-id]', { hasText: "BR_STORE_02" });
      for (let index = 0; index < (await cards.count()); index++) {
        identities.add((await cards.nth(index).getAttribute("data-incident-id"))!);
      }
      for (const cell of await cellsOnScreen(page)) {
        if (cell.includes("BR_STORE_02")) cells.add(cell);
      }

      await page.waitForTimeout(60_000);
      await page.goto("/");
      await waitForFeed(page);
    }

    // Eight minutes of one unchanging fault: one place, and one incident for it
    // from the first window to the last.
    expect([...cells]).toHaveLength(1);
    expect(
      [...identities],
      `the same cell was reported under ${identities.size} different incidents`,
    ).toHaveLength(1);
  });

  // spec.md §4 criterion 6, the trial by fire: a combination nobody rehearsed,
  // injected through the console the way a juror would, has to be detected and
  // diagnosed like any other.
  test("detects an unrehearsed combination injected from the console", async ({ page }) => {
    await page.goto("/console");
    await expect(page.locator(".ct-history__head h1")).toHaveText("Jury console");

    await page.locator(".ct-field", { hasText: "1 · Country" }).locator("select").selectOption("MX");
    await page.locator(".ct-field", { hasText: "2 · Method" }).locator("select").selectOption("CARD");
    await page.locator(".ct-field", { hasText: "3 · Provider" }).locator("select").selectOption("dlocal");
    await page.getByRole("button", { name: "Inject drop now" }).click();
    await expect(page.locator(".ct-toast")).toContainText("Incident injected");

    await waitForConsole(
      page,
      async (current) => {
        for (const cell of await cellsOnScreen(current)) {
          if (cell.includes("providerId=dlocal")) return true;
        }
        return false;
      },
      { timeoutMs: DETECTION_BUDGET_MS, label: "the unrehearsed MX x dlocal drop to be diagnosed" },
    );

    // Diagnosed, not merely detected: the panel has to carry the evidence.
    await page.locator(".ct-incident", { hasText: "providerId=dlocal" }).first().click();
    await expect(page.locator(".ct-aside--right .ct-wilson-track")).toBeVisible();
    await expect(page.locator(".ct-aside--right .ct-playbook")).toContainText("Recommended action");
  });

  // spec.md §4 criterion 1: with nothing injected, the system says so instead of
  // finding something to report.
  test("stays silent once every injected fault is cleared", async ({ page, request }) => {
    await removeNewInjections(request, preExisting);

    await waitForConsole(
      page,
      async (current) => (await incidentCards(current).count()) === 0,
      // Three quiet windows to resolve, plus the tick that notices.
      { timeoutMs: 8 * 60 * 1000, label: "the board to clear after the faults stopped" },
    );

    await expect(page.locator(".ct-silence")).toContainText("that is the expected outcome");
  });
});
