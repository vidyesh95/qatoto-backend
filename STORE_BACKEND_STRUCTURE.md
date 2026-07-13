# STORE_BACKEND_STRUCTURE.md — Qatoto Store: Product-Listing API

> This document describes the **store product-listing** contract the Next.js frontend depends
> on, and how it is wired on the Express backend (`/Users/vinitchuri/code/backend/qatoto-backend`).
> It is the sibling of [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) (auth & identity) — same
> voice, same layering, same envelope — scoped to the seller-facing **Create Store Listing**
> wizard at `/studio/products/create` and the **My Products** list at `/studio/products`.
>
> **Goal:** let a signed-in seller create, upload images for, price (single + B2B tiered), edit,
> publish/unpublish, and delete a product listing — with the backend as the only source of truth.
>
> **Stack (all reused, no new deps):** **Express 5** + **Drizzle ORM** + **PostgreSQL** +
> **zod** (request validation) + **Cloudinary** (image storage) + **sharp** (image validation) +
> **multer** (multipart parse) + **express-rate-limit**. Better Auth already owns identity;
> this feature owns the `/products/*` routes and the commerce tables.
>
> **Status:** the frontend
> [create-listing-page.tsx](src/components/studio/pages/create-listing-page.tsx) is **pure UI**
> today — `handlePublishClick` flips a local boolean, "Save Draft" has no handler, nothing is
> submitted. This doc is the spec the backend-integration phase implements. The commerce domain
> does **not** exist in the backend yet (greenfield: no product/store/order table or route).

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only source of
truth.** (Same NON-NEGOTIABLE principle as [CLAUDE.md](CLAUDE.md) §"thin client" and
BACKEND_STRUCTURE.md §0, applied to commerce.)

Anyone can open DevTools, read the client JS, and forge any request. So for every listing
mutation the backend **re-checks everything, every request, by itself**:

- **Ownership is server-derived.** The seller id comes from `req.user.id` (the session cookie,
  via `requireAuth`), **never** from the request body. A listing's `sellerId` is stamped from
  the session at create time and can never be changed by the client.
- **Every `/products/:id*` route re-verifies ownership** before acting: load the row, confirm
  `product.sellerId === req.user.id`, else respond **`404`** (not `403` — a stranger must not be
  able to probe which product ids exist).
- **Image bytes are untrusted.** The multipart mimetype is a hint, not proof. `sharp` re-decodes
  every uploaded file to prove it is a real raster image, bounds its dimensions, and re-encodes
  it (stripping EXIF / smuggled payloads) before anything is stored — identical to the avatar
  pipeline.
- **Price and inventory are validated even though the seller owns them.** A seller legitimately
  sets their own `priceInCents` / `stockQuantity`, but the backend still bounds them (integer,
  `≥ 0`, sane ceilings), converts and stores canonical values, and is the authority for what a
  buyer later sees. The `currency` is server-owned (`USD` default) — the client never picks it.
- **Publish is gated server-side.** "Save Draft" vs "Publish Listing" is UX; the server decides
  whether a draft is _complete enough_ to go live (title, category, `priceInCents > 0`, ≥ 1
  image) at `POST /products/:id/publish`, and rejects with `422` otherwise.
- **Validate the shape of every body/query** with Zod `.safeParse()` → `422` on failure, using
  `.strict()` to reject unknown keys (the prevailing controller style in this backend).

If you remember nothing else from this file, remember §0.

---

## 1. What the frontend expects

The seller surface is two pages:

- **Create Store Listing** — a 5-step wizard
  ([create-listing-page.tsx](src/components/studio/pages/create-listing-page.tsx)):
  `identity → images → description → pricing → review`. On the review step, **Save Draft**
  persists an incomplete listing (`status: draft`); **Publish Listing** takes it live
  (`status: active`).
- **My Products** — the seller's listing table
  ([products-page.tsx](src/components/studio/pages/products-page.tsx)): each row shows name, SKU,
  a `status` badge (`"Active" | "Draft"`), price label, and stock. "Add product" links into the
  wizard; "Edit" (future) loads a listing for update.

