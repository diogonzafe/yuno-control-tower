# A confirmed drop re-confirms every window, and `emitted` stops gating promotion

**Decisions:** amends `detector.md` §"persistence" and completes
`incident_identity_by_containment.md`, which fixed one of the two mechanisms
behind a single fault producing a stream of incidents. This is the other one,
and the larger of the two.

## What the first fix missed

`incident_identity_by_containment.md` found that incident identity was an exact
key re-estimated every window, and made it containment of the cell instead. That
was real, and it is measurable: on 2026-09-04 at 18:27 the evidence carried
`...providerId=stripe#05`, at 18:30 the same cell came back with no dominant code
at all, and both landed on one incident row whose `detected_at` moved 18:27 →
18:30. Before the change that second window opened incident number two.

But the same measurement showed the fault still producing new incidents:

```
evidence emitted:  18:27   18:30  18:31         18:36  18:38
incident 0e2e26f3        detected 18:31 → resolved 18:34
incident 9b98dc04                              → opened 18:38
injection stripe x itau: continuous 18:26 → 18:38 throughout
```

Evidence was emitted in 5 windows out of 12. The identity was stable; there was
simply nothing arriving to keep the incident alive.

## The mechanism

`persistence.step()` promoted a slice once and never again:

```ts
if (entry.count >= persistenceWindows && !entry.emitted) { entry.emitted = true; promoted.push(c); }
```

Everything that keeps an incident alive runs on promoted signals — `runDiagnosis`,
`buildEvidence`, and the `openOrUpdate` whose `measuredColumns` bumps
`detected_at`. `orchestrate/lifecycle.ts` resolves any active incident whose
`detected_at` is `RESOLVE_AFTER_QUIET_WINDOWS` old.

So a continuous fault was *structurally guaranteed* to be resolved three windows
after its single promotion, and reopened as a fresh incident whenever the streak
happened to break and rebuild. No key, however stable, survives that. This is why
the 44-minute outage of 17:19–18:02 produced seven incidents even though the
onset scan reported the same `started_at` on every one of them.

The comment in `orchestrate/incidents.ts` — "the drop re-confirms every minute
while the incident is live" — described the design this flag quietly prevented.

## Options considered

- **Tolerate the gap in `lifecycle.ts`.** Stop treating absence of
  re-confirmation as quiet, mirroring the rule `persistence.ts` already applies
  to its own streaks. Fixes the resolve, but leaves the system unable to say
  anything about a live incident between promotions: no fresh cost, no fresh
  rate, no re-diagnosis.
- **Bump `detected_at` from the standing streak.** Pass `nextState`'s live
  streaks to `reconcile` and treat one covering the incident's cell as
  re-confirmation. Cheap, but a streak at the merchant root is compatible with
  every incident underneath it, so a genuinely recovered child would be kept
  alive by its sibling's outage.
- **Promote on every confirmed window.** Delete the `!entry.emitted` guard.

## What we chose

The guard is gone. A slice whose streak stands is promoted on every window its
drop is still confirmed, so diagnosis, evidence and `openOrUpdate` all run each
minute an incident is live — which is what the rest of the system already
assumed.

`emitted` is kept, and still set on the first promotion. Its remaining job is to
separate a *watching* card from an incident: `tick.ts` builds `pending` from the
entries where `!emitted`.

## Why

Re-alerting was the thing `emitted` looked like it protected against, and it is
not the layer that protects against it. `openOrUpdate` answers a re-confirmation
with `monitoring`, updating the incident without alerting again (roadmap.md §5) —
that mechanism already exists, one layer up, where it belongs. Suppressing the
signal did not prevent an alert; it prevented the update.

The alternatives both work by inferring "still down" from the absence of
information. Promoting the confirmed window replaces the inference with the
reading itself, and the sibling problem disappears with it: the diagnosis
re-derives its causal cells every window, so a recovered child simply stops
appearing and its incident resolves on the existing three-window rule.

## What it costs

`runDiagnosis` and its two decline queries now run on every window with a live
incident, rather than on the windows that happened to promote. That is the
documented intent, and a quiet minute still costs nothing — `diagnose()` returns
early when no signal confirmed.

A signal is broadcast over SSE each minute per standing slice, so the signal feed
and its ring buffer turn over faster during an incident. `consecutiveWindows`
climbs for as long as the fault lasts, which is what lets the evidence say how
long it has been running.

`context/detector.md` carried a second stale line next to this one, claiming a
fingerprint absent from a window's candidates resets the streak. `b346914`
changed that months ago; the doc is corrected here too.
