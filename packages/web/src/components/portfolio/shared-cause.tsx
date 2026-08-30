import Link from "next/link";
import { formatUsdPerMinute } from "../../lib/format";

export function SharedCause({ affectedMerchants, exposurePerMinute, incidentId }: { affectedMerchants: number; exposurePerMinute: number; incidentId: string }) {
  return (
    <section className="shared-cause">
      <span>Shared cause</span>
      <div>
        <strong>Adyen · BR · CARD is degrading {affectedMerchants} merchants at once</strong>
        <p>Fingerprints share the provider dimension while control routes on dLocal hold. Combined exposure of {formatUsdPerMinute(exposurePerMinute)} across the affected merchants — a single routing shift covers all of them.</p>
      </div>
      <div className="shared-cause__actions">
        <Link href={`/alerts?incident=${incidentId}`} className="btn btn--ghost">Inspect</Link>
        <Link href={`/alerts?incident=${incidentId}&action=group`} className="btn btn--primary">Group into one action</Link>
      </div>
    </section>
  );
}
