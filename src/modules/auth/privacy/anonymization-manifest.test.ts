import { describe, it, expect } from "vitest";
import { parseUserReferenceKey } from "./anonymization-manifest.js";
import type { UserReferenceKey } from "./anonymization-manifest.js";

describe("parseUserReferenceKey", () => {
  it("should split a valid table.column string", () => {
    const result = parseUserReferenceKey("user.id" as UserReferenceKey);
    expect(result).toEqual({ tableName: "user", columnName: "id" });
  });

  it("should handle keys with multiple dots", () => {
    // According to the logic `separatorIndex = key.indexOf(".")`
    const result = parseUserReferenceKey("schema.table.column" as UserReferenceKey);
    expect(result).toEqual({ tableName: "schema", columnName: "table.column" });
  });

  it("should throw an error if there is no dot", () => {
    expect(() => parseUserReferenceKey("tablecolumn" as UserReferenceKey)).toThrowError(
      "anonymization manifest: malformed key tablecolumn"
    );
  });

  it("should throw an error if the dot is at the beginning", () => {
    expect(() => parseUserReferenceKey(".column" as UserReferenceKey)).toThrowError(
      "anonymization manifest: malformed key .column"
    );
  });

  it("should throw an error if the dot is at the end", () => {
    expect(() => parseUserReferenceKey("table." as UserReferenceKey)).toThrowError(
      "anonymization manifest: malformed key table."
    );
  });

  it("should throw an error for an empty string", () => {
    expect(() => parseUserReferenceKey("" as UserReferenceKey)).toThrowError(
      "anonymization manifest: malformed key "
    );
  });
});
