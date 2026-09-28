import { describe, expect, it } from "vitest";

import {
  buildAnswerWithdrawalAuditEntry,
  canViewerDeleteAnswer,
  canViewerDeleteQuestion,
  describeAnswerWithdrawer,
  type QaAnswerAuthorship,
  type QaPermissionViewer,
} from "#src/modules/store/trust/commerce-product-qa.permissions.js";

const SELLER_ORGANIZATION_ID = "commerce_org_seller";
const BUYER_ORGANIZATION_ID = "commerce_org_buyer";
const STRANGER_ORGANIZATION_ID = "commerce_org_stranger";

const SELLER_AUTHOR_USER_ID = "user_seller_author";
const SELLER_TEAMMATE_USER_ID = "user_seller_teammate";
const BUYER_AUTHOR_USER_ID = "user_buyer_author";
const BUYER_TEAMMATE_USER_ID = "user_buyer_teammate";
const STRANGER_USER_ID = "user_stranger";

const SELLER_ANSWER: QaAnswerAuthorship = {
  id: "answer_seller",
  questionId: "question_1",
  authorUserId: SELLER_AUTHOR_USER_ID,
  authorKind: "seller",
  authorOrganizationId: SELLER_ORGANIZATION_ID,
};

const VERIFIED_BUYER_ANSWER: QaAnswerAuthorship = {
  id: "answer_buyer",
  questionId: "question_1",
  authorUserId: BUYER_AUTHOR_USER_ID,
  authorKind: "verified_buyer",
  authorOrganizationId: BUYER_ORGANIZATION_ID,
};

function viewerOf(
  userId: string | null,
  organizationId: string | null,
  memberRole: QaPermissionViewer["memberRole"] = organizationId === null ? null : "support",
): QaPermissionViewer {
  return { userId, organizationId, memberRole };
}

const ANONYMOUS_VIEWER = viewerOf(null, null);

describe("canViewerDeleteAnswer", () => {
  it.each<[string, QaAnswerAuthorship, QaPermissionViewer, boolean]>([
    ["the seller author", SELLER_ANSWER, viewerOf(SELLER_AUTHOR_USER_ID, SELLER_ORGANIZATION_ID), true],
    [
      "a verified-buyer author whose session has no active organization",
      VERIFIED_BUYER_ANSWER,
      viewerOf(BUYER_AUTHOR_USER_ID, null),
      true,
    ],
    [
      "a seller-organization teammate, on the seller's answer",
      SELLER_ANSWER,
      viewerOf(SELLER_TEAMMATE_USER_ID, SELLER_ORGANIZATION_ID),
      true,
    ],
    [
      "a member of a different organization, on the seller's answer",
      SELLER_ANSWER,
      viewerOf(STRANGER_USER_ID, STRANGER_ORGANIZATION_ID),
      false,
    ],
    [
      "a teammate of a verified buyer — org-wide withdrawal is for SELLER answers only",
      VERIFIED_BUYER_ANSWER,
      viewerOf(BUYER_TEAMMATE_USER_ID, BUYER_ORGANIZATION_ID),
      false,
    ],
    [
      "the seller organization, on a verified buyer's answer",
      VERIFIED_BUYER_ANSWER,
      viewerOf(SELLER_TEAMMATE_USER_ID, SELLER_ORGANIZATION_ID),
      false,
    ],
    ["an anonymous caller", SELLER_ANSWER, ANONYMOUS_VIEWER, false],
    [
      "a signed-in caller with no organization, on someone else's seller answer",
      SELLER_ANSWER,
      viewerOf(STRANGER_USER_ID, null),
      false,
    ],
    [
      "an organization with no user — impossible through resolveQaViewer, and grants nothing",
      SELLER_ANSWER,
      viewerOf(null, SELLER_ORGANIZATION_ID),
      false,
    ],
  ])("%s → %s", (_label, answer, viewer, isAllowed) => {
    expect(canViewerDeleteAnswer(answer, viewer)).toBe(isAllowed);
  });
});

