import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Badge tiers statusBadge() hands to an incident the lifecycle still counts as
// active (src/lib/status.ts). The closed ones are `resolved` and `inconclusive`.
export const ACTIVE_BADGE_SELECTOR =
  ".ct-badge--critical, .ct-badge--warn, .ct-badge--ok, .ct-badge--monitoring";

/** Confirmed incidents only. A pending signal renders as a card too, but it has
 * no incidentId and nothing to select. */
export function incidentCards(page: Page): Locator {
  return page.locator(".ct-incident:not(.ct-incident--pending)");
}

export function pendingCards(page: Page): Locator {
  return page.locator(".ct-incident--pending");
}

/** The console is server-rendered but empty until the first SSE snapshot
 * arrives, so every spec has to wait for the feed rather than for the load
 * event. */
export async function waitForFeed(page: Page): Promise<void> {
  await expect(page.locator(".ct-topbar, .ct-history__head")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".ct-loading")).toHaveCount(0, { timeout: 60_000 });
}

/** The cell a card describes, as a stable sorted string built from its
 * dimension chips — the same identity orchestrate/cell.ts matches incidents by. */
export async function cellOf(card: Locator): Promise<string> {
  const chips = await card.locator(".ct-chip").allInnerTexts();
  return chips.map((chip) => chip.trim()).sort().join("|");
}

export async function cellsOnScreen(page: Page): Promise<string[]> {
  const cards = incidentCards(page);
  const cells: string[] = [];
  for (let index = 0; index < (await cards.count()); index++) {
    cells.push(await cellOf(cards.nth(index)));
  }
  return cells;
}

/** "3 active" in the topbar. */
export async function activeCountInHeader(page: Page): Promise<number> {
  const text = await page.locator(".ct-health span").last().innerText();
  return Number(text.replace(/\D+/g, ""));
}

type Injection = { id: string; dimensions: Record<string, string> };

export async function listInjections(request: APIRequestContext): Promise<Injection[]> {
  const response = await request.get("/api/inject");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Injection[];
}

/**
 * Leaves the deployment as the spec found it.
 *
 * Injections outlive the browser context, so a spec that skipped this would
 * keep degrading the environment — and the next spec's assertions — long after
 * it finished. Only ids absent from `preExisting` are removed: a run must never
 * cancel an injection somebody set up outside it, which a prefix match would.
 */
export async function removeNewInjections(
  request: APIRequestContext,
  preExisting: string[],
): Promise<void> {
  const keep = new Set(preExisting);
  for (const injection of await listInjections(request)) {
    if (!keep.has(injection.id)) {
      await request.delete(`/api/inject/${encodeURIComponent(injection.id)}`);
    }
  }
}

export async function injectFault(
  request: APIRequestContext,
  input: {
    id: string;
    dimensions: Record<string, string>;
    conversionMultiplier: number;
    declineWeights?: Record<string, number>;
  },
): Promise<void> {
  const response = await request.post("/api/inject", {
    data: { startsAt: new Date().toISOString(), ...input },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/**
 * Polls the console until `predicate` holds, reloading between attempts.
 *
 * Detection is not an event the page can be awaited on: it takes the detector's
 * 3-window persistence plus an orchestrator tick, so the honest wait is minutes
 * of polling rather than a locator timeout.
 */
export async function waitForConsole(
  page: Page,
  predicate: (page: Page) => Promise<boolean>,
  options: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let last = false;
  while (Date.now() < deadline) {
    await page.goto("/");
    await waitForFeed(page);
    last = await predicate(page);
    if (last) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error(`timed out after ${options.timeoutMs}ms waiting for: ${options.label}`);
}
