/**
 * Keeping payment instruments OUT of a domain that has no business holding them
 * (R_AND_D_BACKEND_STRUCTURE.md §7A, §13, §17 step 5c).
 *
 * §7A is explicit: `compensation_payment_record` "stores no account number, no IBAN, no
 * UPI handle, no card detail, and no payment instrument of any kind". `referenceNote` is a
 * human note — a UTR, a payroll run id — and the API rejects anything that pattern-matches
 * a PAN.
 *
 * WHY THE VALUE IS CHECKED AND NOT JUST THE KEY. The `.strict()` schemas already reject
 * `accountNumber`, `iban`, `upiId` and `paymentMethodId` outright, and §7A calls those
 * three "wire-fraud primitives". But a rejected-key list is defeated by putting the number
 * in a field that IS allowed, and a founder pasting a full card number into a free-text
 * reference is a mistake rather than an attack. Both defences, not either.
 *
 * WHAT STORING ONE WOULD COST: PCI-DSS scope dragged into a product that has none, a PII
 * breach surface with no upside, and a wire-fraud primitive handed to an attacker.
 *
 * PURE, and in `lib/` rather than beside the service, so it can be tested without a
 * configured environment or a database — the check is the security control, and a control
 * whose test needs a live Postgres gets skipped.
 */

/**
 * NOT A LUHN CHECK, deliberately. The point is to keep card and account numbers out of the
 * column, not to decide whether a particular string is a VALID card: a near-miss PAN in a
 * free-text field is the same breach problem as a valid one, and hand-tuning the test
 * toward "valid cards only" would let typos through.
 */
const PAYMENT_INSTRUMENT_PATTERNS: readonly RegExp[] = [
  // A PAN. 13–19 digits is the ISO/IEC 7812 length range, and the optional separator
  // between digits catches the grouping a human types.
  /(?:\d[ -]?){13,19}/,
  // An IBAN: two letters, two check digits, then 11–30 alphanumerics.
  /\b[A-Z]{2}\d{2}[ -]?(?:[A-Z0-9][ -]?){11,30}\b/i,
];

/**
 * True when a free-text note contains something shaped like a payment instrument.
 *
 * The legitimate uses of this field are unaffected: a UTR, a payroll run id and a bank
 * reference are all comfortably under 13 digits.
 */
export function containsPaymentInstrument(referenceNote: string): boolean {
  return PAYMENT_INSTRUMENT_PATTERNS.some((pattern) => pattern.test(referenceNote));
}
