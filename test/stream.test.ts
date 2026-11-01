import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageCredit } from "../src/credits.ts";
import { rememberSession } from "../src/http.ts";
import { fetchRemoteModels, type RemoteModel, toProviderModel } from "../src/models.ts";
import { streamCodeBuddy } from "../src/stream.ts";
import { envelope, sse } from "./helpers.ts";

const session = {
  endpoint: "https://acme.copilot.qq.com",
  accessToken: "session-token",
  uid: "uid-1",
  enterpriseId: "acme",
};

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function completion(credit?: number) {
  return sse([
    {
      id: "1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
    },
    {
      id: "1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
        ...(credit === undefined ? {} : { credit }),
      },
    },
  ]);
}

async function run(remote: RemoteModel, response: () => Response, options: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", async (input: string) =>
    new URL(input).pathname === "/v3/config" ? envelope({ models: [remote] }) : new Response("{}", { status: 404 }),
  );
  await fetchRemoteModels(session);
  vi.unstubAllGlobals();

  const requests: CapturedRequest[] = [];
  const hostFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await request.json(),
    });
    return response();
  };
  const model = {
    ...toProviderModel(remote, session.endpoint),
    provider: "codebuddy",
  } as unknown as Model<Api>;
  const stream = streamCodeBuddy(
    model,
    {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    } as never,
    {
      apiKey: session.accessToken,
      sessionId: "conv-1",
      fetch: hostFetch,
      ...options,
    } as never,
  );
  return { message: await stream.result(), requests };
}

describe("streamCodeBuddy", () => {
  afterEach(() => vi.unstubAllGlobals());
  rememberSession(session);

  it("calls the gateway with CodeBuddy identity headers and records the credit charge", async () => {
    const { message, requests } = await run({ id: "glm", supportsReasoning: true }, () => completion(0.07), {
      reasoning: "off",
    });

    expect(message.stopReason).toBe("stop");
    expect(messageCredit(message)).toBe(0.07);
    const [request] = requests;
    expect(request?.url).toBe("https://acme.copilot.qq.com/v2/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer session-token");
    expect(request?.headers.get("x-user-id")).toBe("uid-1");
    expect(request?.headers.get("x-enterprise-id")).toBe("acme");
    expect(request?.headers.get("x-product")).toBe("Cloud-Hosted");
    expect(request?.headers.get("x-conversation-id")).toBe("conv-1");
    expect(request?.headers.get("x-request-id")).toBe(request?.headers.get("x-conversation-message-id"));
    expect(request?.body).toMatchObject({
      model: "glm",
      stream: true,
      reasoning_effort: "none",
    });
  });

  it("leaves the credit unset when the response does not report one", async () => {
    const { message } = await run({ id: "glm" }, () => completion());
    expect(messageCredit(message)).toBeUndefined();
  });

  it("sends models with their own url and apiKey there without the CodeBuddy session", async () => {
    const { requests } = await run(
      {
        id: "own",
        url: "https://llm.corp.example.com/v1/chat/completions",
        apiKey: "model-key",
      },
      () => completion(),
    );

    const [request] = requests;
    expect(request?.url).toBe("https://llm.corp.example.com/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer model-key");
    for (const header of ["x-user-id", "x-enterprise-id", "x-domain", "x-conversation-id", "x-request-id"]) {
      expect(request?.headers.get(header)).toBeNull();
    }
  });

  it("rejects calls without a CodeBuddy login", () => {
    const model = {
      ...toProviderModel({ id: "glm" }, session.endpoint),
      provider: "codebuddy",
    } as unknown as Model<Api>;
    expect(() => streamCodeBuddy(model, { messages: [] } as never, {} as never)).toThrow(/not logged in/);
  });
});
