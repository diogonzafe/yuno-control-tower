"use client";

import { useState } from "react";

const ranges = ["6h", "24h", "7d"] as const;
export type TimeRange = (typeof ranges)[number];
export const rangeLabels: Record<TimeRange, string> = { "6h": "last 6 hours", "24h": "last 24 hours", "7d": "last 7 days" };

export function Toolbar({ range, onRangeChange }: { range: TimeRange; onRangeChange: (range: TimeRange) => void }) {
  const [sort, setSort] = useState<"exposure" | "conversion" | "name">("exposure");
  return (
    <div className="toolbar">
      <button type="button" className="toolbar__pill">Region <b>LatAm</b></button>
      <div className="toolbar__segment" role="group" aria-label="Time range">
        {ranges.map((r) => <button type="button" key={r} className={r === range ? "toolbar__segment-btn toolbar__segment-btn--active" : "toolbar__segment-btn"} onClick={() => onRangeChange(r)}>{r}</button>)}
      </div>
      <label className="toolbar__pill toolbar__sort">Sort
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="exposure">exposure</option>
          <option value="conversion">conversion</option>
          <option value="name">name</option>
        </select>
      </label>
    </div>
  );
}
