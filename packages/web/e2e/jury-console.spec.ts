import { expect, test } from "@playwright/test";
import { listInjections, removeNewInjections } from "./helpers";

// spec.md §7h: the trial by fire needs someone from outside the team to be able
// to inject an arbitrary incident. If that is a script only the team can run,
// the demo stalls — so the console is a product surface, and it is tested here
// as one.
test.describe("jury console", () => {
  let preExisting: string[] = [];

  test.beforeEach(async ({ page, request }) => {
    preExisting = (await listInjections(request)).map((injection) => injection.id);
    await page.goto("/console");
    await expect(page.locator(".ct-history__head h1")).toHaveText("Jury console");
  });

  test.afterEach(async ({ request }) => {
    await removeNewInjections(request, preExisting);
  });

  test("offers all six dimensions of the cube, each defaulting to any", async ({ page }) => {
    const injector = page.locator(".ct-aside", { hasText: "Jury console" });
    // textContent, not innerText: the stylesheet uppercases these labels, and
    // innerText reports what the CSS renders rather than what the page says.
    const labels = await injector.locator(".ct-field label").allTextContents();
    expect(labels.map((label) => label.trim())).toEqual([
      "1 · Country",
      "2 · Method",
      "3 · Provider",
      "4 · Issuing bank",
      "5 · Merchant",
    ]);

    // Every dimension can be left unfixed — that is what makes the injected
    // combination arbitrary rather than one of a rehearsed few.
    for (const select of await injector.locator(".ct-field select").all()) {
      await expect(select.locator("option").first()).toContainText("any");
    }
  });

  test("keeps PIX honest: no issuer, and Brazil only", async ({ page }) => {
    const method = page.locator(".ct-field", { hasText: "2 · Method" }).locator("select");
    const issuer = page.locator(".ct-field", { hasText: "4 · Issuing bank" }).locator("select");
    const country = page.locator(".ct-field", { hasText: "1 · Country" }).locator("select");

    await method.selectOption("PIX");
    await expect(issuer).toBeDisabled();
    await expect(page.locator(".ct-field", { hasText: "4 · Issuing bank" })).toContainText("PIX has no issuer");

    await country.selectOption("MX");
    await expect(page.locator(".ct-field", { hasText: "2 · Method" })).toContainText("PIX only exists in Brazil");
    await expect(page.getByRole("button", { name: "Inject drop now" })).toBeDisabled();

    await country.selectOption("BR");
    await expect(page.getByRole("button", { name: "Inject drop now" })).toBeEnabled();
  });

  test("injects a drop and lists it as active until it is removed", async ({ page, request }) => {
    await page.locator(".ct-field", { hasText: "1 · Country" }).locator("select").selectOption("BR");
    await page.locator(".ct-field", { hasText: "2 · Method" }).locator("select").selectOption("CARD");
    await page.locator(".ct-field", { hasText: "3 · Provider" }).locator("select").selectOption("adyen");

    await page.getByRole("button", { name: "Inject drop now" }).click();
    await expect(page.locator(".ct-toast")).toContainText("Incident injected");

    // Address the row by the id this test created, never by its dimensions.
    // Filtering on "providerId=adyen" also matches an injection somebody else
    // set up on the same provider, and the remove button below would cancel
    // theirs — which is exactly how this test once cancelled a running
    // measurement out from under it.
    const [created] = (await listInjections(request)).filter(
      (injection) => !preExisting.includes(injection.id),
    );
    expect(created, "the console posted no new injection").toBeDefined();
    expect(created!.dimensions).toMatchObject({ providerId: "adyen", country: "BR", paymentMethod: "CARD" });

    const row = page.locator(".ct-active", { has: page.getByLabel(`Remove injection ${created!.id}`) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("providerId=adyen");

    await page.getByLabel(`Remove injection ${created!.id}`).click();
    await expect(row).toHaveCount(0);
  });

  test("injects the two-simultaneous-causes scenario as two separate faults", async ({ page, request }) => {
    await page.getByRole("button", { name: "Simulate two simultaneous incidents" }).click();
    await expect(page.locator(".ct-toast")).toContainText("Two incidents injected");

    const injected = (await listInjections(request)).filter(
      (injection) => !preExisting.includes(injection.id),
    );
    expect(injected).toHaveLength(2);

    // Same merchant x country root, disjoint provider x issuer cells — the
    // shape the peeling path has to separate rather than collapse into their
    // common ancestor (spec.md §4 criterion 5).
    const roots = new Set(injected.map((i) => `${i.dimensions.merchantId}|${i.dimensions.country}`));
    expect(roots.size).toBe(1);
    const cells = new Set(injected.map((i) => `${i.dimensions.providerId}|${i.dimensions.issuerId}`));
    expect(cells.size).toBe(2);
  });

  // DD7: the expected conversion a material drop is measured against is a
  // configured constant, so the console has to be able to show and change it.
  test("shows the baseline every merchant is measured against", async ({ page }) => {
    const settings = page.locator(".ct-aside", { hasText: "Merchant settings" });
    await expect(settings.locator("h2")).toHaveText("Expected conversion");
    await expect(settings.locator('input[type="number"]')).not.toHaveValue("");
    await expect(settings.getByRole("button", { name: "Apply to all merchants" })).toBeEnabled();
  });
});
