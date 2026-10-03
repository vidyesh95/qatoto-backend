import { describe, expect, it } from "vitest";

import { escapeLikePattern } from "#src/lib/sql-pattern.js";

describe("sql-pattern", () => {
  it("leaves alphanumeric text without SQL wildcards unchanged", () => {
    expect(escapeLikePattern("hello world 123")).toBe("hello world 123");
  });

  it("escapes percent signs so they do not act as wildcards", () => {
    expect(escapeLikePattern("100% verified")).toBe("100\\% verified");
  });

  it("escapes underscore characters so they do not match any character", () => {
    expect(escapeLikePattern("user_name_1")).toBe("user\\_name\\_1");
  });

  it("doubles backslashes before escaping wildcards so escaped wildcards are not altered", () => {
    expect(escapeLikePattern("c:\\files\\data")).toBe("c:\\\\files\\\\data");
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
    expect(escapeLikePattern("\\_")).toBe("\\\\\\_");
  });

  it("handles mixed strings containing backslashes, percent signs, and underscores", () => {
    expect(escapeLikePattern("50%_off\\promo")).toBe("50\\%\\_off\\\\promo");
  });

  it("handles empty string", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});
