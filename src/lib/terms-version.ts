/**
 * The Terms and Conditions version an account accepts (todo §7).
 *
 * THE TERMS PAGE'S "LAST UPDATED" DATE, ISO-formatted. It lives in the frontend
 * (`src/lib/legal-documents.ts`) as well, and the two MUST change together: a client that sends an
 * old version is refused with a 409 rather than silently recorded as accepting text it never
 * showed, so a frontend that ships new Terms without this bump — or the reverse — fails loudly at
 * the first acceptance instead of writing a false record.
 */
export const CURRENT_TERMS_VERSION = "2026-09-28";
