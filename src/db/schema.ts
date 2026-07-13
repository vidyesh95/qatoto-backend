import { randomUUID } from "node:crypto";

import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";

// Case-insensitive text (Postgres `citext`). Used for the email columns so that
// equality AND the UNIQUE constraint compare case-insensitively: two providers
// reporting the same address in different case (Google "User@x.com", GitHub
// "user@x.com") resolve to ONE user via Better Auth's email lookup instead of
// minting a duplicate row. Requires the `citext` extension, created in the
// migration that introduces this type. See src/lib/auth.ts accountLinking.
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

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

// ---------------------------------------------------------------------------
// Store / commerce domain (product listings). See STORE_BACKEND_STRUCTURE.md.
//
// ID STRATEGY — deliberate deviation from the auth tables. Auth rows carry ids
// minted by Better Auth (`text("id").primaryKey()`, no DB default). These
// commerce tables are ours and Better Auth never touches them, so they
// self-generate opaque `text` ids via randomUUID at insert time — still string
// ids to stay consistent with the rest of the schema.
// ---------------------------------------------------------------------------

// The listing's product category. Stored as slugs; the wizard maps its display
// labels ("Home & Kitchen") to these (home_kitchen). Enum so Postgres rejects
// any value the app doesn't know about.
export const productCategoryEnum = pgEnum("product_category", [
  "electronics",
  "fashion",
  "home_kitchen",
  "anime_collectibles",
  "digital_goods",
  "books_media",
  "sports_outdoors",
  "beauty_personal_care",
]);

// Physical condition of the item. Wizard's New/Refurbished/Used, lowercased.
export const productConditionEnum = pgEnum("product_condition", ["new", "refurbished", "used"]);

// Listing lifecycle. `draft` = seller is still building it / abandoned the
// wizard (visible only to them); `active` = published, buyer-visible. The
// draft→active transition is gated server-side (POST /products/:id/publish).
export const productStatusEnum = pgEnum("product_status", ["draft", "active"]);

// A product listing, owned by exactly one seller.
export const product = pgTable(
  "product",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Owner. Stamped from req.user.id at create — NEVER from the body
    // (CLAUDE.md §1.1). Cascade so deleting a user removes their listings.
    sellerId: text("seller_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brand: text("brand"),
    category: productCategoryEnum("category").notNull(),
    condition: productConditionEnum("condition").default("new").notNull(),
    description: text("description"),
    // Money in integer cents. Server-authoritative; the client sends cents,
    // never dollars — no floating-point money in the DB or on the wire.
    priceInCents: integer("price_in_cents").notNull(),
    compareAtPriceInCents: integer("compare_at_price_in_cents"),
    // Server-owned; the wizard hardcodes "$". Not client-writable.
    currency: text("currency").default("USD").notNull(),
    stockQuantity: integer("stock_quantity").default(0).notNull(),
    sku: text("sku"),
    // Short ordered display bullets ("30-hour battery life"). A text[] column,
    // NOT a table: no identity/relationships/queries of their own. Promote to a
    // table only if features ever grow attributes.
    keyFeatures: text("key_features").array().notNull().default([]),
    status: productStatusEnum("status").default("draft").notNull(),
    // NULL until first published; set on the draft→active transition.
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("product_sellerId_idx").on(table.sellerId),
    index("product_status_idx").on(table.status),
    // A seller can't reuse one SKU across their own listings. Postgres UNIQUE
    // permits many NULLs, so SKU stays optional.
    uniqueIndex("product_seller_sku_unq").on(table.sellerId, table.sku),
  ],
);

// A product's images. Two-phase upload: the listing is created first, then
// images are attached one at a time. `position` orders them; position 0 is the
// main image (the wizard's "Main image" badge on the first tile).
export const productImage = pgTable(
  "product_image",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    // Cloudinary secure_url of the normalized asset.
    url: text("url").notNull(),
    // 0 = main listing photo. Contiguous per product; re-packed on delete.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("product_image_productId_idx").on(table.productId)],
);

// B2B volume pricing — buy at least `minimumOrderQuantity` to get
// `unitPriceInCents`. Supported now even though the create wizard doesn't
// collect it yet (STORE_BACKEND_STRUCTURE.md §11).
export const productPricingTier = pgTable(
  "product_pricing_tier",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    unitPriceInCents: integer("unit_price_in_cents").notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").notNull(),
    // Display order of the tier ladder.
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("product_pricing_tier_productId_idx").on(table.productId)],
);

export const productRelations = relations(product, ({ one, many }) => ({
  seller: one(user, { fields: [product.sellerId], references: [user.id] }),
  images: many(productImage),
  pricingTiers: many(productPricingTier),
}));

export const productImageRelations = relations(productImage, ({ one }) => ({
  product: one(product, { fields: [productImage.productId], references: [product.id] }),
}));

export const productPricingTierRelations = relations(productPricingTier, ({ one }) => ({
  product: one(product, { fields: [productPricingTier.productId], references: [product.id] }),
}));
