import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCreditDisplay } from "../src/credit-display.ts";
import { rememberSession } from "../src/http.ts";
import { type AccountQuota, QuotaService } from "../src/quota.ts";

const STATUS_KEY = "codebuddy-credits";

interface Handlers {
	[key: string]: (event: unknown, ctx: Record<string, unknown>) => void;
}

function makePi() {
	const handlers: Handlers = {};
	const commands = new Map<
		string,
		{ handler: (...args: unknown[]) => unknown }
	>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers[event] = handler as Handlers[string];
			return () => {};
		},
		registerCommand(
			name: string,
			options: { handler: (...args: unknown[]) => unknown },
		) {
			commands.set(name, options);
		},
	};
	return { pi, handlers, commands };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const entries: unknown[] = [];
	const setStatus = vi.fn();
	const notify = vi.fn();
	const getApiKeyForProvider = vi.fn();
	const ctx = {
		ui: { setStatus, notify },
		hasUI: true,
		sessionManager: { getEntries: () => entries },
		modelRegistry: { getApiKeyForProvider },
		model: { provider: "codebuddy-cn", id: "glm" },
		...overrides,
	};
	return { ctx, entries, setStatus, notify, getApiKeyForProvider };
}

const quota: AccountQuota = { kind: "enterprise", used: 1, limit: 10 };
const session = {
	endpoint: "https://acme.copilot.qq.com",
	accessToken: "tok",
	uid: "u",
	enterpriseId: "acme",
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("registerCreditDisplay", () => {
	it("rebuilds session credits on session_start and publishes the tally", () => {
		const { pi, handlers } = makePi();
		registerCreditDisplay(pi as never);
		const { ctx, entries, setStatus } = makeCtx();
		entries.push(
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "codebuddy-cn",
					usage: { codebuddyCredit: 0.5 },
				},
			},
			{ type: "message", message: { role: "user" } },
		);

		handlers.session_start({}, ctx);

		const call = setStatus.mock.calls.find((c) => c[0] === STATUS_KEY);
		expect(call?.[1]).toContain("CodeBuddy session: 0.5 credits");
	});

	it("accumulates each message_end charge into the running tally", () => {
		const { pi, handlers } = makePi();
		registerCreditDisplay(pi as never);
		const { ctx, setStatus } = makeCtx();
		handlers.session_start({}, ctx);

		handlers.message_end(
			{
				message: {
					role: "assistant",
					provider: "codebuddy-cn",
					usage: { codebuddyCredit: 0.25 },
				},
			},
			ctx,
		);

		const call = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY).at(-1);
		expect(call?.[1]).toContain("CodeBuddy session: 0.25 credits");
	});

	it("clears the status line when the active model is not CodeBuddy and nothing was charged", () => {
		const { pi, handlers } = makePi();
		registerCreditDisplay(pi as never);
		const { ctx, setStatus } = makeCtx({ model: { provider: "qoder" } });

		handlers.session_start({}, ctx);

		const call = setStatus.mock.calls.find((c) => c[0] === STATUS_KEY);
		expect(call?.[1]).toBeUndefined();
	});

	it("appends the account quota once the active session resolves", async () => {
		const { pi, handlers } = makePi();
		const service = new QuotaService(async () => quota, 0);
		registerCreditDisplay(pi as never, service);
		rememberSession(session);
		const { ctx, getApiKeyForProvider, setStatus } = makeCtx();
		getApiKeyForProvider.mockResolvedValue("tok");

		handlers.session_start({}, ctx);
		await vi.waitFor(() => {
			const call = setStatus.mock.calls
				.filter((c) => c[0] === STATUS_KEY)
				.at(-1);
			expect(call?.[1]).toContain("CodeBuddy cycle: 1 / 10 credits");
		});
	});

	it("ignores a stale refresh that resolves after a newer one (refreshId guard)", async () => {
		const { pi, handlers } = makePi();
		const read = vi.fn(async () => ({ status: "fresh", quota }) as const);
		const service = {
			read,
			peek: vi.fn(() => ({ status: "unavailable" }) as const),
		};
		registerCreditDisplay(pi as never, service as never);
		rememberSession(session);
		const { ctx, getApiKeyForProvider } = makeCtx();
		let firstResolve!: (value: string) => void;
		let secondResolve!: (value: string) => void;
		const first = new Promise<string>((r) => {
			firstResolve = r;
		});
		const second = new Promise<string>((r) => {
			secondResolve = r;
		});
		getApiKeyForProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

		// Two events both trigger refresh; the first is still resolving its session.
		handlers.session_start({}, ctx);
		handlers.model_select({}, ctx);

		// The newer refresh resolves first and reads.
		secondResolve("tok");
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));

		// The stale refresh resolves later and must not read or publish again.
		firstResolve("tok");
		await Promise.resolve();
		await Promise.resolve();
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("times out api key resolution after 10s without reading quota", async () => {
		vi.useFakeTimers();
		const { pi, handlers } = makePi();
		const read = vi.fn();
		registerCreditDisplay(
			pi as never,
			{
				read,
				peek: vi.fn(),
			} as never,
		);
		const { ctx, getApiKeyForProvider } = makeCtx();
		getApiKeyForProvider.mockReturnValue(new Promise(() => {}));

		handlers.session_start({}, ctx);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(read).not.toHaveBeenCalled();
	});
});
