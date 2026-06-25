import { randomBytes, randomInt } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, ne } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { handleReservation, user } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * Handle policy constants. The server is the SOLE authority for these
 * (CLAUDE.md §1.1); the frontend may preview them but never enforces them.
 */
/** Allowed handle changes per rolling rate-limit window. */
export const MAX_HANDLE_CHANGES_PER_WINDOW = 2;
/** Length of the rate-limit window AND the post-change reservation hold. */
const HANDLE_WINDOW_DAYS = 14;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const HANDLE_WINDOW_MS = HANDLE_WINDOW_DAYS * MILLISECONDS_PER_DAY;

/**
 * The one true handle shape: 3–30 chars of lowercase letters, digits, dot,
 * underscore or hyphen. Applied AFTER normalization, server-side, on every path
 * (availability check and the authoritative set). The frontend's identical check
 * is UX only.
 */
const HANDLE_REGEX = /^[a-z0-9._-]{3,30}$/;

function addMilliseconds(base: Date, milliseconds: number): Date {
  return new Date(base.getTime() + milliseconds);
}

/**
 * Normalize a raw, untrusted handle into canonical storage form: strip
 * surrounding whitespace, drop a single leading "@" (display-only sugar), and
 * lowercase. Pure — does not validate length/charset (that's the regex's job).
 */
export function normalizeHandle(rawHandle: string): string {
  return rawHandle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Parse failure for a handle that survives normalization but fails the regex.
 * The `reason` is a user-facing sentence the panel can show verbatim.
 */
export type HandleValidationError = { type: "INVALID"; reason: string };

/**
 * Normalize + regex-validate a raw handle. Returns the canonical handle on
 * success. This is the single gate every server path runs before touching the DB.
 */
export function validateHandle(rawHandle: string): Result<string, HandleValidationError> {
  const normalized = normalizeHandle(rawHandle);

  if (normalized.length < 3 || normalized.length > 30) {
    return {
      success: false,
      error: { type: "INVALID", reason: "Handle must be 3–30 characters." },
    };
  }

  if (!HANDLE_REGEX.test(normalized)) {
    return {
      success: false,
      error: {
        type: "INVALID",
        reason: "Handle may use only lowercase letters, numbers, dots, underscores and hyphens.",
      },
    };
  }

  return { success: true, value: normalized };
}

/**
 * Derived rate-limit state for a user, computed purely from the stored window
 * columns and the current time. The window is "active" while NOW is inside
 * windowStartedAt + 14d; outside it, the user starts fresh with a full allowance.
 */
interface RateLimitWindowState {
  readonly changesRemaining: number;
  readonly isChangeLocked: boolean;
  /** When the active window (and thus any lock) clears; null when no active window. */
  readonly cooldownResetAt: Date | null;
}

function computeRateLimitWindow(
  windowStartedAt: Date | null,
  changeCount: number,
  now: Date,
): RateLimitWindowState {
  const windowEndsAt = windowStartedAt ? addMilliseconds(windowStartedAt, HANDLE_WINDOW_MS) : null;
  const isWindowActive = windowEndsAt !== null && now < windowEndsAt;

  const changesUsed = isWindowActive ? changeCount : 0;
  const changesRemaining = Math.max(0, MAX_HANDLE_CHANGES_PER_WINDOW - changesUsed);
  const isChangeLocked = isWindowActive && changesRemaining === 0;

  return {
    changesRemaining,
    isChangeLocked,
    cooldownResetAt: isChangeLocked ? windowEndsAt : null,
  };
}

/**
 * Panel bootstrap payload — GET /users/me/handle. Mirrors the metadata the
 * frontend needs to render the editor, the rate-limit notice, and a one-tap
 * revert affordance, without leaking handle internals onto every session.
 */
export interface HandleMetadata {
  readonly handle: string | null;
  readonly maxChanges: number;
  readonly changesRemaining: number;
  readonly isChangeLocked: boolean;
  readonly cooldownResetAt: Date | null;
  readonly revertableHandle: string | null;
  readonly revertableExpiresAt: Date | null;
}

export type HandleMetadataError = { type: "USER_NOT_FOUND"; userId: string };

/**
 * Read a user's current handle plus rate-limit and revert metadata. `userId`
 * MUST come from the server-derived session (CLAUDE.md §1.1).
 */
export async function getHandleMetadata(
  userId: string,
): Promise<Result<HandleMetadata, HandleMetadataError>> {
  const now = new Date();

  const [userRow] = await db
    .select({
      handle: user.handle,
      handleChangeCount: user.handleChangeCount,
      handleWindowStartedAt: user.handleWindowStartedAt,
    })
    .from(user)
    .where(eq(user.id, userId));

  if (!userRow) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }

  const window = computeRateLimitWindow(
    userRow.handleWindowStartedAt,
    userRow.handleChangeCount,
    now,
  );

  // The most recently parked, still-live reservation owned by this user is the
  // one the panel offers to revert to (Case 2).
  const [revertable] = await db
    .select({
      reservedHandle: handleReservation.reservedHandle,
      expiresAt: handleReservation.expiresAt,
    })
    .from(handleReservation)
    .where(and(eq(handleReservation.userId, userId), gt(handleReservation.expiresAt, now)))
    .orderBy(handleReservation.expiresAt)
    .limit(1);

  return {
    success: true,
    value: {
      handle: userRow.handle,
      maxChanges: MAX_HANDLE_CHANGES_PER_WINDOW,
      changesRemaining: window.changesRemaining,
      isChangeLocked: window.isChangeLocked,
      cooldownResetAt: window.cooldownResetAt,
      revertableHandle: revertable?.reservedHandle ?? null,
      revertableExpiresAt: revertable?.expiresAt ?? null,
    },
  };
}

