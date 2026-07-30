import { describe, expect, it } from "vitest";
import { alive, parseTunnelUrl } from "../src/tunnel";

describe("tunnel state", () => {
  it("extracts only a Quick Tunnel HTTPS address", () => {
    const log = "INF Your quick Tunnel has been created! Visit it at https://quiet-lake-17.trycloudflare.com";
    expect(parseTunnelUrl(log)).toBe("https://quiet-lake-17.trycloudflare.com");
    expect(parseTunnelUrl("http://localhost:47822")).toBeUndefined();
  });

  it("rejects invalid process identifiers", () => {
    expect(alive(0)).toBe(false);
    expect(alive(-4)).toBe(false);
    expect(alive(Number.NaN)).toBe(false);
  });
});
