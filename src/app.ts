import { toNodeHandler } from "better-auth/node";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import logger from "morgan";

import { config } from "#src/config/index.js";
import { auth } from "#src/lib/auth.js";
import { errorHandler } from "#src/middleware/error-handler.js";
import { parseLongFormJsonBody } from "#src/middleware/json-body.js";
import { notFoundHandler } from "#src/middleware/not-found.js";
import { requestId } from "#src/middleware/request-id.js";
import authRouter from "#src/routes/auth.routes.js";
import discoveryRouter from "#src/routes/discovery.routes.js";
import docsRouter from "#src/routes/docs.routes.js";
import handlesRouter from "#src/routes/handles.routes.js";
import indexRouter from "#src/routes/index.js";
import playlistsRouter from "#src/routes/playlists.routes.js";
import productsRouter from "#src/routes/products.routes.js";
import proofOfEffortRouter, {
  integrationCallbackRouter,
} from "#src/routes/proof-of-effort.routes.js";
import researchCatalogRouter from "#src/routes/research-catalog.routes.js";
import researchProjectsRouter from "#src/routes/research-projects.routes.js";
import seriesRouter from "#src/routes/series.routes.js";
import usersRouter from "#src/routes/users.routes.js";
import videosRouter from "#src/routes/videos.routes.js";
import workshopRouter from "#src/routes/workshop.routes.js";

const app = express();

// Trust first proxy (nginx, load balancer, etc.)
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// CORS — restricted to known frontend origin
app.use(
  cors({
    origin: config.FRONTEND_URL,
    credentials: true,
  }),
);

// Request tracing
app.use(requestId);

// Logging
app.use(logger("dev"));

// Better Auth handler — MUST mount before express.json(); it parses its own
// request bodies off the raw stream. A body parser ahead of it consumes the
// stream and breaks every auth POST (sign-in, OTP, reset). See BACKEND_STRUCTURE §5c.
//
// The wrapper exists because of the `bearer()` plugin (src/lib/auth.ts, §4a). Its
// AFTER hook has `matcher: () => true`, so it stamps `set-auth-token` — the session
// token itself — onto EVERY auth response, browsers included, and adds it to
// Access-Control-Expose-Headers so page script can read it. The session cookie is
// httpOnly precisely to keep that value away from page script; publishing it would
// upgrade any XSS from "act inside the page" to "exfiltrate a portable session".
// R_AND_D_BACKEND_STRUCTURE.md §0: the frontend is a hostile presentation layer.
//
// So: emit the header only to callers that identify as native. Web behaviour is
// byte-identical to before this plugin was added.
const NATIVE_CLIENT_HEADER = "x-qatoto-client";
const authNodeHandler = toNodeHandler(auth.handler);

app.all("/api/auth/*splat", (req, res) => {
  if (req.headers[NATIVE_CLIENT_HEADER] === "native") {
    void authNodeHandler(req, res);
    return;
  }

  const originalSetHeader = res.setHeader.bind(res);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  res.setHeader = ((headerName: string, headerValue: never) => {
    if (headerName.toLowerCase() === "set-auth-token") {
      return res;
    }
    return originalSetHeader(headerName, headerValue);
  }) as typeof res.setHeader;

  void authNodeHandler(req, res);
});

// R&D long-form payloads (a description + problem statement + solution summary +
// evidence notes in one body) exceed 10 kb. MOUNTED BEFORE the global parser on
// purpose: body-parser sets `req._body` once it has parsed, so a larger json() placed
// AFTER would silently no-op and the 10 kb cap would still reject the request.
//
// The cap matters most for non-English users: `limit` counts BYTES while
// z.string().max(n) counts UTF-16 code units, so a 5,000-character description is ~5 KB
// in ASCII but up to 15 KB in UTF-8 for Devanagari or CJK — the global cap would reject
// payloads Zod happily accepts, for those users only.
//
// This mount ALSO covers the §8 workshop router, which shares the prefix: a daily log's
// narrative is 10,000 characters and a chat message is 4,000.
app.use("/research-projects", parseLongFormJsonBody);
// Same reasoning for /discovery: POST /discovery/problem-reports carries a 5,000-character
// description, and PUT /discovery/talent/me carries a bio plus skills plus compensation
// asks. Both are comfortably over 10 kb once the text is not ASCII.
app.use("/discovery", parseLongFormJsonBody);
// Same again for /videos: CreateVideoSchema permits a 5,000-character description plus
// up to 20 sector tags, 30 tags, six 2,048-character URLs and the whole anime block.
// MUST stay ABOVE the global express.json() below — body-parser sets `req._body` on the
// first parse, so a larger parser mounted after it is a silent no-op.
app.use("/videos", parseLongFormJsonBody);

// Body parsing with size limits to prevent payload abuse — for YOUR routes only.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// Cookie parsing
app.use(cookieParser());

// --- Routes ---
app.use("/", indexRouter);
app.use("/", authRouter);
app.use("/users", usersRouter);
app.use("/handles", handlesRouter);
app.use("/products", productsRouter);
app.use("/research-projects", researchProjectsRouter);
// Same prefix, declared AFTER: the workshop router owns /:projectSlug/workshop/* and
// /:projectSlug/daily-logs/* (§8). No collision — researchProjectsRouter's "/:projectSlug"
// matches that one segment exactly and never swallows a deeper path.
app.use("/research-projects", workshopRouter);
// Same prefix again, declared AFTER both: the Proof-of-Effort router owns
// /:projectSlug/effort-claims/*, /equity/*, /allocation-proposals/*, /disputes/*,
// /audit-trail/*, /slice-ledger and /proof-of-effort (§9). Still no collision, for the
// same reason — a single-segment "/:projectSlug" never swallows a deeper path.
app.use("/research-projects", proofOfEffortRouter);
app.use("/discovery", discoveryRouter);
// Creator Studio. The anime review queue is nested at /videos/admin/review rather than a
// root /admin, matching /discovery/admin/* — one domain's moderation surface should not
// claim the global namespace.
app.use("/videos", videosRouter);
app.use("/playlists", playlistsRouter);
app.use("/series", seriesRouter);
// Cross-project R&D resources (/open-roles, /research-categories) mount at the root,
// exactly as the spec mounts the funding router at "/".
app.use("/", researchCatalogRouter);
// The §9 integration callback. Root-mounted because a provider's redirect URI is fixed at
// app-registration time and cannot carry a project slug; the project and the member come
// out of the signed `state` instead (§9.10).
app.use("/", integrationCallbackRouter);
app.use("/", docsRouter);

// --- Error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
