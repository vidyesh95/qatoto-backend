import type { z } from "zod";

import {
  CountersignPeriodSchema,
  DeclineAgreementSchema,
  FinalizePeriodSchema,
  ProposeCompensationAgreementSchema,
  RecordPaymentSchema,
  SupersedePeriodSchema,
  WithdrawAgreementSchema,
} from "#src/schemas/compensation.schemas.js";
import {
  CreateDailyLogSchema,
  SubmitDailyLogSchema,
  UpdateDailyLogSchema,
} from "#src/schemas/daily-logs.schemas.js";
import { CreateCategorySchema } from "#src/schemas/discovery-catalog.schemas.js";
import {
  DecideCategorySchema,
  DecideMergeProposalSchema,
} from "#src/schemas/discovery-moderation.schemas.js";
import {
  CreateDiscoveryRegionSchema,
  CreateDiscoverySkillSchema,
  UpdateDiscoveryRegionSchema,
  UpdateDiscoverySkillSchema,
} from "#src/schemas/discovery-vocabulary.schemas.js";
import {
  CreateFundingRoundSchema,
  CreatePledgeSchema,
  MilestoneSchema,
  MilestoneVarianceSchema,
  UpdateFundingRoundSchema,
  UpdateMilestoneSchema,
} from "#src/schemas/funding.schemas.js";
import {
  CreateMarketInsightSchema,
  UpdateMarketInsightSchema,
} from "#src/schemas/market-insights.schemas.js";
import { MarkNotificationsReadSchema } from "#src/modules/platform/notifications/notifications.schemas.js";
import {
  CountersignPlatformRoleSchema,
  ProposePlatformRoleSchema,
} from "#src/schemas/platform-roles.schemas.js";
import {
  CreateClusterProjectLinkSchema,
  CreateProblemReportSchema,
} from "#src/schemas/problem-clusters.schemas.js";
import {
  CreateApplicationSchema,
  CreateInviteSchema,
  DecisionNoteSchema,
} from "#src/schemas/project-applications.schemas.js";
import {
  CreateOpenRoleSchema,
  UpdateOpenRoleSchema,
} from "#src/schemas/project-roles.schemas.js";
import {
  CreatePromotionalSlideSchema,
  ReorderPromotionalSlidesSchema,
  UpdatePromotionalSlideSchema,
} from "#src/modules/home/promotions/promotions.schemas.js";
import {
  AuthorizeIntegrationSchema,
  BakePieSchema,
  CastVoteSchema,
  CreateSuggestionSchema,
  DecideSuggestionSchema,
  LockRateSchema,
  OverrideStepSchema,
  ProposeRateSchema,
  RaiseDisputeSchema,
  ResolveDisputeSchema,
  ReverifySchema,
  SubmitClaimSchema,
  UploadReceiptSchema,
} from "#src/schemas/proof-of-effort.schemas.js";
import {
  AttachPaperFileSchema,
  CreateBranchSchema,
  CreateOpportunitySchema,
  CreatePaperCategorySchema,
  CreatePaperSchema,
  CreatePostSchema,
  CreateProgramSchema,
  CreateReplySchema,
  DecidePaperCategorySchema,
  DismissReportSchema,
  JoinProgramSchema,
  LogEffortSchema,
  ModeratePaperSchema,
  ModeratePostSchema,
  ModerateProgramSchema,
  RecordContributionSchema,
  ReportContentSchema,
  UpdateBranchSchema,
  UpdateParticipationSchema,
  UpdateProgramSchema,
} from "#src/schemas/research-programs.schemas.js";
import {
  CreateProjectSchema,
  LinkMarketInsightSchema,
  UpdateMemberSchema,
  UpdateProjectSchema,
  UpdateProjectStageSchema,
} from "#src/schemas/research-projects.schemas.js";
import { ReplaceSpotlightSlotsSchema } from "#src/modules/home/spotlight/spotlight.schemas.js";
import {
  CreateSupplierEngagementSchema,
  CreateSupplierSchema,
  UpdateSupplierEngagementSchema,
  UpdateSupplierSchema,
} from "#src/schemas/suppliers.schemas.js";
import { TalentProfileSchema } from "#src/schemas/talent-profiles.schemas.js";
import {
  AddFileLinkSchema,
  CreateColumnSchema,
  CreateTaskSchema,
  MarkChatReadSchema,
  MoveTaskSchema,
  PostChatMessageSchema,
  ReorderColumnsSchema,
  UpdateColumnSchema,
  UpdateFileLinkSchema,
  UpdateTaskSchema,
} from "#src/schemas/workshop.schemas.js";

