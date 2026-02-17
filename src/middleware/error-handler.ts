import type { Request, Response, NextFunction } from "express";
import { config } from "#src/config/index.js";

/**
 * Global error handler middleware.
 * Must have 4 parameters for Express to recognize it as an error handler.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.status || err.statusCode || 500;

  console.error(`[ERROR] ${req.method} ${req.originalUrl}`, {
    status: statusCode,
    message: err.message,
    ...(config.NODE_ENV === "development" && { stack: err.stack }),
  });

  res.status(statusCode).json({
    status: "error",
    statusCode,
    message: err.message || "Internal Server Error",
    ...(config.NODE_ENV === "development" && { stack: err.stack }),
  });
}
