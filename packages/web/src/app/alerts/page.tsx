import { AlertsPage } from "../../components/alerts/alerts-page";

export default async function AlertsRoute({ searchParams }: { searchParams: Promise<{ incident?: string; action?: string }> }) {
  const params = await searchParams;
  return <AlertsPage initialIncidentId={params.incident} showGrouped={params.action === "group"} />;
}
