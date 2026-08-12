import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  check,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { citext, platformRoleEnum } from "#src/db/schema/_primitives.js";
import { commerceOrganization } from "#src/db/schema/store.js";

// Provenance of `user.image`. "oauth" = seeded from a Google/GitHub profile;
// "user" = the user uploaded their own photo (PATCH /users/me/photo). NULL = no
// image. "user" is a lock: OAuth must never overwrite a user-owned photo, exactly
// like nameSetByUser guards the display name. See src/lib/auth.ts databaseHooks.
export const imageSourceEnum = pgEnum("image_source", ["oauth", "user"]);

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // True once the user explicitly set their own name (PATCH /users/me). OAuth
    // seeds `name` at first sign-in; this flag marks it as user-owned so account
    // linking never overwrites it. See src/lib/auth.ts accountLinking.
    nameSetByUser: boolean("name_set_by_user").default(false).notNull(),
    // citext (case-insensitive) + UNIQUE: one email = one user, regardless of the
    // case a provider reports it in. See the `citext` type note above.
    email: citext("email").notNull().unique(),
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
    // A free-text, self-set place ("Pune, India"). NULL until the user sets one.
    //
    // A CLAIM, NOT A FACT, and every surface that renders it must read as one. It is
    // not geocoded, not verified, and deliberately NOT the geo signal for anything:
    // §6's problem submissions carry their own resolved coordinates from
    // `geocode_cache`, and CLAUDE.md §1.1 forbids trusting a client-claimed country
    // for tax, pricing, fraud or geo-restriction. This column exists so a §10
    // discussion post can say where its author says they are — nothing else may read
    // it.
    locationLabel: text("location_label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    isAnonymous: boolean("is_anonymous").default(false),
    // §4a Layer 3. NULL for ordinary users. There is deliberately NO endpoint, no Zod
    // schema and no Better Auth additionalField that writes this: a self-grantable
    // staff role would defeat category moderation and the §7 four-eyes escrow rule at
    // once. Grants are a DBA action. Keep it OUT of every public user projection and
    // out of src/lib/auth.ts additionalFields, which would put it on the
    // client-visible session.
    platformRole: platformRoleEnum("platform_role"),
  },
  (table) => [
    // Partial: staff are a handful of rows out of the whole user table, so the index
    // only carries them.
    index("user_platformRole_idx")
      .on(table.platformRole)
      .where(sql`platform_role IS NOT NULL`),
  ],
);

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
    // Server-selected commerce tenant context. Nullable for users with no commerce
    // membership and during the Phase 0 expand rollout. Every request using it must
    // still re-check an active membership; possession of a session is not authorization.
    activeOrganizationId: text("active_organization_id").references(
      (): AnyPgColumn => commerceOrganization.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("session_userId_idx").on(table.userId),
    index("session_activeOrganizationId_idx")
      .on(table.activeOrganizationId)
      .where(sql`active_organization_id IS NOT NULL`),
  ],
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
    // The email this provider knows the user by — the address shown next to each
    // "Connected" provider in the settings panel. NULL on purpose: credential rows
    // resolve their email from user.email (never stored here, so it can't drift),
    // and pre-existing OAuth rows stay NULL until the backfill (or a fresh sign-in)
    // populates them. Write-once at account creation from the provider profile
    // (Google id_token email claim / GitHub primary verified email) — see the
    // account.create hook in src/lib/auth.ts. NOT a login identifier and
    // deliberately NOT unique: two providers can legitimately report the same
    // address. Never expose alongside tokens. See GET /users/me/linked-accounts.
    // citext to match user.email's case-insensitive semantics.
    email: citext("email"),
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

// One rate-limit window, shared by every API instance (§11l.2 item 7). The per-process
// MemoryStore express-rate-limit ships with is not a bound once more than one instance
// runs, and it resets on every restart — a deploy handed an attacker a fresh OTP budget.
//
// COMPOSITE PK, not a concatenated "namespace:key" string, and that is a security choice
// rather than a style one. `emailKey` in src/middleware/rate-limit.ts derives its key from
// the request BODY, so with a delimiter an email of "otpRequestIp:1.2.3.4" would land in
// the per-IP limiter's bucket. Two columns cannot be collided that way. It also makes
// resetAll a PK-prefix DELETE and lets `GROUP BY namespace` name the hot limiter.
//
// NO SURROGATE ID: nothing references a bucket, so a uuid would be dead weight and a
// randomUUID() call on a hot path. NO created_at: the row is UPDATEd in place across many
// windows, so it would record the first hit ever rather than this window's start — a
// reader would take it for the window start and be wrong. The window start is
// `expires_at` minus the limiter's windowMs. NO FK to `user`: the key is a user id OR an
// IP OR an email, so two of the three could never satisfy one.
//
// This is a CACHE, not a ledger. Truncating it resets every live window and nothing else.
export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    /** The limiter's own name. One namespace per limiter; duplicates throw at boot. */
    namespace: text("namespace").notNull(),
    /** The keyGenerator's output — a user id, an IP, or a hash of an oversized key. */
    bucketKey: text("bucket_key").notNull(),
    hitCount: integer("hit_count").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.bucketKey] }),
    // For the retention sweep. Live keys rewrite their own row, so only ABANDONED keys
    // accumulate — but a cache still must not grow forever.
    index("rate_limit_bucket_expiresAt_idx").on(table.expiresAt),
    // An assertion that the store's key normalizer ran, not a validation of user input.
    // `emailKey` reads an unbounded body field, and a btree index row caps at ~2704 bytes,
    // so an oversized key would be an attacker-triggerable write failure on the OTP path.
    // The store hashes anything longer to `sha256:<hex>` before it reaches SQL.
    check("rate_limit_bucket_key_ck", sql`char_length(bucket_key) BETWEEN 1 AND 256`),
    check("rate_limit_bucket_hits_ck", sql`hit_count >= 0`),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
  handleReservations: many(handleReservation),
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
  activeOrganization: one(commerceOrganization, {
    fields: [session.activeOrganizationId],
    references: [commerceOrganization.id],
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
