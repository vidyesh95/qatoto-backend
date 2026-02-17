import type { Request, Response, NextFunction } from "express";
import createError from "http-errors";

/**
 * Catch-all middleware for unmatched routes.
 * Forwards a 404 error to the error handler.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  next(createError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}
