import { describe, expect, it } from "vitest";
import { refuseCrossSite } from "./http";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost:3000/api/proposals/P-001/accept", { method: "POST", headers: { host: "localhost:3000", ...headers } });

describe("refuseCrossSite", () => {
  it("allows a same-origin JSON POST, and curl (no Origin header)", () => {
    expect(refuseCrossSite(req({ "content-type": "application/json", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(refuseCrossSite(req({ "content-type": "application/json; charset=utf-8" }))).toBeNull();
  });

  it.each([
    ["text/plain (a no-preflight cross-site form/fetch)", { "content-type": "text/plain" }, 415],
    ["form-encoded", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["no content type", {}, 415],
    ["JSON from another origin", { "content-type": "application/json", origin: "https://evil.example" }, 403],
    ["JSON from another localhost port", { "content-type": "application/json", origin: "http://localhost:5173" }, 403],
    ['opaque "null" origin', { "content-type": "application/json", origin: "null" }, 403],
    ["sec-fetch-site cross-site", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
  ])("refuses %s", (_, headers, status) => {
    expect(refuseCrossSite(req(headers))?.status).toBe(status);
  });
});
