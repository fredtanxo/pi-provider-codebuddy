import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { type CodeBuddySession, getData, sessionEnterpriseId } from "./http.ts";

export const CODEBUDDY_API = "codebuddy-chat-completions";

const CACHE_FILE = "codebuddy-models-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
const DEFAULT_EFFORTS: readonly Effort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const RESPONSES_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);
const CHAT_TAG = "chat";

type Effort = (typeof VALID_EFFORTS)[number];

export interface RemoteModel {
	id: string;
	name?: string;
	credits?: string;
	tags?: string[];
	maxInputTokens?: number;
	maxOutputTokens?: number;
	supportsImages?: boolean;
	supportsToolCall?: boolean;
	supportsReasoning?: boolean;
	reasoning?: { effort?: string; supportedEfforts?: string[] };
	thinkingLevelMap?: Partial<Record<string, string | null>>;
	api?: string;
	url?: string;
	apiKey?: string;
	useCustomProtocol?: boolean;
}

interface RemoteConfig {
	models?: RemoteModel[];
	agents?: { name?: string; models?: string[] }[];
}

interface ModelCache {
	fetchedAt: number;
	models: RemoteModel[];
}

/** One file, one entry per site endpoint: identical model ids across sites must not collide. */
interface ModelCacheFile {
	endpoints: Record<string, ModelCache>;
}

const remoteModelsByEndpointAndId = new Map<string, RemoteModel>();

function cachePath(): string {
	return join(getAgentDir(), CACHE_FILE);
}

function remember(endpoint: string, models: RemoteModel[]): void {
	for (const model of models)
		remoteModelsByEndpointAndId.set(`${endpoint}|${model.id}`, model);
}

// Parsed once per process; writeModelCache keeps the snapshot current, so staleness
// checks and cached catalogs stop re-reading the file on every call.
let cacheFile: ModelCacheFile | undefined;
let cacheFileLoaded = false;

function readCacheFile(): ModelCacheFile | undefined {
	if (cacheFileLoaded) return cacheFile;
	cacheFileLoaded = true;
	try {
		const cache = JSON.parse(
			readFileSync(cachePath(), "utf8"),
		) as ModelCacheFile;
		if (cache.endpoints && typeof cache.endpoints === "object") {
			for (const [endpoint, entry] of Object.entries(cache.endpoints)) {
				if (entry && Array.isArray(entry.models))
					remember(endpoint, entry.models);
			}
			cacheFile = cache;
		}
	} catch {
		// Missing or corrupt cache: treated as absent until the next write.
	}
	return cacheFile;
}

export function readModelCache(endpoint: string): ModelCache | undefined {
	const cache = readCacheFile();
	const entry = cache?.endpoints[endpoint];
	if (!entry) return undefined;
	remember(endpoint, entry.models);
	return entry;
}

