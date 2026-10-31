import {
	type AssistantMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	attachCredit,
	CREDIT_USAGE_FIELD,
	type CreditMeter,
	collectSessionCredits,
	creditFetch,
	creditScanner,
	formatSessionCredits,
} from "../src/credits.ts";

async function scan(
	chunks: string[],
): Promise<{ meter: CreditMeter; text: string }> {
	const meter: CreditMeter = {};
	const encoder = new TextEncoder();
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	const text = await new Response(
		source.pipeThrough(creditScanner(meter)),
	).text();
	return { meter, text };
}

describe("creditScanner", () => {
	it("passes the body through and reads credit split across chunks", async () => {
		const body =
			'data: {"usage":null}\n\ndata: {"usage":{"total_tokens":3,"credit":0.07}}\n\ndata: [DONE]\n\n';
		const { meter, text } = await scan([
			body.slice(0, 40),
			body.slice(40, 55),
			body.slice(55),
		]);
		expect(text).toBe(body);
		expect(meter.credit).toBe(0.07);
	});

	it("accepts numeric strings and a final line without a newline", async () => {
		expect(
			(await scan(['data: {"usage":{"credit":"1.5"}}'])).meter.credit,
		).toBe(1.5);
	});

	it("leaves the meter empty when no chunk reports credit", async () => {
		expect(
			(
				await scan([
					'data: {"usage":{"credit":null}}\n',
					"data: not-json credit\n",
				])
			).meter.credit,
		).toBeUndefined();
	});
});

describe("collectSessionCredits", () => {
	const reply = (provider: string, usage: Record<string, unknown>) => ({
		type: "message",
		message: { role: "assistant", provider, usage },
	});

	it("sums replies from every CodeBuddy site provider and counts replies without charge info", () => {
		const credits = collectSessionCredits([
			reply("codebuddy", { codebuddyCredit: 0.1 }), // pre-multi-site transcripts
			reply("codebuddy-cn", { codebuddyCredit: 0.2 }),
			reply("codebuddy-intl", {}),
			reply("codebuddyfoo", { codebuddyCredit: 7 }), // different extension, not ours
			reply("qoder", { codebuddyCredit: 5 }),
			{ type: "message", message: { role: "user" } },
			{ type: "compaction" },
		]);
		expect(credits).toEqual({ total: 0.3, charged: 2, unknown: 1, last: 0.2 });
		expect(formatSessionCredits(credits)).toBe(
			"CodeBuddy session: 0.3 credits (1 without charge info)",
		);
	});
});

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "codebuddy",
		model: "glm",
		usage: { ...USAGE },
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("attachCredit", () => {
	it("stamps the persisted field onto the done message's usage", async () => {
		const meter: CreditMeter = { credit: 0.42 };
		const inner = createAssistantMessageEventStream();
		const outer = attachCredit(inner, meter);

		inner.push({ type: "done", reason: "stop", message: assistant() });
		inner.end();

		const done = await outer.result();
		expect(done.usage[CREDIT_USAGE_FIELD as keyof typeof done.usage]).toBe(
			0.42,
		);
	});

	it("stamps an error message and re-emits it so the turn settles", async () => {
		const meter: CreditMeter = { credit: 0.1 };
		const inner = createAssistantMessageEventStream();
		const outer = attachCredit(inner, meter);

		const failing = assistant({ stopReason: "error", errorMessage: "boom" });
		inner.push({ type: "error", reason: "error", error: failing });
		inner.end();

		await expect(outer.result()).resolves.toMatchObject({
			stopReason: "error",
			usage: { [CREDIT_USAGE_FIELD]: 0.1 },
		});
	});

	it("leaves usage untouched when the meter recorded no credit", async () => {
		const meter: CreditMeter = {};
		const inner = createAssistantMessageEventStream();
		const outer = attachCredit(inner, meter);

		inner.push({ type: "done", reason: "stop", message: assistant() });
		inner.end();

		const done = await outer.result();
		expect(
			done.usage[CREDIT_USAGE_FIELD as keyof typeof done.usage],
		).toBeUndefined();
	});
});

describe("creditFetch", () => {
	it("pipes the body through the scanner and preserves status and headers", async () => {
		const meter: CreditMeter = {};
		const body = 'data: {"usage":{"credit":0.99}}\n\n';
		const upstream = new Response(body, {
			status: 201,
			statusText: "Created",
			headers: { "Content-Type": "text/event-stream", "X-Test": "1" },
		});
		const fetchFn = creditFetch(meter, async () => upstream);
		const response = await fetchFn("https://example.com", {});

		expect(response.status).toBe(201);
		expect(response.headers.get("X-Test")).toBe("1");
		expect(await response.text()).toBe(body);
		expect(meter.credit).toBe(0.99);
	});

	it("returns the response untouched when it has no body", async () => {
		const meter: CreditMeter = {};
		const upstream = new Response(null, { status: 204 });
		const fetchFn = creditFetch(meter, async () => upstream);
		const response = await fetchFn("https://example.com", {});
		expect(response).toBe(upstream);
	});
});
