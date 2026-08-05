import { db } from "#src/db/index.js";
import { commerceOrganizationAuditEntry } from "#src/db/schema.js";
import { canonicalizeDocument } from "#src/lib/canonical-hash.js";
import type { Result } from "#src/types/index.js";

export type CommerceOrganizationAuditEventKind =
  (typeof commerceOrganizationAuditEntry.$inferSelect)["eventKind"];
export type CommerceOrganizationAuditMemberRole = NonNullable<
  (typeof commerceOrganizationAuditEntry.$inferSelect)["actorMemberRoleSnapshot"]
>;

export type CommerceAuditSafeValue =
  | string
  | boolean
  | null
  | readonly CommerceAuditSafeValue[]
  | { readonly [key: string]: CommerceAuditSafeValue };

export interface CommerceOrganizationAuditAppendInput {
  readonly organizationId: string;
  readonly eventKind: CommerceOrganizationAuditEventKind;
  readonly actorUserId: string | null;
  readonly actorMemberRoleSnapshot: CommerceOrganizationAuditMemberRole | null;
  readonly targetEntityType: string;
  readonly targetEntityId: string;
  readonly payload: Readonly<Record<string, CommerceAuditSafeValue>>;
  readonly occurredAt: Date;
}

export type CommerceOrganizationAuditAppendError =
  | { type: "UNSAFE_PAYLOAD"; fieldPath: string }
  | { type: "PAYLOAD_TOO_LARGE" }
  | { type: "APPEND_FAILED" };

const MAXIMUM_PAYLOAD_JSON_LENGTH = 10_000;
const FORBIDDEN_PAYLOAD_KEY =
  /(address|cipher|encrypted|email|filename|object.*key|password|phone|registration|secret|tax|token)/i;
type CommerceAuditDatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

function findUnsafePayloadPath(value: CommerceAuditSafeValue, fieldPath: string): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const unsafeItemPath = findUnsafePayloadPath(item, `${fieldPath}[${String(index)}]`);
      if (unsafeItemPath !== null) return unsafeItemPath;
    }
    return null;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childPath = `${fieldPath}.${key}`;
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) return childPath;
    const unsafeChildPath = findUnsafePayloadPath(childValue, childPath);
    if (unsafeChildPath !== null) return unsafeChildPath;
  }
  return null;
}

/**
 * Appends redacted organization history. The payload is canonical and rejects
 * secret/PII-bearing field names before any database write. Callers pass their
 * transaction so the domain mutation and its immutable audit evidence commit together.
 */
export async function appendCommerceOrganizationAuditEntry(
  databaseExecutor: CommerceAuditDatabaseExecutor,
  input: CommerceOrganizationAuditAppendInput,
): Promise<Result<{ readonly auditEntryId: string }, CommerceOrganizationAuditAppendError>> {
  const unsafePayloadPath = findUnsafePayloadPath(input.payload, "$");
  if (unsafePayloadPath !== null) {
    return {
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: unsafePayloadPath },
    };
  }

  const payloadJson = canonicalizeDocument(input.payload);
  if (payloadJson.length > MAXIMUM_PAYLOAD_JSON_LENGTH) {
    return { success: false, error: { type: "PAYLOAD_TOO_LARGE" } };
  }

  try {
    const [insertedEntry] = await databaseExecutor
      .insert(commerceOrganizationAuditEntry)
      .values({
        organizationId: input.organizationId,
        eventKind: input.eventKind,
        actorUserId: input.actorUserId,
        actorMemberRoleSnapshot: input.actorMemberRoleSnapshot,
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        payloadJson,
        occurredAt: input.occurredAt,
      })
      .returning({ id: commerceOrganizationAuditEntry.id });

    if (!insertedEntry) return { success: false, error: { type: "APPEND_FAILED" } };
    return { success: true, value: { auditEntryId: insertedEntry.id } };
  } catch {
    return { success: false, error: { type: "APPEND_FAILED" } };
  }
}