B2B **tiered pricing** (`ProductPricingTier` in [src/types/store.ts](src/types/store.ts) —
`{ unitPrice, minimumOrderQuantity }`) is part of the store's commerce model. The backend
supports it now; the create wizard does **not** collect it yet (see §11, frontend-behind-backend
gap).

### Field mapping (form → contract)

| Frontend form field (state var)        | Backend field                 | Notes                                                  |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `productTitle`                         | `title`                       | 1–200 chars (mirrors `PRODUCT_TITLE_MAX_LENGTH = 200`) |
| `brandName`                            | `brand`                       | nullable                                               |
| `selectedCategory` (8 labels)          | `category` (enum)             | UI labels → stored slugs (see §4)                      |
| `selectedCondition`                    | `condition` (enum)            | `new` \| `refurbished` \| `used`, default `new`        |
| `selectedImageFiles` (`File[]`, ≤ 9)   | `product_image` rows          | two-phase upload; first = main (`position 0`)          |
| `productDescription`                   | `description`                 | nullable                                               |
| `keyFeatures` (`string[]`)             | `keyFeatures` (`text[]`)      | short ordered bullets, count-capped                    |
| `priceInDollars` `"129.99"`            | `priceInCents` (int)          | client sends **cents**; backend authoritative, `≥ 0`   |
| `compareAtPriceInDollars`              | `compareAtPriceInCents` (int) | nullable                                               |
| `stockQuantity`                        | `stockQuantity` (int)         | `≥ 0`, default `0`                                     |
| `skuCode`                              | `sku`                         | nullable; `UNIQUE(sellerId, sku)`                      |
| Save Draft / Publish Listing           | `status` (enum)               | `draft` \| `active`; publish gated server-side         |
| `ProductPricingTier` (not in form yet) | `product_pricing_tier` rows   | supported now; UI collects later                       |

**Money contract:** the form's price inputs are dollar strings (`type="number" step="0.01"`).
The thin client converts to integer cents at submit (`Math.round(dollars * 100)`) and sends
`priceInCents` / `compareAtPriceInCents`. The backend stores cents and is the sole authority —
no floating-point money crosses the wire or lands in the DB. The display label
(`"$129.99"`) is derived on read (`priceInCents / 100`), never stored.

---

## 2. The stack

Everything is already installed for the auth feature — the store adds **zero new dependencies**.

| Concern          | Pick                                                      | Why / reuse                                                         |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Server framework | **Express 5**                                             | Same app, one more router (`/products`).                            |
| Language         | **TypeScript** (strict, ESM `#src/*`)                     | Shared shapes with the frontend.                                    |
| Database ORM     | **Drizzle ORM**                                           | New tables in `src/db/schema.ts`; `pnpm db:generate && db:migrate`. |
| Database         | **PostgreSQL** via `pg`                                   | `UNIQUE(sellerId, sku)`, FKs, enums enforced at the DB.             |
| Validation       | **zod**                                                   | Inline `.safeParse()` in the controller → `422` (prevailing style). |
| Image storage    | **Cloudinary** (`src/lib/cloudinary.ts`)                  | Add product-image helpers alongside the avatar ones.                |
| Image processing | **sharp** (`src/lib/image.ts`)                            | Reuse decode/bound/re-encode; generalize the avatar validator.      |
| File uploads     | **multer** (new `src/middleware/upload-product-image.ts`) | Mirror `upload-avatar.ts`: memory storage, size cap, mimetype gate. |
| Rate limiting    | **express-rate-limit** (`src/middleware/rate-limit.ts`)   | Per-route limiter on create + image upload.                         |

**Money is integer cents** everywhere in the store schema and contract (`priceInCents`,
`compareAtPriceInCents`, `unitPriceInCents`) — no `numeric`, no floats.

---

## 3. Folder structure (additions)

New and changed files, following the existing route → controller → service → db layering:

