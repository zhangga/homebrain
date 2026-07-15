import { describe, expect, test } from "bun:test";
import { assertSafeWebBinding, isLoopbackHost } from "./web-security.ts";

describe("web binding safety", () => {
  test("recognizes local-only hostnames and addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.12.34.56")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });

  test("non-local binding requires a non-empty admin token", () => {
    expect(() => assertSafeWebBinding("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertSafeWebBinding("0.0.0.0", "admin-secret")).not.toThrow();
    expect(() => assertSafeWebBinding("0.0.0.0", undefined)).toThrow("HOMEAGENT_WEB_ADMIN_TOKEN");
    expect(() => assertSafeWebBinding("::", "   ")).toThrow("HOMEAGENT_WEB_ADMIN_TOKEN");
  });
});