/**
 * Result of the Tier-1 live availability probe. Discriminated by `status`:
 * - available  : free to claim (absent everywhere, or only an expired hold).
 * - taken      : held by someone else (active) → offer free `suggestions`.
 * - revertable : the caller's own live reservation → a one-tap Case-2 revert.
 * - current    : already the caller's active handle → a no-op.
 * - invalid    : failed normalization/regex → carries a user-facing `reason`.
 */
export type HandleAvailability =
  | { status: "available"; handle: string }
  | { status: "taken"; handle: string; suggestions: readonly string[] }
  | { status: "revertable"; handle: string; expiresAt: Date }
  | { status: "current"; handle: string }
  | { status: "invalid"; handle: string; reason: string };

/**
 * Build up to four free handle variants to offer when the requested one is
 * taken. Candidates are generated deterministically from the base, then filtered
 * to those that pass validation AND are not currently occupied (by a user's
 * active handle or a live reservation).
 */
async function suggestFreeHandles(baseHandle: string): Promise<readonly string[]> {
  const now = new Date();

  // Deterministic candidate set; trimmed to <=30 chars so long bases still yield
  // valid suggestions.
  const rawCandidates = [
    `${baseHandle}1`,
    `${baseHandle}_`,
    `${baseHandle}_x`,
    `${baseHandle}26`,
    `${baseHandle}.dev`,
    `the_${baseHandle}`,
  ];

  const candidates = [
    ...new Set(
      rawCandidates
        .map((candidate) => candidate.slice(0, 30))
        .filter((candidate) => HANDLE_REGEX.test(candidate) && candidate !== baseHandle),
    ),
  ];

  if (candidates.length === 0) {
    return [];
  }

  const occupiedByUser = await db
    .select({ handle: user.handle })
    .from(user)
    .where(inArray(user.handle, candidates));

  const occupiedByLiveReservation = await db
    .select({ reservedHandle: handleReservation.reservedHandle })
    .from(handleReservation)
    .where(
      and(
        inArray(handleReservation.reservedHandle, candidates),
        gt(handleReservation.expiresAt, now),
      ),
    );

  const occupied = new Set<string>([
    ...occupiedByUser
      .map((row) => row.handle)
      .filter((handle): handle is string => handle !== null),
    ...occupiedByLiveReservation.map((row) => row.reservedHandle),
  ]);

  return candidates.filter((candidate) => !occupied.has(candidate)).slice(0, 4);
}

/**
 * Tier-1 read-only availability check (debounced from the client; rate-limited at
 * the route). Implements the spec's Availability stage including the lazy read of
 * expired holds as "available". `userId` distinguishes the caller's own
 * current/revertable handle from a stranger's taken one.
 */
