"use client";

import { useEffect, useState } from "react";

type MerchantSetting = {
  merchantId: string;
  name: string;
  expectedConversion: number;
  minMaterialDropPp: number;
};

export function MerchantSettings() {
  const [rate, setRate] = useState<number>(0.9);
  const [mixed, setMixed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = () => {
    fetch("/api/merchants")
      .then((response) => response.json())
      .then((data: MerchantSetting[]) => {
        if (data.length === 0) return;
        const [first, ...rest] = data;
        const allSame = rest.every((setting) => setting.expectedConversion === first!.expectedConversion);
        setMixed(!allSame);
        if (allSame) setRate(first!.expectedConversion);
      })
      .catch(() => {});
  };

  useEffect(refresh, []);

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/merchants", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedConversion: rate }),
      });
      setMixed(false);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="ct-aside">
      <div className="ct-aside__head">
        <div className="ct-aside__eyebrow"><i /><span>Merchant settings</span></div>
        <h2>Expected conversion</h2>
        <p>One baseline conversion for every merchant. A material drop below it is what raises an incident.</p>
      </div>

      <div className="ct-aside__body">
        <div className="ct-field">
          <label>Baseline conversion (all merchants)</label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          />
          <small>≈ {(rate * 100).toFixed(0)}%.{mixed ? " Merchants currently have different values." : ""}</small>
        </div>

        <div>
          <button type="button" className="ct-btn ct-btn--primary" onClick={save} disabled={saving}>
            Apply to all merchants
          </button>
        </div>

        {savedAt !== null && <small>Saved — takes effect on the next detection tick.</small>}
      </div>
    </aside>
  );
}
