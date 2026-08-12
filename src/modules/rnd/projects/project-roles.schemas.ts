/**
 * Request schemas for project-roles, extracted from project-roles.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

export const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;

/**
 * THE TWO POLICIES A CASH STRAND MAY ADVERTISE (§4d, §7A).
 *
 * `milestone_escrow_release` and `on_completion_escrow_release` are RETIRED. They forced
 * every salary and one-time strand through an escrow release, which meant a founder who
 * never ran a funding round here had no way to say "I pay this person from my own bank
 * account" — money-in gated data-out — and, worse, it made a wage conditional on a
 * Proof-of-Effort verdict, which §0 now forbids outright.
 *
 * They stay in the pgEnum so migration 0010's existing rows remain readable. Nothing new
 * may be written with them: this schema refuses them with a 422, and
 * `open_role_compensation_policy_pairing_ck` (migration 0019) refuses them at the column
 * level. Both, not either — a rule with no database behind it is a convention.
 */
export const CASH_POLICIES = ["off_platform_payroll", "direct_transfer"] as const;

export const MoneyInCentsSchema = z.number().int().min(0);

export const BasisPointsSchema = z.number().int().min(0).max(10_000);

/**
 * One strand per kind, each carrying only its own columns.
 *
 * The `earnedAsPolicy` enum differs per branch on purpose: equity vests through Slicing
 * Pie, cash is paid by the company and reported here (§7A), and pairing them the other
 * way lets a founder advertise a mechanism that does not exist. The DB CHECK enforces the
 * same rule; this makes it a 422 with a field path instead of a 500.
 */
export const CompensationStrandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("salary"),
      salaryMinInCentsPerMonth: MoneyInCentsSchema,
      salaryMaxInCentsPerMonth: MoneyInCentsSchema.optional(),
      earnedAsPolicy: z.enum(CASH_POLICIES),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("one_time"),
      oneTimeMinInCents: MoneyInCentsSchema,
      oneTimeMaxInCents: MoneyInCentsSchema.optional(),
      earnedAsPolicy: z.enum(CASH_POLICIES),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("equity"),
      equityBasisPointsMin: BasisPointsSchema,
      equityBasisPointsMax: BasisPointsSchema.optional(),
      earnedAsPolicy: z.literal("slicing_pie_vesting"),
      earnedAsNote: z.string().trim().max(500).optional(),
    })
    .strict(),
]);

export const OpenRoleFieldsSchema = z.object({
  roleTitle: z.string().trim().min(1).max(120),
  skills: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  commitment: z.enum(ROLE_COMMITMENTS),
  // slotsFilledCount is ABSENT — it is a server-owned counter moved only by the accept
  // transaction, and `.strict()` rejects a client trying to set it.
  slotsTotal: z.number().int().min(1).max(50).optional(),
  description: z.string().trim().max(10_000).optional(),
  compensation: z.array(CompensationStrandSchema).max(3).optional(),
});

export const CreateOpenRoleSchema = OpenRoleFieldsSchema.strict();

export const UpdateOpenRoleSchema = OpenRoleFieldsSchema.strict().partial();

export const ListOpenRolesQuerySchema = z
  .object({
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    skill: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).optional(),
    minEquityBasisPoints: z.coerce.number().int().min(0).max(10_000).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