/**
 * Which Zod schema each R&D route parses its body with (§11l.2 item 8).
 *
 * WHY A MAP AND NOT A DERIVATION. Nothing at runtime connects a route to its schema. There
 * is no validation middleware on any chain — a `src/middleware/validate.ts` once existed, was
 * used by zero routes, and has been deleted — and the real pattern is an in-controller
 * `Schema.safeParse(req.body)`, so the schema is a local inside a closure the router cannot
 * see. The only link between the two is the controller function's name.
 *
 * WHICH MAKES THIS THE ONE HAND-MAINTAINED THING IN A DERIVED SPEC, and therefore the one
 * thing that can drift. `openapi-rnd-bodies.test.ts` is what stops it: it walks the same
 * routers, finds every route whose handler reads a body, and fails the build naming any key
 * missing from here. Adding a body-taking route without an entry is a red build, not a
 * silently undocumented endpoint.
 *
 * KEYED `"<verb> <openApiPath>"`, the convention `PUBLICLY_RESOLVABLE` in `openapi-rnd.ts`
 * already uses. Two keys look like typos and are not: `post /research-projects/` carries a
 * trailing slash because the router declares `router.post("/")` under that mount, while
 * `patch /research-projects/{projectSlug}` does not.
 *
 * VALUES HOLD THE SCHEMA ITSELF, never its name. `CreateCategorySchema` serves both
 * `post /discovery/categories` and `post /research-categories`, and a name-keyed lookup
 * across sixteen controller modules invites exactly that collision.
 *
 * NO NEW IMPORT COST: `openapi-rnd.ts` already imports all sixteen routers, each of which
 * imports its controllers, so every schema below is in the module graph before this file is
 * evaluated. Nothing under `src/controllers/` or `src/services/` imports `#src/docs/*`, so
 * there is no cycle.
 */

/**
 * `required` IS NOT DERIVABLE FROM THE SCHEMA, and the difference is not academic.
 * `!schema.safeParse({}).success` calls seventeen of these bodies optional; only nine
 * routes are. `UpdateProjectSchema.safeParse({})` succeeds, yet that handler reads
 * `req.body` directly and Express 5 leaves it `undefined` when there is no Content-Type, so
 * a bodyless PATCH is a 422. Publishing `required: false` there would be a spec that
 * quietly LOOSENS — the exact thing `route-inventory.ts` forbids.
 *
 * The truth is a property of the ROUTE: a body is optional exactly when the handler reads it
 * through `optionalBody(req)`. The test asserts that correspondence in both directions.
 */
export interface RndRequestBody {
  readonly schema: z.ZodType;
  readonly required: boolean;
  /** Set only for the one multipart route; JSON otherwise. */
  readonly contentType?: "multipart/form-data";
  /** The file part's field name, merged into the schema as a binary property. */
  readonly binaryField?: string;
}

