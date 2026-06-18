import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Middleware factory that validates request body, query, and/or params
 * against the provided Zod schemas.
 *
 * @example
 * ```ts
 * router.post(
 *   '/users',
 *   validate({ body: createUserSchema }),
 *   usersController.create,
 * );
 * ```
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        // Zod output is narrower than Express's ParsedQs; assignment is intentional.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        req.query = schemas.query.parse(req.query) as typeof req.query;
      }
      if (schemas.params) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "Validation failed",
          errors: error.issues.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}