```text
qatoto-backend/
├── src/
│   ├── db/
│   │   └── schema.ts                       # + product, product_image, product_pricing_tier tables + enums + relations
│   ├── routes/
│   │   └── products.routes.ts              # NEW — /products CRUD, image, publish routes
│   ├── controllers/
│   │   └── products.controller.ts          # NEW — Zod parse + ownership guard + HTTP mapping
│   ├── services/
│   │   └── products.service.ts             # NEW — domain logic, returns Result<T, ProductError>
│   ├── middleware/
│   │   └── upload-product-image.ts         # NEW — multer memory upload for the `image` field (mirror upload-avatar.ts)
│   ├── lib/
│   │   ├── cloudinary.ts                    # + uploadProductImage / deleteProductImage / deleteAllProductImages
│   │   └── image.ts                         # generalize validateAndNormalizeAvatar → validateAndNormalizeImage
│   ├── types/
│   │   └── index.ts                         # (unchanged) PaginatedResponse / PaginationMeta — finally used by GET /products/mine
│   └── app.ts                               # + app.use("/products", productsRouter)
```

`req.user` is already attached by `requireAuth` (`src/middleware/require-auth.ts`) and typed via
the ambient augmentation in `src/types/express.d.ts` — no change needed.

---

## 4. The data (new commerce tables)

All in `src/db/schema.ts`, following the repo conventions:
`pgTable("snake_case", { camelColumn: type("snake_case_col") })`; timestamps
`createdAt: timestamp("created_at").defaultNow().notNull()` and
`updatedAt … $onUpdate(() => new Date()).notNull()`; FKs
`.references(() => …, { onDelete: "cascade" })`; indexes in the 3rd `pgTable` arg; `relations(...)`
declared separately.

> **ID strategy — one deliberate deviation.** The auth tables use `text("id").primaryKey()` with
> the value **generated by Better Auth**. The commerce tables are ours and Better Auth never
> touches them, so they **self-generate** their ids:
> `text("id").primaryKey().$defaultFn(() => randomUUID())` (`import { randomUUID } from "node:crypto"`).
> Still `text` ids (opaque strings) to stay consistent with the rest of the schema — just
> generated in-app instead of by the auth engine.

### Enums

```ts
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

export const productConditionEnum = pgEnum("product_condition", ["new", "refurbished", "used"]);

export const productStatusEnum = pgEnum("product_status", ["draft", "active"]);
```

**Category label ↔ slug map** (the wizard's `PRODUCT_CATEGORIES` display labels; the server
stores slugs):

| UI label               | Stored slug            |
| ---------------------- | ---------------------- |
| Electronics            | `electronics`          |
| Fashion                | `fashion`              |
| Home & Kitchen         | `home_kitchen`         |
| Anime & Collectibles   | `anime_collectibles`   |
| Digital Goods          | `digital_goods`        |
| Books & Media          | `books_media`          |
| Sports & Outdoors      | `sports_outdoors`      |
| Beauty & Personal Care | `beauty_personal_care` |

`condition` maps the wizard's `PRODUCT_CONDITIONS` (`New`/`Refurbished`/`Used`) lowercased.
`status` maps the My Products badge: `draft` → "Draft", `active` → "Active".

### `product`

The listing itself, owned by exactly one seller.

```ts
export const product = pgTable(
    "product",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // Owner. Stamped from req.user.id at create — NEVER from the body (§0). Cascade so
        // deleting a user removes their listings.
        sellerId: text("seller_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        brand: text("brand"),
        category: productCategoryEnum("category").notNull(),
        condition: productConditionEnum("condition").default("new").notNull(),
        description: text("description"),
        // Money in integer cents. Server-authoritative; the client sends cents, never dollars.
        priceInCents: integer("price_in_cents").notNull(),
        compareAtPriceInCents: integer("compare_at_price_in_cents"),
        // Server-owned; the wizard hardcodes "$". Not client-writable.
        currency: text("currency").default("USD").notNull(),
        stockQuantity: integer("stock_quantity").default(0).notNull(),
        sku: text("sku"),
        // Short ordered display bullets ("30-hour battery life"). A text[] column, NOT a table —
        // see the note below.
        keyFeatures: text("key_features").array().notNull().default([]),
        status: productStatusEnum("status").default("draft").notNull(),
        // NULL until first published; set on the draft→active transition.
        publishedAt: timestamp("published_at"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [
        index("product_sellerId_idx").on(table.sellerId),
        index("product_status_idx").on(table.status),
        // A seller can't reuse one SKU across their own listings. Postgres UNIQUE permits many
        // NULLs, so SKU stays optional.
        uniqueIndex("product_seller_sku_unq").on(table.sellerId, table.sku),
    ],
);
```

