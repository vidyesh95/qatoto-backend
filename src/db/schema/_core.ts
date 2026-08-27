import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  check,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  citext,
  platformRoleEnum,
  userModerationActionKindEnum,
  userProfileModerationStateEnum,
  userReportReasonEnum,
  userReportStatusEnum,
} from "#src/db/schema/_primitives.js";
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
    // See src/modules/auth/handles/handle.service.ts (computeRateLimitWindow). The server is the
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
    /**
     * The channel description — public free text, rendered on `/channel/:handle`.
     *
     * NULLABLE, AND NOT ONLY AS A STYLE CHOICE. `scripts/verify-anonymization-coverage.ts` seeds
     * its probe user with a fixed column list, so a NOT NULL column with no default here breaks
     * the verifier itself before it can check anything.
     *
     * IT IS PUBLIC THE MOMENT IT IS WRITTEN, which is a deliberate divergence from every other
     * public profile text in this schema — `talent_profile.visibility` defaults to `private` and
     * `community_cofounder_profile.state` defaults to `draft` behind moderation. The abuse path
     * here is REACTIVE instead: `user_report` plus `profileModerationState` below, which is why
     * those two must never be removed while this column is public.
     *
     * NOT IN THE ANONYMIZATION MANIFEST, because that file is keyed on FOREIGN KEYS into `user`
     * and this is a scalar. It is scrubbed by the one explicit line in
     * `anonymize-account.service.ts` beside `locationLabel`, and the ONLY executable guard on
     * that line is `scripts/smoke-privacy.ts`'s "the identity is gone" assertion. Nothing else
     * will notice if it is dropped.
     */
    bio: text("bio"),
    /**
     * Whether a moderator has hidden this person's PROFILE TEXT — the bio and the links, and
     * nothing else.
     *
     * DELIBERATELY NARROW. There is no platform-wide "hidden user" state here and this is not
     * one: `name`, `image` and every video stay visible. A real account-level suspension would
     * need a `public-user-gate.ts` and an audit of every public read of a user, and nothing would
     * fail if one were missed — that is a separate piece of work, not a column.
     *
     * IT IS NOT `deactivatedAt`, AND MUST NOT BECOME IT. That column's invariant is that a live
     * session implies NULL, so a moderator writing it would be undone by the user signing in.
     * This is the same argument `studio.ts` makes for `moderation_visibility_state` being its own
     * column rather than a value on `publish_status`.
     */
    profileModerationState: userProfileModerationStateEnum("profile_moderation_state")
      .default("visible")
      .notNull(),
    /**
     * Whether this creator has asked to be listed in Qatoto's public sitemap.
     *
     * DISCOVERABILITY, NOT VISIBILITY. `/channel/:handle` is public either way — every feed card
     * links to it — and this only decides whether `GET /channels` announces the handle to a
     * crawler. Copy that implies switching it off makes a channel private is a claim this column
     * cannot keep.
     *
     * DEFAULTS FALSE, because a directory of PEOPLE is not a directory of products. The cofounder
     * directory made the argument first: "a directory of people who did not consent to being in
     * it" is a decision, not a default.
     *
     * ⚠️ SCALAR, SO THE ANONYMIZATION VERIFIER CANNOT SEE IT — the same trap as `bio` directly
     * above. It is set FALSE by one explicit line in `anonymize-account.service.ts`, and nothing
     * will turn red if that line is deleted; `scripts/smoke-privacy.ts` is its only executable
     * guard. An anonymized account must leave the directory rather than keep being advertised.
     */
    isChannelListed: boolean("is_channel_listed").default(false).notNull(),
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
    // --- ACCOUNT LIFECYCLE (Privacy Part 3). Until these landed an account had exactly
    //     two states: it exists, or the row is gone — and the row can never be gone,
    //     because rule R2 (schema/rnd.ts) makes 40+ tables hold `restrict` FKs here and
    //     45 migrations install BEFORE UPDATE OR DELETE triggers. Deletion is therefore
    //     an ANONYMIZATION, and these two columns are the states it passes through.
    //
    // NULL = active. Set by POST /users/me/deletion-request, which also deletes every
    // `session` row in the same transaction. CLEARED AGAIN BY SIGNING IN: the
    // `session.create.before` hook in src/lib/auth.ts reactivates inside the grace
    // window, so THE INVARIANT IS THAT A LIVE SESSION IMPLIES A NULL HERE. That is what
    // lets the rest of the surface skip a cancel endpoint entirely — there is no
    // authenticated caller for it to serve.
    deactivatedAt: timestamp("deactivated_at"),
    // NULL until the scrub commits, and TERMINAL — nothing sets it back. Once stamped,
    // `email` is an @deleted.qatoto.invalid placeholder and the `account`/`passkey` rows
    // are gone, so there is no credential left to sign in with even if something tried.
    anonymizedAt: timestamp("anonymized_at"),
  },
  (table) => [
    // Partial: staff are a handful of rows out of the whole user table, so the index
    // only carries them.
    index("user_platformRole_idx")
      .on(table.platformRole)
      .where(sql`platform_role IS NOT NULL`),
    // Partial for the same reason: accounts inside a 30-day grace window are a handful
    // of rows, and this index serves `getAllUsers`' new `deactivated_at IS NULL` filter
    // plus the anonymization sweep's candidate scan.
    index("user_deactivatedAt_idx")
      .on(table.deactivatedAt)
      .where(sql`deactivated_at IS NOT NULL`),
    // THE ORDERING IS THE POINT, not the null-checking. An anonymized row that was never
    // deactivated means the scrub ran without a grace window ever opening — i.e. someone
    // called the service directly, bypassing the request route. Postgres refusing that
    // is cheaper than discovering it afterwards, when the data is gone.
    check(
      "user_lifecycle_ck",
      sql`anonymized_at IS NULL
          OR (deactivated_at IS NOT NULL AND anonymized_at >= deactivated_at)`,
    ),
  ],
);

