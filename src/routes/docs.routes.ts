import express from "express";
import type { Request, Response } from "express";
import helmet, { contentSecurityPolicy } from "helmet";
import redocExpressMiddleware from "redoc-express";
import swaggerUi from "swagger-ui-express";

import { openApiSpec } from "#src/docs/openapi.js";

const router = express.Router();

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
