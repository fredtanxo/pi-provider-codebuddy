import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodeBuddyCredentials, CredentialsInvalidError, loginCodeBuddy, refreshCodeBuddy } from "../src/auth.ts";
import { PROVIDERS } from "../src/product.ts";
import { envelope } from "./helpers.ts";

const CN = PROVIDERS.find((provider) => provider.id === "codebuddy-cn")!;
const INTL = PROVIDERS.find((provider) => provider.id === "codebuddy-intl")!;
const IOA = PROVIDERS.find((provider) => provider.id === "codebuddy-ioa")!;
const ENTERPRISE = PROVIDERS.find((provider) => provider.id === "codebuddy-enterprise")!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function callbacks(overrides: Record<string, unknown> = {}) {
  return {
    onAuth: () => {},
    onDeviceCode: () => {},
    onPrompt: async () => "",
    ...overrides,
  } as any;
}

/** Login server whose token endpoint answers with `tokenReplies` in order, then succeeds. */
function stubLoginServer(tokenReplies: Response[] = []) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.pathname.endsWith("/auth/state")) return envelope({ state: "s", authUrl: `${url.origin}/login?state=s` });
    if (url.pathname.endsWith("/auth/token")) {
      return (
        tokenReplies.shift() ??
        envelope({
          accessToken: "tok",
          refreshToken: "ref",
          expiresIn: 3600,
          domain: url.host,
        })
      );
    }
    return envelope({ uid: "u", enterpriseId: "e", nickname: "n" });
  });
  return requests;
}

describe("login providers", () => {
  it("logs the fixed CN endpoint without any site prompt", async () => {
    const requests = stubLoginServer();
    const credentials = await loginCodeBuddy(CN, callbacks({ onSelect: async () => "ignored" }));
    expect(credentials.endpoint).toBe("https://copilot.tencent.com");
    expect(credentials.providerId).toBe("codebuddy-cn");
    expect(new Set(requests.map((request) => request.url.host))).toEqual(new Set(["copilot.tencent.com"]));
  });

  it("logs the International site under its own provider id", async () => {
    stubLoginServer();
    const credentials = await loginCodeBuddy(INTL, callbacks());
    expect(credentials.endpoint).toBe("https://www.codebuddy.ai");
    expect(credentials.providerId).toBe("codebuddy-intl");
  });

  it("asks for a domain only for the enterprise provider", async () => {
    stubLoginServer();
    const prompts: string[] = [];
    const credentials = await loginCodeBuddy(
      ENTERPRISE,
      callbacks({
        onPrompt: async ({ message }: { message: string }) => {
          prompts.push(message);
          return "acme.copilot.qq.com";
        },
      }),
    );
    expect(credentials.endpoint).toBe("https://acme.copilot.qq.com");
    expect(credentials.providerId).toBe("codebuddy-enterprise");
    expect(prompts).toEqual(["Enterprise domain"]);
  });

  it("marks iOA credentials and appends ioa=1 to the auth URL", async () => {
    const requests = stubLoginServer([envelope({ accessToken: "tok", refreshToken: "ref", expiresIn: 3600 })]);
    const onAuth = vi.fn();
    const credentials = await loginCodeBuddy(IOA, callbacks({ onAuth }));

    expect(credentials.endpoint).toBe("https://copilot.tencent.com");
    expect(credentials.providerId).toBe("codebuddy-ioa");
    expect(credentials.environment).toBe("iOA");
    // The token carried no domain; iOA falls back to its SSO domain for account polling too.
    expect(credentials.domain).toBe("tencent.sso.copilot.tencent.com");
    const accountPoll = requests.find((request) => request.url.pathname.endsWith("/login/account"));
    expect(accountPoll?.headers["X-Domain"]).toBe("tencent.sso.copilot.tencent.com");
    expect(onAuth.mock.calls[0]?.[0].url).toContain("ioa=1");
    // Non-iOA logins never carry the flag.
    const again = await loginCodeBuddy(CN, callbacks({ onAuth }));
    expect(again.environment).toBeUndefined();
    expect(onAuth.mock.calls[1]?.[0].url).not.toContain("ioa=1");
  });
});

