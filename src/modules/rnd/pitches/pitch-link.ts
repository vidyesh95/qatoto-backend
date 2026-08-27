/**
 * The two URLs a pitch carries, normalized before storage.
 *
 * A THIN WRAPPER, and deliberately nothing more. `src/lib/external-url.ts` holds the policy
 * — https only, arbitrary host, no credentials, no control characters, fragment dropped.
 * This file exists to do two things that policy cannot know about:
 *
 *  1. NAME WHICH FIELD FAILED. Two URLs arrive in one body, and "not https" without saying
 *     which one is a validation message the person cannot act on.
 *  2. PRESERVE THE THREE-WAY DISTINCTION. On a PATCH, `undefined` means "leave it alone"
 *     and `null` means "clear it". Collapsing those would make a funding link something a
 *     founder can add and never remove, which on a page that points strangers at a payment
 *     page is the wrong direction to fail in.
 */

import { parseHttpsUrl } from "#src/lib/external-url.js";
import type { ExternalUrlError } from "#src/lib/external-url.js";
import type { Result } from "#src/types/index.js";

/**
 * A rejected URL, carrying the field it came from.
 *
 * The nested `reason` keeps the shared parser's own variant intact rather than flattening
 * it, so the error mapper can say "that is not https" instead of "that is invalid".
 */
export type PitchLinkError = {
  type: "PITCH_LINK_INVALID";
  field: "externalFundingUrl" | "externalContactUrl";
  reason: ExternalUrlError;
};

export interface NormalizedPitchLinks {
  /** `undefined` = not mentioned in this request. `null` = explicitly cleared. */
  readonly externalFundingUrl: string | null | undefined;
  readonly externalContactUrl: string | null | undefined;
}

function normalizeOne(
  field: PitchLinkError["field"],
  rawValue: string | null | undefined,
): Result<string | null | undefined, PitchLinkError> {
  if (rawValue === undefined) return { success: true, value: undefined };
  if (rawValue === null) return { success: true, value: null };

  const parsed = parseHttpsUrl(rawValue);
  if (!parsed.success) {
    return { success: false, error: { type: "PITCH_LINK_INVALID", field, reason: parsed.error } };
  }
  return { success: true, value: parsed.value };
}

/**
 * Normalizes both links, refusing on the first bad one.
 *
 * FIRST FAILURE WINS rather than collecting both. A caller fixing one URL will resubmit and
 * see the second immediately, and reporting two failures for what is usually one paste
 * error reads as though the whole form is wrong.
 */
export function normalizePitchLinks(input: {
  readonly externalFundingUrl?: string | null | undefined;
  readonly externalContactUrl?: string | null | undefined;
}): Result<NormalizedPitchLinks, PitchLinkError> {
  const fundingUrl = normalizeOne("externalFundingUrl", input.externalFundingUrl);
  if (!fundingUrl.success) return fundingUrl;

  const contactUrl = normalizeOne("externalContactUrl", input.externalContactUrl);
  if (!contactUrl.success) return contactUrl;

  return {
    success: true,
    value: {
      externalFundingUrl: fundingUrl.value,
      externalContactUrl: contactUrl.value,
    },
  };
}

/**
 * The sentence shown to the person who typed the URL.
 *
 * Lives here rather than in the error mapper because it is the only place that knows both
 * halves — which field, and which of the parser's refusals. Every branch names the actual
 * mistake: "must start with https://" is actionable, "invalid URL" is not.
 */
export function describePitchLinkError(error: PitchLinkError): string {
  switch (error.reason.type) {
    case "EXTERNAL_URL_EMPTY":
      return "Enter a link, or leave the field out entirely to clear it.";
    case "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS":
      return "That link contains spaces or control characters. Paste it again without them.";
    case "EXTERNAL_URL_TOO_LONG":
      return `That link is ${String(error.reason.length)} characters; the maximum is ${String(error.reason.maximum)}.`;
    case "EXTERNAL_URL_UNPARSEABLE":
      return "That is not a link Qatoto can read. Include the full address, starting with https://.";
    case "EXTERNAL_URL_NOT_HTTPS":
      // `${scheme}:` not `${scheme}://` — "javascript://" is not a thing, and a message that
      // misspells the scheme it is complaining about undercuts the one instruction it gives.
      return `Links must start with https:// — this one starts with ${error.reason.scheme}:.`;
    case "EXTERNAL_URL_HOST_INVALID":
      return "That link does not name a public website.";
    case "EXTERNAL_URL_HAS_CREDENTIALS":
      return "Remove the username and password from the link before saving it.";
    default: {
      const exhaustiveCheck: never = error.reason;
      throw new Error(`Unhandled pitch link error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
