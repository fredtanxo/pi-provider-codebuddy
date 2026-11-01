import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type CodeBuddySession, type Envelope, HttpError, requestEnvelope } from "./http.ts";
import {
  CLI_VERSION,
  type CodeBuddyProvider,
  hostOf,
  IOA_DEFAULT_DOMAIN,
  type NetworkEnvironment,
  normalizeEndpoint,
  PLATFORM,
  providerById,
} from "./product.ts";

const LOGIN_TOKEN_PENDING_CODE = 11217;
const LOGIN_ACCOUNT_PENDING_CODE = 12151;
const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 300_000;
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface CodeBuddyCredentials extends OAuthCredentials {
  /** The site provider these credentials belong to (one credential slot per id). */
  providerId: string;
  endpoint: string;
  domain?: string;
  /** Only iOA needs to be carried explicitly; every other environment is derivable from the domain. */
  environment?: Extract<NetworkEnvironment, "iOA">;
  uid?: string;
  enterpriseId?: string;
  nickname?: string;
  enterpriseName?: string;
  refreshExpires?: number;
}

interface AuthTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  domain?: string;
}

interface AccountPayload {
  uid?: string;
  nickname?: string;
  enterpriseId?: string;
  enterpriseName?: string;
}

/** omp's login callbacks have no `onSelect`; pi's do. */
type LoginCallbacks = Omit<OAuthLoginCallbacks, "onSelect"> & Partial<Pick<OAuthLoginCallbacks, "onSelect">>;

const UNAUTHENTICATED_HEADERS = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function promptEnterpriseEndpoint(callbacks: LoginCallbacks): Promise<string> {
  const answer = await callbacks.onPrompt({
    message: "Enterprise domain",
    placeholder: "https://<enterprise>.copilot.qq.com",
  });
  return normalizeEndpoint(answer);
}

/** Re-login instruction carrying the exact provider id, so multi-site users know which slot expired. */
function reloginHint(credentials: CodeBuddyCredentials): string {
  const provider = providerById(credentials.providerId);
  return `${provider?.label ?? "CodeBuddy"} login has expired; run /login ${credentials.providerId}`;
}

/** Refresh rejected by the server (revoked session, expired refresh token): only re-login helps. */
export class CredentialsInvalidError extends Error {}

function toCredentials(
  providerId: string,
  endpoint: string,
  token: AuthTokenPayload,
  account: AccountPayload | undefined,
  environment?: "iOA",
  previous?: CodeBuddyCredentials,
): CodeBuddyCredentials {
  const now = Date.now();
  const expiresIn = (token.expiresIn ?? 3600) * 1000;
  return {
    providerId: providerId || previous?.providerId || "codebuddy",
    refresh: token.refreshToken ?? previous?.refresh ?? "",
    access: token.accessToken,
    expires: now + Math.max(expiresIn - EXPIRY_SKEW_MS, expiresIn / 2),
    refreshExpires: token.refreshExpiresIn ? now + token.refreshExpiresIn * 1000 : previous?.refreshExpires,
    endpoint,
    // The CLI's applyIOADefaultHeaders: the server's value wins, iOA falls back to its SSO domain.
    domain: token.domain || previous?.domain || (environment === "iOA" ? IOA_DEFAULT_DOMAIN : hostOf(endpoint)),
    environment: environment ?? previous?.environment,
    uid: account?.uid ?? previous?.uid,
    enterpriseId: account?.enterpriseId || previous?.enterpriseId || undefined,
    nickname: account?.nickname ?? previous?.nickname,
    enterpriseName: account?.enterpriseName ?? previous?.enterpriseName,
  };
}

export function sessionFromCredentials(credentials: CodeBuddyCredentials): CodeBuddySession {
  return {
    endpoint: credentials.endpoint,
    accessToken: credentials.access,
    domain: credentials.domain,
    environment: credentials.environment,
    uid: credentials.uid,
    enterpriseId: credentials.enterpriseId,
  };
}

