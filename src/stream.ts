import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { attachCredit, type CreditMeter, creditFetch } from "./credits.ts";
import { identityHeaders, lookupSession, uuidv7Hex } from "./http.ts";
import { isResponsesApi, modelBaseUrl, remoteModel } from "./models.ts";

export function streamCodeBuddy(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const accessToken = options?.apiKey;
  if (!accessToken) throw new Error("CodeBuddy is not logged in. Run /login and select CodeBuddy.");
  const session = lookupSession(accessToken) ?? {
    endpoint: new URL(model.baseUrl).origin,
    accessToken,
  };
  // Routing metadata is cached per site; the session's endpoint is the cache key, even for
  // custom-url models whose own baseUrl points elsewhere.
  const remote = remoteModel(model.id, session.endpoint);
  const modelApiKey = remote?.url ? remote.apiKey?.trim() : undefined;
  const requestId = uuidv7Hex();
  const target = {
    ...model,
    api: isResponsesApi(remote?.api) ? "openai-responses" : "openai-completions",
    baseUrl: remote ? modelBaseUrl(remote, session.endpoint) : `${session.endpoint}/v2`,
    // A model-level key replaces the CodeBuddy session, as in the CLI.
    headers: modelApiKey ? { ...model.headers } : { ...model.headers, ...identityHeaders(session) },
  } as Model<"openai-completions">;
  const meter: CreditMeter = {};
  const inner = streamSimple(target, context, {
    ...options,
    fetch: creditFetch(meter, options?.fetch),
    apiKey: modelApiKey || accessToken,
    headers: modelApiKey
      ? options?.headers
      : {
          ...options?.headers,
          "X-Conversation-ID": options?.sessionId ?? crypto.randomUUID(),
          "X-Conversation-Request-ID": requestId,
          "X-Conversation-Message-ID": requestId,
          "X-Request-ID": requestId,
          "X-Agent-Intent": "craft",
        },
  });
  return attachCredit(inner, meter);
}
