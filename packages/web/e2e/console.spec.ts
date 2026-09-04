import { expect, test } from "@playwright/test";
import {
  activeCountInHeader,
  cellsOnScreen,
  incidentCards,
  pendingCards,
  waitForFeed,
} from "./helpers";

test.describe("live console", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForFeed(page);
  });

  test("holds the incident stream open", async ({ page }) => {
    await expect(page.locator(".ct-health")).toContainText("Monitoring");
    await expect(page.locator(".ct-stream-error")).toHaveCount(0);
  });

  // spec.md §4 criterion 1, and the ce531f3 regression from the other side: the
  // topbar counts what the lifecycle calls active, and the feed renders it. A
  // `monitoring` incident dropping out of one but not the other is what made an
  // ongoing incident vanish from the live view precisely because it persisted.
  test("the header count, the feed count and the cards all agree", async ({ page }) => {
    const cards = await incidentCards(page).count();
    expect(await activeCountInHeader(page)).toBe(cards);
    await expect(page.locator(".ct-incidents__count")).toHaveText(`${cards} open`);
  });

  /**
   * The regression this suite exists for.
   *
   * Incident identity is containment of the cell (orchestrate/cell.ts), so two
   * live incidents can never describe the same place. When identity was an exact
   * fingerprint, one 44-minute fault put seven cards through this feed — each a
   * fresh incident for the same cell, opened as the re-estimated key churned.
   */
  test("no two live incidents describe the same cell", async ({ page }) => {
    const cells = await cellsOnScreen(page);
    expect(new Set(cells).size, `duplicate cells on screen: ${cells.join(" ; ")}`).toBe(cells.length);
  });

  // Silence is a claim the system makes deliberately (spec.md §4 criterion 1),
  // not the absence of one, so it must be on screen exactly when nothing is.
  test("says nothing is wrong, or shows what is — never both, never neither", async ({ page }) => {
    const silence = await page.locator(".ct-silence").count();
    const cards = (await incidentCards(page).count()) + (await pendingCards(page).count());
    expect(silence === 1 ? cards === 0 : cards > 0).toBe(true);
  });

  test("opens the evidence column when an incident is selected", async ({ page }) => {
    const cards = incidentCards(page);
    test.skip((await cards.count()) === 0, "no live incident to drill into right now");

    await expect(page.locator(".ct-shell--split")).toHaveCount(0);
    await cards.first().click();

    // split-shell.tsx keeps these two on one condition: the column that opens
    // and the panel that fills it.
    await expect(page.locator(".ct-shell--split")).toHaveCount(1);
    await expect(page.locator(".ct-aside--right h2")).toBeVisible();
  });

  test("a pending signal is watched, not alerted", async ({ page }) => {
    const pending = pendingCards(page);
    test.skip((await pending.count()) === 0, "no signal building persistence right now");

    const first = pending.first();
    await expect(first.locator(".ct-badge--pending")).toHaveText("Watching");
    // No incidentId behind it, so there is nothing to select or drill into.
    await expect(first.locator(".ct-incident__cta")).toHaveCount(0);
    await expect(first.locator(".ct-pending-progress")).toContainText("windows");
  });
});
