# End-to-end suite

Playwright specs that drive the **deployed** Control Tower, not a local one.

Nothing is started locally on purpose. The detector needs a live generator, a
live Redis stream and minutes of real rollups behind it, so a `next dev` pointed
at `NEXT_PUBLIC_USE_FIXTURES` would assert against hand-written JSON instead of
the pipeline the jury will actually see. The target defaults to the Railway
production URL and is overridden with `E2E_BASE_URL`.

Playwright needs **Node 20+** (the repo asks for 22). Under Node 18 it refuses
to start.

## The two projects

```bash
pnpm --filter @control-tower/web test:e2e            # ui — read-only, ~1 min
pnpm --filter @control-tower/web test:e2e:scenarios  # scenarios — injects, ~25 min
```

**`ui`** only reads. It is safe to run at any time, including mid-demo, and it
skips the assertions that need a live incident when the board happens to be
quiet. It covers the console, the evidence panel, history and the jury console.

**`scenarios`** injects real faults into the shared deployment and waits for the
detector's 3-window persistence plus an orchestrator tick. It changes what the
dashboard shows while it runs, so do not run it during a demo.

## What the scenarios cover

| Spec | `spec.md` §4 |
|---|---|
| Two simultaneous causes separated and ranked | criterion 5 |
| One continuous fault stays one incident | the `f5dea64` regression |
| An unrehearsed combination injected from the console | criterion 6, trial by fire |
| Silence once the faults are cleared | criterion 1 |

## Injections are shared state

Every spec that injects records the ids that already existed and removes only
the ones it created. Never address an injection by its dimensions: filtering on
`providerId=adyen` also matches an injection somebody else set up, and the
remove button will cancel theirs. That is not hypothetical — it is how the first
run of this suite cancelled a stability measurement out from under itself.