export async function checkHandleAvailability(
  rawHandle: string,
  userId: string,
): Promise<HandleAvailability> {
  const validation = validateHandle(rawHandle);
  if (!validation.success) {
    return {
      status: "invalid",
      handle: normalizeHandle(rawHandle),
      reason: validation.error.reason,
    };
  }

  const normalized = validation.value;
  const now = new Date();

  const [owningUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.handle, normalized));

  if (owningUser) {
    return owningUser.id === userId
      ? { status: "current", handle: normalized }
      : { status: "taken", handle: normalized, suggestions: await suggestFreeHandles(normalized) };
  }

  const [reservation] = await db
    .select({
      userId: handleReservation.userId,
      expiresAt: handleReservation.expiresAt,
    })
    .from(handleReservation)
    .where(eq(handleReservation.reservedHandle, normalized));

  // No reservation, or an expired hold (Condition B) → free to claim.
  if (!reservation || reservation.expiresAt <= now) {
    return { status: "available", handle: normalized };
  }

  // A live reservation: the caller's own is revertable; anyone else's is taken.
  return reservation.userId === userId
    ? { status: "revertable", handle: normalized, expiresAt: reservation.expiresAt }
    : { status: "taken", handle: normalized, suggestions: await suggestFreeHandles(normalized) };
}

/**
 * Domain failures for {@link setHandle}. Each maps to a distinct HTTP status in
 * the controller. RATE_LIMITED carries the reset instant the 429 surfaces.
 */
export type SetHandleError =
  | HandleValidationError
  | { type: "USER_NOT_FOUND"; userId: string }
  | { type: "TAKEN" }
  | { type: "RATE_LIMITED"; cooldownResetAt: Date };

/**
 * Successful set/revert outcome — the new active handle and the post-change
 * rate-limit state the panel echoes back.
 */
export interface SetHandleSuccess {
  readonly handle: string;
  readonly changesRemaining: number;
  readonly cooldownResetAt: Date | null;
}

/**
 * Postgres unique-violation SQLSTATE. The user.handle UNIQUE and
 * handle_reservations PK are the real race guards behind the SELECT-based
 * availability re-check; a concurrent claim that beats us surfaces here.
 */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Tier-2 authoritative set/revert — the trust boundary (CLAUDE.md §1.1, §3.3).
 * Runs the full atomic transaction: lock the user row, enforce the rate limit,
 * re-check availability under lock, then execute Case 1 (claim a new handle,
 * parking the old one for 14 days) or Case 2 (revert to the caller's own live
 * reservation). The case is detected server-side from ownership — the client
 * never picks it. `userId` MUST come from the session.
 */