export function isModelCacheStale(endpoint: string): boolean {
	const entry = readModelCache(endpoint);
	return !entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function writeModelCache(endpoint: string, models: RemoteModel[]): void {
	// Best-effort: a read-only agent dir or full disk must not discard an
	// otherwise successful fetch; the in-memory catalog is already updated.
	try {
		const cache = readCacheFile() ?? { endpoints: {} };
		cache.endpoints[endpoint] = { fetchedAt: Date.now(), models };
		const path = cachePath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		cacheFile = cache;
		cacheFileLoaded = true;
	} catch {
		// The next successful fetch retries the write.
	}
}

/** Routing metadata (custom url/apiKey/api) for a model of one site, from the last fetch or the cache. */
export function remoteModel(
	id: string,
	endpoint: string,
): RemoteModel | undefined {
	if (remoteModelsByEndpointAndId.size === 0) readCacheFile();
	return remoteModelsByEndpointAndId.get(`${endpoint}|${id}`);
}

/** Cached catalog of one site for provider registration before or instead of a network refresh. */
export function cachedModels(endpoint: string): ProviderModelConfig[] {
	const entry = readModelCache(endpoint);
	return entry
		? entry.models.map((model) => toProviderModel(model, endpoint))
		: [];
}

async function fetchEnterpriseModels(
	session: CodeBuddySession,
	signal?: AbortSignal,
): Promise<RemoteModel[]> {
	const enterpriseId = sessionEnterpriseId(session);
	if (!enterpriseId) return [];
	try {
		const models = await getData<RemoteModel[]>(
			session,
			`/console/enterprises/${encodeURIComponent(enterpriseId)}/config/models`,
			signal,
		);
		return Array.isArray(models) ? models : [];
	} catch {
		return [];
	}
}

/**
 * The CLI's `ModelsProductProvider` + SmartMerge: enterprise models override `/v3/config`
 * entries by id, and enterprise models tagged `chat` join the `cli` agent's model list.
 */
export function mergeCatalog(
	config: RemoteConfig,
	enterpriseModels: RemoteModel[],
): RemoteModel[] {
	const byId = new Map<string, RemoteModel>();
	for (const model of config.models ?? [])
		if (model.id) byId.set(model.id, model);
	for (const model of enterpriseModels)
		if (model.id) byId.set(model.id, { ...byId.get(model.id), ...model });

	const cliModels = config.agents?.find(
		(agent) => agent.name === "cli",
	)?.models;
	const enterpriseChat = enterpriseModels
		.filter((model) => model.tags?.includes(CHAT_TAG))
		.map((model) => model.id);
	const allowed = cliModels
		? [
				...enterpriseChat.filter((id) => !cliModels.includes(id)).reverse(),
				...cliModels,
			]
		: undefined;
	if (!allowed) return [...byId.values()];
	return allowed
		.map((id) => byId.get(id))
		.filter((model): model is RemoteModel => model !== undefined);
}

export async function fetchRemoteModels(
	session: CodeBuddySession,
	signal?: AbortSignal,
): Promise<RemoteModel[]> {
	const [config, enterpriseModels] = await Promise.all([
		getData<RemoteConfig>(session, "/v3/config", signal),
		fetchEnterpriseModels(session, signal),
	]);
	const models = mergeCatalog(config ?? {}, enterpriseModels);
	remember(session.endpoint, models);
	writeModelCache(session.endpoint, models);
	return models;
}

function isEffort(value: unknown): value is Effort {
	return VALID_EFFORTS.includes(value as Effort);
}

/** The CLI's `resolveSupportedEfforts`, defaulting to its full picker list (low…max). */
export function supportedEfforts(model: RemoteModel): Effort[] {
	const declared = model.reasoning?.supportedEfforts;
	if (Array.isArray(declared)) return declared.filter(isEffort);
	const map = model.thinkingLevelMap;
	if (!map) return [...DEFAULT_EFFORTS];
	const top = map.max != null ? "max" : map.xhigh != null ? "xhigh" : "high";
	return VALID_EFFORTS.slice(0, VALID_EFFORTS.indexOf(top) + 1);
}

function wireEffort(model: RemoteModel, effort: Effort): string {
	return model.thinkingLevelMap?.[effort] ?? effort;
}

export function isResponsesApi(api: string | undefined): boolean {
	return api !== undefined && RESPONSES_APIS.has(api);
}

/** Base URL the OpenAI client appends `/chat/completions` or `/responses` to. */
export function modelBaseUrl(model: RemoteModel, endpoint: string): string {
	if (!model.url) return `${endpoint}/v2`;
	const suffix = isResponsesApi(model.api) ? "/responses" : "/chat/completions";
	let base = model.url
		.trim()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
	while (base.endsWith(suffix))
		base = base.slice(0, -suffix.length).replace(/\/+$/, "");
	return base;
}

export function toProviderModel(
	model: RemoteModel,
	endpoint: string,
): ProviderModelConfig {
	const reasoning = model.supportsReasoning === true;
	const efforts = reasoning ? supportedEfforts(model) : [];
	const credits = model.credits?.trim();
	const defaultEffort =
		isEffort(model.reasoning?.effort) &&
		efforts.includes(model.reasoning.effort)
			? model.reasoning.effort
			: undefined;
	const effortMap = Object.fromEntries(
		efforts.map((effort) => [effort, wireEffort(model, effort)]),
	);
	const config = {
		id: model.id,
		name: credits
			? `${model.name ?? model.id} (${credits})`
			: (model.name ?? model.id),
		api: CODEBUDDY_API,
		baseUrl: modelBaseUrl(model, endpoint),
		reasoning: reasoning && efforts.length > 0,
		input: model.supportsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.maxInputTokens ?? 128_000,
		maxTokens: model.maxOutputTokens ?? 16_000,
		// pi: level → reasoning_effort value; null marks a level unsupported, `off` sends "none" like the CLI.
		thinkingLevelMap:
			efforts.length > 0
				? {
						off: "none",
						...Object.fromEntries(
							VALID_EFFORTS.map((effort) => [
								effort,
								effortMap[effort] ?? null,
							]),
						),
					}
				: undefined,
		// omp: the same ladder for its effort-based thinking control. `requiresEffort: false` stops omp's
		// lineage rules from clamping "off" to the lowest effort; the server accepts "none".
		thinking:
			efforts.length > 0
				? {
						mode: "effort",
						efforts,
						defaultLevel: defaultEffort,
						effortMap,
						requiresEffort: false,
					}
				: undefined,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: efforts.length > 0,
			reasoningDisableMode: efforts.length > 0 ? "none-effort" : undefined,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
	return config as ProviderModelConfig;
}
