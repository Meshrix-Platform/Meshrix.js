import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SERVER_PORT,
  DEFAULT_VITE_PORT,
  getDefaultServerUrl,
  resolveComposeHostPort,
  resolveServerPort,
  resolveVitePort
} from "../../../packages/foundation/src/config/server-env.ts";

afterEach((): any => {
  vi.unstubAllEnvs();
});

describe("server-env port resolution", (): any => {
  it("returns documented defaults without environment overrides", (): any => {
    vi.stubEnv("MESHRIX_SERVER_PORT", "");
    vi.stubEnv("MESHRIX_VITE_PORT", "");
    vi.stubEnv("MESHRIX_HOST_PORT", "");
    expect(resolveServerPort()).toBe(DEFAULT_SERVER_PORT);
    expect(resolveVitePort()).toBe(DEFAULT_VITE_PORT);
    expect(resolveComposeHostPort()).toBe(DEFAULT_SERVER_PORT);
    expect(getDefaultServerUrl()).toBe(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
  });

  it("honors each environment override", (): any => {
    vi.stubEnv("MESHRIX_SERVER_PORT", "8123");
    vi.stubEnv("MESHRIX_VITE_PORT", "5199");
    vi.stubEnv("MESHRIX_HOST_PORT", "9000");
    expect(resolveServerPort()).toBe(8123);
    expect(resolveVitePort()).toBe(5199);
    expect(resolveComposeHostPort()).toBe(9000);
    expect(getDefaultServerUrl()).toBe("http://127.0.0.1:8123");
  });

  it("prefers an explicit option over the environment", (): any => {
    vi.stubEnv("MESHRIX_SERVER_PORT", "8123");
    expect(resolveServerPort({ port: 8443 })).toBe(8443);
    expect(resolveServerPort({ port: "9443" })).toBe(9443);
    expect(getDefaultServerUrl({ port: 9443 })).toBe("http://127.0.0.1:9443");
  });

  it("falls back to the default on invalid values", (): any => {
    vi.stubEnv("MESHRIX_SERVER_PORT", "not-a-port");
    vi.stubEnv("MESHRIX_VITE_PORT", "70000");
    expect(resolveServerPort()).toBe(DEFAULT_SERVER_PORT);
    expect(resolveVitePort()).toBe(DEFAULT_VITE_PORT);
    expect(resolveServerPort({ port: 0 })).toBe(DEFAULT_SERVER_PORT);
    expect(resolveServerPort({ port: -1 })).toBe(DEFAULT_SERVER_PORT);
    expect(resolveServerPort({ port: 65536 })).toBe(DEFAULT_SERVER_PORT);
  });
});