describe("canViewerDeleteQuestion", () => {
  const question = { askedByUserId: STRANGER_USER_ID };

  it.each<[string, QaPermissionViewer, boolean]>([
    ["the asker, with no organization", viewerOf(STRANGER_USER_ID, null), true],
    [
      "the seller of the product — sellers get no power over buyers' questions",
      viewerOf(SELLER_AUTHOR_USER_ID, SELLER_ORGANIZATION_ID),
      false,
    ],
    ["an anonymous caller", ANONYMOUS_VIEWER, false],
  ])("%s → %s", (_label, viewer, isAllowed) => {
    expect(canViewerDeleteQuestion(question, viewer)).toBe(isAllowed);
  });
});

describe("describeAnswerWithdrawer", () => {
  it("names the author and a teammate differently", () => {
    expect(describeAnswerWithdrawer(SELLER_ANSWER, viewerOf(SELLER_AUTHOR_USER_ID, SELLER_ORGANIZATION_ID))).toBe(
      "author",
    );
    expect(describeAnswerWithdrawer(SELLER_ANSWER, viewerOf(SELLER_TEAMMATE_USER_ID, SELLER_ORGANIZATION_ID))).toBe(
      "organization_member",
    );
  });
});

describe("buildAnswerWithdrawalAuditEntry", () => {
  const occurredAt = new Date("2026-09-28T10:00:00.000Z");

  it.each<[string, QaAnswerAuthorship, QaPermissionViewer, Record<string, unknown>]>([
    [
      "a seller teammate: the seller's chain, the teammate's role, organization_member",
      SELLER_ANSWER,
      viewerOf(SELLER_TEAMMATE_USER_ID, SELLER_ORGANIZATION_ID, "viewer"),
      {
        organizationId: SELLER_ORGANIZATION_ID,
        actorUserId: SELLER_TEAMMATE_USER_ID,
        actorMemberRoleSnapshot: "viewer",
        payload: { questionId: "question_1", withdrawnBy: "organization_member" },
      },
    ],
    [
      "a seller author still in the org: the seller's chain, their role, author",
      SELLER_ANSWER,
      viewerOf(SELLER_AUTHOR_USER_ID, SELLER_ORGANIZATION_ID, "owner"),
      {
        organizationId: SELLER_ORGANIZATION_ID,
        actorUserId: SELLER_AUTHOR_USER_ID,
        actorMemberRoleSnapshot: "owner",
        payload: { questionId: "question_1", withdrawnBy: "author" },
      },
    ],
    [
      "a verified-buyer author with no active org: the BUYER org's chain, no role, author",
      VERIFIED_BUYER_ANSWER,
      viewerOf(BUYER_AUTHOR_USER_ID, null),
      {
        organizationId: BUYER_ORGANIZATION_ID,
        actorUserId: BUYER_AUTHOR_USER_ID,
        actorMemberRoleSnapshot: null,
        payload: { questionId: "question_1", withdrawnBy: "author" },
      },
    ],
    [
      "an author acting from a DIFFERENT org: recorded by user, with no borrowed role",
      SELLER_ANSWER,
      viewerOf(SELLER_AUTHOR_USER_ID, STRANGER_ORGANIZATION_ID, "owner"),
      {
        organizationId: SELLER_ORGANIZATION_ID,
        actorUserId: SELLER_AUTHOR_USER_ID,
        actorMemberRoleSnapshot: null,
        payload: { questionId: "question_1", withdrawnBy: "author" },
      },
    ],
  ])("%s", (_label, answer, viewer, expected) => {
    expect(buildAnswerWithdrawalAuditEntry(answer, viewer, occurredAt)).toEqual({
      eventKind: "product_answer_withdrawn",
      targetEntityType: "commerce_product_answer",
      targetEntityId: answer.id,
      occurredAt,
      ...expected,
    });
  });
});
