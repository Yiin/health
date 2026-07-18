import { describe, expect, it } from "vitest";

import {
  isAuthorized,
  isBasicAuthEnabled,
  parseBasicAuthHeader,
} from "./basic-auth";

function basicAuth(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("isBasicAuthEnabled", () => {
  it("is false when either var is missing", () => {
    expect(isBasicAuthEnabled({})).toBe(false);
    expect(isBasicAuthEnabled({ user: "u" })).toBe(false);
    expect(isBasicAuthEnabled({ pass: "p" })).toBe(false);
    expect(isBasicAuthEnabled({ user: "", pass: "p" })).toBe(false);
  });

  it("is true when both vars are set", () => {
    expect(isBasicAuthEnabled({ user: "u", pass: "p" })).toBe(true);
  });
});

describe("parseBasicAuthHeader", () => {
  it("parses a well-formed header", () => {
    expect(parseBasicAuthHeader(basicAuth("alice", "s3cret"))).toEqual({
      user: "alice",
      pass: "s3cret",
    });
  });

  it("allows colons in the password", () => {
    expect(parseBasicAuthHeader(basicAuth("alice", "a:b:c"))).toEqual({
      user: "alice",
      pass: "a:b:c",
    });
  });

  it("rejects malformed headers", () => {
    expect(parseBasicAuthHeader(null)).toBeNull();
    expect(parseBasicAuthHeader("Bearer xyz")).toBeNull();
    expect(parseBasicAuthHeader("Basic !!!not-base64!!!")).toBeNull();
    expect(parseBasicAuthHeader(`Basic ${btoa("nocolon")}`)).toBeNull();
  });
});

describe("isAuthorized", () => {
  const config = { user: "yiin", pass: "hunter2" };

  it("passes through when the gate is disabled", () => {
    expect(isAuthorized({}, null)).toBe(true);
    expect(isAuthorized({ user: "yiin" }, null)).toBe(true);
  });

  it("rejects missing, malformed, and wrong credentials", () => {
    expect(isAuthorized(config, null)).toBe(false);
    expect(isAuthorized(config, "Bearer xyz")).toBe(false);
    expect(isAuthorized(config, basicAuth("yiin", "wrong"))).toBe(false);
    expect(isAuthorized(config, basicAuth("someone", "hunter2"))).toBe(false);
  });

  it("accepts matching credentials", () => {
    expect(isAuthorized(config, basicAuth("yiin", "hunter2"))).toBe(true);
  });
});
