import express from "express";
import helmet from "helmet";
import cors from "cors";
import logger from "morgan";
import cookieParser from "cookie-parser";

import { config } from "#src/config/index.js";
import { requestId } from "#src/middleware/request-id.js";
import { notFoundHandler } from "#src/middleware/not-found.js";
import { errorHandler } from "#src/middleware/error-handler.js";
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
app.use("/", indexRouter);
app.use("/users", usersRouter);

// --- Error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
