import { expect, test } from "@playwright/test";
import { ACTIVE_BADGE_SELECTOR, waitForFeed } from "./helpers";

test.describe("incident history", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/history");
    await waitForFeed(page);
  });

  /**
   * ce531f3's regression, asserted from the page that used to swallow them.
   *
   * `monitoring` is not a calmer kind of closed — it is an open incident the
   * detector keeps re-confirming (roadmap.md §5). History listing everything
   * that was not literally "open" filed an ongoing incident under the run's
   * closed book, precisely because it persisted.
   */
  test("never lists an incident the lifecycle still calls active", async ({ page }) => {
    await expect(page.locator(`.ct-history__list ${ACTIVE_BADGE_SELECTOR}`)).toHaveCount(0);
  });

  test("only offers the two closed statuses as filters", async ({ page }) => {
    const options = await page.locator(".ct-history__filters select").first().locator("option").allInnerTexts();
    expect(options.map((option) => option.trim())).toEqual(["any status", "Resolved", "Inconclusive"]);
  });

  test("filters by status", async ({ page }) => {
    const cards = page.locator(".ct-history__list .ct-incident");
    test.skip((await cards.count()) === 0, "no closed incident in this run yet");

    await page.locator(".ct-history__filters select").first().selectOption({ label: "Resolved" });
    const badges = page.locator(".ct-history__list .ct-badge");
    for (let index = 0; index < (await badges.count()); index++) {
      await expect(badges.nth(index)).toHaveText("Resolved");
    }
  });

  test("searches by fingerprint", async ({ page }) => {
    const cards = page.locator(".ct-history__list .ct-incident");
    test.skip((await cards.count()) === 0, "no closed incident in this run yet");

    const fingerprint = (await cards.first().locator(".ct-fingerprint").innerText()).trim();
    await page.getByPlaceholder("Search by dimension or fingerprint…").fill(fingerprint);

    await expect(cards).not.toHaveCount(0);
    for (let index = 0; index < (await cards.count()); index++) {
      // A substring match, because that is what the filter does: the bare cell
      // key is a prefix of the same cell carrying a dominant code, and a
      // recurrence of one fault legitimately shares its signature.
      await expect(cards.nth(index).locator(".ct-fingerprint")).toContainText(fingerprint);
    }
  });

  test("says so when the filters match nothing", async ({ page }) => {
    await page.getByPlaceholder("Search by dimension or fingerprint…").fill("no-such-cell-anywhere");
    await expect(page.locator(".ct-history__list .ct-incident")).toHaveCount(0);
    await expect(page.locator(".ct-wilson-note")).toContainText("No incident matches these filters");
  });

  test("drills into a closed incident from history", async ({ page }) => {
    const cards = page.locator(".ct-history__list .ct-incident");
    test.skip((await cards.count()) === 0, "no closed incident in this run yet");

    await cards.first().click();
    await expect(page.locator(".ct-shell--split")).toHaveCount(1);
    await expect(page.locator(".ct-aside--right .ct-playbook")).toContainText("Recommended action");
  });
});

test.describe("navigation", () => {
  test("moves between the three pages", async ({ page }) => {
    await page.goto("/");
    await waitForFeed(page);

    await page.getByRole("link", { name: "History" }).click();
    await expect(page.locator(".ct-history__head h1")).toHaveText("Incident history");

    await page.getByRole("link", { name: "Console" }).click();
    // The console page has two asides — merchant settings and the injector.
    await expect(page.getByRole("heading", { name: "Inject an incident" })).toBeVisible();

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.locator(".ct-topbar")).toBeVisible();
  });
});
