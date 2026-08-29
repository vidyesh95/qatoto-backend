/**
 * STORE §20 — the per-category attribute vocabulary.
 *
 * WHAT THIS EXISTS TO FIX. `commerce_product_specification` is free text, so two sellers listing
 * the same chair write "Material"/"Wood" and "material type"/"Solid oak". Both are reasonable and
 * neither can be filtered or compared. These definitions give a category a fixed set of questions,
 * inherited down the tree, so a spec sheet becomes a comparison and a facet becomes a filter.
 *
 * THE ONE RULE THE WHOLE FEATURE RESTS ON: an attribute defined on a parent applies to every leaf
 * beneath it. Without inheritance an admin authors "voltage" once per leaf, the copies drift, and
 * two leaves end up with `voltage` and `voltage_volts` — the free-text problem re-created in the
 * one place that was supposed to be canonical.
 *
 * CAPABILITY FIRST, RESOURCES SECOND, in every staff function here — the §11 id-oracle rule, and
 * the same order `commerce-categories.service.ts` follows.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceCategoryAttribute,
  commerceCategoryAttributeChoice,
  commerceProductAttributeValue,
  product,
} from "#src/db/schema.js";
import { recordPlatformAction } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/** How deep the ancestor walk goes. Matches `buildCategoryTrail`'s own cap. */
const MAXIMUM_CATEGORY_DEPTH = 16;

export type AttributeValueKind = "enum" | "number" | "text";

export type CommerceCategoryAttributeError =
  | PlatformAccessError
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "ATTRIBUTE_NOT_FOUND"; attributeId: string }
  | { type: "ATTRIBUTE_KEY_TAKEN"; attributeKey: string }
  /** A `text` attribute cannot be filterable — see the CHECK and the enum's doc comment. */
  | { type: "ATTRIBUTE_NOT_FILTERABLE_KIND"; valueKind: AttributeValueKind }
  /** `number` needs a scale; the other kinds must not carry one. */
  | { type: "ATTRIBUTE_NUMERIC_SHAPE_INVALID" }
  /** Choices belong to `enum` and to nothing else. */
  | { type: "ATTRIBUTE_CHOICES_NOT_APPLICABLE"; valueKind: AttributeValueKind }
  | { type: "ATTRIBUTE_CHOICE_NOT_FOUND"; choiceValue: string }
  /** The product's category does not define (or inherit) this attribute. */
  | { type: "ATTRIBUTE_NOT_IN_CATEGORY"; attributeKey: string }
  /** The submitted value does not match the definition's `valueKind`. */
  | { type: "ATTRIBUTE_VALUE_KIND_MISMATCH"; attributeKey: string; expected: AttributeValueKind }
  | { type: "ATTRIBUTE_IN_USE"; attributeId: string; productCount: number }
  | { type: "ATTRIBUTE_REQUEST_NOT_FOUND"; requestId: string }
  | {
      type: "ATTRIBUTE_REQUEST_ALREADY_DECIDED";
      requestId: string;
      state: "approved" | "rejected";
    };

export interface AttributeChoiceView {
  readonly id: string;
  readonly choiceValue: string;
  readonly label: string;
  readonly position: number;
}

export interface CategoryAttributeView {
  readonly id: string;
  readonly categoryId: string;
  readonly attributeKey: string;
  readonly label: string;
  readonly groupLabel: string | null;
  readonly valueKind: AttributeValueKind;
  readonly unitLabel: string | null;
  readonly numericScale: number | null;
  readonly isFilterable: boolean;
  readonly isRequiredForPublish: boolean;
  readonly position: number;
  readonly choices: readonly AttributeChoiceView[];
  /**
   * How many listings answer this attribute. DERIVED, and it appears in no request body — it is
   * what the delete guard reads, and a client able to set it could talk that guard into removing
   * a definition still in use.
   */
  readonly valueCount: number;
  /**
   * Whether this definition came from an ANCESTOR rather than from the category asked about.
   * The admin console needs it to say "inherited from Electronics" instead of offering an edit
   * that would silently rewrite a parent's vocabulary for every sibling leaf.
   */
  readonly isInherited: boolean;
}

