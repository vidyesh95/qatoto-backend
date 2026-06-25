import { toNodeHandler } from "better-auth/node";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import logger from "morgan";

import { config } from "#src/config/index.js";
import { auth } from "#src/lib/auth.js";
import { errorHandler } from "#src/middleware/error-handler.js";
import { notFoundHandler } from "#src/middleware/not-found.js";
import { requestId } from "#src/middleware/request-id.js";
import authRouter from "#src/routes/auth.routes.js";
import handlesRouter from "#src/routes/handles.routes.js";
import indexRouter from "#src/routes/index.js";
import usersRouter from "#src/routes/users.routes.js";

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
app.all("/api/auth/*splat", toNodeHandler(auth.handler));

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

// --- Error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
