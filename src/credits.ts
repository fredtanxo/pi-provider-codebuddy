import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type FetchFunction,
} from "@earendil-works/pi-ai";
import { field, numberField } from "./json.ts";
import { CODEBUDDY_API } from "./models.ts";
import { isCodeBuddyProvider } from "./product.ts";

/** Persisted on `AssistantMessage.usage` so session files keep per-request credit charges. */
export const CREDIT_USAGE_FIELD = "codebuddyCredit";

export interface CreditMeter {
	credit?: number;
}

function scanLine(line: string, meter: CreditMeter): void {
	if (!line.startsWith("data:") || !line.includes('"credit"')) return;
	try {
		const credit = numberField(JSON.parse(line.slice(5)), "usage", "credit");
		if (credit !== undefined) meter.credit = credit;
	} catch {
		// Not a JSON event; the host's own parser reports malformed streams.
	}
}

/** Passes the SSE body through untouched while recording `usage.credit`, which CodeBuddy adds to the final chunk. */
export function creditScanner(
	meter: CreditMeter,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = "";
	const scan = (text: string, flush: boolean) => {
		buffer += text;
		const lines = buffer.split(/\r?\n/);
		buffer = flush ? "" : (lines.pop() ?? "");
		for (const line of lines) scanLine(line, meter);
	};
	return new TransformStream({
		transform(chunk, controller) {
			scan(decoder.decode(chunk, { stream: true }), false);
			controller.enqueue(chunk);
		},
		flush() {
			scan(decoder.decode(), true);
		},
	});
}

export function creditFetch(
	meter: CreditMeter,
	base: FetchFunction = fetch,
): FetchFunction {
	return async (input, init) => {
		const response = await base(input, init);
		if (!response.body) return response;
		return new Response(response.body.pipeThrough(creditScanner(meter)), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/** Re-emits the host's events, stamping the final message with the credit the response reported. */
export function attachCredit(
	inner: AssistantMessageEventStream,
	meter: CreditMeter,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	const stamp = (message: AssistantMessage) => {
		if (meter.credit !== undefined)
			Object.assign(message.usage, { [CREDIT_USAGE_FIELD]: meter.credit });
	};
	const ZERO_USAGE: AssistantMessage["usage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	void (async () => {
		// Latest partial, kept so a forwarding failure can still emit a terminal error event.
		let partial: AssistantMessage | undefined;
		try {
			for await (const event of inner) {
				if (event.type === "done") stamp(event.message);
				else if (event.type === "error") stamp(event.error);
				else partial = event.partial;
				outer.push(event);
			}
		} catch (error) {
			// Without this the rejection is unhandled (terminates the host) and the
			// consumer's result() never settles, hanging the turn.
			const message: AssistantMessage = {
				...(partial ?? {
					role: "assistant",
					content: [],
					api: CODEBUDDY_API,
					provider: "codebuddy",
					model: "unknown",
					usage: ZERO_USAGE,
					timestamp: Date.now(),
				}),
				content: [],
				usage: partial?.usage ?? ZERO_USAGE,
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: partial?.timestamp ?? Date.now(),
			};
			outer.push({ type: "error", reason: "error", error: message });
		} finally {
			outer.end();
		}
	})();
	return outer;
}

export interface SessionCredits {
	/** Sum of reported charges, rounded like the CLI's `roundCredit`. */
	total: number;
	charged: number;
	/** CodeBuddy replies without a recorded charge (older sessions, failed requests). */
	unknown: number;
	last?: number;
}

/** Reads `credit` from the message's `usage`, where `attachCredit` stores it under `CREDIT_USAGE_FIELD`. */
export function messageCredit(message: unknown): number | undefined {
	return numberField(message, "usage", CREDIT_USAGE_FIELD);
}

/**
 * Adds one assistant message's charge to a running tally. `sum` carries the unrounded
 * total outside `credits`, so the published number stays rounded exactly like a full rescan.
 */
export function accumulateMessage(
	credits: SessionCredits,
	sum: { value: number },
	message: unknown,
): void {
	if (
		field(message, "role") !== "assistant" ||
		!isCodeBuddyProvider(field(message, "provider") as string)
	)
		return;
	const credit = messageCredit(message);
	if (credit === undefined) {
		credits.unknown++;
		return;
	}
	sum.value += credit;
	credits.charged++;
	credits.last = credit;
}

/** Sums charges across every CodeBuddy site provider, including the pre-multi-site "codebuddy" id. */
export function collectSessionCredits(
	entries: readonly unknown[],
): SessionCredits {
	const credits: SessionCredits = { total: 0, charged: 0, unknown: 0 };
	const sum = { value: 0 };
	for (const entry of entries) {
		if (field(entry, "type") !== "message") continue;
		accumulateMessage(credits, sum, field(entry, "message"));
	}
	credits.total = roundCredit(sum.value);
	return credits;
}

export function roundCredit(value: number): number {
	return Math.round(100 * value) / 100;
}

export function formatSessionCredits(credits: SessionCredits): string {
	const unknown = credits.unknown
		? ` (${credits.unknown} without charge info)`
		: "";
	return `CodeBuddy session: ${credits.total} credits${unknown}`;
}
