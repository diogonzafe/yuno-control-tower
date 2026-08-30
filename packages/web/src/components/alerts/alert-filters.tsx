export type AlertFilter = "ALL" | "OPEN" | "MONITORING" | "RESOLVED";
const filters: { key: AlertFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "MONITORING", label: "Monitoring" },
  { key: "RESOLVED", label: "Resolved" },
];

export function AlertFilters({ active, onChange }: { active: AlertFilter; onChange: (filter: AlertFilter) => void }) {
  return (
    <div className="toolbar__segment filter-bar" role="group" aria-label="Filter alerts by status">
      {filters.map((filter) => <button type="button" key={filter.key} className={filter.key === active ? "toolbar__segment-btn toolbar__segment-btn--active" : "toolbar__segment-btn"} onClick={() => onChange(filter.key)}>{filter.label}</button>)}
    </div>
  );
}
