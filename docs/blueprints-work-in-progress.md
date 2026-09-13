# Blueprints Work in Progress

The `/blueprints` backend is substantially complete and already wired end-to-end with the frontend. All four arms (Hero Carousel, Showcase Launches, Case Studies, and Teardowns) have fully functioning public feeds, authoring pipelines, engagement layers, and staff moderation consoles backed by PostgreSQL.

Below is a breakdown of the current operational status, what was recently completed, and the deliberate architectural boundaries or potential next-phase items remaining.

---

## 1. What Is Fully Implemented & Verified

Every API client in `qatoto-frontend/src/lib/blueprints/` maps to an active Express route in [`blueprints.routes.ts`](file:///Users/vinitchuri/code/backend/qatoto-backend/src/modules/home/blueprints/blueprints.routes.ts):

| Arm | Public Reads | Author Writes | Engagement | Moderation / Staff |
| :--- | :--- | :--- | :--- | :--- |
| **Hero Carousel** | `GET /hero-slides` | — | — | Full CRUD + atomic reordering (`/admin/hero-slides/*`) |
| **Showcase Launches** | Feed (`/showcases`), slugs (`/slugs`), detail (`/:launchSlug`) | Multipart submit (`POST /showcases`), write-up image uploads, `/mine` | View beacons, likes, upvotes, threaded comments with likes | Review queue & publish/reject, reader reports, plus `flag` / `restore` (`/admin/showcases/*`) |
| **Case Studies** | Index (`/case-studies`), slugs, options, detail (`/:caseStudySlug`) | JSON submit (`POST /case-studies`), cursor-paged `/mine` | View beacons, likes | Review queue (with withheld company reveal) + flag/restore |
| **Teardowns** | Index (`/teardowns`), options, slugs, detail, claim targets, market signal | Submission intake (`POST /teardowns`), `/mine` | View beacons, likes, saves, threaded comments with likes | Review queue + flag, quarantine, and restore verbs |
| **Cross-arm** | `/engagement/state` | — | `/comments/:commentId` (edit/delete/like) | `/admin/content-reports` (reader report queue + dismissal) |

All 30 backend blueprint test suites (766 tests), 5 database constraint verification scripts, and 4 end-to-end smoke scripts pass cleanly. The full project gate is 205 files / 3985 tests.

---

## 2. Deliberate Boundaries & Features Not Yet in Backend

If you are planning the next phase of capabilities, the following features are not yet implemented by design (detailed in [`BLUEPRINTS_BACKEND_STRUCTURE.md`](file:///Users/vinitchuri/code/backend/qatoto-backend/docs/BLUEPRINTS_BACKEND_STRUCTURE.md)):

### A. 3D CAD/Assembly Geometry for User-Submitted Teardowns
- **Current State:** The authoring wizard (`POST /blueprints/teardowns`) collects part listings ([`teardown_part_listing`](file:///Users/vinitchuri/code/backend/qatoto-backend/src/db/schema/home.ts)), document links, and manufacturing files.
- **What's Missing:** The interactive 3D explode/layer viewer tables ([`teardown_assembly`](file:///Users/vinitchuri/code/backend/qatoto-backend/src/db/schema/home.ts), `teardown_part`, `teardown_assembly_step`, `teardown_fastener`) can currently only be created via database seeds (`pnpm db:seed-blueprint-teardowns`). There is no user submission schema or endpoint to upload `.glb` models or configure 3D exploded assemblies.

### ~~B. Reader Reports and Post-Publish Moderation on Showcase Launches~~ — **DONE**
- **Landed:** `showcase_launch` now admits `flagged`, readers can report a launch
  (`POST /blueprints/showcases/:launchSlug/reports`), and moderators can `flag` / `restore` it
  (`POST /blueprints/admin/showcases/:launchId/moderation-state`).
- ⚠️ **`quarantine` is still refused on this arm, deliberately.** Not because a showcase has no files
  — it has a heading image and write-up images — but because they are the maker's *own* by
  attestation, and because `heading_image_url` is NOT NULL so there is no representable withheld
  state. See `BLUEPRINTS_BACKEND_STRUCTURE.md` §9.3.
- ⚠️ **A flag does not hide anything.** The page still answers, the row stays in the feed, and the
  public slug survives; what a flag changes is that the launch stops accruing new engagement and
  appears in the report queue. Hiding it would make filing a report a takedown.

### C. Direct File Uploads for Teardown Documents & Fabrication Files
- **Current State:** Showcases and Hero slides support direct multipart image uploads to Cloudinary.
- **What's Missing:** Teardown documents and CAD/manufacturing files currently only accept pasted `https://` URLs in the wizard. There is no multipart file upload endpoint for `.step`, `.dxf`, or `.pdf` attachments.

### D. Server-Side Draft Storage & Edit-and-Resubmit
- **Current State:** The authoring wizards for teardowns, showcases, and case studies retain draft state entirely on the client side (React state).
- **What's Missing:** There is no draft persistence endpoint (no autosave or resume-later across devices). Furthermore, moderator rejections are terminal (authors must submit a fresh submission rather than editing an existing record).

### E. Direct Rights-Claim / DMCA Intake
- **Current State:** `GET /teardowns/:teardownSlug/claim-targets` provides the list of items for an IP claim. The frontend `/report` route generates a structured `mailto:` notice.
- **What's Missing:** There is no in-platform database table or submission endpoint for submitting formal legal rights claims.

---

## 3. Checklist for Production Go-Live Between Frontend & Backend

To have frontend and backend run seamlessly in your local or production environment:

1. **Run Database Seeds:**
   Ensure all blueprint seed scripts have been executed so initial rows are populated:
   ```bash
   pnpm db:seed-blueprint-hero-slides
   pnpm db:seed-blueprint-teardowns
   pnpm db:seed-blueprint-case-studies
   pnpm db:seed-blueprint-store-categories
   ```

2. **Remove Frontend `noindex` and Restore Sitemap:**
   Once seeded, in `qatoto-frontend`:
   - Remove `robots: { index: false, follow: false }` across the 7 blueprint routes (e.g., `src/app/(home)/blueprints/page.tsx`, `teardowns/page.tsx`, `showcase/page.tsx`, `case-studies/page.tsx`, and detail pages).
   - Restore the `/blueprints` entries in `qatoto-frontend/src/app/sitemap.ts`.
