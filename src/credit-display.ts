import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	accumulateMessage,
	collectSessionCredits,
	formatSessionCredits,
	roundCredit,
	type SessionCredits,
} from "./credits.ts";
import { lookupSession } from "./http.ts";
import { field } from "./json.ts";
import { PROVIDERS, providerById } from "./product.ts";
import {
	describeAccountQuota,
	formatAccountQuota,
	QuotaService,
	type QuotaState,
} from "./quota.ts";

const STATUS_KEY = "codebuddy-credits";
const AUTH_TIMEOUT_MS = 10_000;

function quotaText(state: QuotaState): string | undefined {
	if (state.status === "unavailable") return undefined;
	return `${formatAccountQuota(state.quota)}${state.status === "stale" ? " [stale]" : ""}`;
}

/** Session spend from per-request `usage.credit`, plus each logged-in account's billing-cycle quota. */
export function registerCreditDisplay(
	pi: ExtensionAPI,
	service = new QuotaService(),
): void {
	let refreshId = 0;
	// Identity of the account behind the active model, so the status line tracks the right quota.
	let activeIdentity: string | undefined;
	// Running credit tally: rebuilt once at session_start, then fed by each message_end
	// event. Rescanning the whole session per message would copy every entry each time.
	let credits: SessionCredits = { total: 0, charged: 0, unknown: 0 };
	const sum = { value: 0 };

	const rebuildCredits = (ctx: ExtensionContext) => {
		credits = { total: 0, charged: 0, unknown: 0 };
		sum.value = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (field(entry, "type") !== "message") continue;
			accumulateMessage(credits, sum, field(entry, "message"));
		}
	};

	const isActive = (ctx: ExtensionContext) =>
		/^codebuddy(-|$)/.test(ctx.model?.provider ?? "");

	const publish = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		credits.total = roundCredit(sum.value);
		if (!isActive(ctx) && credits.charged + credits.unknown === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const quota = activeIdentity
			? quotaText(service.peek(activeIdentity))
			: undefined;
		ctx.ui.setStatus(
			STATUS_KEY,
			[formatSessionCredits(credits), quota].filter(Boolean).join(" · "),
		);
	};

	const resolveSession = async (ctx: ExtensionContext) => {
		if (!isActive(ctx) || !ctx.model?.provider) return undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const token = await Promise.race([
				ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), AUTH_TIMEOUT_MS);
				}),
			]);
			const session = lookupSession(token);
			if (session) activeIdentity = QuotaService.identity(session);
			return session;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	};

	const refresh = async (ctx: ExtensionContext, force = false) => {
		const id = ++refreshId;
		publish(ctx);
		if (!isActive(ctx)) return;
		const session = await resolveSession(ctx);
		if (!session || id !== refreshId) return;
		await service.read(session, force);
		if (id === refreshId) publish(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		rebuildCredits(ctx);
		void refresh(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		accumulateMessage(credits, sum, event.message);
		publish(ctx);
	});
	pi.on("agent_end", (_event, ctx) => void refresh(ctx, true));
	// pi only; omp refreshes after the next turn instead.
	pi.on("model_select", (_event, ctx) => void refresh(ctx));

	pi.registerCommand("codebuddy-usage", {
		description:
			"Show CodeBuddy credits spent in this session and every logged-in account's billing-cycle quota",
		handler: async (_args, ctx) => {
			const credits = collectSessionCredits(ctx.sessionManager.getEntries());
			const lines = [
				formatSessionCredits(credits),
				`Charged requests: ${credits.charged}${credits.last !== undefined ? ` · last request: ${credits.last} credits` : ""}`,
			];
			const session = await resolveSession(ctx);
			if (!session) {
				lines.push("Account quota: not logged in to CodeBuddy.");
			} else {
				const provider = providerById(ctx.model?.provider);
				lines.push(`Account: ${provider?.label ?? ctx.model?.provider}`);
				const state = await service.read(session, true);
				if (state.status === "unavailable")
					lines.push(
						`Account quota unavailable: ${state.error ?? "unknown error"}`,
					);
				else {
					lines.push(...describeAccountQuota(state.quota));
					if (state.status === "stale")
						lines.push(
							`Refresh failed (${state.error}); showing the last snapshot.`,
						);
				}
			}
			// Every other stored account, snapshot only: reading them all would hammer the billing API.
			for (const site of PROVIDERS) {
				if (site.id === ctx.model?.provider) continue;
				try {
					const token = await ctx.modelRegistry.getApiKeyForProvider(site.id);
					const other = lookupSession(token);
					if (!other) continue;
					const state = service.peek(QuotaService.identity(other));
					const text = quotaText(state) ?? "quota not read yet";
					lines.push(`${site.label}: ${text}`);
				} catch {
					// Not logged in on this site, or the host could not resolve its credential.
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
			publish(ctx);
		},
	});
}
