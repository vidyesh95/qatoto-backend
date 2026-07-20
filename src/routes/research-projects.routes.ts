import express from "express";

import * as applicationsController from "#src/controllers/project-applications.controller.js";
import * as rolesController from "#src/controllers/project-roles.controller.js";
import * as projectsController from "#src/controllers/research-projects.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import {
  applicationCreateLimiter,
  inviteCreateLimiter,
  projectCoverUploadLimiter,
  projectCreateLimiter,
  projectRoleWriteLimiter,
  projectWatchLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import { uploadProjectCover } from "#src/middleware/upload-project-cover.js";

const router = express.Router();

/**
 * Research & Development — projects, team, roles, applications and invites (§11a).
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser/upload →
 * controller. The limiter precedes `requireIdentifiedUser` deliberately, so an
 * unidentified caller cannot hammer that guard's extra query; and both follow
 * `requireAuth`, because every limiter keys on `req.user.id`.
 *
 * `requireIdentifiedUser` is applied by a STRUCTURAL rule, not by route name: every
 * endpoint whose transaction WRITES A project_member ROW, plus every uniqueness quota
 * and distinct-count. That is what puts it on `/invites/:inviteId/accept` — the
 * endpoint reached by the INVITEE, who actually gets the roster row — and not merely on
 * `POST /invites`, which is reached by the inviter.
 *
 * ROUTE ORDER: literal segments are declared BEFORE `/:projectSlug`, and `/members/me`
 * before `/members/:memberId`, or Express matches the param route first and swallows
 * them. Same rule as the users router's `/me` and the products router's `/mine`.
 */

// --- Collection routes. Literals first.

/** POST /research-projects — creates a DRAFT. 201. */
router.post(
  "/",
  requireAuth,
  projectCreateLimiter,
  requireIdentifiedUser,
  projectsController.createProject,
);

/** GET /research-projects — public feed of `active` projects. */
router.get("/", attachOptionalUser, projectsController.listProjects);

/** GET /research-projects/slugs — for generateStaticParams; no session needed. */
router.get("/slugs", projectsController.listProjectSlugs);

/** GET /research-projects/mine — the caller's own, drafts included. */
router.get("/mine", requireAuth, projectsController.listMyProjects);

// --- Single project.

/** GET /research-projects/:projectSlug — a draft resolves only for its members. */
router.get("/:projectSlug", attachOptionalUser, projectsController.getProject);

/** PATCH /research-projects/:projectSlug — maintainer+, or founder for the equity band. */
router.patch("/:projectSlug", requireAuth, projectsController.updateProject);

/** POST /research-projects/:projectSlug/cover — multipart, field `cover`. */
router.post(
  "/:projectSlug/cover",
  requireAuth,
  projectCoverUploadLimiter,
  uploadProjectCover,
  projectsController.uploadCover,
);

/** DELETE /research-projects/:projectSlug/cover — refused while published. */
router.delete("/:projectSlug/cover", requireAuth, projectsController.deleteCover);

/** POST /research-projects/:projectSlug/publish — server-side completeness gate. */
router.post(
  "/:projectSlug/publish",
  requireAuth,
  requireIdentifiedUser,
  projectsController.publishProject,
);

/** POST /research-projects/:projectSlug/unpublish — active → draft. */
router.post("/:projectSlug/unpublish", requireAuth, projectsController.unpublishProject);

/** POST /research-projects/:projectSlug/archive — terminal. */
router.post("/:projectSlug/archive", requireAuth, projectsController.archiveProject);

/** PATCH /research-projects/:projectSlug/stage — writes an append-only audit row. */
router.patch(
  "/:projectSlug/stage",
  requireAuth,
  parseCompactJsonBody,
  projectsController.changeStage,
);

/** GET /research-projects/:projectSlug/stage-history — member-only. */
router.get("/:projectSlug/stage-history", requireAuth, projectsController.getStageHistory);

// --- Team and membership. `/members/me` MUST precede `/members/:memberId`.

/** GET /research-projects/:projectSlug/team — name/avatar joined from `user`. */
router.get("/:projectSlug/team", attachOptionalUser, projectsController.getTeam);

/** DELETE /research-projects/:projectSlug/members/me — sets `left`, never deletes. */
router.delete("/:projectSlug/members/me", requireAuth, projectsController.leaveProject);