async function pollToken(endpoint: string, state: string, signal?: AbortSignal): Promise<AuthTokenPayload> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const url = `${endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  while (Date.now() < deadline) {
    const body = await requestEnvelope<AuthTokenPayload>(url, { headers: UNAUTHENTICATED_HEADERS }, signal);
    if (body.data?.accessToken) return body.data;
    if (body.code !== LOGIN_TOKEN_PENDING_CODE && body.code !== 0) {
      throw new Error(`CodeBuddy login failed (code ${body.code}): ${body.msg ?? "unknown error"}`);
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("CodeBuddy login timed out after 5 minutes");
}

async function pollAccount(
  endpoint: string,
  state: string,
  token: AuthTokenPayload,
  environment: "iOA" | undefined,
  signal?: AbortSignal,
): Promise<AccountPayload> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const url = `${endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
  const headers = {
    Authorization: `Bearer ${token.accessToken}`,
    "X-Domain": token.domain || (environment === "iOA" ? IOA_DEFAULT_DOMAIN : hostOf(endpoint)),
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
  let authRetried = false;
  while (Date.now() < deadline) {
    let body: Envelope<AccountPayload>;
    try {
      body = await requestEnvelope<AccountPayload>(url, { headers }, signal);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403) && !authRetried) {
        authRetried = true;
        await sleep(POLL_INTERVAL_MS, signal);
        continue;
      }
      throw error;
    }
    if (body.code === 0 && body.data) return body.data;
    if (body.code !== LOGIN_ACCOUNT_PENDING_CODE) {
      throw new Error(`CodeBuddy account lookup failed (code ${body.code}): ${body.msg ?? "unknown error"}`);
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("CodeBuddy account lookup timed out");
}

export async function loginCodeBuddy(
  provider: CodeBuddyProvider,
  callbacks: LoginCallbacks,
): Promise<CodeBuddyCredentials> {
  const signal = callbacks.signal;
  const endpoint = provider.endpoint ?? (await promptEnterpriseEndpoint(callbacks));
  const environment = provider.environment;
  const stateBody = await requestEnvelope<{ state: string; authUrl: string }>(
    `${endpoint}/v2/plugin/auth/state?platform=${PLATFORM}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Domain": hostOf(endpoint),
        ...UNAUTHENTICATED_HEADERS,
      },
      body: "{}",
    },
    signal,
  );
  const state = stateBody.data?.state;
  const authUrl = stateBody.data?.authUrl;
  if (!state || !authUrl) {
    throw new Error(`CodeBuddy login could not start (code ${stateBody.code}): ${stateBody.msg ?? "missing state"}`);
  }
  const url = new URL(authUrl);
  url.searchParams.set("version", CLI_VERSION);
  // The CLI's decorateAuthUrl: iOA SSO only engages its enterprise login on this flag.
  if (environment === "iOA") url.searchParams.set("ioa", "1");
  callbacks.onAuth({
    url: url.toString(),
    instructions: "Complete the CodeBuddy login in your browser.",
  });
  callbacks.onProgress?.("Waiting for browser login...");

  const token = await pollToken(endpoint, state, signal);
  callbacks.onProgress?.("Fetching CodeBuddy account...");
  const account = await pollAccount(endpoint, state, token, environment, signal);
  return toCredentials(provider.id, endpoint, token, account, environment);
}

export async function refreshCodeBuddy(
  credentials: CodeBuddyCredentials,
  signal?: AbortSignal,
): Promise<CodeBuddyCredentials> {
  if (!credentials.endpoint)
    throw new CredentialsInvalidError(`CodeBuddy credentials have no endpoint. ${reloginHint(credentials)}`);
  if (!credentials.refresh)
    throw new CredentialsInvalidError(`CodeBuddy credentials have no refresh token. ${reloginHint(credentials)}`);
  let body: Envelope<AuthTokenPayload & { data?: AuthTokenPayload }>;
  try {
    body = await requestEnvelope<AuthTokenPayload & { data?: AuthTokenPayload }>(
      `${credentials.endpoint}/v2/plugin/auth/token/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.access}`,
          "X-Refresh-Token": credentials.refresh,
          "X-Auth-Refresh-Source": "plugin",
          "X-Domain":
            credentials.domain ||
            (credentials.environment === "iOA" ? IOA_DEFAULT_DOMAIN : hostOf(credentials.endpoint)),
        },
        body: "{}",
      },
      signal,
    );
  } catch (error) {
    // HTTP-level rejection: the server no longer accepts this session.
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new CredentialsInvalidError(
        `CodeBuddy rejected the token refresh (${error.status}). ${reloginHint(credentials)}`,
      );
    }
    throw error; // Network and other transport failures are transient; the host retries.
  }
  const token = body.data?.accessToken ? body.data : body.data?.data;
  if (!token?.accessToken) {
    if (body.code === 401 || body.code === 403) {
      throw new CredentialsInvalidError(
        `CodeBuddy rejected the token refresh (code ${body.code}). ${reloginHint(credentials)}`,
      );
    }
    throw new Error(`CodeBuddy token refresh failed (code ${body.code}): ${body.msg ?? "no token returned"}`);
  }
  return toCredentials(
    credentials.providerId,
    credentials.endpoint,
    token,
    undefined,
    credentials.environment,
    credentials,
  );
}
