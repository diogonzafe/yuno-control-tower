import type { HealthState } from "../../types/dashboard";

export type MerchantFilter = "ALL" | HealthState;
const filters: { key: MerchantFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "MATERIAL_DROP", label: "Material drop" },
  { key: "MONITORING", label: "Monitoring" },
  { key: "HEALTHY", label: "Healthy" },
  { key: "INSUFFICIENT_EVIDENCE", label: "Insufficient evidence" },
];

export function MerchantFilters({ search, onSearch, status, onStatus }: { search: string; onSearch: (value: string) => void; status: MerchantFilter; onStatus: (status: MerchantFilter) => void }) {
  return (
    <div className="toolbar filter-bar">
      <input className="toolbar__search" type="search" placeholder="Search merchants or IDs…" value={search} onChange={(event) => onSearch(event.target.value)} aria-label="Search merchants" />
      <div className="toolbar__segment" role="group" aria-label="Filter merchants by status">
        {filters.map((filter) => <button type="button" key={filter.key} className={filter.key === status ? "toolbar__segment-btn toolbar__segment-btn--active" : "toolbar__segment-btn"} onClick={() => onStatus(filter.key)}>{filter.label}</button>)}
      </div>
    </div>
  );
}
