"use client";

import { useEffect, useState } from "react";
import type { Catalog } from "@control-tower/app";

type MerchantSetting = {
  merchantId: string;
  name: string;
  expectedConversion: number;
  minMaterialDropPp: number;
};

export function MerchantSettings({ catalog }: { catalog: Catalog | null }) {
  const [settings, setSettings] = useState<MerchantSetting[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [rate, setRate] = useState<number>(0.9);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = () => {
    fetch("/api/merchants")
      .then((response) => response.json())
      .then((data: MerchantSetting[]) => {
        setSettings(data);
        setMerchantId((current) => current || data[0]?.merchantId || "");
      })
      .catch(() => {});
  };

  useEffect(refresh, []);

  useEffect(() => {
    const current = settings.find((setting) => setting.merchantId === merchantId);
    if (current) setRate(current.expectedConversion);
  }, [merchantId, settings]);

  const save = async () => {
    if (!merchantId) return;
    setSaving(true);
    try {
      await fetch(`/api/merchants/${encodeURIComponent(merchantId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedConversion: rate }),
      });
      refresh();
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const merchantName = catalog?.merchants.find((merchant) => merchant.id === merchantId)?.name;

  return (
    <aside className="ct-aside">
      <div className="ct-aside__head">
        <div className="ct-aside__eyebrow"><i /><span>Merchant settings</span></div>
        <h2>Expected conversion</h2>
        <p>Set the baseline conversion for a merchant. A material drop below it (see the merchant&apos;s configured delta) is what raises an incident.</p>
      </div>

      <div className="ct-aside__body">
        <div className="ct-field">
          <label>Merchant</label>
          <select value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
            {settings.map((setting) => (
              <option key={setting.merchantId} value={setting.merchantId}>
                {setting.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ct-field">
          <label>Baseline conversion{merchantName ? ` for ${merchantName}` : ""}</label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          />
          <small>≈ {(rate * 100).toFixed(0)}%. Incidents fire when the observed rate falls materially below this.</small>
        </div>

        <div>
          <button type="button" className="ct-btn ct-btn--primary" onClick={save} disabled={saving || !merchantId}>
            Save baseline
          </button>
        </div>

        {savedAt !== null && <small>Saved — takes effect on the next detection tick.</small>}
      </div>
    </aside>
  );
}
