"use client";

import { useEffect, useState } from "react";
import type { Catalog } from "@control-tower/app";
import { COUNTRIES, PAYMENT_METHODS } from "@control-tower/contracts";

type Country = (typeof COUNTRIES)[number];
type Method = (typeof PAYMENT_METHODS)[number];

type Form = {
  country: Country | "";
  paymentMethod: Method | "";
  providerId: string;
  issuerId: string;
  merchantId: string;
  targetRate: number;
};

type ActiveIncident = { id: string; dimensions: Record<string, string>; conversionMultiplier: number };

// The generator multiplies each cell's baseline conversion by `conversionMultiplier`
// (see packages/generator/src/transaction.ts). The jury thinks in "conversion drops
// to X", not in multipliers, so the form takes a target rate and we divide it back
// out against the generator's default baseline (GENERATOR_DEFAULT_CONVERSION, default
// 0.90 — see packages/generator/src/catalog.ts). Per-route offsets (PIX +0.05, AR, MX)
// and per-merchant randomization shift the real baseline slightly, so the achieved
// rate is approximate.
const BASELINE_CONVERSION = 0.9;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const targetRateToMultiplier = (targetRate: number) =>
  clamp(Number.isFinite(targetRate) ? targetRate / BASELINE_CONVERSION : 1, 0, 1);

const initialForm: Form = { country: "BR", paymentMethod: "CARD", providerId: "", issuerId: "", merchantId: "", targetRate: 0.3 };

export function InjectConsole({ catalog, catalogFailed }: { catalog: Catalog | null; catalogFailed: boolean }) {
  const [form, setForm] = useState<Form>(initialForm);
  const [active, setActive] = useState<ActiveIncident[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refreshActive = () => {
    fetch("/api/inject")
      .then((response) => response.json())
      .then((data: ActiveIncident[]) => setActive(data))
      .catch(() => {});
  };

  useEffect(() => {
    refreshActive();
    const interval = setInterval(refreshActive, 5000);
    return () => clearInterval(interval);
  }, []);

  const issuerOptions = catalog?.issuers.filter((issuer) => !form.country || issuer.country === form.country || issuer.id === "NA") ?? [];
  const merchantOptions = catalog?.merchants.filter((merchant) => !form.country || merchant.id.startsWith(form.country)) ?? [];
  const pixOnlyBr = form.paymentMethod === "PIX" && form.country !== "BR";

  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({
    ...current,
    [key]: value,
    ...(key === "paymentMethod" && value === "PIX" ? { issuerId: "" } : {}),
  }));

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const dimensions: Record<string, string> = {};
      if (form.providerId) dimensions.providerId = form.providerId;
      if (form.country) dimensions.country = form.country;
      if (form.paymentMethod) dimensions.paymentMethod = form.paymentMethod;
      if (form.issuerId) dimensions.issuerId = form.issuerId;
      if (form.merchantId) dimensions.merchantId = form.merchantId;

      const response = await fetch("/api/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `jury-${Date.now()}`,
          startsAt: new Date().toISOString(),
          dimensions,
          conversionMultiplier: targetRateToMultiplier(form.targetRate),
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Injection failed (${response.status})`);
      }
      refreshActive();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Injection failed");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/inject/${encodeURIComponent(id)}`, { method: "DELETE" });
    refreshActive();
  };

  return (
    <aside className="ct-aside">
      <div className="ct-aside__head">
        <div className="ct-aside__eyebrow"><i /><span>Jury console</span></div>
        <h2>Inject an incident</h2>
        <p>Pick which dimensions should fail and by how much conversion drops. Leave a field as <em>any</em> to not fix that dimension.</p>
        {catalogFailed && <p className="ct-catalog-warning">Couldn&apos;t load the merchant/provider catalog — dropdowns below will be empty until it&apos;s back.</p>}
      </div>

      <div className="ct-aside__body">
        <div className="ct-field">
          <label>1 · Country</label>
          <select value={form.country} onChange={(event) => update("country", event.target.value as Form["country"])}>
            <option value="">any country</option>
            {COUNTRIES.map((country) => <option key={country} value={country}>{country}</option>)}
          </select>
        </div>

        <div className="ct-field">
          <label>2 · Method</label>
          <select value={form.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value as Form["paymentMethod"])}>
            <option value="">any method</option>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
          {pixOnlyBr && <small>PIX only exists in Brazil — the list narrows with country.</small>}
        </div>

        <div className="ct-field">
          <label>3 · Provider</label>
          <select value={form.providerId} onChange={(event) => update("providerId", event.target.value)}>
            <option value="">any provider</option>
            {catalog?.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </div>

        <div className="ct-field">
          <label>4 · Issuing bank</label>
          <select value={form.issuerId} onChange={(event) => update("issuerId", event.target.value)} disabled={form.paymentMethod === "PIX"}>
            <option value="">any issuer</option>
            {issuerOptions.map((issuer) => <option key={issuer.id} value={issuer.id}>{issuer.name}</option>)}
          </select>
          {form.paymentMethod === "PIX" && <small>PIX has no issuer — the cube uses <code>NA</code>.</small>}
        </div>

        <div className="ct-field">
          <label>5 · Merchant</label>
          <select value={form.merchantId} onChange={(event) => update("merchantId", event.target.value)}>
            <option value="">any merchant</option>
            {merchantOptions.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}
          </select>
        </div>

        <div className="ct-field">
          <label>6 · Conversion during incident</label>
          <input type="number" min={0} max={BASELINE_CONVERSION} step={0.05} value={form.targetRate} onChange={(event) => update("targetRate", Number(event.target.value))} />
          <small>Conversion for the slice drops to about this rate (baseline ≈ {BASELINE_CONVERSION}). 0 kills it entirely; {BASELINE_CONVERSION} leaves it untouched. Sent as ×{targetRateToMultiplier(form.targetRate).toFixed(2)}.</small>
        </div>

        <div>
          <button type="button" className="ct-btn ct-btn--primary" onClick={submit} disabled={submitting || pixOnlyBr}>Inject incident now</button>
          {submitError && <small role="alert">{submitError}</small>}
        </div>

        {active.length > 0 && (
          <div className="ct-active-list">
            <span>Active injections</span>
            {active.map((incident) => (
              <div className="ct-active" key={incident.id}>
                <span>{Object.entries(incident.dimensions).map(([key, value]) => `${key}=${value}`).join(" · ") || "whole portfolio"} · conv ↓ ≈{(incident.conversionMultiplier * BASELINE_CONVERSION).toFixed(2)}</span>
                <button type="button" onClick={() => remove(incident.id)} aria-label={`Remove injection ${incident.id}`}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
