/**
 * redoc-express ships dist/index.d.ts written with ESM `export default` syntax,
 * but its package.json has no "type" field so TS resolves the module as
 * CommonJS under NodeNext — a format where `export default` in a .d.ts does NOT
 * mean `module.exports = fn` and leaves the default import uncallable
 * (TS2349). This shim restates the same shape as a proper ambient module so the
 * default import resolves to the callable middleware factory.
 */
declare module "redoc-express" {
  import type { Request, Response } from "express";

  interface RedocExpressOptions {
    title?: string;
    specUrl?: string;
    nonce?: string;
    [key: string]: unknown;
  }

  function redocExpressMiddleware(
    options?: RedocExpressOptions,
  ): (req: Request, res: Response) => void;

  export default redocExpressMiddleware;
}
