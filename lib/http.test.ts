import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseCrossSite, refuseForeignHost } from "./http";

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

describe("refuseForeignHost (DNS rebinding)", () => {
  const get = (host: string) => new Request("http://x/api/proposals", { headers: { host } });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:3123", "localhost"])("serves %s", (host) => {
    expect(refuseForeignHost(get(host))).toBeNull();
  });

  it.each(["evil.example:3000", "evil.example", "localhost.evil.example:3000", "127.0.0.1.nip.io:3000", "", "::bad::"])("refuses Host %j", (host) => {
    expect(refuseForeignHost(get(host))?.status).toBe(403);
  });

  it("refuses a rebinding POST even though its Origin matches its Host", () => {
    const r = req({ host: "evil.example:3000", origin: "http://evil.example:3000", "content-type": "application/json", "sec-fetch-site": "same-origin" });
    expect(refuseCrossSite(r)?.status).toBe(403);
  });

  it("allows extra hosts from RULEBOOK_ALLOWED_HOSTS", () => {
    vi.stubEnv("RULEBOOK_ALLOWED_HOSTS", "rulebook.example.app, demo.internal");
    expect(refuseForeignHost(get("rulebook.example.app"))).toBeNull();
    expect(refuseForeignHost(get("demo.internal:8080"))).toBeNull();
    expect(refuseForeignHost(get("evil.example"))?.status).toBe(403);
  });
});