const ATTRIBUTE_COLUMNS = {
  id: commerceCategoryAttribute.id,
  categoryId: commerceCategoryAttribute.categoryId,
  attributeKey: commerceCategoryAttribute.attributeKey,
  label: commerceCategoryAttribute.label,
  groupLabel: commerceCategoryAttribute.groupLabel,
  valueKind: commerceCategoryAttribute.valueKind,
  unitLabel: commerceCategoryAttribute.unitLabel,
  numericScale: commerceCategoryAttribute.numericScale,
  isFilterable: commerceCategoryAttribute.isFilterable,
  isRequiredForPublish: commerceCategoryAttribute.isRequiredForPublish,
  position: commerceCategoryAttribute.position,
} as const;

/**
 * The category's own id plus every ancestor, nearest first.
 *
 * An N+1 walk rather than a recursive CTE, matching `buildCategoryTrail` — the depth is bounded
 * by the same 16 and a tree this shallow does not justify a second query shape to keep in sync.
 * State is NOT filtered: a draft ancestor still owns its attributes, and hiding them would make a
 * leaf's vocabulary depend on whether somebody had published a category above it.
 */
async function listCategoryAncestryNearestFirst(categoryId: string): Promise<readonly string[]> {
  const trail: string[] = [];
  let currentId: string | null = categoryId;
  for (let depth = 0; depth < MAXIMUM_CATEGORY_DEPTH && currentId !== null; depth += 1) {
    trail.push(currentId);
    const [row]: Array<{ parentCategoryId: string | null }> = await db
      .select({ parentCategoryId: commerceCategory.parentCategoryId })
      .from(commerceCategory)
      .where(eq(commerceCategory.id, currentId))
      .limit(1);
    if (!row) break;
    currentId = row.parentCategoryId;
  }
  return trail;
}

async function attachChoicesAndCounts(
  rows: readonly {
    readonly id: string;
    readonly categoryId: string;
    readonly attributeKey: string;
    readonly label: string;
    readonly groupLabel: string | null;
    readonly valueKind: AttributeValueKind;
    readonly unitLabel: string | null;
    readonly numericScale: number | null;
    readonly isFilterable: boolean;
    readonly isRequiredForPublish: boolean;
    readonly position: number;
  }[],
  inheritedAttributeIds: ReadonlySet<string>,
): Promise<readonly CategoryAttributeView[]> {
  if (rows.length === 0) return [];
  const attributeIds = rows.map((row) => row.id);

  // Two grouped queries for the whole page rather than a pair per row, the same shape
  // `withUsageCounts` uses for the category tree.
  const [choiceRows, countRows] = await Promise.all([
    db
      .select({
        id: commerceCategoryAttributeChoice.id,
        attributeId: commerceCategoryAttributeChoice.attributeId,
        choiceValue: commerceCategoryAttributeChoice.choiceValue,
        label: commerceCategoryAttributeChoice.label,
        position: commerceCategoryAttributeChoice.position,
      })
      .from(commerceCategoryAttributeChoice)
      .where(inArray(commerceCategoryAttributeChoice.attributeId, attributeIds))
      .orderBy(
        asc(commerceCategoryAttributeChoice.position),
        asc(commerceCategoryAttributeChoice.choiceValue),
      ),
    db
      .select({
        attributeId: commerceProductAttributeValue.attributeId,
        total: sql<number>`count(*)::int`,
      })
      .from(commerceProductAttributeValue)
      .where(inArray(commerceProductAttributeValue.attributeId, attributeIds))
      .groupBy(commerceProductAttributeValue.attributeId),
  ]);

  const choicesByAttributeId = new Map<string, AttributeChoiceView[]>();
  for (const choiceRow of choiceRows) {
    const bucket = choicesByAttributeId.get(choiceRow.attributeId) ?? [];
    bucket.push({
      id: choiceRow.id,
      choiceValue: choiceRow.choiceValue,
      label: choiceRow.label,
      position: choiceRow.position,
    });
    choicesByAttributeId.set(choiceRow.attributeId, bucket);
  }
  const countByAttributeId = new Map(countRows.map((row) => [row.attributeId, row.total]));

  return rows.map((row) => ({
    ...row,
    choices: choicesByAttributeId.get(row.id) ?? [],
    valueCount: countByAttributeId.get(row.id) ?? 0,
    isInherited: inheritedAttributeIds.has(row.id),
  }));
}

