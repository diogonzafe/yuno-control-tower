export type DeclineFamily =
  | "issuer"
  | "funds"
  | "fraud"
  | "credential"
  | "network"
  | "auth"
  | "merchant";

// Mirrors rollup_declines_minute (db/schema.ts). decline_code is not a
// conversion dimension (schema.md §5): it describes the shape of the failures,
// so it lives in its own rollup and its own row type.
export type DeclineRollupRow = {
  bucket: string;
  merchantId: string;
  providerId: string;
  country: "BR" | "MX" | "AR";
  paymentMethod: "CARD" | "PIX";
  issuerId: string;
  declineCode: string;
  count: number;
};

export type DeclineCode = {
  code: string;
  paymentMethod: "CARD" | "PIX";
  family: DeclineFamily;
  baselineShare: number;
  diagnostic: boolean;
};