/** PATCH /research-projects/:projectSlug/members/:memberId — founder only. */
router.patch(
  "/:projectSlug/members/:memberId",
  requireAuth,
  requireIdentifiedUser,
  parseCompactJsonBody,
  projectsController.updateMember,
);

/** DELETE /research-projects/:projectSlug/members/:memberId — founder only. */
router.delete("/:projectSlug/members/:memberId", requireAuth, projectsController.removeMember);

// --- Open roles.

/** GET /research-projects/:projectSlug/roles */
router.get("/:projectSlug/roles", attachOptionalUser, rolesController.listRoles);

/** POST /research-projects/:projectSlug/roles — maintainer+. */
router.post(
  "/:projectSlug/roles",
  requireAuth,
  projectRoleWriteLimiter,
  parseCompactJsonBody,
  rolesController.createRole,
);

/** POST /research-projects/:projectSlug/roles/:roleId/close — literal before param. */
router.post("/:projectSlug/roles/:roleId/close", requireAuth, rolesController.closeRole);

/** POST /research-projects/:projectSlug/roles/:roleId/reopen */
router.post("/:projectSlug/roles/:roleId/reopen", requireAuth, rolesController.reopenRole);

/** PATCH /research-projects/:projectSlug/roles/:roleId — maintainer+. */
router.patch(
  "/:projectSlug/roles/:roleId",
  requireAuth,
  projectRoleWriteLimiter,
  parseCompactJsonBody,
  rolesController.updateRole,
);

/** DELETE /research-projects/:projectSlug/roles/:roleId — 409 if referenced. */
router.delete("/:projectSlug/roles/:roleId", requireAuth, rolesController.deleteRole);

// --- Applications.

/** GET /research-projects/:projectSlug/applications — maintainer+. */
router.get("/:projectSlug/applications", requireAuth, applicationsController.listApplications);

/** POST /research-projects/:projectSlug/applications — `kind` is server-derived. */
router.post(
  "/:projectSlug/applications",
  requireAuth,
  applicationCreateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  applicationsController.createApplication,
);

/** POST …/applications/:applicationId/accept — WRITES a member row, so identified. */
router.post(
  "/:projectSlug/applications/:applicationId/accept",
  requireAuth,
  requireIdentifiedUser,
  parseCompactJsonBody,
  applicationsController.acceptApplication,
);

/** POST …/applications/:applicationId/decline */
router.post(
  "/:projectSlug/applications/:applicationId/decline",
  requireAuth,
  parseCompactJsonBody,
  applicationsController.declineApplication,
);

/** POST …/applications/:applicationId/withdraw — the applicant only. */
router.post(
  "/:projectSlug/applications/:applicationId/withdraw",
  requireAuth,
  parseCompactJsonBody,
  applicationsController.withdrawApplication,
);

// --- Invites.

/** GET /research-projects/:projectSlug/invites — maintainer+. */
router.get("/:projectSlug/invites", requireAuth, applicationsController.listInvites);

/** POST /research-projects/:projectSlug/invites — maintainer+. */
router.post(
  "/:projectSlug/invites",
  requireAuth,
  inviteCreateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  applicationsController.createInvite,
);

/**
 * POST …/invites/:inviteId/accept — the INVITEE, and the endpoint that actually
 * inserts the roster row. Guarding only POST /invites would check the inviter and leave
 * this one open to an anonymous session.
 */
router.post(
  "/:projectSlug/invites/:inviteId/accept",
  requireAuth,
  requireIdentifiedUser,
  applicationsController.acceptInvite,
);

/** POST …/invites/:inviteId/decline — the invitee. */
router.post(
  "/:projectSlug/invites/:inviteId/decline",
  requireAuth,
  applicationsController.declineInvite,
);

/** DELETE /research-projects/:projectSlug/invites/:inviteId — maintainer+ revokes. */
router.delete("/:projectSlug/invites/:inviteId", requireAuth, applicationsController.revokeInvite);

// --- Watch. Idempotent by construction; the counter moves only on a real change.

/** POST /research-projects/:projectSlug/watch */
router.post(
  "/:projectSlug/watch",
  requireAuth,
  projectWatchLimiter,
  requireIdentifiedUser,
  projectsController.watchProject,
);

/** DELETE /research-projects/:projectSlug/watch */
router.delete(
  "/:projectSlug/watch",
  requireAuth,
  projectWatchLimiter,
  projectsController.unwatchProject,
);

export default router;