describe("login flow", () => {
  it("keeps polling while the token is pending and stores account identity", async () => {
    const requests = stubLoginServer([envelope(undefined, 11217)]);
    const onAuth = vi.fn();
    const credentials = await loginCodeBuddy(CN, callbacks({ onAuth }));

    expect(requests.filter((request) => request.url.pathname.endsWith("/auth/token"))).toHaveLength(2);
    expect(onAuth.mock.calls[0]?.[0].url).toContain("version=");
    expect(credentials).toMatchObject({
      access: "tok",
      refresh: "ref",
      uid: "u",
      enterpriseId: "e",
      domain: "copilot.tencent.com",
    });
    expect(credentials.expires).toBeLessThan(Date.now() + 3600_000);
  });

  it("stops on any other token error code", async () => {
    stubLoginServer([envelope(undefined, 500)]);
    await expect(loginCodeBuddy(CN, callbacks())).rejects.toThrow(/code 500/);
  });

  it("gives up after the 5-minute token poll deadline", async () => {
    vi.useFakeTimers();
    // The token endpoint keeps reporting "pending" forever.
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/auth/state")) return envelope({ state: "s", authUrl: `${url.origin}/login?state=s` });
      if (url.pathname.endsWith("/auth/token")) return envelope(undefined, 11217);
      return envelope({ uid: "u", enterpriseId: "e" });
    });

    const login = loginCodeBuddy(CN, callbacks());
    const assertion = expect(login).rejects.toThrow(/timed out after 5 minutes/);
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("refreshCodeBuddy", () => {
  const credentials: CodeBuddyCredentials = {
    providerId: "codebuddy-cn",
    access: "old",
    refresh: "ref",
    expires: 0,
    endpoint: "https://acme.copilot.qq.com",
    domain: "acme.copilot.qq.com",
    uid: "u",
    enterpriseId: "acme",
  };

  it("sends the refresh token and keeps identity and refresh token the server omits", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return envelope({ accessToken: "new", expiresIn: 3600 });
    });
    const refreshed = await refreshCodeBuddy(credentials);
    expect(headers["X-Refresh-Token"]).toBe("ref");
    expect(headers.Authorization).toBe("Bearer old");
    expect(refreshed).toMatchObject({
      access: "new",
      refresh: "ref",
      uid: "u",
      enterpriseId: "acme",
      providerId: "codebuddy-cn",
    });
  });

  it("accepts the token nested one level deeper", async () => {
    vi.stubGlobal("fetch", async () => envelope({ data: { accessToken: "nested", refreshToken: "r2" } }));
    expect(await refreshCodeBuddy(credentials)).toMatchObject({
      access: "nested",
      refresh: "r2",
    });
  });

  it("falls back to the iOA SSO domain and keeps the environment across refreshes", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return envelope({ accessToken: "new", expiresIn: 3600 });
    });
    const refreshed = await refreshCodeBuddy({
      ...credentials,
      providerId: "codebuddy-ioa",
      domain: undefined,
      environment: "iOA",
    });
    expect(headers["X-Domain"]).toBe("tencent.sso.copilot.tencent.com");
    expect(refreshed).toMatchObject({
      access: "new",
      environment: "iOA",
      domain: "tencent.sso.copilot.tencent.com",
    });
  });

  it("raises CredentialsInvalidError with a re-login hint when the server rejects the credential", async () => {
    // Business-code rejection over HTTP 200.
    vi.stubGlobal("fetch", async () => envelope(undefined, 401));
    const rejection = refreshCodeBuddy(credentials);
    await expect(rejection).rejects.toBeInstanceOf(CredentialsInvalidError);
    await expect(rejection).rejects.toThrow(/\/login codebuddy-cn/);

    // HTTP-level rejection.
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    await expect(refreshCodeBuddy(credentials)).rejects.toBeInstanceOf(CredentialsInvalidError);
    vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
    await expect(refreshCodeBuddy(credentials)).rejects.toBeInstanceOf(CredentialsInvalidError);
  });

  it("keeps other failures transient so the host can retry", async () => {
    vi.stubGlobal("fetch", async () => envelope(undefined, 500));
    const error = await refreshCodeBuddy(credentials).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialsInvalidError);
    expect((error as Error).message).toMatch(/refresh failed/);
    await expect(refreshCodeBuddy({ ...credentials, endpoint: "" })).rejects.toBeInstanceOf(CredentialsInvalidError);
    await expect(refreshCodeBuddy({ ...credentials, refresh: "" })).rejects.toBeInstanceOf(CredentialsInvalidError);
  });
});