/**
 * The RESOLVED set for a category: its own attributes plus every ancestor's.
 *
 * ⚠️ A NEARER DEFINITION SHADOWS A FARTHER ONE on the same `attributeKey`. A leaf that needs a
 * different unit or a longer choice list for a question its parent already asks says so by
 * defining the key itself, and the parent's version disappears for that leaf only. Returning both
 * would give one product two answers to one question and no rule for picking between them.
 */
export async function resolveCategoryAttributes(
  categoryId: string,
): Promise<readonly CategoryAttributeView[]> {
  const ancestry = await listCategoryAncestryNearestFirst(categoryId);
  if (ancestry.length === 0) return [];

  const rows = await db
    .select(ATTRIBUTE_COLUMNS)
    .from(commerceCategoryAttribute)
    .where(inArray(commerceCategoryAttribute.categoryId, [...ancestry]))
    .orderBy(asc(commerceCategoryAttribute.position), asc(commerceCategoryAttribute.attributeKey));

  const depthByCategoryId = new Map(ancestry.map((id, depth) => [id, depth]));
  const nearestByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = nearestByKey.get(row.attributeKey);
    const rowDepth = depthByCategoryId.get(row.categoryId) ?? Number.MAX_SAFE_INTEGER;
    const existingDepth =
      existing === undefined
        ? Number.MAX_SAFE_INTEGER
        : (depthByCategoryId.get(existing.categoryId) ?? Number.MAX_SAFE_INTEGER);
    if (rowDepth < existingDepth) nearestByKey.set(row.attributeKey, row);
  }

  const resolved = [...nearestByKey.values()].toSorted(
    (left, right) =>
      left.position - right.position || left.attributeKey.localeCompare(right.attributeKey),
  );
  const inheritedIds = new Set(
    resolved.filter((row) => row.categoryId !== categoryId).map((row) => row.id),
  );
  return attachChoicesAndCounts(resolved, inheritedIds);
}

/** The admin view of ONE category: the resolved set, so inherited rows are visible and labelled. */
export async function listCategoryAttributesForStaff(
  actorUserId: string,
  categoryId: string,
): Promise<Result<readonly CategoryAttributeView[], CommerceCategoryAttributeError>> {
  // 1. CAPABILITY FIRST — before `categoryId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  // 2. Resources second.
  const [category] = await db
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, categoryId))
    .limit(1);
  if (!category) return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId } };

  return { success: true, value: await resolveCategoryAttributes(categoryId) };
}

export interface CreateCategoryAttributeInput {
  readonly attributeKey: string;
  readonly label: string;
  readonly groupLabel: string | null;
  readonly valueKind: AttributeValueKind;
  readonly unitLabel: string | null;
  readonly numericScale: number | null;
  readonly isFilterable: boolean;
  readonly isRequiredForPublish: boolean;
  readonly choices: readonly { readonly choiceValue: string; readonly label: string }[];
}

/**
 * The shape rules SQL cannot express, checked once and shared by create and update.
 *
 * The database carries the same three as CHECKs — this exists so the caller gets a named 422
 * instead of a constraint-violation 500, not because the CHECKs are optional.
 */
function validateAttributeShape(input: {
  readonly valueKind: AttributeValueKind;
  readonly numericScale: number | null;
  readonly isFilterable: boolean;
  readonly choiceCount: number;
}): Result<null, CommerceCategoryAttributeError> {
  if (input.isFilterable && input.valueKind === "text") {
    return {
      success: false,
      error: { type: "ATTRIBUTE_NOT_FILTERABLE_KIND", valueKind: input.valueKind },
    };
  }
  if ((input.valueKind === "number") !== (input.numericScale !== null)) {
    return { success: false, error: { type: "ATTRIBUTE_NUMERIC_SHAPE_INVALID" } };
  }
  if (input.choiceCount > 0 && input.valueKind !== "enum") {
    return {
      success: false,
      error: { type: "ATTRIBUTE_CHOICES_NOT_APPLICABLE", valueKind: input.valueKind },
    };
  }
  return { success: true, value: null };
}

