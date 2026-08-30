import { ingestionIssue } from "../../lib/ingestion-data";

export function IssueBanner() {
  return (
    <section className="issue-banner">
      <span>Pipeline issue</span>
      <div>
        <strong>{ingestionIssue.title}</strong>
        <p>{ingestionIssue.detail} {ingestionIssue.impact}</p>
      </div>
    </section>
  );
}
