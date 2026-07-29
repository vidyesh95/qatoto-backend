import express from "express";
import type { Request, Response } from "express";
import helmet, { contentSecurityPolicy } from "helmet";
import redocExpressMiddleware from "redoc-express";
import swaggerUi from "swagger-ui-express";

import { config } from "#src/config/index.js";
import { openApiSpec } from "#src/docs/openapi.js";

const router = express.Router();

/**
 * THE WHOLE DOC SURFACE IS GATED (§11l.2 item 8).
 *
 * `/openapi.json`, `/docs` and `/redoc` were served unauthenticated in every environment,
 * and between them they enumerate the entire route surface — every path, every parameter
 * name, every admin subtree. That is a reasonable trade while building and free
 * reconnaissance in production.
 *
 * `DOCS_ENABLED` defaults to on, so nothing changes for a developer; a production
 * deployment sets `DOCS_ENABLED=false` and the routes stop existing rather than answering
 * 403 — a 403 confirms the surface is there.
 */
router.use((req, res, next) => {
  if (!config.DOCS_ENABLED) {
    next("router");
    return;
  }
  next();
});

// The global helmet() in app.ts sets a strict default CSP that blocks Swagger UI's
// and ReDoc's inline <script>/<style> tags (no nonce support in swagger-ui-express).
// Relax script-src/style-src ONLY for these doc routes — every other route keeps the
// strict default since this runs after (and only on) this router's own requests.
router.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  }),
);

/**
 * GET /openapi.json
 * Raw spec — the single source both UIs below render from.
 */
router.get("/openapi.json", (req: Request, res: Response) => {
  res.status(200).json(openApiSpec);
});

/**
 * GET /docs
 * Swagger UI — interactive, request-firing explorer.
 */
router.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

/**
 * GET /redoc
 * ReDoc — read-only, three-panel reference rendering of the same spec.
 */
router.get(
  "/redoc",
  redocExpressMiddleware({ title: "Qatoto API Docs", specUrl: "/openapi.json" }),
);

export default router;