/** The next free position on THIS category. Appends; there is no reorder route — see the table. */
async function nextAttributePosition(categoryId: string): Promise<number> {
  const [highest] = await db
    .select({ value: sql<number | null>`max(${commerceCategoryAttribute.position})` })
    .from(commerceCategoryAttribute)
    .where(eq(commerceCategoryAttribute.categoryId, categoryId));
  return (highest?.value ?? -1) + 1;
}

export async function createCategoryAttribute(
  actorUserId: string,
  categoryId: string,
  input: CreateCategoryAttributeInput,
): Promise<Result<CategoryAttributeView, CommerceCategoryAttributeError>> {
  // 1. CAPABILITY FIRST — before `categoryId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  // 2. Resources second.
  const [category] = await db
    .select({ id: commerceCategory.id, slug: commerceCategory.slug })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, categoryId))
    .limit(1);
  if (!category) return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId } };

  const shapeResult = validateAttributeShape({ ...input, choiceCount: input.choices.length });
  if (!shapeResult.success) return { success: false, error: shapeResult.error };

  /**
   * ⚠️ UNIQUENESS IS CHECKED AGAINST THE RESOLVED SET, NOT JUST THIS CATEGORY'S OWN ROWS.
   *
   * The unique index only covers `(category_id, attribute_key)`, so the database would happily
   * accept a leaf defining `voltage` while its parent already does. That is legal and is how
   * shadowing works — but it is almost never what an admin typing into a leaf's form means, and
   * an accidental shadow silently changes the unit or the choice list for that leaf alone. It is
   * refused here and re-offered as an edit of the ancestor's row.
   */
  const resolved = await resolveCategoryAttributes(categoryId);
  if (resolved.some((attribute) => attribute.attributeKey === input.attributeKey)) {
    return {
      success: false,
      error: { type: "ATTRIBUTE_KEY_TAKEN", attributeKey: input.attributeKey },
    };
  }

  const position = await nextAttributePosition(categoryId);

  const inserted = await recordPlatformAction(
    async (tx) => {
      const [attributeRow] = await tx
        .insert(commerceCategoryAttribute)
        .values({
          categoryId,
          attributeKey: input.attributeKey,
          label: input.label,
          groupLabel: input.groupLabel,
          valueKind: input.valueKind,
          unitLabel: input.unitLabel,
          numericScale: input.numericScale,
          isFilterable: input.isFilterable,
          isRequiredForPublish: input.isRequiredForPublish,
          position,
        })
        .returning(ATTRIBUTE_COLUMNS);
      if (!attributeRow) throw new Error("createCategoryAttribute: insert returned no row");

      if (input.choices.length > 0) {
        await tx.insert(commerceCategoryAttributeChoice).values(
          input.choices.map((choice, choiceIndex) => ({
            attributeId: attributeRow.id,
            choiceValue: choice.choiceValue,
            label: choice.label,
            position: choiceIndex,
          })),
        );
      }
      return attributeRow;
    },
    (attributeRow) => ({
      eventKind: "commerce_category_attribute_created",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Created a category attribute",
      targetLabel: `attribute ${input.attributeKey} on ${category.slug}`,
      payload: {
        categoryId,
        attributeId: attributeRow.id,
        attributeKey: input.attributeKey,
        valueKind: input.valueKind,
        isFilterable: input.isFilterable,
      },
      occurredAt: new Date(),
    }),
  );

  const [view] = await attachChoicesAndCounts([inserted], new Set());
  if (!view) throw new Error("createCategoryAttribute: view assembly returned no row");
  return { success: true, value: view };
}

export interface UpdateCategoryAttributeInput {
  readonly label?: string;
  readonly groupLabel?: string | null;
  readonly unitLabel?: string | null;
  readonly isFilterable?: boolean;
  readonly isRequiredForPublish?: boolean;
  readonly choices?: readonly { readonly choiceValue: string; readonly label: string }[];
}

