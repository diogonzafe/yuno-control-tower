"use client";

import type { Catalog, IncidentRow } from "@control-tower/app";
import { formatLocal, formatPercent, formatRelativeSince, formatUsd, formatUsdPerMin } from "../../lib/format";
import { decisionTagLabel, declineCodeLabel } from "../../lib/labels";
import { dimensionLabel, executiveNarrative, operationsNarrative, playbookFor, type Audience } from "../../lib/narrative";
import { causeLabel, statusBadge } from "../../lib/status";
import { expectedSourceHint } from "../../lib/labels";
import { Term } from "./term";

const EMPTY_CATALOG: Catalog = { merchants: [], providers: [], issuers: [] };

function EmptyPanel() {
  return (
    <aside className="ct-aside ct-aside--right">
      <div className="ct-aside__head">
        <div className="ct-aside__eyebrow"><i /><span>Evidence panel</span></div>
        <h2>Select an incident</h2>
      </div>
      <div className="ct-evidence-body">
        <div className="ct-evidence-empty">
          <p>Once an incident is confirmed, this is where the drill-down path shows up: which dimensions the engine tested, which one concentrated the deficit, and what it ruled out as an echo.</p>
          <div className="ct-evidence-proof">
            <span>What this panel proves</span>
            <p>A naive system would fire four alerts for the same incident. Showing the three it ruled out is what separates diagnosis from a list of correlations.</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function EvidencePanel({ incident, catalog, audience }: { incident: IncidentRow | null; catalog: Catalog | null; audience: Audience }) {
  if (!incident) return <EmptyPanel />;

  const e = incident.evidence;
  const cat = catalog ?? EMPTY_CATALOG;
  const narrative = audience === "operations" ? operationsNarrative(e, cat) : executiveNarrative(e, cat);
  const playbook = playbookFor(e);
  const ciLeft = e.ci.low * 100;
  const ciWidth = Math.max(1, (e.ci.high - e.ci.low) * 100);
  const currency = Object.keys(e.costLocal)[0];
  const badge = statusBadge(incident);
  const cause = causeLabel(e.confidence);

  return (
    <aside className="ct-aside ct-aside--right">
      <div className="ct-aside__head">
        <div className="ct-aside__eyebrow"><i /><span>Evidence panel</span></div>
        <h2>{dimensionLabel(e.dimensions, cat)}</h2>
        <p>
          <span className={`ct-badge ct-badge--${badge.tier}`} style={{ marginRight: 8 }}>{badge.label}</span>
          {e.diagnosisSource === "beam_search" ? "deterministic fallback" : "agent"}
        </p>
      </div>

      <div className="ct-evidence-body">
        {cause && !cause.isolated && (
          <div className="ct-inconclusive">
            <span>Cause not isolated</span>
            <p>
              The drop is confirmed, but no child slice separated from its siblings in this
              window — usually because splitting the cell leaves each child below the volume
              needed to tell it apart from noise. The system reports the deficit at the
              merchant level instead of promoting the least innocent cell.
            </p>
          </div>
        )}

        <div className="ct-ev-dims">
          {Object.entries(e.dimensions).map(([key, value]) => value && <span className="ct-ev-dim" key={key}><span>{key}</span><span>{String(value)}</span></span>)}
        </div>

        <div className="ct-box">
          <span><Term title="A 95% Wilson score interval: a confidence range for the true approval rate given the sample size, more honest than a plain percentage at low volume.">Wilson 95% interval</Term> · {e.windowUsed} window</span>
          <div className="ct-wilson-track">
            <div className="ct-ci-bar__fill" style={{ left: `${ciLeft}%`, width: `${ciWidth}%`, background: "rgba(232,80,80,0.15)", borderColor: "currentColor" }} />
            <div className="ct-ci-bar__expected" style={{ left: `${e.expectedRate * 100}%` }} />
            <div className="ct-ci-bar__observed" style={{ left: `${e.observedRate * 100}%` }} />
          </div>
          <div className="ct-wilson-row">
            <div><span className="ct-muted">observed</span><span>{formatPercent(e.observedRate)} · {formatPercent(e.ci.low)}–{formatPercent(e.ci.high)}</span></div>
            <div><span className="ct-muted">expected</span><span>{formatPercent(e.expectedRate)} · <Term title={expectedSourceHint(e.expectedSource)}>{e.expectedSource.replace("_", "-")}</Term></span></div>
            <div><span className="ct-muted">sample</span><span>{e.approved}/{e.attempts} approved</span></div>
          </div>
          <span className="ct-wilson-note">Confirmed for {e.consecutiveWindows} consecutive window{e.consecutiveWindows === 1 ? "" : "s"} — even the interval&apos;s optimistic edge sits below the material-drop threshold.</span>
        </div>

        <div className="ct-narrative">
          <div className="ct-narrative__head"><span>{audience === "operations" ? "Operations" : "Executive"}</span><span>since {formatRelativeSince(e.startedAt, e.startedAtExact)}</span></div>
          <p>{narrative}</p>
        </div>

        <div>
          <span className="ct-section-label">Cost — floor, not estimate</span>
          <div className="ct-cost-grid">
            <div className="ct-cost-card"><strong>{formatUsdPerMin(e.costUsdPerMin)}</strong><span>at minimum, per minute</span></div>
            <div className="ct-cost-card"><strong>{formatUsd(e.costUsdMinor)}</strong><span>accumulated{currency ? ` · ${formatLocal(e.costLocal[currency]!, currency)}` : ""}</span></div>
          </div>
          <p className="ct-cost-note" style={{ marginTop: 9 }}>{e.lostApprovals.toLocaleString("en-US")} lost approvals, computed with the optimistic edge of the interval ({formatPercent(e.ci.high)}). The number is a floor.</p>
        </div>

        {e.investigationTrail.length > 0 && (
          <div>
            <span className="ct-section-label">Drill-down path</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {e.investigationTrail.map((step) => <TrailStep key={step.stepNo} step={step} />)}
            </div>
          </div>
        )}

        {e.declineMix.length > 0 && (
          <div>
            <span className="ct-section-label">Decline mix</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {e.declineMix.map((entry) => <MixRow key={entry.code} entry={entry} dominant={entry.code === e.dominantDecline} />)}
            </div>
            <p className="ct-wilson-note" style={{ marginTop: 8 }}>The pale bar is the cell&apos;s normal mix. The signal is never the code&apos;s presence — it is the shift in its share.</p>
          </div>
        )}

        {e.suppressedEchoes.length > 0 && (
          <div>
            <span className="ct-section-label">Suppressed echoes · {e.suppressedEchoes.length}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {e.suppressedEchoes.map((echo, index) => (
                <div className="ct-echo" key={index}>
                  <div className="ct-echo__top"><span>{dimensionLabel(echo.dimensions, cat)}</span><span>not alerted</span></div>
                  <p>Dropped to <strong style={{ color: "var(--amber)" }}>{formatPercent(echo.observedRate)}</strong> — but recovers to <strong style={{ color: "var(--green)" }}>{formatPercent(echo.residualRate)}</strong> once the causal cell is removed. Shadow, not incident.</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="ct-playbook">
          <span>Recommended action · {playbook.id}</span>
          <span className="ct-playbook__title">{playbook.title}</span>
          <span className="ct-playbook__body">{playbook.body}</span>
          <div className="ct-playbook__notice"><i /><span>Pending human approval. The system never executes remediation.</span></div>
        </div>
      </div>
    </aside>
  );
}

function TrailStep({ step }: { step: import("@control-tower/contracts").InvestigationAuditStep }) {
  return (
    <div className="ct-trail-step">
      <span className="ct-trail-step__no">{step.stepNo}</span>
      <div className="ct-trail-step__body">
        <span className="ct-trail-step__q">{decisionTagLabel(step.decisionTag)}</span>
        <span className="ct-trail-step__a">{step.decisionSummary}</span>
        <span className="ct-trail-step__tool">
          {step.toolName}
          {step.status === "failed" ? ` · failed${step.errorCode ? ` (${step.errorCode})` : ""}` : ""}
        </span>
      </div>
    </div>
  );
}

function MixRow({ entry, dominant }: { entry: import("@control-tower/contracts").DeclineMixEntry; dominant: boolean }) {
  const color = dominant ? "var(--red)" : "var(--muted-5)";
  return (
    <div className="ct-mix-row">
      <div className="ct-mix-row__top">
        <span><code style={{ color }}>{entry.code}</code> <span className="ct-muted">{declineCodeLabel(entry.code)}</span></span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color }}>{(entry.observedShare * 100).toFixed(0)}% (base {(entry.baselineShare * 100).toFixed(0)}%)</span>
      </div>
      <div className="ct-mix-track">
        <div className="ct-mix-baseline" style={{ width: `${Math.min(100, entry.baselineShare * 100)}%` }} />
        <div className="ct-mix-observed" style={{ width: `${Math.min(100, entry.observedShare * 100)}%`, background: color }} />
      </div>
    </div>
  );
}
