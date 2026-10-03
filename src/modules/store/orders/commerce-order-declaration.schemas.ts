/**
 * Request schemas for third-party declarations on an order. Extracted from the controller for
 * the reason every `*.schemas.ts` in this module is: importing a controller to reach a schema
 * drags in its whole service and db graph.
 */
import { z } from "zod";

export const OrderIdParamsSchema = z
  .object({ orderId: z.string().trim().min(1).max(200) })
  .strict();

export const DeclarationParamsSchema = z
  .object({
    orderId: z.string().trim().min(1).max(200),
    declarationId: z.string().trim().min(1).max(200),
  })
  .strict();

/** A calendar date, `YYYY-MM-DD`. Validity and issue dates are days, not instants. */
const CalendarDateSchema = z.iso.date();

const CoverageSchema = z
  .object({
    amountInCents: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a three-letter ISO 4217 code."),
  })
  .strict();

/**
 * Fields every kind shares.
 *
 * WHAT IS NOT HERE IS THE DESIGN:
 *
 *   - **No side, no organization, no member.** Derived from the session and the order — a body
 *     that carried them would let a buyer record a declaration as the seller.
 *   - **No `disclaimerVersion` to store.** `acknowledgedDisclaimerVersion` is checked against
 *     the server's own constant and refused when stale; the stored value is the server's, so a
 *     client cannot write a version that never existed.
 *   - **No verification field of any kind.** Qatoto checks none of this.
 */
const DeclarationCommonFields = {
  issuer: z.string().trim().min(1).max(200),
  reference: z.string().trim().min(1).max(100),
  validFrom: CalendarDateSchema.optional(),
  validUntil: CalendarDateSchema.optional(),
  evidenceDocumentId: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
  acknowledgedDisclaimerVersion: z.string().trim().min(1).max(64),
};

/**
 * One legal shape per kind, matching `commerce_order_third_party_declaration_kind_shape_ck`.
 *
 * A test report carries a `standard` and NO pass/fail: Qatoto is not a conformity assessment
 * body, and a stored verdict on a self-arranged report would read as one this platform endorsed.
 */
export const RecordDeclarationBodySchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("transit_cover"),
        ...DeclarationCommonFields,
        coverageClass: z.string().trim().min(1).max(80).optional(),
        coverage: CoverageSchema.optional(),
        shipmentLegId: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("storage_cover"),
        ...DeclarationCommonFields,
        coverageClass: z.string().trim().min(1).max(80).optional(),
        coverage: CoverageSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("test_report"),
        ...DeclarationCommonFields,
        standard: z.string().trim().min(1).max(200),
        issuedOn: CalendarDateSchema.optional(),
      })
      .strict(),
  ])
  .refine(
    (body) =>
      body.validFrom === undefined ||
      body.validUntil === undefined ||
      body.validUntil >= body.validFrom,
    { message: "validUntil cannot be before validFrom.", path: ["validUntil"] },
  );

export type RecordDeclarationBody = z.infer<typeof RecordDeclarationBodySchema>;