/**
 * Edit a definition.
 *
 * ⚠️ `attributeKey`, `valueKind` AND `numericScale` ARE ABSENT, and each for the same reason
 * `commerce_category.slug` is absent from its patch: they are identity rather than presentation.
 * The key is what a stored value points at and what a saved filter link names; the kind and the
 * scale decide which column every existing value lives in and what its integer means. An
 * attribute that needs a different one of those three is a NEW attribute — changing them in
 * place would silently reinterpret every answer already given.
 */
export async function updateCategoryAttribute(
  actorUserId: string,
  attributeId: string,
  input: UpdateCategoryAttributeInput,
): Promise<Result<CategoryAttributeView, CommerceCategoryAttributeError>> {
  // 1. CAPABILITY FIRST — before `attributeId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  // 2. Resources second.
  const [existing] = await db
    .select(ATTRIBUTE_COLUMNS)
    .from(commerceCategoryAttribute)
    .where(eq(commerceCategoryAttribute.id, attributeId))
    .limit(1);
  if (!existing) return { success: false, error: { type: "ATTRIBUTE_NOT_FOUND", attributeId } };

  const shapeResult = validateAttributeShape({
    valueKind: existing.valueKind,
    numericScale: existing.numericScale,
    isFilterable: input.isFilterable ?? existing.isFilterable,
    choiceCount: input.choices?.length ?? 0,
  });
  if (!shapeResult.success) return { success: false, error: shapeResult.error };

  const scalarUpdates: Record<string, unknown> = {};
  if (input.label !== undefined) scalarUpdates.label = input.label;
  if (input.groupLabel !== undefined) scalarUpdates.groupLabel = input.groupLabel;
  if (input.unitLabel !== undefined) scalarUpdates.unitLabel = input.unitLabel;
  if (input.isFilterable !== undefined) scalarUpdates.isFilterable = input.isFilterable;
  if (input.isRequiredForPublish !== undefined) {
    scalarUpdates.isRequiredForPublish = input.isRequiredForPublish;
  }

  const updated = await recordPlatformAction(
    async (tx) => {
      const [attributeRow] =
        Object.keys(scalarUpdates).length === 0
          ? [existing]
          : await tx
              .update(commerceCategoryAttribute)
              .set(scalarUpdates)
              .where(eq(commerceCategoryAttribute.id, attributeId))
              .returning(ATTRIBUTE_COLUMNS);
      if (!attributeRow) throw new Error("updateCategoryAttribute: update returned no row");

      /**
       * ⚠️ CHOICES ARE A REPLACE-SET, AND A CHOICE IN USE SURVIVES IT. Deleting one a listing has
       * answered would violate `commerce_product_attribute_value.choice_id`'s RESTRICT — so the
       * delete is scoped to choices with no value pointing at them, and an in-use choice the
       * admin dropped from the list simply stays. Losing the constraint violation is not the
       * point; keeping the buyer's filter working is.
       */
      if (input.choices !== undefined) {
        const keptValues = new Set(input.choices.map((choice) => choice.choiceValue));
        const currentChoices = await tx
          .select({
            id: commerceCategoryAttributeChoice.id,
            choiceValue: commerceCategoryAttributeChoice.choiceValue,
          })
          .from(commerceCategoryAttributeChoice)
          .where(eq(commerceCategoryAttributeChoice.attributeId, attributeId));

        const removableIds = currentChoices
          .filter((choice) => !keptValues.has(choice.choiceValue))
          .map((choice) => choice.id);
        if (removableIds.length > 0) {
          const inUse = await tx
            .select({ choiceId: commerceProductAttributeValue.choiceId })
            .from(commerceProductAttributeValue)
            .where(inArray(commerceProductAttributeValue.choiceId, removableIds));
          const inUseIds = new Set(inUse.map((row) => row.choiceId));
          const deletableIds = removableIds.filter((id) => !inUseIds.has(id));
          if (deletableIds.length > 0) {
            await tx
              .delete(commerceCategoryAttributeChoice)
              .where(inArray(commerceCategoryAttributeChoice.id, deletableIds));
          }
        }

        const currentByValue = new Map(
          currentChoices.map((choice) => [choice.choiceValue, choice]),
        );
        for (const [choiceIndex, choice] of input.choices.entries()) {
          const current = currentByValue.get(choice.choiceValue);
          if (current === undefined) {
            await tx.insert(commerceCategoryAttributeChoice).values({
              attributeId,
              choiceValue: choice.choiceValue,
              label: choice.label,
              position: choiceIndex,
            });
          } else {
            await tx
              .update(commerceCategoryAttributeChoice)
              .set({ label: choice.label, position: choiceIndex })
              .where(eq(commerceCategoryAttributeChoice.id, current.id));
          }
        }
      }
      return attributeRow;
    },
    (attributeRow) => ({
      eventKind: "commerce_category_attribute_updated",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Updated a category attribute",
      targetLabel: `attribute ${attributeRow.attributeKey}`,
      payload: {
        attributeId,
        changedFields: Object.keys(scalarUpdates),
        choicesReplaced: input.choices !== undefined,
      },
      occurredAt: new Date(),
    }),
  );

  const [view] = await attachChoicesAndCounts([updated], new Set());
  if (!view) throw new Error("updateCategoryAttribute: view assembly returned no row");
  return { success: true, value: view };
}

