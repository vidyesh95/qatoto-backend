import { describe, expect, it } from "vitest";

import { readGoogleProfileFromIdToken } from "#src/lib/oauth-profile.js";

/** Build a structurally valid JWT whose payload is the given claims object. */
function buildIdToken(claims: unknown): string {
  const headerSegment = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${headerSegment}.${payloadSegment}.fake-signature`;
}

describe("readGoogleProfileFromIdToken", () => {
  describe("malformed tokens", () => {
    it("rejects a string with no dots", () => {
      expect(readGoogleProfileFromIdToken("not-a-jwt")).toEqual({
        success: false,
        error: "id_token is not a well-formed JWT",
      });
    });

    it("rejects the empty string", () => {
      expect(readGoogleProfileFromIdToken("")).toEqual({
        success: false,
        error: "id_token is not a well-formed JWT",
      });
    });

    it("rejects a token with only two segments", () => {
      expect(readGoogleProfileFromIdToken("header.payload")).toEqual({
        success: false,
        error: "id_token is not a well-formed JWT",
      });
    });

    it("rejects a token with four segments", () => {
      expect(readGoogleProfileFromIdToken("one.two.three.four")).toEqual({
        success: false,
        error: "id_token is not a well-formed JWT",
      });
    });

    it("rejects a payload that does not decode to JSON", () => {
      expect(readGoogleProfileFromIdToken("header.!!!.signature")).toEqual({
        success: false,
        error: "id_token payload is not valid base64url JSON",
      });
    });

    it("rejects a payload that is valid base64url but not JSON", () => {
      const nonJsonPayload = Buffer.from("plain text, not json").toString("base64url");
      expect(readGoogleProfileFromIdToken(`header.${nonJsonPayload}.signature`)).toEqual({
        success: false,
        error: "id_token payload is not valid base64url JSON",
      });
    });
  });

  describe("claim validation", () => {
    it("rejects claims that fail schema validation", () => {
      expect(readGoogleProfileFromIdToken(buildIdToken({ name: 12345 }))).toEqual({
        success: false,
        error: "id_token claims failed validation",
      });
    });

    it("rejects a JSON payload that is not an object", () => {
      expect(readGoogleProfileFromIdToken(buildIdToken("just a string"))).toEqual({
        success: false,
        error: "id_token claims failed validation",
      });
    });

    it("rejects a picture claim that is not a URL", () => {
      expect(readGoogleProfileFromIdToken(buildIdToken({ picture: "not-a-url" }))).toEqual({
        success: false,
        error: "id_token claims failed validation",
      });
    });
  });

  describe("successful decodes", () => {
    it("extracts name, picture, and a verified email", () => {
      const decodeResult = readGoogleProfileFromIdToken(
        buildIdToken({
          name: "Vidyesh Churi",
          picture: "https://lh3.googleusercontent.com/avatar.png",
          email: "vidyesh@example.com",
          email_verified: true,
        }),
      );
      expect(decodeResult).toEqual({
        success: true,
        value: {
          name: "Vidyesh Churi",
          image: "https://lh3.googleusercontent.com/avatar.png",
          email: "vidyesh@example.com",
        },
      });
    });

    it("drops the email when email_verified is false", () => {
      const decodeResult = readGoogleProfileFromIdToken(
        buildIdToken({ email: "attacker@example.com", email_verified: false }),
      );
      expect(decodeResult).toEqual({
        success: true,
        value: expect.objectContaining({ email: undefined }),
      });
    });

    it("drops the email when email_verified is absent", () => {
      const decodeResult = readGoogleProfileFromIdToken(buildIdToken({ email: "someone@example.com" }));
      expect(decodeResult).toEqual({
        success: true,
        value: expect.objectContaining({ email: undefined }),
      });
    });

    it("succeeds with an empty claims object, yielding no profile fields", () => {
      expect(readGoogleProfileFromIdToken(buildIdToken({}))).toEqual({
        success: true,
        value: { name: undefined, image: undefined, email: undefined },
      });
    });
  });
});
