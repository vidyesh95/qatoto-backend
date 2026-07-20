import { describe, expect, it } from "vitest";

import { isForeignKeyViolation, isUniqueViolation, readSqlStateCode } from "#src/lib/pg-errors.js";

/**
 * Reproduces how drizzle-orm 0.45 actually surfaces a driver failure: a
 * `DrizzleQueryError` whose `.cause` is the `pg` error carrying the SQLSTATE.
 * Verified empirically against this database — `ctor=DrizzleQueryError
 * topLevelCode=undefined causeCode=23505`.
 */
function createDrizzleWrappedError(sqlStateCode: string): Error {
  const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: sqlStateCode,
  });
  return Object.assign(new Error("Failed query"), { cause: driverError });
}

describe("readSqlStateCode", () => {
  it("reads the code from a bare driver error", () => {
    expect(readSqlStateCode(Object.assign(new Error("x"), { code: "23505" }))).toBe("23505");
  });

  it("reads the code through drizzle's wrapper — the case the old check missed", () => {
    expect(readSqlStateCode(createDrizzleWrappedError("23505"))).toBe("23505");
  });

  it("reads the code through several layers of nesting", () => {
    const nested = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("middle"), {
        cause: Object.assign(new Error("inner"), { code: "23503" }),
      }),
    });
    expect(readSqlStateCode(nested)).toBe("23503");
  });

  it("returns undefined for a non-driver error rather than guessing", () => {
    expect(readSqlStateCode(new Error("plain"))).toBeUndefined();
    expect(readSqlStateCode("not an error")).toBeUndefined();
    expect(readSqlStateCode(null)).toBeUndefined();
    expect(readSqlStateCode(undefined)).toBeUndefined();
  });

  it("terminates on a cause cycle instead of hanging the request", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(readSqlStateCode(cyclic)).toBeUndefined();
  });
});

describe("isUniqueViolation", () => {
  it("detects 23505 through drizzle's wrapper", () => {
    // THE REGRESSION TEST. The previous implementation read `error.code` at the top
    // level, which is undefined here, so it returned false and a duplicate SKU became
    // a 500 instead of 409 SKU_TAKEN.
    expect(isUniqueViolation(createDrizzleWrappedError("23505"))).toBe(true);
  });

  it("detects 23505 on a bare driver error", () => {
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "23505" }))).toBe(true);
  });

  it("does not match a different SQLSTATE", () => {
    expect(isUniqueViolation(createDrizzleWrappedError("23514"))).toBe(false);
    expect(isUniqueViolation(createDrizzleWrappedError("QT001"))).toBe(false);
  });

  it("does not match a plain error, so genuine bugs still re-throw", () => {
    expect(isUniqueViolation(new Error("connection terminated"))).toBe(false);
  });
});

describe("isForeignKeyViolation", () => {
  it("detects 23503 — an onDelete:restrict parent that still has children", () => {
    expect(isForeignKeyViolation(createDrizzleWrappedError("23503"))).toBe(true);
  });

  it("does not match a unique violation", () => {
    expect(isForeignKeyViolation(createDrizzleWrappedError("23505"))).toBe(false);
  });
});