/**
 * One answer as the seller submits it.
 *
 * A TAGGED UNION rather than three optional columns, so "which kind of answer is this" is
 * decided once by the caller and cannot arrive as two at a time — the shape the value table's
 * `num_nonnulls(...) = 1` CHECK enforces one layer down.
 */
export type ProductAttributeValueInput =
  | { readonly attributeKey: string; readonly kind: "enum"; readonly choiceValue: string }
  | { readonly attributeKey: string; readonly kind: "number"; readonly numericValueScaled: number }
  | { readonly attributeKey: string; readonly kind: "text"; readonly textValue: string };

export interface ProductAttributeValueView {
  readonly attributeId: string;
  readonly attributeKey: string;
  readonly label: string;
  readonly groupLabel: string | null;
  readonly valueKind: AttributeValueKind;
  readonly unitLabel: string | null;
  readonly numericScale: number | null;
  readonly position: number;
  readonly choiceValue: string | null;
  readonly choiceLabel: string | null;
  readonly numericValueScaled: number | null;
  readonly textValue: string | null;
}

/** The structured answers on one listing, ordered as the spec sheet renders them. */
export async function listProductAttributeValues(
  productId: string,
): Promise<readonly ProductAttributeValueView[]> {
  const rows = await db
    .select({
      attributeId: commerceCategoryAttribute.id,
      attributeKey: commerceCategoryAttribute.attributeKey,
      label: commerceCategoryAttribute.label,
      groupLabel: commerceCategoryAttribute.groupLabel,
      valueKind: commerceCategoryAttribute.valueKind,
      unitLabel: commerceCategoryAttribute.unitLabel,
      numericScale: commerceCategoryAttribute.numericScale,
      position: commerceCategoryAttribute.position,
      choiceValue: commerceCategoryAttributeChoice.choiceValue,
      choiceLabel: commerceCategoryAttributeChoice.label,
      numericValueScaled: commerceProductAttributeValue.numericValueScaled,
      textValue: commerceProductAttributeValue.textValue,
    })
    .from(commerceProductAttributeValue)
    .innerJoin(
      commerceCategoryAttribute,
      eq(commerceCategoryAttribute.id, commerceProductAttributeValue.attributeId),
    )
    .leftJoin(
      commerceCategoryAttributeChoice,
      eq(commerceCategoryAttributeChoice.id, commerceProductAttributeValue.choiceId),
    )
    .where(eq(commerceProductAttributeValue.productId, productId))
    .orderBy(asc(commerceCategoryAttribute.position), asc(commerceCategoryAttribute.attributeKey));
  return rows;
}

/**
 * `PUT /products/:id/attributes` — a REPLACE-SET over one listing's structured answers.
 *
 * Replace-set, matching the shipped variants / highlights / customization-options writes: what
 * this array holds becomes the listing's whole structured spec sheet, and `[]` clears it.
 *
 * ⚠️ EVERY KEY IS CHECKED AGAINST THE PRODUCT'S RESOLVED SET, and a key outside it is refused
 * rather than dropped. A seller sending `voltage` for a chair has misunderstood something, and
 * silently discarding it would leave them believing the listing states a fact it does not.
 *
 * ⚠️ THE KIND MUST MATCH THE DEFINITION. A number sent for an `enum` attribute is a 422 naming
 * the expected kind, not a coerced string — the whole reason the definition exists is that the
 * answer has a type.
 *
 * DELETE-THEN-INSERT IS SAFE HERE, unlike for variants: nothing references a value row, so
 * rewriting the set cannot orphan anything. `attributeId`'s RESTRICT protects the DEFINITION,
 * which this never touches.
 */
