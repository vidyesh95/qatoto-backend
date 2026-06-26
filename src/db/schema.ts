import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";

// Provenance of `user.image`. "oauth" = seeded from a Google/GitHub profile;
// "user" = the user uploaded their own photo (PATCH /users/me/photo). NULL = no
// image. "user" is a lock: OAuth must never overwrite a user-owned photo, exactly
// like nameSetByUser guards the display name. See src/lib/auth.ts databaseHooks.
export const imageSourceEnum = pgEnum("image_source", ["oauth", "user"]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // True once the user explicitly set their own name (PATCH /users/me). OAuth
  // seeds `name` at first sign-in; this flag marks it as user-owned so account
  // linking never overwrites it. See src/lib/auth.ts accountLinking.
  nameSetByUser: boolean("name_set_by_user").default(false).notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  // Who owns `image` — see imageSourceEnum. NULL until an image is set.
  imageSource: imageSourceEnum("image_source"),
  // The user's current active handle (stored normalized: lowercased, no leading
  // "@"). UNIQUE so two users can never hold the same handle; NULL until claimed
  // (Postgres UNIQUE permits many NULLs). The leading "@" is a display concern the
  // client adds — never stored here. Exposed on the session via Better Auth
  // additionalFields (src/lib/auth.ts) so session.user.handle drives menu/avatar.
  handle: text("handle").unique(),
  // Timestamp of the last successful handle change. NULL until first change.
  handleUpdatedAt: timestamp("handle_updated_at"),
  // Rate-limit bookkeeping: how many changes the user has made inside the CURRENT
  // 14-day window, and when that window opened. A change consumes one; at
  // MAX_HANDLE_CHANGES_PER_WINDOW the user is locked until windowStartedAt + 14d.
  // See src/services/handle.service.ts (computeRateLimitWindow). The server is the
  // sole authority for this (CLAUDE.md §1.1) — the client only previews the lock.
  handleChangeCount: integer("handle_change_count").default(0).notNull(),
  handleWindowStartedAt: timestamp("handle_window_started_at"),
  // The user's BACKUP "account recovery" email — a SECOND address, distinct from
  // the primary login `email` above. It is NOT a login identifier: you cannot sign
  // in with it, and it is deliberately NOT UNIQUE (unlike `email`/`handle`). A
  // recovery email is a backup, not an identity — a shared family/admin inbox is a
  // legitimate case, and a UNIQUE index would also leak (an enumeration oracle:
  // "this address is already in use"). The real anti-abuse guard is that you can
  // only store an address you can read mail at — ownership is proven by an OTP sent
  // to it (recovery_email_otp below). Stored normalized (trimmed, lowercased).
  recoveryEmail: text("recovery_email"),
  // True only once the user proved they can read mail at `recoveryEmail` (via the
  // OTP). Reset to false on any change; flips true only after re-verification —
  // exactly how emailVerified guards the primary email. An UNVERIFIED recovery
  // email must NEVER be usable to recover the account (see recovery flow).
  recoveryEmailVerified: boolean("recovery_email_verified").default(false).notNull(),
  // Timestamp of the last successful recovery-email change. NULL until first set.
  recoveryEmailUpdatedAt: timestamp("recovery_email_updated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  isAnonymous: boolean("is_anonymous").default(false),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("passkey_userId_idx").on(table.userId)],
);

// A handle a user PREVIOUSLY held, parked for 14 days after they changed away
// from it. While the row exists with expires_at > NOW() it is (a) blocked from
// anyone else claiming it and (b) revertable by its owner (Case 2). Once
// expires_at < NOW() the hold is dead: it reads as available to everyone and is
// lazy-deleted on the next touch (plus a daily cron sweep). reserved_handle is
// the PK — it is the normalized handle string, so the table can hold at most one
// reservation per handle, mirroring user.handle's UNIQUE.
export const handleReservation = pgTable(
  "handle_reservations",
  {
    reservedHandle: text("reserved_handle").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("handle_reservations_userId_idx").on(table.userId),
    index("handle_reservations_expiresAt_idx").on(table.expiresAt),
  ],
);

// A short-lived, single-use OTP proving the user can read mail at a candidate
// recovery address. We CANNOT reuse Better Auth's own OTP endpoints for this:
// with `disableSignUp: true` (src/lib/auth.ts), sendVerificationOTP silently
// no-ops and checkVerificationOTP throws USER_NOT_FOUND for any email that isn't
// already a user — and a recovery address is, by definition, not a login email.
// So we own this OTP end-to-end, mirroring the verification table's contract:
// hashed (argon2 — never plaintext), expiring, single-use, attempt-capped.
//
// One pending challenge per user PER PURPOSE: the composite PK (userId, purpose)
// means a re-request for the same purpose overwrites the old row. `purpose` is
// 'verify_address' (Half 1: prove a NEW backup address) or 'reset_password'
// (Half 2: recover the account via the already-verified backup address).
export const recoveryEmailOtp = pgTable(
  "recovery_email_otp",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    // The address the code was sent to. For 'verify_address' this is the NEW
    // candidate (not yet stored on user); for 'reset_password' it's the already
    // verified user.recoveryEmail. Kept so verify can persist exactly what was proven.
    candidateEmail: text("candidate_email").notNull(),
    otpHash: text("otp_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    // Brute-force budget for the 6-digit code (10^6 space). Mirrors Better Auth's
    // own per-OTP `allowedAttempts` (default 3): the row is destroyed once exceeded.
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.purpose] })],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
  handleReservations: many(handleReservation),
  recoveryEmailOtps: many(recoveryEmailOtp),
}));

export const recoveryEmailOtpRelations = relations(recoveryEmailOtp, ({ one }) => ({
  user: one(user, {
    fields: [recoveryEmailOtp.userId],
    references: [user.id],
  }),
}));

export const handleReservationRelations = relations(handleReservation, ({ one }) => ({
  user: one(user, {
    fields: [handleReservation.userId],
    references: [user.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));