> **Why `keyFeatures` is a `text[]` column, not a table.** Key features are a handful of tiny,
> order-preserving display strings with no identity, relationships, or queries of their own. A
> `product_key_feature` table would add a join and an id for no benefit. If features ever grow
> attributes (icon, category, per-feature analytics) promote it to a table then. For now, an
> array column is the right altitude.

### `product_image`

Two-phase upload: the listing is created first, then images are attached one at a time. `position`
orders them; `position 0` is the main image (the wizard's "Main image" badge on the first tile).

```ts
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
```

Cloudinary public id is **deterministic per image**: `qatoto/products/<productId>/<imageId>`
(mirrors the avatar pattern's one-asset-per-entity idea, scaled to many-per-product). Max **9**
images per product (the wizard's `MAX_PRODUCT_IMAGES`) is enforced in the service, not the DB.

### `product_pricing_tier`

B2B volume pricing — `ProductPricingTier` from the frontend types. Supported now even though the
wizard doesn't collect it yet.

```ts
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
        // Buy at least this many to get unitPriceInCents. e.g. 10+ → $9.00/unit.
        minimumOrderQuantity: integer("minimum_order_quantity").notNull(),
        // Display order of the tier ladder.
        position: integer("position").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [index("product_pricing_tier_productId_idx").on(table.productId)],
);
```

### Relations

```ts
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
```

After editing `schema.ts`, run `pnpm db:generate && pnpm db:migrate`.

---

## 5. The API — endpoints YOU write (`src/routes/products.routes.ts`)

Mounted in `src/app.ts`:

```ts
app.use("/products", productsRouter); // after express.json(), like /users
```

**Every** route is guarded by `requireAuth`; the seller id is `req.user.id`. Every `/:id*` route
runs the ownership check (§0) and returns `404` when the caller doesn't own the row. Route order:
declare the literal `/mine` **before** `/:id` so "mine" is never swallowed as an id param (same
`/me`-before-`/:id` rule as the users router).

| Method & path                          | Body / input                                      | Behavior & statuses                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /products`                       | JSON `CreateProductSchema`                        | Create a **draft** (identity + description + pricing + optional tiers). `sellerId` from session. `201` `PublicProduct` · `422` validation · `409` `SKU_TAKEN`.     |
| `GET /products/mine`                   | `?page&limit`                                     | Caller's own listings, `PaginatedResponse<ProductListRow>` ordered by `updatedAt` desc. `200`.                                                                     |
| `GET /products/:id`                    | —                                                 | Full `PublicProduct` (with images + tiers) for edit/detail. Owner only → `404` if not owner or missing.                                                            |
| `PATCH /products/:id`                  | JSON `UpdateProductSchema` (all optional)         | Partial update of mutable fields (+ replace tiers). `200` `PublicProduct` · `422` · `404` · `409` `SKU_TAKEN`.                                                     |
| `POST /products/:id/images`            | `multipart/form-data`, field **`image`** (1 file) | sharp validate+normalize → Cloudinary → append at next `position`. `201` `ProductImage` · statuses per the image map below · `409` `TOO_MANY_IMAGES` (>9) · `404`. |
| `DELETE /products/:id/images/:imageId` | —                                                 | Destroy the Cloudinary asset + row, re-pack remaining positions. `200` · `404`.                                                                                    |
| `PATCH /products/:id/images/reorder`   | JSON `{ imageIds: string[] }`                     | Set order (index 0 = main image). Must be a permutation of the product's image ids. `200` · `422` · `404`.                                                         |
| `POST /products/:id/publish`           | —                                                 | draft → active. Re-validate completeness server-side; set `publishedAt`. `200` `PublicProduct` · `422` `INCOMPLETE_FOR_PUBLISH` · `404`.                           |
| `POST /products/:id/unpublish`         | —                                                 | active → draft (clears nothing else). `200` · `404`.                                                                                                               |
| `DELETE /products/:id`                 | —                                                 | Delete listing; cascade removes images + tiers, and the service destroys all Cloudinary assets for the product first. `200` · `404`.                               |

### Image upload status map (reuses the avatar pipeline)

Same `Result` errors as `PATCH /users/me/photo`, mapped identically:

| Service error                                    | HTTP  | Meaning                                          |
| ------------------------------------------------ | ----- | ------------------------------------------------ |
| missing `req.file`                               | `422` | No `image` field on the multipart body.          |
| `NOT_AN_IMAGE`                                   | `422` | Bytes don't decode as a raster image.            |
| `UNSUPPORTED_FORMAT`                             | `422` | Not JPEG/PNG/WebP.                               |
| `DIMENSIONS_TOO_SMALL` / `DIMENSIONS_TOO_LARGE`  | `422` | Outside 64–8192 px.                              |
| `TOO_MANY_IMAGES`                                | `409` | Product already has 9 images.                    |
| `NOT_CONFIGURED`                                 | `503` | Cloudinary creds absent.                         |
| `UPLOAD_FAILED` / `DELETE_FAILED`                | `502` | Storage provider error.                          |
| `NOT_FOUND` (product not owned/missing)          | `404` | Ownership guard.                                 |
| (size cap, in `upload-product-image` middleware) | `413` | File exceeds the 5 MB limit.                     |
| (mimetype gate / malformed multipart)            | `422` | Non-image content-type, wrong field, or >1 file. |

---

## 6. Validation (`src/controllers/products.controller.ts`)

Inline Zod at the top of the controller, `Schema.safeParse(req.body)`, `422` +
`z.flattenError(parsed.error).fieldErrors` — the prevailing style
([handle.controller.ts](../backend/qatoto-backend/src/controllers/handle.controller.ts),
`users.controller.ts`). `.strict()` rejects unknown keys.

```ts
const PricingTierSchema = z.object({
    unitPriceInCents: z.number().int().min(0),
    minimumOrderQuantity: z.number().int().min(1),
});

const CreateProductSchema = z
    .object({
        title: z.string().trim().min(1).max(200),
        brand: z.string().trim().max(120).optional(),
        category: z.enum([
            "electronics",
            "fashion",
            "home_kitchen",
            "anime_collectibles",
            "digital_goods",
            "books_media",
            "sports_outdoors",
            "beauty_personal_care",
        ]),
        condition: z.enum(["new", "refurbished", "used"]).default("new"),
        description: z.string().trim().max(5000).optional(),
        keyFeatures: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
        priceInCents: z.number().int().min(0),
        compareAtPriceInCents: z.number().int().min(0).optional(),
        stockQuantity: z.number().int().min(0).default(0),
        sku: z.string().trim().max(64).optional(),
        pricingTiers: z.array(PricingTierSchema).max(10).default([]),
    })
    .strict();

// Every field optional — a PATCH may touch any subset. Sending `pricingTiers` REPLACES the set.
const UpdateProductSchema = CreateProductSchema.partial();

const ReorderImagesSchema = z.object({ imageIds: z.array(z.string()).min(1) }).strict();
```

Notes the doc pins down:

- The client sends **cents** (integers). If a future client posts dollars, that's a contract
  break — the schema rejects non-integers, so it fails loudly at `422` rather than silently
  storing `129.99` cents.
- `compareAtPriceInCents`, when present, should exceed `priceInCents` (it renders as a struck-out
  "was" price). Enforce with a `.refine()` and surface a field error — a display invariant, but
  still server-checked.
- `publish` and image routes take **no body** for the mutation itself; their only inputs are the
  session and the path params.

---

## 7. Services & Result types (`src/services/products.service.ts`)

Services never touch `req`/`res`; they return `Result<T, ProductError>`
([types/index.ts](../backend/qatoto-backend/src/types/index.ts)) and the controller exhaustively
switches on `error.type` → HTTP (with a `never` default), exactly like
[users.service.ts](../backend/qatoto-backend/src/services/users.service.ts).

```ts
export type ProductError =
    | { type: "NOT_FOUND"; productId: string } // missing OR not owned by caller → 404
    | { type: "SKU_TAKEN"; sku: string } // UNIQUE(sellerId, sku) → 409
    | { type: "TOO_MANY_IMAGES"; limit: number } // > 9 → 409
    | { type: "INCOMPLETE_FOR_PUBLISH"; missing: string[] } // publish gate → 422
    | AvatarValidationError // reused from lib/image.ts (sharp) — image routes
    | CloudinaryError; // reused from lib/cloudinary.ts — image routes
```

Read-back shapes (mirror `PublicUser` / `PUBLIC_USER_COLUMNS` — one canonical projection so the
shape can't drift between mutations):

```ts
// Full listing for the create/edit/detail flows.
export interface PublicProduct {
    readonly id: string;
    readonly title: string;
    readonly brand: string | null;
    readonly category: string; // slug
    readonly condition: "new" | "refurbished" | "used";
    readonly description: string | null;
    readonly priceInCents: number;
    readonly compareAtPriceInCents: number | null;
    readonly currency: string;
    readonly stockQuantity: number;
    readonly sku: string | null;
    readonly keyFeatures: readonly string[];
    readonly status: "draft" | "active";
    readonly publishedAt: Date | null;
    readonly images: readonly { id: string; url: string; position: number }[];
    readonly pricingTiers: readonly {
        id: string;
        unitPriceInCents: number;
        minimumOrderQuantity: number;
        position: number;
    }[];
}

// Compact row for the My Products list (maps 1:1 to products-page.tsx).
export interface ProductListRow {
    readonly id: string;
    readonly title: string;
    readonly sku: string | null;
    readonly priceInCents: number;
    readonly stockQuantity: number;
    readonly status: "draft" | "active";
}
```

Ownership is enforced **in the service**: reads/mutations filter
`where(and(eq(product.id, id), eq(product.sellerId, sellerId)))`; an empty result → `NOT_FOUND`
(the controller maps it to `404`, never leaking existence). Create + tier-replace + publish run
inside a transaction so images/tiers stay consistent with the parent row.

---

## 8. The media pipeline (reuse the avatar plumbing)

Three layers, mirroring `PATCH /users/me/photo`:

1. **`src/middleware/upload-product-image.ts`** (new) — multer **memory** storage, single field
   **`image`**, **5 MB** cap (`413`), `files: 1`, first-pass `image/*` mimetype gate. A copy of
   `upload-avatar.ts` with the field renamed. Runs **inside** the route so the global
   `express.json()` never touches multipart bodies.
2. **`src/lib/image.ts`** — generalize `validateAndNormalizeAvatar` →
   `validateAndNormalizeImage` (same behavior: decode to prove it's real, allow jpeg/png/webp,
   bound 64–8192 px, cap decoded pixels against decompression bombs, re-encode to webp q85, strip
   EXIF). Keep a thin `validateAndNormalizeAvatar` alias so the avatar route is untouched, or
   have both call the shared core.
3. **`src/lib/cloudinary.ts`** — add:
    - `uploadProductImage(productId, imageId, buffer)` → public id
      `qatoto/products/<productId>/<imageId>`, returns `{ secureUrl }`.
    - `deleteProductImage(productId, imageId)` → destroy that asset.
    - `deleteAllProductImages(productId)` → destroy the whole
      `qatoto/products/<productId>/` folder before a listing delete (so no orphaned assets).
      Same `Result<T, CloudinaryError>` shape and `NOT_CONFIGURED` fallback as the avatar helpers.

Because each image has its own stable public id, re-uploading or deleting is idempotent and can't
orphan siblings.

---

## 9. How a request flows (create → images → tiers → publish)

```text
1. Wizard "Save Draft" (or step-through) → ONE call:
   POST /products { title, category, condition, priceInCents, compareAtPriceInCents?,
                    stockQuantity, sku?, description?, keyFeatures[], pricingTiers[] }
   → requireAuth resolves sellerId from the session cookie (NEVER the body).
   → CreateProductSchema.safeParse → 422 on bad shape.
   → service inserts product (status: "draft") + tiers in a txn; UNIQUE(sellerId, sku) race → 409.
   → 201 PublicProduct (carries the new id).

2. For each selected image (two-phase), sequentially:
   POST /products/:id/images   (multipart, field "image")
   → ownership guard (not owner/missing → 404).
   → multer 5 MB gate → sharp decode+normalize+re-encode (untrusted bytes) → Cloudinary upload
     at qatoto/products/<id>/<imageId> → insert product_image at next position.
   → 10th image → 409 TOO_MANY_IMAGES.
   → 201 ProductImage. (position 0 is the main photo; reorder later via /images/reorder.)

3. Wizard "Publish Listing":
   POST /products/:id/publish
   → ownership guard.
   → server re-checks completeness: title + category + priceInCents > 0 + >= 1 image.
     missing → 422 INCOMPLETE_FOR_PUBLISH { missing: [...] }.
   → status: "active", publishedAt = now.
   → 200 PublicProduct.

4. My Products page:
   GET /products/mine?page=1&limit=20
   → PaginatedResponse<ProductListRow>; the "Active"/"Draft" badge reads `status`.
```

If the seller abandons the wizard after step 1, the listing simply stays a `draft` — visible only
to them in My Products, never to buyers. Nothing to clean up.

---

## 10. Zero-trust checklist (per §0, applied to each route)

- `sellerId` is **only** ever `req.user.id`. There is no `sellerId` field in any request schema.
- Ownership is re-checked in the **service** on every `:id` operation; failure → `NOT_FOUND` →
  `404`.
- Image bytes are **always** re-decoded by `sharp`; the multipart mimetype is never trusted.
- `priceInCents` / `compareAtPriceInCents` / `stockQuantity` / tier prices are integer-bounded and
  `≥ 0`; `currency` is server-set.
- Publish completeness is decided server-side; the client's "Publish" click is a request, not an
  authorization.
- Every body/query is Zod `.safeParse()`d with `.strict()` → `422` before the service runs.

---

## 11. Frontend-behind-backend gaps (planned, not live)

- **Tiered pricing input.** The backend accepts `pricingTiers` on create/update and stores
  `product_pricing_tier` rows, but the create wizard has no tier UI yet — it always sends
  `pricingTiers: []`. Adding a tier editor to the "Pricing & Inventory" step is a pure frontend
  follow-up; the contract is already there.
- **Edit flow.** `GET /products/:id` + `PATCH /products/:id` support loading and updating a
  listing, but the My Products "Edit" button is currently inert. Wiring it re-uses the same
  wizard in edit mode.
- **Currency selector.** `currency` is server-owned (`USD`); the wizard hardcodes `$`. If
  multi-currency ships, it becomes a server-validated field, not a free client choice.
- **Digital vs physical / shipping.** `digital_goods` is a category, but there is no
  digital-delivery or shipping/weight model yet — out of scope for this doc.

---

## 12. Verification (when the backend phase begins)

1. `pnpm db:generate && pnpm db:migrate` — apply the three new tables + enums.
2. Sign in (get a session cookie), then exercise the flow:

    ```bash
    # create a draft
    curl -X POST https://localhost:8000/products -b cookies.txt -H 'content-type: application/json' \
      -d '{"title":"Wireless Headphones","category":"electronics","condition":"new",
           "priceInCents":12999,"stockQuantity":42,"sku":"QT-AUDIO-001","keyFeatures":["30-hour battery"]}'
    # → 201, capture the id

    # attach an image
    curl -X POST https://localhost:8000/products/<id>/images -b cookies.txt -F image=@photo.jpg
    # → 201

    # publish
    curl -X POST https://localhost:8000/products/<id>/publish -b cookies.txt
    # → 200, status "active"

    # seller list
    curl https://localhost:8000/products/mine -b cookies.txt
    # → 200, row with status "active"
    ```

3. Confirm the contract covers every wizard field (`productTitle`, `brandName`,
   `selectedCategory`, `selectedCondition`, `selectedImageFiles`, `productDescription`,
   `keyFeatures`, `priceInDollars`, `compareAtPriceInDollars`, `stockQuantity`, `skuCode`) and
   every My Products column (`status`, `skuCode`, price, `stockQuantity`).
4. Negative checks: publish an imageless draft → `422 INCOMPLETE_FOR_PUBLISH`; POST a 10th image →
   `409 TOO_MANY_IMAGES`; another seller's `GET /products/:id` → `404`; reused SKU → `409`.
