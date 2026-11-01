import { describe, expect, it } from "vitest";
import {
  deploymentType,
  enterpriseIdFromEndpoint,
  isCodeBuddyProvider,
  isIOADomain,
  networkEnvironment,
  normalizeEndpoint,
  PROVIDERS,
} from "../src/product.ts";

describe("normalizeEndpoint", () => {
  it("accepts bare hosts, trailing slashes and paths", () => {
    expect(normalizeEndpoint("acme.copilot.qq.com")).toBe("https://acme.copilot.qq.com");
    expect(normalizeEndpoint(" https://acme.copilot.qq.com/ ")).toBe("https://acme.copilot.qq.com");
    expect(normalizeEndpoint("https://www.codebuddy.ai/v2/plugin")).toBe("https://www.codebuddy.ai");
  });

  it("rejects empty and non-http input", () => {
    expect(() => normalizeEndpoint("  ")).toThrow(/empty/);
    expect(() => normalizeEndpoint("ftp://example.com")).toThrow(/protocol/);
  });
});

describe("networkEnvironment and deploymentType", () => {
  it.each([
    ["copilot.tencent.com", "internal", "SaaS"],
    ["www.codebuddy.cn", "internal", "SaaS"],
    ["www.codebuddy.ai", "external", "SaaS"],
    // Also matches `*.sso.copilot.tencent.com`, which the CLI checks first.
    ["tencent.sso.copilot.tencent.com", "iOA", "Cloud-Hosted"],
    ["acme.copilot.qq.com", "cloudhosted", "Cloud-Hosted"],
    ["acme.copilot-staging.qq.com", "cloudhosted", "Cloud-Hosted"],
    ["acme.sso.codebuddy.cn", "cloudhosted", "Cloud-Hosted"],
    ["codebuddy.corp.example.com", "selfhosted", "Self-Hosted"],
  ])("%s → %s / %s", (host, environment, deployment) => {
    expect(networkEnvironment(host)).toBe(environment);
    expect(deploymentType(`https://${host}`, networkEnvironment(host))).toBe(deployment);
  });

  it("does not let a wildcard match across labels", () => {
    expect(networkEnvironment("a.b.copilot.qq.com")).toBe("selfhosted");
    expect(networkEnvironment("evilcopilot.qq.com")).toBe("selfhosted");
  });

  it("derives the enterprise id from a cloud-hosted subdomain", () => {
    expect(enterpriseIdFromEndpoint("https://acme.copilot.qq.com")).toBe("acme");
    expect(enterpriseIdFromEndpoint("https://acme.sso.copilot.tencent.com")).toBe("acme");
    expect(enterpriseIdFromEndpoint("https://www.codebuddy.ai")).toBeUndefined();
  });
});

describe("provider table", () => {
  it("gives every site its own provider id and shares the CN endpoint with iOA", () => {
    const ioa = PROVIDERS.find((provider) => provider.id === "codebuddy-ioa");
    expect(ioa?.endpoint).toBe("https://copilot.tencent.com");
    expect(ioa?.environment).toBe("iOA");
    expect(new Set(PROVIDERS.map((provider) => provider.id)).size).toBe(PROVIDERS.length);
    expect(PROVIDERS.at(-1)?.id).toBe("codebuddy-enterprise");
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(ids).toEqual(["codebuddy-cn", "codebuddy-intl", "codebuddy-ioa", "codebuddy-enterprise"]);
  });

  it("matches codebuddy provider ids including the pre-multi-site one", () => {
    expect(isCodeBuddyProvider("codebuddy")).toBe(true);
    expect(isCodeBuddyProvider("codebuddy-cn")).toBe(true);
    expect(isCodeBuddyProvider("codebuddy-enterprise")).toBe(true);
    expect(isCodeBuddyProvider("codebuddyfoo")).toBe(false);
    expect(isCodeBuddyProvider("qoder")).toBe(false);
    expect(isCodeBuddyProvider(undefined)).toBe(false);
  });

  it("recognizes iOA SSO domains without letting wildcards overmatch", () => {
    expect(isIOADomain("tencent.sso.copilot.tencent.com")).toBe(true);
    expect(isIOADomain("tencent.sso.copilot-staging.tencent.com")).toBe(true);
    expect(isIOADomain("tencent.sso.codebuddy.cn")).toBe(true);
    expect(isIOADomain("acme.sso.copilot.tencent.com")).toBe(false);
    expect(isIOADomain("copilot.tencent.com")).toBe(false);
  });
});