export async function setHandle(
  userId: string,
  rawHandle: string,
): Promise<Result<SetHandleSuccess, SetHandleError>> {
  const validation = validateHandle(rawHandle);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  const targetHandle = validation.value;
  const now = new Date();
  const newReservationExpiry = addMilliseconds(now, HANDLE_WINDOW_MS);

  try {
    return await db.transaction(async (tx) => {
      // Lock the caller's row for the duration: serializes concurrent changes by
      // the same user and pins the rate-limit counters we read+write.
      const [userRow] = await tx
        .select({
          handle: user.handle,
          handleChangeCount: user.handleChangeCount,
          handleWindowStartedAt: user.handleWindowStartedAt,
        })
        .from(user)
        .where(eq(user.id, userId))
        .for("update");

      if (!userRow) {
        return { success: false, error: { type: "USER_NOT_FOUND", userId } } as const;
      }

      // No-op: already the caller's active handle. Don't consume a change.
      if (userRow.handle === targetHandle) {
        const window = computeRateLimitWindow(
          userRow.handleWindowStartedAt,
          userRow.handleChangeCount,
          now,
        );
        return {
          success: true,
          value: {
            handle: targetHandle,
            changesRemaining: window.changesRemaining,
            cooldownResetAt: window.cooldownResetAt,
          },
        } as const;
      }

      // Rate limit (server is the authority).
      const window = computeRateLimitWindow(
        userRow.handleWindowStartedAt,
        userRow.handleChangeCount,
        now,
      );
      if (window.isChangeLocked && window.cooldownResetAt) {
        return {
          success: false,
          error: { type: "RATE_LIMITED", cooldownResetAt: window.cooldownResetAt },
        } as const;
      }

      // Re-check availability under lock on any existing reservation for the target.
      const [targetReservation] = await tx
        .select({
          userId: handleReservation.userId,
          expiresAt: handleReservation.expiresAt,
        })
        .from(handleReservation)
        .where(eq(handleReservation.reservedHandle, targetHandle))
        .for("update");

      const isStrangerLiveReservation =
        targetReservation !== undefined &&
        targetReservation.userId !== userId &&
        targetReservation.expiresAt > now;

      if (isStrangerLiveReservation) {
        return { success: false, error: { type: "TAKEN" } } as const;
      }

      // Another user actively holding the handle blocks it (their own current is
      // the no-op handled above; the only rows left here are strangers').
      const [conflictingUser] = await tx
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.handle, targetHandle), ne(user.id, userId)))
        .for("update");

      if (conflictingUser) {
        return { success: false, error: { type: "TAKEN" } } as const;
      }

      // Drop any reservation sitting on the target: either the caller's own live
      // one being reclaimed (Case 2), or an expired stranger's hold (Condition B,
      // Case 1). Both must be cleared before we (re)assign the handle.
      if (targetReservation) {
        await tx
          .delete(handleReservation)
          .where(eq(handleReservation.reservedHandle, targetHandle));
      }

      // Park the handle the caller is leaving (if any) for 14 days so it can be
      // reverted and isn't immediately grabbable. Defensive pre-delete keeps the
      // PK insert clean if a stale row somehow exists for it.
      if (userRow.handle !== null) {
        const previousHandle = userRow.handle;
        await tx
          .delete(handleReservation)
          .where(eq(handleReservation.reservedHandle, previousHandle));
        await tx.insert(handleReservation).values({
          reservedHandle: previousHandle,
          userId,
          expiresAt: newReservationExpiry,
        });
      }

      // Advance the rate-limit window: continue the active one, else open a fresh
      // one starting now.
      const windowEndsAt = userRow.handleWindowStartedAt
        ? addMilliseconds(userRow.handleWindowStartedAt, HANDLE_WINDOW_MS)
        : null;
      const isWindowActive = windowEndsAt !== null && now < windowEndsAt;
      const nextWindowStartedAt =
        isWindowActive && userRow.handleWindowStartedAt ? userRow.handleWindowStartedAt : now;
      const nextChangeCount = isWindowActive ? userRow.handleChangeCount + 1 : 1;

      await tx
        .update(user)
        .set({
          handle: targetHandle,
          handleUpdatedAt: now,
          handleWindowStartedAt: nextWindowStartedAt,
          handleChangeCount: nextChangeCount,
        })
        .where(eq(user.id, userId));

      const postChangeWindow = computeRateLimitWindow(nextWindowStartedAt, nextChangeCount, now);

      return {
        success: true,
        value: {
          handle: targetHandle,
          changesRemaining: postChangeWindow.changesRemaining,
          cooldownResetAt: postChangeWindow.cooldownResetAt,
        },
      } as const;
    });
  } catch (error) {
    // A concurrent claim won the race between our SELECT re-check and write.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "TAKEN" } };
    }
    throw error;
  }
}

/** Max length of a stored handle — keeps generated placeholders inside the regex. */
const MAX_HANDLE_LENGTH = 30;
/** Fixed prefix every auto-generated placeholder carries. */
const PLACEHOLDER_PREFIX = "user_";
/** How many candidates to try before falling back to a fully generic handle. */
const PLACEHOLDER_BASE_ATTEMPTS = 4;
const PLACEHOLDER_MAX_ATTEMPTS = 8;

/**
 * Reduce a raw fragment (a name token or email local-part) to handle-safe
 * characters: lowercase, runs of anything else collapsed to a single underscore,
 * and trimmed of leading/trailing underscores. May return "" (caller falls back).
 */
