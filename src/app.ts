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

// Body parsing with size limits to prevent payload abuse
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// Cookie parsing
app.use(cookieParser());

// --- Routes ---
app.all("/api/auth/*", toNodeHandler(auth.handler));
app.use("/", indexRouter);
app.use("/users", usersRouter);

// --- Error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
