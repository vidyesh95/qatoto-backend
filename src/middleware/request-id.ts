import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Middleware that attaches a unique request ID to each request.
 * Useful for tracing requests through logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("X-Request-Id", id);
  next();
}
