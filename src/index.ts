import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { type CodeBuddyCredentials, loginCodeBuddy, refreshCodeBuddy, sessionFromCredentials } from "./auth.ts";
import { registerCreditDisplay } from "./credit-display.ts";
import { type CodeBuddySession, lookupSession, rememberSession } from "./http.ts";
import {
  CODEBUDDY_API,
  cachedModels,
  fetchRemoteModels,
  isModelCacheStale,
  type RemoteModel,
  toProviderModel,
} from "./models.ts";
import { type CodeBuddyProvider, PROVIDERS } from "./product.ts";
import { streamCodeBuddy } from "./stream.ts";

const STARTUP_FETCH_TIMEOUT_MS = 10_000;

function rememberCredentials(credentials: OAuthCredentials): CodeBuddySession {
  const session = sessionFromCredentials(credentials as CodeBuddyCredentials);
  rememberSession(session);
  return session;
}

function toProviderModels(models: RemoteModel[], session: CodeBuddySession): ProviderModelConfig[] {
  return models.map((model) => toProviderModel(model, session.endpoint));
}

/** Every codebuddy credential slot in the host's auth store, including the pre-multi-site "codebuddy" key. */
export function storedCredentials(): (CodeBuddyCredentials & {
  type?: string;
})[] {
  try {
    const auth = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
    return Object.entries(auth)
      .filter(([id]) => /^codebuddy(-|$)/.test(id))
      .map(([, value]) => value as CodeBuddyCredentials & { type?: string });
  } catch {
    return [];
  }
}

/** The provider's endpoint: fixed for the public sites, stored per account for the enterprise slot. */
export function endpointFor(site: CodeBuddyProvider): string | undefined {
  return site.endpoint ?? storedCredentials().find((credential) => credential.providerId === site.id)?.endpoint;
}

/**
 * pi resolves `--model` before any session event, so a stale catalog is fetched while the
 * factory is awaited. Reads pi's `auth.json` without writing it; expired tokens are left to
 * pi's own refresh at `session_start`.
 */
export async function startupModelsFor(site: CodeBuddyProvider): Promise<ProviderModelConfig[]> {
  const endpoint = endpointFor(site);
  if (!endpoint) return [];
  if (!isModelCacheStale(endpoint)) return cachedModels(endpoint);
  try {
    const credential = storedCredentials().find(
      (candidate) => candidate.type === "oauth" && candidate.endpoint === endpoint,
    );
    if (!credential || credential.expires <= Date.now()) return cachedModels(endpoint);
    const session = rememberCredentials(credential);
    return toProviderModels(await fetchRemoteModels(session, AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS)), session);
  } catch {
    return cachedModels(endpoint);
  }
}

export default async function codebuddyExtension(pi: ExtensionAPI): Promise<void> {
  const buildConfig = (site: CodeBuddyProvider, models: ProviderModelConfig[]): ProviderConfig => {
    const config = {
      name: site.label,
      baseUrl: models[0]?.baseUrl,
      api: CODEBUDDY_API,
      streamSimple: streamCodeBuddy,
      models,
      oauth: {
        name: site.label,
        isSubscription: true,
        async login(callbacks: OAuthLoginCallbacks) {
          const credentials = await loginCodeBuddy(site, callbacks);
          const session = rememberCredentials(credentials);
          try {
            callbacks.onProgress?.("Fetching CodeBuddy models...");
            const remote = await fetchRemoteModels(session, callbacks.signal);
            pi.registerProvider(site.id, buildConfig(site, toProviderModels(remote, session)));
          } catch (error) {
            callbacks.onProgress?.(
              `Logged in, but fetching models failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return credentials;
        },
        async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal) {
          const refreshed = await refreshCodeBuddy(credentials as CodeBuddyCredentials, signal);
          rememberCredentials(refreshed);
          return refreshed;
        },
        getApiKey(credentials: OAuthCredentials) {
          rememberCredentials(credentials);
          return credentials.access;
        },
      },
      // pi: invoked with the stored credential when the catalog refreshes.
      async refreshModels(context: RefreshModelsContext) {
        const credential = context.credential;
        if (context.allowNetwork && credential?.type === "oauth" && credential.endpoint) {
          const session = rememberCredentials(credential as unknown as CodeBuddyCredentials);
          return toProviderModels(await fetchRemoteModels(session, context.signal), session);
        }
        const endpoint = credential?.type === "oauth" ? (credential.endpoint as string | undefined) : site.endpoint;
        return endpoint ? cachedModels(endpoint) : [];
      },
      // omp: invoked with the raw stored access token.
      async fetchDynamicModels(apiKey: string | undefined) {
        const session = lookupSession(apiKey);
        if (!session) return cachedModels(site.endpoint ?? "");
        try {
          return toProviderModels(await fetchRemoteModels(session), session);
        } catch {
          // omp calls this hook with no guaranteed guard; a failed fetch
          // degrades to the cached catalog instead of propagating.
          return cachedModels(session.endpoint);
        }
      },
    };
    return config as unknown as ProviderConfig;
  };

  // Startup fetches run concurrently: serial awaits would add up to four
  // 10-second timeouts to extension load when every cache is stale.
  await Promise.all(
    PROVIDERS.map(async (site) => {
      pi.registerProvider(site.id, buildConfig(site, await startupModelsFor(site)));
    }),
  );
  registerCreditDisplay(pi);

  // pi only refreshes catalogs over the network on request; omp refreshes through `fetchDynamicModels`.
  pi.on("session_start", async (_event, ctx) => {
    const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
      getProviderAuth?: unknown;
    };
    if (typeof registry.getProviderAuth !== "function") return;
    for (const site of PROVIDERS) {
      const endpoint = endpointFor(site);
      if (!endpoint || !isModelCacheStale(endpoint)) continue;
      try {
        await registry.refresh({
          providers: [site.id],
          allowNetwork: true,
          force: true,
        });
      } catch {
        // Keep the cached catalog; the next session retries.
      }
    }
  });
}