/**
 * A creator's external links, shown in the channel About panel.
 *
 * A CHILD TABLE RATHER THAN COLUMNS, because the set is ordered and variable — and because a
 * replace-the-set write is a cleaner shape than N nullable columns nobody can reorder.
 *
 * `cascade`, per rule R2: these are a personal advertisement that dies with the account, the same
 * verdict `community_cofounder_profile` reaches and for the same stated reason — "a cofounder
 * profile IS a person, so a deleted account must take its own listing with it". The manifest
 * carries `user_profile_link.user_id` as `delete_rows` to match.
 *
 * ⚠️ ANYTHING THAT LATER REFERENCES THIS TABLE MUST ALSO CASCADE. A `restrict` child would make
 * the erasure's `DELETE FROM user_profile_link` raise `23503`, which is not one of the SQLSTATEs
 * the anonymization job treats as a permanent refusal — so pg-boss would retry the whole ladder
 * forever against something that can never succeed.
 *
 * `https://` ONLY, and it is not decoration: this URL is rendered as an href on a public page, so
 * the check is what keeps a `javascript:` or `data:` scheme off it. Byte-identical in shape to
 * `commerce_organization_url_ck`.
 */
export const userProfileLink = pgTable(
  "user_profile_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    /** The creator's own ordering. Assigned from the submitted array's index on every write. */
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("user_profile_link_userId_idx").on(table.userId, table.sortOrder),
    // One row per position, so a replace-the-set write cannot leave two links claiming the same
    // slot and the channel page cannot render them in an order the creator did not choose.
    uniqueIndex("user_profile_link_position_uidx").on(table.userId, table.sortOrder),
    check(
      "user_profile_link_text_ck",
      sql`char_length(label) BETWEEN 1 AND 60
          AND char_length(url) <= 2048
          AND url LIKE 'https://%'
          AND sort_order >= 0`,
    ),
  ],
);

