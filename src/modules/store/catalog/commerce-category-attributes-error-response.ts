/**
 * Error → HTTP for the category-attribute surface (STORE §20).
 *
 * The same status policy the category mapper states: 403 names no resource so it cannot be used
 * to probe an id; 404 is only reachable AFTER the capability check has passed; 422 means the
 * request itself is wrong and the same payload will keep failing; 409 is a conflict with the
 * CURRENT state that the same payload would survive later.
 */
import type { Response } from "express";

import type { CommerceCategoryAttributeError } from "#src/modules/store/catalog/commerce-category-attributes.service.js";

export function mapCategoryAttributeErrorToResponse(error: CommerceCategoryAttributeError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403: the gate. Names no resource.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "Managing category attributes requires the moderator or admin role.",
      };

    // --- 404: past the gate already.
    case "CATEGORY_NOT_FOUND":
      return { statusCode: 404, message: "Store category not found." };
    case "ATTRIBUTE_NOT_FOUND":
      return { statusCode: 404, message: "That attribute does not exist." };
    case "ATTRIBUTE_REQUEST_NOT_FOUND":
      return { statusCode: 404, message: "That attribute request does not exist." };

    // --- 422: the payload is wrong and will stay wrong.
    case "ATTRIBUTE_NOT_FILTERABLE_KIND":
      return {
        statusCode: 422,
        message: "A free-text attribute cannot be filterable.",
        errors: {
          isFilterable: [
            "Only enum and number attributes can be filtered. Free text produces one chip per spelling, which is worse than no filter.",
          ],
        },
      };
    case "ATTRIBUTE_NUMERIC_SHAPE_INVALID":
      return {
        statusCode: 422,
        message: "A number attribute needs a scale, and only a number attribute may have one.",
        errors: {
          numericScale: ["Set a scale of 0–6 for a number attribute, and none for the others."],
        },
      };
    case "ATTRIBUTE_CHOICES_NOT_APPLICABLE":
      return {
        statusCode: 422,
        message: "Only an enum attribute can carry choices.",
        errors: { choices: [`This attribute is a ${error.valueKind}, so it has no choice list.`] },
      };
    case "ATTRIBUTE_CHOICE_NOT_FOUND":
      return {
        statusCode: 422,
        message: `"${error.choiceValue}" is not one of this attribute's choices.`,
        errors: { values: ["Pick one of the values the category defines."] },
      };
    case "ATTRIBUTE_NOT_IN_CATEGORY":
      return {
        statusCode: 422,
        message: `This listing's category does not define "${error.attributeKey}".`,
        errors: {
          values: [
            "Only attributes the category defines (or inherits) can be answered. Anything else belongs in the free-text specifications.",
          ],
        },
      };
    case "ATTRIBUTE_VALUE_KIND_MISMATCH":
      return {
        statusCode: 422,
        message: `"${error.attributeKey}" expects a ${error.expected} answer.`,
        errors: { values: [`Send a ${error.expected} value for this attribute.`] },
      };

    // --- 409: true now, not necessarily later.
    case "ATTRIBUTE_KEY_TAKEN":
      return {
        statusCode: 409,
        message: `"${error.attributeKey}" is already defined on this category or one above it.`,
        errors: {
          attributeKey: [
            "Edit the existing attribute instead — defining it again here would shadow the inherited one for this branch only.",
          ],
        },
      };
    case "ATTRIBUTE_IN_USE":
      return {
        statusCode: 409,
        message: `${String(error.productCount)} listings still answer this attribute. Turn off filtering instead of removing it.`,
      };
    case "ATTRIBUTE_REQUEST_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message:
          error.state === "approved"
            ? "Another moderator already approved this request."
            : "Another moderator already rejected this request.",
      };

    default: {
      // Adding a variant without handling it here breaks the build, which is the point.
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled category attribute error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondCategoryAttributeError(
  res: Response,
  error: CommerceCategoryAttributeError,
): void {
  const { statusCode, message, errors } = mapCategoryAttributeErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
