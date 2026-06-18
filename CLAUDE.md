# Qatoto Backend — Agent Specification

This document is the architectural guide, operational manual, and system prompt for every agent (AI or human) writing code in the **Qatoto** backend.

**Qatoto** is a B2B e-commerce platform for full-lifecycle product development: feasibility surveys, team formation, equity crowdfunding and investor matching, supplier contract onboarding, and multi-party escrow management.

**Stack:** Express.js · TypeScript (strict) · Zod for all boundary parsing.

---

## 0. Domain Model — What Qatoto Does

Qatoto is a **concept-to-consumer foundry**: it takes a raw idea and supplies the team, funding, inspiration, and logistics to ship it. Code you write belongs to one of these subsystems. Use these names in modules, services, and routes.

| Subsystem | What it does | Core entities |
| --------- | ------------ | ------------- |
| **Incubation / Team Formation** | Innovator posts a vision; algorithm matches CTOs, engineers, hobbyists who trade skills for **equity or future rewards**. Team builds an MVP in the platform's collaborative workspace. | `ProjectIdea`, `ContributorProfile`, `EquityGrant`, `TeamInvite` |
| **Daily Update Protocol** | Members submit daily video/transcript logs. AI analyzes for bottlenecks and workflow gaps, and keeps an immutable **Proof of Effort** record. | `DailyUpdateLog`, `ProofOfEffortRecord`, `WorkflowInsight` |
| **Funding** | Equity crowdfunding and investor matching. Investors see granular verified progress, lowering risk. | `InvestorProfile`, `FundingRound`, `ShareAllocation`, `CrowdfundPledge` |
| **Financial Governance** | Neutral escrow + auditor. Compensation computed from logged effort (research/promotion/dev). Fund allocation tracked against AI-verified updates to prevent fraud. | `EscrowAccount`, `EffortBasedCompensation`, `FundAllocationLedger` |
| **Market & Civic Intelligence** | **Knowledge Hub** (where demand is highest) + **Opportunity Map** (user-reported infrastructure gaps → heat map of problems to solve). | `DemandSignal`, `ProblemReport`, `OpportunityMapPin` |
| **Creative Engine** | **Anime section** and **Project Immortal** moonshot research as non-linear inspiration sources for real products. | `InspirationSource`, `ResearchProject` |
| **B2B Logistics & Storefront** | Post-build: storefront, shipping, international compliance, support, marketing suite. | `Product`, `Storefront`, `Shipment`, `ComplianceCheck`, `MarketingCampaign` |

**Money, equity, and effort are the high-stakes invariants.** Anything touching `ShareAllocation`, `EscrowAccount`, `FundAllocationLedger`, or `EffortBasedCompensation` is security-critical — apply Section 1.1 (zero-trust) and Section 3.3 (`Result` over thrown errors) without exception.

---

## How to read this document

Sections 1–2 are **mandates** — non-negotiable rules. Section 3 is the **pattern library** — copy these shapes. Section 4 is the **review checklist** — run it before declaring any change done.

When a rule here conflicts with existing code, the rule wins. Flag the offending code; do not imitate it.

---

## 1. Core Architectural Mandates

### 1.1 Zero-Trust Frontend — Backend is the Sole Source of Truth

The Next.js frontend runs entirely in the user's browser. Treat it as **untrusted and potentially hostile**. Users can mutate frontend state, bypass client validation via dev tools, and fire raw HTTP requests directly at any endpoint.

Therefore the Express backend independently, on every request:

- Authenticates the caller.
- Enforces granular role-based access control (RBAC) — verify the caller is *authorized for this specific resource*, not merely logged in.
- Parses and validates every payload shape before any domain logic runs.
- Enforces all data-integrity invariants server-side.

Never trust a value because the frontend "should have" validated it. Re-derive and re-check everything that gates a state transition (prices, share counts, escrow amounts, role claims).

### 1.2 Descriptive, Intentional Naming

Every variable, function, parameter, type, and class name must state a real domain concept.

- **Banned:** cryptic or single-letter names — `a`, `b`, `p`, `t`, `val`, `data`, `tmp`. *(Exception: the standard Express `next` parameter in handler signatures.)*
- **Required:** explicit compound names — `targetInvestorProfileId`, `calculateEscrowServiceFee`, `projectFeasibilitySurveyResult`, `allocatedEquitySharesCount`.

Names are documentation. A reader should understand intent without chasing the definition.

---

## 2. Rust-Inspired Type Discipline

This is a heavy-logic backend. **Loose typing, implicit `any`, unchecked type assertions (`as Type`), and catch-all `try/catch` are prohibited.** Compile-time invariants plus strict runtime parsing eliminate ambiguity and prevent logic drift.

Four guiding habits:

1. **Parse, don't validate.** Raw untrusted data never reaches business logic. Parse it into a typed domain model at the controller boundary with Zod.
2. **Make illegal states unrepresentable.** Use discriminated unions, not bags of optional flags.
3. **Explicit failure paths.** Expected operational failures (entity not found, payment declined) are *return values*, not thrown exceptions. Reserve `throw` for unrecoverable programmer/environment errors.
4. **Immutable by default.** Treat domain entities as read-only; produce new objects instead of mutating in place.

