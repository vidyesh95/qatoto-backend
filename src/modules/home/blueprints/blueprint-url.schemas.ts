import { z } from "zod";

/**
 * The two URL predicates every blueprint write gate needs, in one place.
 *
 * EXTRACTED RATHER THAN COPIED A THIRD TIME. `teardown-import.schemas.ts` declared these privately
 * and the case-study submission gate needs the outbound one; a third spelling of "what counts as a
 * same-site asset" is exactly the drift that makes an open redirect possible in one arm and not
 * another. The SQL halves of the same rules live in `src/db/schema/home.ts` as `assetUrlCheck` and
 * `externalUrlCheck`, and the two layers are deliberately both present: the schema names a field a
 * writer can fix, the CHECK is the backstop for anything that reaches the table by another path.
 *
 * These mirror the frontend's `createHttpsOrSiteRelativeUrlSchema` and
 * `createExternalHttpsUrlSchema` (`src/lib/blueprints/url-source.schemas.ts`).
 *
 * NOT `src/lib/external-url.ts`, which is a `Result`-returning parser for a single field that needs
 * a typed refusal reason on the wire. These are array-element schemas inside a body parse, where a
 * Zod issue path is already the thing the caller reports.
 */

/** Spaces and control characters, which a browser and a proxy may disagree about. */
// oxlint-disable-next-line no-control-regex -- the control range IS the thing being refused.
const ILLEGAL_URL_CHARACTERS = /[\u0000-\u0020\u007F]/;

/** A leading `/\` is read as protocol-relative by a browser, exactly as `//` is. */
const PROTOCOL_RELATIVE_BACKSLASH_PREFIX = `/${String.fromCharCode(92)}`;

/**
 * An asset this site may serve: https, or a site-relative path that is genuinely same-site.
 *
 * ⚠️ THE LENGTH IS A PARAMETER FOR THE REASON `createExternalUrlSchema` BELOW GIVES, and one
 * surface has already needed it: a moderator's publish body carries a 2,000-character note beside
 * the thumbnail address, and at the four-bytes-per-character worst case `json-body-budget.test.ts`
 * computes, a 2,048-character URL puts that body over the 16 KB compact tier. The rule is one
 * spelling either way — only the ceiling moves.
 */
export function createAssetUrlSchema(maximumCharacters: number) {
  return (
    z
      .string()
      .min(1)
      .max(maximumCharacters)
      .refine((url) => url.startsWith("https://") || url.startsWith("/"), {
        message: "An asset address must be https:// or a site-relative path.",
      })
      /*
       * PROTOCOL-RELATIVE IS REFUSED IN BOTH SPELLINGS. A browser reads `//host` and the backslash
       * variant as "same scheme, different host", so a leading-slash test alone is not a same-site
       * test — it is an open redirect wearing one.
       */
      .refine(
        (url) => !url.startsWith("//") && !url.startsWith(PROTOCOL_RELATIVE_BACKSLASH_PREFIX),
        {
          message: "An asset address may not be protocol-relative.",
        },
      )
      .refine((url) => !ILLEGAL_URL_CHARACTERS.test(url), {
        message: "An address may not contain spaces or control characters.",
      })
  );
}

export const AssetUrlSchema = createAssetUrlSchema(2048);

/** The default outbound cap, matching the frontend's `createExternalHttpsUrlSchema(2048)`. */
const DEFAULT_EXTERNAL_URL_MAXIMUM_CHARACTERS = 2048;

/**
 * An outbound link — a supplier, a licence, a citation. https only; there is no same-site case.
 *
 * ⚠️ THE LENGTH IS A PARAMETER BECAUSE ONE SURFACE HAD TO TIGHTEN IT. A case study may link ten
 * sources, and ten 2,048-character URLs put that route's worst-case body above the platform's
 * 128 KB ceiling — `json-body-budget.test.ts` computes it at four bytes per character and refuses a
 * route whose cap is below what its own schema accepts. So case-study sources cap at 512, on both
 * sides of the wire, and a URL that long is a tracking-parameter-laden mess rather than a citation.
 */
export function createExternalUrlSchema(maximumCharacters: number) {
  return z
    .string()
    .min(1)
    .max(maximumCharacters)
    .refine((url) => url.startsWith("https://"), { message: "An outbound link must be https://." })
    .refine((url) => !ILLEGAL_URL_CHARACTERS.test(url), {
      message: "An address may not contain spaces or control characters.",
    });
}

export const ExternalUrlSchema = z
  .string()
  .min(1)
  .max(DEFAULT_EXTERNAL_URL_MAXIMUM_CHARACTERS)
  .refine((url) => url.startsWith("https://"), { message: "An outbound link must be https://." })
  .refine((url) => !ILLEGAL_URL_CHARACTERS.test(url), {
    message: "An address may not contain spaces or control characters.",
  });
