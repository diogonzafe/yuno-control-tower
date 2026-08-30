import { z } from "zod";

export const COUNTRIES = ["AR", "MX", "BR"] as const;
export const PAYMENT_METHODS = ["CARD", "PIX"] as const;
export const CURRENCIES = ["ARS", "MXN", "BRL"] as const;
export const FX_SOURCES = ["PTAX", "DOF", "BCRA_A3500", "MOCK"] as const;
export const TRANSACTION_STATUSES = ["SUCCESS", "DECLINED"] as const;
export const CARD_TYPES = ["debit", "credit"] as const;

export const transactionEventSchema = z
  .object({
    transactionId: z.string().uuid(),
    merchantOrderId: z.string().min(1),
    merchantId: z.string().min(1),
    providerId: z.string().min(1),
    country: z.enum(COUNTRIES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    currency: z.enum(CURRENCIES),
    amountMinor: z.number().int().nonnegative(),
    fxRate: z.number().positive(),
    fxRateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
    fxSource: z.enum(FX_SOURCES),
    amountUsdMinor: z.number().int().nonnegative(),
    status: z.enum(TRANSACTION_STATUSES),
    declineCode: z.string().min(1).nullable().optional(),
    rawDeclineCode: z.string().min(1).nullable().optional(),
    cardBrand: z.string().min(1).nullable().optional(),
    cardType: z.enum(CARD_TYPES).nullable().optional(),
    cardBin: z.string().length(6).nullable().optional(),
    issuerId: z.string().min(1),
    token: z.string().min(1).nullable().optional(),
    latencyMs: z.number().int().nonnegative().nullable().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (event) => (event.status === "DECLINED") === (event.declineCode != null),
    {
      message: "declineCode must be present if and only if status is DECLINED",
      path: ["declineCode"],
    },
  )
  .refine(
    (event) => event.paymentMethod !== "PIX" || event.country === "BR",
    {
      message: "PIX is only valid when country is BR (DD5)",
      path: ["paymentMethod"],
    },
  );

export type TransactionEvent = z.infer<typeof transactionEventSchema>;