/**
 * A report about a PERSON's profile — `POST /users/:userId/reports`.
 *
 * ITS OWN TABLE, not a member on an existing report enum. This codebase already made that call
 * once: each moderation queue gets its own table rather than a widened `target_kind`, because a
 * queue's columns, its reasons and its verdict are its own.
 *
 * ## WHAT UPHOLDING ONE ACTUALLY DOES
 *
 * It flips `user.profile_moderation_state`, which hides the BIO AND LINKS and nothing else. Not the
 * name, not the avatar, not a single video. That is a deliberately narrow lever: those two fields
 * are new, so the channel read is their only public consumer and one enforcement point covers them.
 * A platform-wide "hidden user" would need every public read of a person to honour a new predicate —
 * six modules in `home/` alone before the feed, spotlight, store and R&D — with nothing failing if
 * one were missed.
 *
 * ## THE THREE USER REFERENCES ARE THREE DIFFERENT DECISIONS
 *
 * `reported_user_id` is `restrict`, NOT cascade. `video_content_report` cascades on its video
 * because "a report about a deleted video is noise"; a user row is never deleted here — closure is
 * an anonymization — so cascade would be dead code pretending to be a policy. The manifest keeps
 * this row through an erasure, and the reason is worth stating: if requesting deletion erased the
 * reports filed against you, deletion would be a ban-evasion route.
 *
 * `reporter_user_id` is `set null` — a departing reporter must not erase the report they filed,
 * because the report is evidence about somebody else.
 *
 * `resolved_by_user_id` is `restrict` — a moderator cannot be deleted out from under a decision
 * they made. The same asymmetry `video_content_report` documents on the same pair.
 *
 * ONE REPORT PER PERSON PER SUBJECT, through the partial unique index below, so a brigading loop
 * cannot inflate the queue and a `409` is an honest answer rather than a silent second row.
 */
export const userReport = pgTable(
  "user_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    reportedUserId: text("reported_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reason: userReportReasonEnum("reason").notNull(),
    detailText: text("detail_text"),
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    status: userReportStatusEnum("status").default("open").notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Partial for the reason `video_content_report_reporter_uidx` states: `reporter_user_id` is
    // nullable by the `set null` above, two erased reporters are two NULLs, and NULLs do not
    // collide in a unique index anyway. Stating it keeps the index small.
    uniqueIndex("user_report_reporter_uidx")
      .on(table.reportedUserId, table.reporterUserId)
      .where(sql`reporter_user_id IS NOT NULL`),
    index("user_report_queue_idx").on(table.status, table.createdAt, table.id),
    index("user_report_subject_idx").on(table.reportedUserId, table.status),
    check(
      "user_report_detail_ck",
      sql`detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000`,
    ),
    // Byte-identical to the same check in its four sibling forks. Both halves matter: a resolver
    // with no timestamp is a half-written decision, and an `open` row carrying a resolution is a
    // queue entry that will be handed to a moderator twice.
    check(
      "user_report_resolution_ck",
      sql`(resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)`,
    ),
    // A person cannot report themselves. Enforced here as well as in the service, because the
    // service check produces the useful message and this is what makes the rule true.
    check("user_report_self_ck", sql`reported_user_id <> reporter_user_id`),
  ],
);

/**
 * Every profile-text moderation decision, with the human behind it.
 *
 * `moderator_user_id` is NOT NULL and `restrict`, and `audit_entry_id` ties each row to the
 * hash chain — an unlogged staff action is what the chain exists to make impossible.
 */
export const userModerationAction = pgTable(
  "user_moderation_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    actionKind: userModerationActionKindEnum("action_kind").notNull(),
    subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "set null" }),
    reportId: text("report_id").references(() => userReport.id, { onDelete: "set null" }),
    moderatorUserId: text("moderator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    moderatorRoleSnapshot: text("moderator_role_snapshot").notNull(),
    reasonNote: text("reason_note").notNull(),
    auditEntryId: text("audit_entry_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_moderation_action_audit_uidx").on(table.auditEntryId),
    index("user_moderation_action_timeline_idx").on(table.createdAt, table.id),
    index("user_moderation_action_subject_idx").on(table.subjectUserId, table.createdAt),
    check(
      "user_moderation_action_text_ck",
      sql`char_length(reason_note) BETWEEN 1 AND 2000
          AND char_length(moderator_role_snapshot) BETWEEN 1 AND 40`,
    ),
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
    // The identity provider that issued this account, e.g. "local:credential" for
    // email/password, "https://accounts.google.com" for Google, or
    // "local:oauth:github" for providers (like GitHub) that don't expose their own
    // issuer. Required by Better Auth 1.7's core account model — see
    // findCredentialAccount / updatePassword / findAccountByKey in its
    // internal-adapter, and account-key.ts's resolveOAuthAccountKey. Paired with
    // accountId as the account's real unique key.
    issuer: text("issuer").notNull(),
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
  (table) => [
    index("account_userId_idx").on(table.userId),
    // Better Auth 1.7's real account key — see the `issuer` column comment above.
    uniqueIndex("account_issuer_accountId_uidx").on(table.issuer, table.accountId),
  ],
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
