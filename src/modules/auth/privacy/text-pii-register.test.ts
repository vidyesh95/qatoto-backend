import { describe, it, expect } from "vitest";
import { parseTextPiiColumnKey } from "./text-pii-register.js";

describe("parseTextPiiColumnKey", () => {
  it("should parse a valid table and column key", () => {
    const result = parseTextPiiColumnKey("users.email");
    expect(result).toEqual({
      tableName: "users",
      columnName: "email",
    });
  });

  it("should parse a valid key with multiple dots correctly (splitting on the first dot)", () => {
    const result = parseTextPiiColumnKey("schema.table.column");
    expect(result).toEqual({
      tableName: "schema",
      columnName: "table.column",
    });
  });

  it("should throw an error if the key does not contain a dot", () => {
    expect(() => parseTextPiiColumnKey("users")).toThrow(
      'text-pii-register: "users" is not a "<table>.<column>" key'
    );
  });

  it("should throw an error if the key starts with a dot", () => {
    expect(() => parseTextPiiColumnKey(".email")).toThrow(
      'text-pii-register: ".email" is not a "<table>.<column>" key'
    );
  });

  it("should throw an error if the key ends with a dot", () => {
    expect(() => parseTextPiiColumnKey("users.")).toThrow(
      'text-pii-register: "users." is not a "<table>.<column>" key'
    );
  });

  it("should throw an error if the key is an empty string", () => {
    expect(() => parseTextPiiColumnKey("")).toThrow(
      'text-pii-register: "" is not a "<table>.<column>" key'
    );
  });
});
