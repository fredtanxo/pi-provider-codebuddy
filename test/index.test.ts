import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointFor, startupModelsFor, storedCredentials } from "../src/index.ts";
import { PROVIDERS } from "../src/product.ts";

const ENTERPRISE = PROVIDERS.find((p) => p.id === "codebuddy-enterprise")!;

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(getAgentDir(), "auth.json"), { force: true });
});

function writeAuth(contents: unknown) {
  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(contents));
}

describe("storedCredentials", () => {
  it("reads only codebuddy credential slots from auth.json", () => {
    writeAuth({
      "codebuddy-cn": {
        providerId: "codebuddy-cn",
        access: "a",
        type: "oauth",
      },
      "codebuddy-intl": {
        providerId: "codebuddy-intl",
        access: "b",
        type: "oauth",
      },
      codebuddy: { providerId: "codebuddy", access: "legacy" },
      anthropic: { access: "other" },
    });
    expect(storedCredentials().map((c) => c.providerId)).toEqual(["codebuddy-cn", "codebuddy-intl", "codebuddy"]);
  });

  it("returns [] when auth.json is missing or malformed (silent degradation)", () => {
    expect(storedCredentials()).toEqual([]);
    writeAuth("not json{");
    expect(storedCredentials()).toEqual([]);
  });
});

describe("endpointFor", () => {
  it("prefers the fixed site endpoint over the stored credential", () => {
    expect(endpointFor(PROVIDERS.find((p) => p.id === "codebuddy-cn")!)).toBe("https://copilot.tencent.com");
  });

  it("falls back to the stored credential endpoint for the enterprise slot", () => {
    writeAuth({
      "codebuddy-enterprise": {
        providerId: "codebuddy-enterprise",
        access: "a",
        endpoint: "https://acme.copilot.qq.com",
      },
    });
    expect(endpointFor(ENTERPRISE)).toBe("https://acme.copilot.qq.com");
  });

  it("returns undefined when the enterprise slot has no stored credential", () => {
    expect(endpointFor(ENTERPRISE)).toBeUndefined();
  });
});

describe("startupModelsFor", () => {
  it("degrades to an empty catalog when no endpoint or credential resolves", async () => {
    // No auth.json at all: the enterprise slot has neither a fixed endpoint
    // nor a stored credential, so the catalog is empty rather than throwing.
    await expect(startupModelsFor(ENTERPRISE)).resolves.toEqual([]);
  });
});
