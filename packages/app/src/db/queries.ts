import type { RollupRow } from "../detect/types.js";

// SQL implementation belongs to the DB-layer branch; the detector receives arrays.
export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>;
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>;
}