function sanitizeHandleFragment(rawFragment: string): string {
  return rawFragment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Derive the human-recognizable middle of a placeholder handle: the first name
 * token if present, else the email local-part. Returns null when neither yields
 * any usable characters (→ a fully generic numeric handle).
 */
function derivePlaceholderBase(fullName: string | null, email: string | null): string | null {
  const firstNameToken = fullName?.trim().split(/\s+/)[0] ?? "";
  const fromName = sanitizeHandleFragment(firstNameToken);
  if (fromName.length > 0) {
    return fromName;
  }

  const emailLocalPart = email?.split("@")[0] ?? "";
  const fromEmail = sanitizeHandleFragment(emailLocalPart);
  if (fromEmail.length > 0) {
    return fromEmail;
  }

  return null;
}

/**
 * Build one placeholder candidate. With a base: `user_<base>_<4 hex>` (base
 * trimmed so the whole thing fits 30 chars). Without one: `user_<8 digits>`.
 * The random suffix is what makes it unique; collisions are retried by the caller.
 */
function buildPlaceholderCandidate(base: string | null): string {
  if (base === null) {
    return `${PLACEHOLDER_PREFIX}${randomInt(10_000_000, 100_000_000)}`;
  }

  const randomSuffix = randomBytes(2).toString("hex"); // 4 hex chars
  const reservedLength = PLACEHOLDER_PREFIX.length + 1 + randomSuffix.length; // prefix + "_" + suffix
  const trimmedBase = base.slice(0, MAX_HANDLE_LENGTH - reservedLength).replace(/_+$/, "");

  // If trimming wiped the base entirely, drop to the generic numeric form.
  if (trimmedBase.length === 0) {
    return `${PLACEHOLDER_PREFIX}${randomInt(10_000_000, 100_000_000)}`;
  }

  return `${PLACEHOLDER_PREFIX}${trimmedBase}_${randomSuffix}`;
}

/** True if a handle is free of any active claim (user.handle or a live reservation). */
async function isHandleClaimable(candidate: string, now: Date): Promise<boolean> {
  const [owningUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.handle, candidate));
  if (owningUser) {
    return false;
  }

  const [liveReservation] = await db
    .select({ reservedHandle: handleReservation.reservedHandle })
    .from(handleReservation)
    .where(
      and(eq(handleReservation.reservedHandle, candidate), gt(handleReservation.expiresAt, now)),
    );

  return !liveReservation;
}

/** Failure of {@link assignPlaceholderHandle} — only after exhausting all attempts. */
export type AssignPlaceholderHandleError = { type: "EXHAUSTED" };

/**
 * Seed a brand-new user with a unique, randomized temporary handle derived from
 * their name or email (e.g. "Vidyesh Churi" → `user_vidyesh_7a9f`,
 * `trading_dev@gmail.com` → `user_trading_dev_3b1c`, no name → `user_84920482`).
 *
 * Called from the Better Auth user-create hook (src/lib/auth.ts). The first few
 * attempts use the name/email base; later attempts and any all-symbol input fall
 * back to a generic numeric handle. Stored directly as the active handle WITHOUT
 * touching the rate-limit window — the user keeps their full change allowance.
 *
 * Returns the assigned handle, or null if the user already has one (idempotent /
 * never clobbers). The user.handle UNIQUE constraint is the final race guard:
 * a concurrent claim surfaces as a 23505 and we retry with a fresh suffix.
 */
export async function assignPlaceholderHandle(
  userId: string,
  fullName: string | null,
  email: string | null,
): Promise<Result<string | null, AssignPlaceholderHandleError>> {
  const base = derivePlaceholderBase(fullName, email);
  const now = new Date();

  for (let attempt = 0; attempt < PLACEHOLDER_MAX_ATTEMPTS; attempt++) {
    const candidate = buildPlaceholderCandidate(attempt < PLACEHOLDER_BASE_ATTEMPTS ? base : null);

    // Cheap pre-check skips most collisions (incl. live reservations, which the
    // UNIQUE constraint alone wouldn't catch); the constraint is the backstop.
    if (!(await isHandleClaimable(candidate, now))) {
      continue;
    }

    try {
      // Only seed when still unclaimed — never overwrite an existing handle.
      const [updated] = await db
        .update(user)
        .set({ handle: candidate })
        .where(and(eq(user.id, userId), isNull(user.handle)))
        .returning({ handle: user.handle });

      // No row updated → user vanished or already had a handle. Either way, done.
      return { success: true, value: updated?.handle ?? null };
    } catch (error) {
      if (isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  return { success: false, error: { type: "EXHAUSTED" } };
}

/**
 * Daily cron helper: hard-delete every dead reservation. Lazy reads already treat
 * expired holds as available, so this only keeps the table small. Returns the
 * number of rows removed.
 */
export async function purgeExpiredHandleReservations(): Promise<number> {
  const now = new Date();
  const deleted = await db
    .delete(handleReservation)
    .where(lte(handleReservation.expiresAt, now))
    .returning({ reservedHandle: handleReservation.reservedHandle });
  return deleted.length;
}
