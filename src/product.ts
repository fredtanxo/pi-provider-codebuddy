/** Mirrors `@tencent-ai/codebuddy-code` product.json (CLI 2.171.0). */
export const CLI_VERSION = "2.171.0";
export const PLATFORM = "CLI";

export type NetworkEnvironment = "internal" | "external" | "iOA" | "cloudhosted" | "selfhosted";
export type DeploymentType = "SaaS" | "Cloud-Hosted" | "Self-Hosted";

/**
 * One host credential slot per provider id: users log into each site separately and
 * address its models as `<id>/<model>`, so identical model ids across sites never merge.
 */
export interface CodeBuddyProvider {
  id: "codebuddy-cn" | "codebuddy-intl" | "codebuddy-ioa" | "codebuddy-enterprise";
  label: string;
  /** Fixed endpoint; the enterprise provider asks for one during login. */
  endpoint?: string;
  environment?: "iOA";
}

export const PROVIDERS: readonly CodeBuddyProvider[] = [
  {
    id: "codebuddy-cn",
    label: "CodeBuddy (CN)",
    endpoint: "https://copilot.tencent.com",
  },
  {
    id: "codebuddy-intl",
    label: "CodeBuddy (International)",
    endpoint: "https://www.codebuddy.ai",
  },
  // Same endpoint as the Chinese site; iOA is told apart by the `ioa=1` auth param
  // and the default headers below, never by the domain.
  {
    id: "codebuddy-ioa",
    label: "CodeBuddy iOA",
    endpoint: "https://copilot.tencent.com",
    environment: "iOA",
  },
  { id: "codebuddy-enterprise", label: "CodeBuddy Enterprise" },
];

export function providerById(id: string | undefined): CodeBuddyProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Matches every provider id the extension ever registered, including the pre-multi-site "codebuddy". */
export function isCodeBuddyProvider(provider: string | undefined | null): boolean {
  return /^codebuddy(-|$)/.test(provider ?? "");
}

/** The CLI's `IOAUtils.applyIOADefaultHeaders` fallbacks, applied only when unset. */
export const IOA_DEFAULT_DOMAIN = "tencent.sso.copilot.tencent.com";
export const IOA_DEFAULT_ENTERPRISE_ID = "etahzsqej0n4";

const INTERNAL_DOMAINS = [
  "copilot.tencent.com",
  "staging-copilot.tencent.com",
  "www.codebuddy.cn",
  "staging.codebuddy.cn",
  "www.workbuddy.cn",
  "staging.workbuddy.cn",
];
const EXTERNAL_DOMAINS = ["www.codebuddy.ai", "staging-codebuddy.tencent.com"];
const IOA_DOMAINS = [
  "tencent.sso.copilot.tencent.com",
  "tencent.sso.copilot-staging.tencent.com",
  "tencent.sso.codebuddy.cn",
  "tencent.staging-sso.codebuddy.cn",
];
const CLOUD_HOSTED_DOMAINS = [
  "*.sso.copilot.tencent.com",
  "*.sso.copilot-staging.tencent.com",
  "*.copilot.qq.com",
  "*.copilot-staging.qq.com",
  "*.sso.codebuddy.cn",
  "*.staging-sso.codebuddy.cn",
];

function wildcardPattern(pattern: string, capture: boolean): RegExp {
  const body = pattern.replace(/\./g, "\\.").replace(/\*/g, capture ? "([^.]*)" : "[^.]*");
  return new RegExp(`^${body}$`);
}

function matchesDomain(patterns: readonly string[], host: string): boolean {
  return patterns.some(
    (pattern) => pattern === host || (pattern.includes("*") && wildcardPattern(pattern, false).test(host)),
  );
}

/** Whether the host is one of the iOA SSO login domains. */
export function isIOADomain(host: string): boolean {
  return matchesDomain(IOA_DOMAINS, host.toLowerCase().replace(/:\d+$/, ""));
}

/** Accepts `host`, `host/`, or `https://host/...` and returns `https://host` (origin only). */
export function normalizeEndpoint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("CodeBuddy endpoint is empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid CodeBuddy endpoint: ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported CodeBuddy endpoint protocol: ${url.protocol}`);
  }
  return url.origin;
}

export function hostOf(endpoint: string): string {
  return new URL(endpoint).hostname;
}

/** The CLI's `resolveEnvBySession`: classifies the login domain against product.json's domain lists. */
export function networkEnvironment(domain: string): NetworkEnvironment {
  const host = domain.replace(/:\d+$/, "").toLowerCase();
  if (matchesDomain(INTERNAL_DOMAINS, host)) return "internal";
  if (matchesDomain(IOA_DOMAINS, host)) return "iOA";
  if (matchesDomain(CLOUD_HOSTED_DOMAINS, host)) return "cloudhosted";
  if (matchesDomain(EXTERNAL_DOMAINS, host)) return "external";
  return "selfhosted";
}

/** The CLI's `resolveDeploymentType`, falling back to product.json's `SaaS` default. */
export function deploymentType(endpoint: string, environment: NetworkEnvironment): DeploymentType {
  if (matchesDomain(CLOUD_HOSTED_DOMAINS, hostOf(endpoint))) return "Cloud-Hosted";
  if (environment === "cloudhosted") return "Cloud-Hosted";
  if (environment === "selfhosted") return "Self-Hosted";
  return "SaaS";
}

/** The CLI's `resolveEnterpriseIdFromEndpoint`: the `*` capture of a cloud-hosted domain. */
export function enterpriseIdFromEndpoint(endpoint: string): string | undefined {
  const host = hostOf(endpoint);
  for (const pattern of CLOUD_HOSTED_DOMAINS) {
    const match = wildcardPattern(pattern, true).exec(host);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
