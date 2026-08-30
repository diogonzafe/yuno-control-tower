import type { MerchantHealth } from "../types/dashboard";

// Temporary presentation fixture. API/SSE wiring belongs here once packages/app exposes it.
export const allMerchants: MerchantHealth[] = [
  { name: "Shopline LatAm", id: "mrc_shopline", countries: ["BR", "MX", "AR"], triggerPp: 3.0, expected: 84.0, current: 78.4, volumeUsd: 1420000, exposurePerMinute: 281, status: "MATERIAL_DROP" },
  { name: "Vendo", id: "mrc_vendo", countries: ["BR"], triggerPp: 2.5, expected: 86.5, current: 79.1, volumeUsd: 980000, exposurePerMinute: 164, status: "MATERIAL_DROP" },
  { name: "Pampa Foods", id: "mrc_pampa", countries: ["AR", "MX"], triggerPp: 3.5, expected: 90.0, current: 74.2, volumeUsd: 412000, exposurePerMinute: 96, status: "MATERIAL_DROP" },
  { name: "Bemol Digital", id: "mrc_bemol", countries: ["BR"], triggerPp: 2.5, expected: 94.4, current: 86.1, volumeUsd: 764000, exposurePerMinute: 118, status: "MONITORING" },
  { name: "Kaya Foods", id: "mrc_kaya", countries: ["BR", "MX"], triggerPp: 3.0, expected: 95.2, current: 88.8, volumeUsd: 512000, exposurePerMinute: 71, status: "MONITORING" },
  { name: "Nubi Store", id: "mrc_nubi", countries: ["BR"], triggerPp: 2.0, expected: 92.7, current: 91.6, volumeUsd: 268000, exposurePerMinute: 24, status: "HEALTHY" },
  { name: "Andes Market", id: "mrc_andes", countries: ["AR"], triggerPp: 2.5, expected: 93.1, current: 92.4, volumeUsd: 341000, exposurePerMinute: 12, status: "HEALTHY" },
  { name: "Rota Verde", id: "mrc_rotaverde", countries: ["BR", "MX"], triggerPp: 3.0, expected: 91.8, current: 90.9, volumeUsd: 198000, exposurePerMinute: 9, status: "HEALTHY" },
  { name: "Lumen Wear", id: "mrc_lumen", countries: ["MX"], triggerPp: 2.5, expected: 92.9, current: 92.1, volumeUsd: 156000, exposurePerMinute: 6, status: "HEALTHY" },
  { name: "Cerrado Fit", id: "mrc_cerrado", countries: ["BR"], triggerPp: 2.0, expected: 96.0, current: 93.5, volumeUsd: 8400, exposurePerMinute: 2, status: "INSUFFICIENT_EVIDENCE" },
];

export function topOffenders(limit: number): MerchantHealth[] {
  return [...allMerchants].filter((merchant) => merchant.status !== "HEALTHY" && merchant.status !== "INSUFFICIENT_EVIDENCE").sort((a, b) => b.exposurePerMinute - a.exposurePerMinute).slice(0, limit);
}
