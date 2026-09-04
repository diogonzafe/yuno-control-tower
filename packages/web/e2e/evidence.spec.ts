import { expect, test, type Page } from "@playwright/test";
import { incidentCards, waitForFeed } from "./helpers";

async function openFirstIncident(page: Page): Promise<boolean> {
  await page.goto("/");
  await waitForFeed(page);
  const cards = incidentCards(page);
  if ((await cards.count()) === 0) return false;
  await cards.first().click();
  await expect(page.locator(".ct-aside--right")).toBeVisible();
  return true;
}

test.describe("evidence panel", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await openFirstIncident(page)), "no live incident to drill into right now");
  });

  // spec.md §4 criterion 3: what / where / since when / who, each visible
  // rather than asserted in prose.
  test("answers what, where, since when and who", async ({ page }) => {
    const panel = page.locator(".ct-aside--right");

    // where — the cell, dimension by dimension
    await expect(panel.locator(".ct-ev-dim").first()).toBeVisible();

    // what — the drop itself, against the interval that confirmed it
    await expect(panel.locator(".ct-wilson-track")).toBeVisible();
    await expect(panel.locator(".ct-wilson-row")).toContainText("observed");
    await expect(panel.locator(".ct-wilson-row")).toContainText("expected");
    await expect(panel.locator(".ct-wilson-row")).toContainText("approved");

    // since when — onset, not detection time
    await expect(panel.locator(".ct-narrative__head")).toContainText("since");

    // who — the cell named in the heading, and the culprit the narrative names
    await expect(panel.locator("h2")).not.toBeEmpty();
    await expect(panel.locator(".ct-narrative p")).not.toBeEmpty();
  });

  // spec.md §4 criterion 4: readable explanation + estimated cost + recommended
  // action. The action is a recommendation and has to read as one.
  test("shows the cost as a floor and a recommendation the system will not execute", async ({ page }) => {
    const panel = page.locator(".ct-aside--right");

    await expect(panel.locator(".ct-cost-card")).toHaveCount(2);
    await expect(panel.locator(".ct-cost-grid")).toContainText("at minimum, per minute");
    await expect(panel.locator(".ct-cost-note")).toContainText("floor");

    await expect(panel.locator(".ct-playbook")).toContainText("Recommended action");
    await expect(panel.locator(".ct-playbook__notice")).toContainText(
      "The system never executes remediation",
    );
  });

  test("rewrites the narrative for the executive audience", async ({ page }) => {
    const narrative = page.locator(".ct-narrative p");
    const operations = await narrative.innerText();

    await page.getByRole("button", { name: "Executive" }).click();
    await expect(page.locator(".ct-narrative__head")).toContainText("Executive");
    expect(await narrative.innerText()).not.toBe(operations);

    await page.getByRole("button", { name: "Operations" }).click();
    await expect(narrative).toHaveText(operations);
  });

  // rules.md §3 boundary #2 and DD18: the panel's job is to show what was ruled
  // out, not only what was picked. Both sections are conditional on the
  // evidence carrying them, so this asserts their shape when present.
  test("shows the drill-down path and what it suppressed, when there is any", async ({ page }) => {
    const panel = page.locator(".ct-aside--right");

    if ((await panel.locator(".ct-trail-step").count()) > 0) {
      await expect(panel).toContainText("Drill-down path");
      await expect(panel.locator(".ct-trail-step__no").first()).not.toBeEmpty();
    }

    if ((await panel.locator(".ct-echo").count()) > 0) {
      await expect(panel).toContainText("Suppressed echoes");
      await expect(panel.locator(".ct-echo").first()).toContainText("Shadow, not incident");
    }

    if ((await panel.locator(".ct-mix-row").count()) > 0) {
      await expect(panel).toContainText("Decline mix");
      await expect(panel).toContainText("it is the shift in its share");
    }
  });

  // An incident whose drill-down gave up says so instead of promoting the least
  // innocent cell (spec.md §5).
  test("admits when no cause was isolated", async ({ page }) => {
    const panel = page.locator(".ct-aside--right");
    const notIsolated = await panel.locator(".ct-inconclusive").count();
    // The same claim in two places: the chip on the card that is open, and the
    // block in the panel showing it. Scoped to the selected card — the other
    // cards on screen are different incidents with their own verdicts.
    const chip = await page.locator(".ct-incident--selected .ct-cause--open").count();
    expect(notIsolated > 0).toBe(chip > 0);
  });
});
