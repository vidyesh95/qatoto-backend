/**
 * The schema, split by product area (docs/*_BACKEND_STRUCTURE.md) rather than left as one
 * 21,973-line file — 10.6% of the backend in a single unit that 157 modules import.
 *
 * THIS BARREL IS WHAT MAKES THE SPLIT FREE. Every one of those 157 importers still writes
 * `#src/db/schema.js` and is otherwise untouched, and `drizzle.config.ts` still points
 * here. The split follows the 27 section rules the monolith had already drawn for itself.
 *
 * HOW TO PROVE A CHANGE HERE IS ORGANIZATION-ONLY. `db:generate` answers a different
 * question — it diffs against `drizzle/meta/`'s newest snapshot, so it tells you what SQL a
 * change needs, not whether the change was a change at all:
 *
 *     drizzle-kit export --sql
 *
 * composes DDL from this module with no database connection and without reading
 * drizzle/meta/. Compare the SORTED output before and after — it must be the same 7,252
 * statements:
 *
 *     diff <(sort before.sql) <(sort after.sql)
 *
 * Compare the sorted output, NOT a checksum of the raw output. `export` emits in
 * declaration order, so any deliberate reordering of these files changes the bytes while
 * changing no schema. A byte-level gate here fails for the wrong reason.
 *
 * ORDER OF THESE RE-EXPORTS IS NOT LOAD ORDER and must not be read as a dependency list;
 * see `_primitives.ts` for the one initialization constraint that is real.
 */
export * from "#src/db/schema/_core.js";
export * from "#src/db/schema/_primitives.js";
export * from "#src/db/schema/home.js";
export * from "#src/db/schema/platform.js";
export * from "#src/db/schema/privacy.js";
export * from "#src/db/schema/rnd.js";
export * from "#src/db/schema/store.js";
export * from "#src/db/schema/studio.js";