---

## 3. Pattern Library

### 3.1 Boundary Validation (Express Controllers & Middleware)

Never write `req.body as SomeType`. Parse every `body`, `params`, and `query` with Zod via `safeParse`. Use `.strict()` to reject unknown keys (or `.strip()` to silently drop them — choose deliberately).

```typescript
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// Strict domain primitive
export const ProductIdSchema = z
  .string()
  .regex(/^prd_[a-zA-Z0-9]+$/, 'Invalid Product ID format');
export type ProductId = z.infer<typeof ProductIdSchema>;

export const CreateProductSchema = z
  .object({
    name: z.string().min(1),
    price: z.number().positive(),
  })
  .strict(); // reject unexpected properties
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const handleCreateProduct = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const parsedRequest = CreateProductSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    return res.status(422).json({
      status: 'error',
      errors: parsedRequest.error.flatten().fieldErrors,
    });
  }

  // parsedRequest.data is now fully trusted and typed.
  const createResult = await ProductService.create(parsedRequest.data);

  if (!createResult.success) {
    return res.status(409).json({ status: 'error', error: createResult.error });
  }

  return res.status(201).json(createResult.value);
};
```

Rules:

- Parse failure → **`422 Unprocessable Entity`** with `flatten().fieldErrors`.
- Derive the input type with `z.infer` — never hand-write a parallel `interface`.
- Prefer a reusable `validateBody(schema)` middleware over repeating the `safeParse` block.

### 3.2 Impossible States — Discriminated Unions

Do not model a process with independent optional flags (`isLoading?`, `error?`, `data?`) — that permits contradictory states (data *and* error at once). Use one string-literal `status` discriminant, and enforce exhaustiveness with `never`.

```typescript
type CheckoutState =
  | { status: 'empty' }
  | { status: 'processing'; cartId: string }
  | { status: 'failed'; cartId: string; reason: string }
  | { status: 'completed'; cartId: string; receiptId: string; total: number };

function getStatusMessage(state: CheckoutState): string {
  switch (state.status) {
    case 'empty':
      return 'No items in cart.';
    case 'processing':
      return `Processing checkout for cart ${state.cartId}`;
    case 'failed':
      return `Checkout failed: ${state.reason}`;
    case 'completed':
      return `Success! Receipt: ${state.receiptId}`;
    default: {
      // Adding a new status without handling it breaks the build here.
      const _exhaustiveCheck: never = state;
      throw new Error(`Unhandled checkout state: ${JSON.stringify(_exhaustiveCheck)}`);
    }
  }
}
```

### 3.3 Explicit Failures over Exception Trees

Predictable domain failures return a `Result` union. Both branches must be handled at the call site.

```typescript
export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

type PaymentError =
  | { type: 'INSUFFICIENT_FUNDS'; balance: number }
  | { type: 'CARD_EXPIRED'; expiryDate: string }
  | { type: 'GATEWAY_TIMEOUT' };

export async function processPayment(
  userId: string,
  amount: number,
): Promise<Result<{ chargeId: string }, PaymentError>> {
  const account = await db.findAccount(userId);

  if (account.balance < amount) {
    return {
      success: false,
      error: { type: 'INSUFFICIENT_FUNDS', balance: account.balance },
    };
  }

  // ... execute charge ...
  return { success: true, value: { chargeId: 'ch_12345' } };
}
```

`throw` is allowed **only** for the unrecoverable: lost DB connection, missing required env var, assertion of an invariant that should be physically impossible.

### 3.4 Immutable Data & Local Mutations

Mark entity properties and function inputs `readonly`. State transitions return a new reference; they never mutate the input.

```typescript
interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly permissions: readonly string[];
}

// WRONG — mutates the input
// function grantAdmin(user: UserProfile) { user.permissions.push('admin'); }

// RIGHT — returns a modified clone
function grantAdmin(user: UserProfile): UserProfile {
  return {
    ...user,
    permissions: [...user.permissions, 'admin'],
  };
}
```

---

## 4. Enforcement Checklist

Run this before declaring any backend change complete:

- [ ] No `any` and no type assertions (`as`). Types are inferred or explicitly declared.
- [ ] Every route input (`body`, `params`, `query`) is parsed with a Zod schema via `.safeParse()`; parse failures return `422`.
- [ ] Input types come from `z.infer`, not hand-written duplicates.
- [ ] Business methods return `Result<T, E>` for domain errors; `throw` is reserved for unrecoverable faults.
- [ ] Multi-state values use a discriminated union with a `status` field — no optional-flag soup.
- [ ] Every `switch` on a domain discriminant has a `never` exhaustiveness default.
- [ ] Entities and inputs are `readonly`; state transitions return new objects.
- [ ] Every endpoint authenticates **and** authorizes the caller against the specific resource.
- [ ] Names are descriptive domain terms — no `a`, `val`, `tmp`, bare `data`.
