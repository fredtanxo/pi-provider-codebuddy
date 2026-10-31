import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchRemoteModels,
	mergeCatalog,
	modelBaseUrl,
	readModelCache,
	remoteModel,
	supportedEfforts,
	toProviderModel,
} from "../src/models.ts";
import { envelope } from "./helpers.ts";

describe("mergeCatalog", () => {
	const config = {
		models: [
			{ id: "a", name: "A", maxOutputTokens: 1 },
			{ id: "b", name: "B", maxOutputTokens: 1 },
			{ id: "img", name: "Image" },
		],
		agents: [{ name: "cli", models: ["a", "b"] }],
	};

	it("keeps the cli whitelist order when there are no enterprise models", () => {
		expect(mergeCatalog(config, []).map((model) => model.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("overrides by id and prepends enterprise chat models like the CLI's unshift", () => {
		const merged = mergeCatalog(config, [
			{ id: "b", name: "B (enterprise)" },
			{ id: "e1", name: "E1", tags: ["chat"] },
			{ id: "e2", name: "E2", tags: ["chat"] },
			{ id: "e3", name: "E3", tags: ["other"] },
		]);
		expect(merged.map((model) => model.id)).toEqual(["e2", "e1", "a", "b"]);
		expect(merged.find((model) => model.id === "b")).toMatchObject({
			name: "B (enterprise)",
			maxOutputTokens: 1,
		});
	});

	it("keeps every model when there is no cli agent", () => {
		expect(
			mergeCatalog({ models: config.models }, []).map((model) => model.id),
		).toEqual(["a", "b", "img"]);
	});
});

describe("thinking levels", () => {
	it("defaults to the CLI picker list without ultracode", () => {
		expect(supportedEfforts({ id: "m" })).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("honours declared supportedEfforts and thinkingLevelMap like resolveSupportedEfforts", () => {
		expect(
			supportedEfforts({
				id: "m",
				reasoning: { supportedEfforts: ["low", "high", "ultracode"] },
			}),
		).toEqual(["low", "high"]);
		expect(
			supportedEfforts({ id: "m", thinkingLevelMap: { low: "l", xhigh: "x" } }),
		).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("maps levels for pi and omp", () => {
		const model = toProviderModel(
			{
				id: "glm-5.3",
				name: "GLM-5.3",
				credits: "x0.79 credits",
				maxInputTokens: 1_000_000,
				maxOutputTokens: 48_000,
				supportsImages: true,
				supportsReasoning: true,
				reasoning: { effort: "medium" },
			},
			"https://acme.copilot.qq.com",
		) as Record<string, any>;
		expect(model).toMatchObject({
			name: "GLM-5.3 (x0.79 credits)",
			baseUrl: "https://acme.copilot.qq.com/v2",
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				xhigh: "xhigh",
				max: "max",
			},
			thinking: {
				mode: "effort",
				efforts: ["low", "medium", "high", "xhigh", "max"],
				defaultLevel: "medium",
				requiresEffort: false,
			},
			compat: {
				supportsReasoningEffort: true,
				reasoningDisableMode: "none-effort",
				maxTokensField: "max_tokens",
			},
		});
	});

	it("sends the model's own wire value when it declares a thinkingLevelMap", () => {
		const model = toProviderModel(
			{
				id: "m",
				supportsReasoning: true,
				thinkingLevelMap: { low: "lite", high: "deep" },
			},
			"https://x.copilot.qq.com",
		) as Record<string, any>;
		expect(model.thinkingLevelMap).toMatchObject({
			low: "lite",
			medium: "medium",
			high: "deep",
			xhigh: null,
		});
		expect(model.thinking.effortMap).toMatchObject({
			low: "lite",
			high: "deep",
		});
	});

	it("leaves non-reasoning models without thinking metadata", () => {
		const model = toProviderModel(
			{ id: "auto", name: "Auto", credits: "" },
			"https://x.copilot.qq.com",
		) as Record<string, any>;
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
		expect(model.thinkingLevelMap).toBeUndefined();
	});
});

describe("modelBaseUrl", () => {
	it("uses the gateway unless the model has its own url", () => {
		expect(modelBaseUrl({ id: "m" }, "https://x.copilot.qq.com")).toBe(
			"https://x.copilot.qq.com/v2",
		);
		expect(
			modelBaseUrl(
				{ id: "m", url: "https://llm.corp/v1/chat/completions/" },
				"https://x",
			),
		).toBe("https://llm.corp/v1");
		expect(
			modelBaseUrl({ id: "m", url: "https://llm.corp/v1" }, "https://x"),
		).toBe("https://llm.corp/v1");
		expect(
			modelBaseUrl(
				{
					id: "m",
					url: "https://llm.corp/v1/responses",
					api: "openai-responses",
				},
				"https://x",
			),
		).toBe("https://llm.corp/v1");
	});
});

describe("fetchRemoteModels", () => {
	afterEach(() => vi.unstubAllGlobals());

	const session = {
		endpoint: "https://acme.copilot.qq.com",
		accessToken: "t",
		enterpriseId: "acme",
	};

	it("merges enterprise models, caches the catalog and remembers routing metadata", async () => {
		const paths: string[] = [];
		vi.stubGlobal("fetch", async (input: string) => {
			const path = new URL(input).pathname;
			paths.push(path);
			if (path === "/v3/config") {
				return envelope({
					models: [{ id: "a" }],
					agents: [{ name: "cli", models: ["a"] }],
				});
			}
			return envelope([
				{ id: "own", tags: ["chat"], url: "https://llm.corp/v1", apiKey: "k" },
			]);
		});

		const models = await fetchRemoteModels(session);

		expect(paths.sort()).toEqual([
			"/console/enterprises/acme/config/models",
			"/v3/config",
		]);
		expect(models.map((model) => model.id)).toEqual(["own", "a"]);
		expect(remoteModel("own", session.endpoint)).toMatchObject({
			url: "https://llm.corp/v1",
			apiKey: "k",
		});
		expect(readModelCache(session.endpoint)).toMatchObject({
			fetchedAt: expect.any(Number),
			models: [{ id: "own" }, { id: "a" }],
		});
	});

	it("keeps identical model ids from different sites apart", async () => {
		vi.stubGlobal("fetch", async (input: string) =>
			new URL(input).host === "acme.copilot.qq.com"
				? envelope({
						models: [{ id: "shared", url: "https://cn-llm.corp/v1" }],
					})
				: envelope({
						models: [{ id: "shared", url: "https://intl-llm.corp/v1" }],
					}),
		);
		await fetchRemoteModels({
			endpoint: "https://acme.copilot.qq.com",
			accessToken: "t",
		});
		await fetchRemoteModels({
			endpoint: "https://www.codebuddy.ai",
			accessToken: "t2",
		});

		expect(remoteModel("shared", "https://acme.copilot.qq.com")?.url).toBe(
			"https://cn-llm.corp/v1",
		);
		expect(remoteModel("shared", "https://www.codebuddy.ai")?.url).toBe(
			"https://intl-llm.corp/v1",
		);
		expect(
			remoteModel("shared", "https://unknown.example.com"),
		).toBeUndefined();
	});

	it("still returns the base catalog when the enterprise endpoint fails", async () => {
		vi.stubGlobal("fetch", async (input: string) =>
			new URL(input).pathname === "/v3/config"
				? envelope({ models: [{ id: "a" }] })
				: new Response("forbidden", { status: 403 }),
		);
		expect((await fetchRemoteModels(session)).map((model) => model.id)).toEqual(
			["a"],
		);
	});

	it("fails when /v3/config reports an error", async () => {
		vi.stubGlobal("fetch", async () => envelope(undefined, 401));
		await expect(
			fetchRemoteModels({ ...session, enterpriseId: undefined }),
		).rejects.toThrow(/code 401/);
	});
});
