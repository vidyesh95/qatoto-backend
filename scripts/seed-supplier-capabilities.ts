/**
 * Idempotently applies the baseline §11i supplier capability vocabulary.
 *
 * Unlike the §6 lookups, migration 0020 does NOT insert these rows — the migration creates
 * the table and this script fills it, so the vocabulary can grow by appending to
 * `BASELINE_SUPPLIER_CAPABILITIES` rather than by hand-writing another migration every
 * time a moderator needs one more chip.
 *
 * ON CONFLICT DO NOTHING, deliberately — never DO UPDATE. A moderator may have edited a
 * label, and a seed script must not silently revert an editorial decision.
 *
 * There is no `POST /supplier-capabilities`, so this script is the only way a row lands.
 * That is what keeps the table free of a moderation status: no spam surface, nothing to
 * moderate.
 *
 *   pnpm db:seed-supplier-capabilities
 */
import "dotenv/config";
import { db, pool } from "#src/db/index.js";
import { supplierCapability } from "#src/db/schema.js";
import { BASELINE_SUPPLIER_CAPABILITIES } from "#src/db/seed-data.js";

async function seedSupplierCapabilities(): Promise<number> {
  const inserted = await db
    .insert(supplierCapability)
    .values(
      BASELINE_SUPPLIER_CAPABILITIES.map((capability) => ({
        id: capability.id,
        slug: capability.slug,
        label: capability.label,
        kind: capability.kind,
        isActive: true,
      })),
    )
    .onConflictDoNothing({ target: supplierCapability.slug })
    .returning({ slug: supplierCapability.slug });

  return inserted.length;
}

async function main(): Promise<void> {
  const insertedCount = await seedSupplierCapabilities();

  if (insertedCount === 0) {
    console.log(
      `All ${BASELINE_SUPPLIER_CAPABILITIES.length} supplier capabilities already present. Nothing to do.`,
    );
    return;
  }

  console.log(`Inserted ${insertedCount} supplier capability row(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Supplier capability seed failed:", error);
    await pool.end();
    process.exit(1);
  });