export const RND_REQUEST_BODIES: Readonly<Record<string, RndRequestBody>> = {
  "patch /discovery/admin/market-insights/{insightId}": {
    schema: UpdateMarketInsightSchema,
    required: true,
  },
  "patch /discovery/admin/regions/{regionId}": {
    schema: UpdateDiscoveryRegionSchema,
    required: true,
  },
  "patch /discovery/admin/skills/{skillId}": { schema: UpdateDiscoverySkillSchema, required: true },
  "patch /funding-rounds/{roundId}": { schema: UpdateFundingRoundSchema, required: true },
  "patch /milestones/{milestoneId}": { schema: UpdateMilestoneSchema, required: true },
  "patch /research-projects/{projectSlug}": { schema: UpdateProjectSchema, required: true },
  "patch /research-projects/{projectSlug}/daily-logs/{logId}": {
    schema: UpdateDailyLogSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/effort-claims/{claimId}/steps/{stepId}/override": {
    schema: OverrideStepSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/members/{memberId}": {
    schema: UpdateMemberSchema,
    required: false,
  },
  "patch /research-projects/{projectSlug}/roles/{roleId}": {
    schema: UpdateOpenRoleSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/stage": {
    schema: UpdateProjectStageSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/supplier-engagements/{engagementId}": {
    schema: UpdateSupplierEngagementSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/workshop/chat/{messageId}": {
    schema: PostChatMessageSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/workshop/columns/{columnId}": {
    schema: UpdateColumnSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/workshop/files/{fileId}": {
    schema: UpdateFileLinkSchema,
    required: true,
  },
  "patch /research-projects/{projectSlug}/workshop/tasks/{taskId}": {
    schema: UpdateTaskSchema,
    required: true,
  },
  "patch /suppliers/{supplierId}": { schema: UpdateSupplierSchema, required: true },
  "post /discovery/admin/categories/{categoryId}/decide": {
    schema: DecideCategorySchema,
    required: true,
  },
  "post /discovery/admin/market-insights": { schema: CreateMarketInsightSchema, required: true },
  "post /discovery/admin/merge-proposals/{proposalId}/decide": {
    schema: DecideMergeProposalSchema,
    required: true,
  },
  "post /discovery/admin/regions": { schema: CreateDiscoveryRegionSchema, required: true },
  "post /discovery/admin/skills": { schema: CreateDiscoverySkillSchema, required: true },
  "post /discovery/categories": { schema: CreateCategorySchema, required: true },
  "post /discovery/problem-clusters/{clusterId}/project-links": {
    schema: CreateClusterProjectLinkSchema,
    required: true,
  },
  "post /discovery/problem-reports": { schema: CreateProblemReportSchema, required: true },
  "post /funding-rounds/{roundId}/pledges": { schema: CreatePledgeSchema, required: true },
  "post /notifications/read": { schema: MarkNotificationsReadSchema, required: true },
  "post /research-categories": { schema: CreateCategorySchema, required: true },
  "post /research-projects/": { schema: CreateProjectSchema, required: true },
  "post /research-projects/{projectSlug}/allocation-proposals/{proposalId}/dispute": {
    schema: RaiseDisputeSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/applications": {
    schema: CreateApplicationSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/applications/{applicationId}/accept": {
    schema: DecisionNoteSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/applications/{applicationId}/decline": {
    schema: DecisionNoteSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/applications/{applicationId}/withdraw": {
    schema: DecisionNoteSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/compensation-agreements/{agreementId}/decline": {
    schema: DeclineAgreementSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/compensation-agreements/{agreementId}/withdraw": {
    schema: WithdrawAgreementSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/compensation-period-lines/{lineId}/payments": {
    schema: RecordPaymentSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/compensation-periods/{periodId}/countersign": {
    schema: CountersignPeriodSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/compensation-periods/{periodId}/finalize": {
    schema: FinalizePeriodSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/compensation-periods/{periodId}/supersede": {
    schema: SupersedePeriodSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/daily-logs": {
    schema: CreateDailyLogSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/daily-logs/{logId}/submit": {
    schema: SubmitDailyLogSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/disputes/{disputeId}/resolve": {
    schema: ResolveDisputeSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/disputes/{disputeId}/votes": {
    schema: CastVoteSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/effort-claims": {
    schema: SubmitClaimSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/effort-claims/{claimId}/reverify": {
    schema: ReverifySchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/fair-market-rate/lock": {
    schema: LockRateSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/funding-rounds": {
    schema: CreateFundingRoundSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/integrations/{provider}/authorize-url": {
    schema: AuthorizeIntegrationSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/invites": { schema: CreateInviteSchema, required: true },
  "post /research-projects/{projectSlug}/market-insight-links": {
    schema: LinkMarketInsightSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/members/{memberUserId}/compensation-agreement": {
    schema: ProposeCompensationAgreementSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/members/{memberUserId}/fair-market-rate": {
    schema: ProposeRateSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/milestones": { schema: MilestoneSchema, required: true },
  "post /research-projects/{projectSlug}/optimization-suggestions": {
    schema: CreateSuggestionSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/optimization-suggestions/{suggestionId}/accept": {
    schema: DecideSuggestionSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/optimization-suggestions/{suggestionId}/dismiss": {
    schema: DecideSuggestionSchema,
    required: false,
  },
  "post /research-projects/{projectSlug}/physical-receipts": {
    schema: UploadReceiptSchema,
    required: true,
    contentType: "multipart/form-data",
    binaryField: "receipt",
  },
  "post /research-projects/{projectSlug}/pie-bake": { schema: BakePieSchema, required: true },
  "post /research-projects/{projectSlug}/roles": { schema: CreateOpenRoleSchema, required: true },
  "post /research-projects/{projectSlug}/supplier-engagements": {
    schema: CreateSupplierEngagementSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/chat": {
    schema: PostChatMessageSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/chat/read": {
    schema: MarkChatReadSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/columns": {
    schema: CreateColumnSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/columns/reorder": {
    schema: ReorderColumnsSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/files": {
    schema: AddFileLinkSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/tasks": {
    schema: CreateTaskSchema,
    required: true,
  },
  "post /research-projects/{projectSlug}/workshop/tasks/{taskId}/move": {
    schema: MoveTaskSchema,
    required: true,
  },
  // --- §10 research programs (§11f) ---
  //
  // `required` is NOT derivable from the schema — the truth is a property of the route: a
  // body is optional exactly when the handler reads it through `optionalBody(req)`. The two
  // PATCHes below do; everything else parses `req.body` directly.
  "post /research-programs/": { schema: CreateProgramSchema, required: true },
  "patch /research-programs/{programSlug}": { schema: UpdateProgramSchema, required: false },
  "post /research-programs/{programSlug}/moderate": {
    schema: ModerateProgramSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/branches": { schema: CreateBranchSchema, required: true },
  "patch /research-programs/{programSlug}/branches/{branchId}": {
    schema: UpdateBranchSchema,
    required: false,
  },
  "post /research-programs/{programSlug}/papers": { schema: CreatePaperSchema, required: true },
  // The one multipart route in this domain. `binaryField` splices a
  // `{ type: "string", format: "binary" }` property into the converted object, so
  // `additionalProperties: false` stays correct.
  // --- The home-page promotional carousel.
  //
  // TWO MULTIPART ENTRIES. `binaryField` splices a `{ type: "string", format: "binary" }`
  // property into the converted object so `additionalProperties: false` stays correct.
  // The create route carries its text parts in the SAME body, which is why its schema is
  // a real object rather than only the file.
  "post /promotions/admin/slides": {
    schema: CreatePromotionalSlideSchema,
    required: true,
    contentType: "multipart/form-data",
    binaryField: "image",
  },
  "patch /promotions/admin/slides/reorder": {
    schema: ReorderPromotionalSlidesSchema,
    required: true,
  },
  "patch /promotions/admin/slides/{slideId}": {
    schema: UpdatePromotionalSlideSchema,
    required: true,
  },
  // PATCH /promotions/admin/slides/{slideId}/image is deliberately ABSENT. It carries only
  // the file and its controller never touches `req.body`, so it is not a body-reading
  // route — an entry here would be an orphan the sweep reports.
  "put /spotlight/admin/slots": {
    schema: ReplaceSpotlightSlotsSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/papers/{paperId}/file": {
    schema: AttachPaperFileSchema,
    required: true,
    contentType: "multipart/form-data",
    binaryField: "paper",
  },
  "post /research-programs/{programSlug}/papers/{paperId}/report": {
    schema: ReportContentSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/papers/{paperId}/moderate": {
    schema: ModeratePaperSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/posts": { schema: CreatePostSchema, required: true },
  "post /research-programs/{programSlug}/posts/{postId}/replies": {
    schema: CreateReplySchema,
    required: true,
  },
  "post /research-programs/{programSlug}/posts/{postId}/report": {
    schema: ReportContentSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/posts/{postId}/moderate": {
    schema: ModeratePostSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/reports/{reportId}/dismiss": {
    schema: DismissReportSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/contributors/me": {
    schema: JoinProgramSchema,
    required: true,
  },
  "patch /research-programs/{programSlug}/contributors/me": {
    schema: UpdateParticipationSchema,
    required: false,
  },
  "post /research-programs/{programSlug}/effort-logs": { schema: LogEffortSchema, required: true },
  "post /research-programs/{programSlug}/contributions": {
    schema: RecordContributionSchema,
    required: true,
  },
  "post /research-programs/{programSlug}/product-opportunities": {
    schema: CreateOpportunitySchema,
    required: true,
  },
  "post /admin/platform-roles/proposals": { schema: ProposePlatformRoleSchema, required: true },
  "post /admin/platform-roles/proposals/{proposalId}/countersign": {
    schema: CountersignPlatformRoleSchema,
    required: false,
  },
  "post /research-paper-categories": { schema: CreatePaperCategorySchema, required: true },
  "post /research-paper-categories/{categoryId}/decide": {
    schema: DecidePaperCategorySchema,
    required: true,
  },
  "post /suppliers": { schema: CreateSupplierSchema, required: true },
  "put /discovery/talent/me": { schema: TalentProfileSchema, required: true },
  "put /milestones/{milestoneId}/variance": { schema: MilestoneVarianceSchema, required: true },
};