export async function replaceProductAttributeValues(
  sellerOrganizationId: string,
  productId: string,
  values: readonly ProductAttributeValueInput[],
): Promise<Result<readonly ProductAttributeValueView[], CommerceCategoryAttributeError>> {
  const [productRow] = await db
    .select({ id: product.id, categoryId: product.categoryId })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.sellerOrganizationId, sellerOrganizationId)))
    .limit(1);
  // A product the caller does not own answers the same as one that does not exist — the
  // ownership rule every `/products/:id*` route follows.
  if (!productRow) {
    return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId: productId } };
  }

  const resolved = await resolveCategoryAttributes(productRow.categoryId);
  const definitionByKey = new Map(resolved.map((attribute) => [attribute.attributeKey, attribute]));

  const insertRows: {
    productId: string;
    attributeId: string;
    choiceId: string | null;
    numericValueScaled: number | null;
    textValue: string | null;
  }[] = [];

  for (const value of values) {
    const definition = definitionByKey.get(value.attributeKey);
    if (definition === undefined) {
      return {
        success: false,
        error: { type: "ATTRIBUTE_NOT_IN_CATEGORY", attributeKey: value.attributeKey },
      };
    }
    if (definition.valueKind !== value.kind) {
      return {
        success: false,
        error: {
          type: "ATTRIBUTE_VALUE_KIND_MISMATCH",
          attributeKey: value.attributeKey,
          expected: definition.valueKind,
        },
      };
    }

    switch (value.kind) {
      case "enum": {
        const choice = definition.choices.find(
          (candidate) => candidate.choiceValue === value.choiceValue,
        );
        if (choice === undefined) {
          return {
            success: false,
            error: { type: "ATTRIBUTE_CHOICE_NOT_FOUND", choiceValue: value.choiceValue },
          };
        }
        insertRows.push({
          productId,
          attributeId: definition.id,
          choiceId: choice.id,
          numericValueScaled: null,
          textValue: null,
        });
        break;
      }
      case "number":
        insertRows.push({
          productId,
          attributeId: definition.id,
          choiceId: null,
          numericValueScaled: value.numericValueScaled,
          textValue: null,
        });
        break;
      case "text":
        insertRows.push({
          productId,
          attributeId: definition.id,
          choiceId: null,
          numericValueScaled: null,
          textValue: value.textValue,
        });
        break;
      default: {
        const exhaustiveValue: never = value;
        throw new Error(`Unhandled attribute value kind: ${JSON.stringify(exhaustiveValue)}`);
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(commerceProductAttributeValue)
      .where(eq(commerceProductAttributeValue.productId, productId));
    if (insertRows.length > 0) {
      await tx.insert(commerceProductAttributeValue).values(insertRows);
    }
  });

  /**
   * The search document carries the attribute VALUES in its indexed text, so a structured answer
   * stays findable in the free-text box. Enqueued after commit, like every other product write.
   */
  const { enqueueProductSearchDocumentRefresh } =
    await import("#src/modules/store/catalog/store-search.service.js");
  await enqueueProductSearchDocumentRefresh(productId);

  return { success: true, value: await listProductAttributeValues(productId) };
}

/**
 * A public slug to its category id, ACTIVE only.
 *
 * Its own lookup rather than reusing `getCategoryBySlug`, which returns the whole detail
 * projection plus facets and a page of products — none of which an attribute read needs.
 * Draft and retired categories answer null, so the attributes route 404s by the same rule the
 * category page itself does.
 */
export async function findActiveCategoryIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(and(eq(commerceCategory.slug, slug), eq(commerceCategory.state, "active")))
    .limit(1);
  return row?.id ?? null;
}
