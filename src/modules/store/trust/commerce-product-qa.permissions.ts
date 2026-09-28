/**
 * Who may withdraw a product question or answer, and what the withdrawal records (§3.3).
 *
 * PURE, with no database import, because this is the permission and the audit shape the read
 * projection and the write path must agree on. The projection renders `viewer.canDelete` from
 * these; `retractProductAnswer` refuses with them. Two copies of the rule would drift into a
 * control that 404s, or a 200 for a row the page said you could not touch.
 *
 * THE RULE:
 *
 *  - A question is withdrawable by its asker only. It has no organization — it is asked by a
 *    person — so there is nobody else with a claim to it.
 *  - An answer is withdrawable by the user who wrote it, AND, for a SELLER answer only, by any
 *    active member of the seller organization. The answer is displayed under the organization's
 *    name, and any active member may already post it (`resolveAnswerAuthority`) and delete the
 *    listing it sits on (`requireActiveSellerCommerceOrganization` gates no role) — so a teammate
 *    who could write it may also withdraw it. A seller has NO power over a buyer's question or a
 *    verified-buyer answer: that would be a seller editing the public record of their own product.
 *
 * `viewer.organizationId` is only ever the organization `resolveActiveCommerceOrganization`
 * verified an ACTIVE membership in. It is never a client claim.
 */

import type { commerceProductAnswer } from "#src/db/schema.js";
import type {
  CommerceOrganizationAuditAppendInput,
  CommerceOrganizationAuditMemberRole,
} from "#src/modules/store/organizations/commerce-organization-audit.service.js";

type ProductAnswerAuthorKind = (typeof commerceProductAnswer.$inferSelect)["authorKind"];

export interface QaPermissionViewer {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly memberRole: CommerceOrganizationAuditMemberRole | null;
}

export interface QaQuestionAuthorship {
  readonly askedByUserId: string;
}

/**
 * `authorOrganizationId` is a POST-TIME SNAPSHOT (NOT NULL, written once at insert), not a join
 * through current membership — so a user who changes organizations neither gains nor loses a
 * claim over answers written before the move.
 */
export interface QaAnswerAuthorship {
  readonly id: string;
  readonly questionId: string;
  readonly authorUserId: string;
  readonly authorKind: ProductAnswerAuthorKind;
  readonly authorOrganizationId: string;
}

export type AnswerWithdrawer = "author" | "organization_member";

export function canViewerDeleteQuestion(
  question: QaQuestionAuthorship,
  viewer: QaPermissionViewer,
): boolean {
  return viewer.userId !== null && question.askedByUserId === viewer.userId;
}

export function canViewerDeleteAnswer(
  answer: QaAnswerAuthorship,
  viewer: QaPermissionViewer,
): boolean {
  // Defensive: an organization without a user cannot happen through `resolveQaViewer`, and must
  // not grant anything if it ever does.
  if (viewer.userId === null) return false;
  if (answer.authorUserId === viewer.userId) return true;
  return answer.authorKind === "seller" && answer.authorOrganizationId === viewer.organizationId;
}

/** Only meaningful once `canViewerDeleteAnswer` has said yes. */
export function describeAnswerWithdrawer(
  answer: QaAnswerAuthorship,
  viewer: QaPermissionViewer,
): AnswerWithdrawer {
  return answer.authorUserId === viewer.userId ? "author" : "organization_member";
}

/**
 * The audit entry a withdrawal appends, filed on the ANSWERING organization's chain — which every
 * answer has, seller and verified-buyer alike, so an author withdrawing their own answer is
 * recorded exactly as a teammate is. The role is snapshotted only when the actor is withdrawing
 * AS a member of that organization; an author who has since left it, or who is acting from
 * another one, is recorded by user with no role rather than with a role in some other org.
 */
export function buildAnswerWithdrawalAuditEntry(
  answer: QaAnswerAuthorship,
  viewer: QaPermissionViewer,
  occurredAt: Date,
): CommerceOrganizationAuditAppendInput {
  return {
    organizationId: answer.authorOrganizationId,
    eventKind: "product_answer_withdrawn",
    actorUserId: viewer.userId,
    actorMemberRoleSnapshot:
      viewer.organizationId === answer.authorOrganizationId ? viewer.memberRole : null,
    targetEntityType: "commerce_product_answer",
    targetEntityId: answer.id,
    payload: {
      questionId: answer.questionId,
      withdrawnBy: describeAnswerWithdrawer(answer, viewer),
    },
    occurredAt,
  };
}
