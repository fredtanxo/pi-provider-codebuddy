import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountQuota,
	describeAccountQuota,
	fetchAccountQuota,
	parseEnterpriseUsage,
	parsePersonalPackages,
	QuotaService,
} from "../src/quota.ts";
import { envelope } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("parseEnterpriseUsage", () => {
	it("reads the get-enterprise-user-usage response shape", () => {
		const quota = parseEnterpriseUsage({
			credit: 20.79,
			cycleStartTime: "2026-10-13 00:00:00",
			cycleEndTime: "2026-11-12 23:59:59",
			limitNum: 10000,
			cycleResetTime: "2026-11-13 00:00:00",
		});
		expect(quota).toEqual({
			kind: "enterprise",
			used: 20.79,
			limit: 10000,
			cycleStart: "2026-10-13 00:00:00",
			cycleEnd: "2026-11-12 23:59:59",
			resetAt: "2026-11-13 00:00:00",
		});
		expect(describeAccountQuota(quota)).toContain(
			"Remaining: 9979.21 credits (0.2% used)",
		);
	});

	it("treats limitNum -1 as unlimited and adds the exclusive gift pack like the web console", () => {
		expect(parseEnterpriseUsage({ credit: 5, limitNum: -1 })).toMatchObject({
			used: 5,
			limit: undefined,
		});
		expect(
			parseEnterpriseUsage({
				credit: 5,
				limitNum: 100,
				exclusiveGift: { hasGift: true, usedCredits: 2, totalCredits: 50 },
			}),
		).toMatchObject({ used: 7, limit: 150 });
		expect(
			parseEnterpriseUsage({
				credit: 5,
				limitNum: 100,
				exclusiveGift: { hasGift: false, totalCredits: 50 },
			}),
		).toMatchObject({ used: 5, limit: 100 });
	});
});

describe("parsePersonalPackages", () => {
	it("sums cycle packs and today's slice of daily packs, skipping refunded and expired ones", () => {
		const paid = {
			Accounts: [
				{
					Status: 0,
					CapacityType: 2,
					CycleCapacitySizePrecise: "1000",
					CycleCapacityRemainPrecise: "750.5",
				},
				{
					Status: 3,
					CapacityType: 2,
					CycleCapacitySizePrecise: "200",
					CycleCapacityRemainPrecise: "0",
				},
				{
					Status: 2,
					CapacityType: 2,
					CycleCapacitySizePrecise: "999",
					CycleCapacityRemainPrecise: "999",
				},
				{
					Status: 1,
					CapacityType: 2,
					CycleCapacitySizePrecise: "999",
					CycleCapacityRemainPrecise: "999",
				},
			],
		};
		const free = {
			Accounts: [
				{
					Status: 0,
					CapacityType: 4,
					CycleCapacitySizePrecise: "3000",
					SlicePeriodUsageDetails: [
						{
							SlicePeriodCapacitySizePrecise: "100",
							SlicePeriodCapacityRemainPrecise: "40",
						},
					],
				},
				{ Status: 0, CapacityType: 4 },
			],
		};
		expect(parsePersonalPackages(paid, free)).toEqual({
			kind: "personal",
			used: 509.5,
			limit: 1300,
		});
	});

	it("sums a cycle bonus pack plus a cycle-reporting slice-type plan pack", () => {
		const free = {
			Accounts: [
				{
					Status: 0,
					CapacityType: 1,
					PackageCode: "TCACA_code_030_BjSt89qTvr",
					CycleCapacitySizePrecise: "1500",
					CycleCapacityRemainPrecise: "1500",
				},
				{
					Status: 0,
					CapacityType: 4,
					PackageCode: "TCACA_code_008_cfWoLwvjU4",
					CycleCapacitySizePrecise: "500",
					CycleCapacityRemainPrecise: "494.05",
					// Slice-type pack reporting its billing cycle when no daily slice exists yet.
					CycleCapacityUsedPrecise: "5.95",
				},
			],
		};
		expect(parsePersonalPackages({ Accounts: [] }, free)).toEqual({
			kind: "personal",
			used: 5.95,
			limit: 2000,
		});
	});
});

describe("fetchAccountQuota", () => {
	function stubBilling(
		handler: (
			path: string,
			body: Record<string, unknown>,
			headers: Headers,
		) => Response,
	) {
		vi.stubGlobal("fetch", async (input: string, init: RequestInit) =>
			handler(
				new URL(input).pathname,
				JSON.parse(String(init.body)),
				new Headers(init.headers),
			),
		);
	}

	it("uses the enterprise usage endpoint for enterprise accounts", async () => {
		const calls: string[] = [];
		stubBilling((path, _body, headers) => {
			calls.push(path);
			expect(headers.get("x-enterprise-id")).toBe("acme");
			return envelope({ credit: 1, limitNum: 10 });
		});
		const quota = await fetchAccountQuota({
			endpoint: "https://acme.copilot.qq.com",
			accessToken: "t",
		});
		expect(calls).toEqual(["/billing/meter/get-enterprise-user-usage"]);
		expect(quota).toMatchObject({ kind: "enterprise", used: 1, limit: 10 });
	});

	it("queries paid and today's free packs for personal accounts", async () => {
		const bodies = new Map<string, Record<string, unknown>>();
		stubBilling((path, body) => {
			bodies.set(path, body);
			return envelope({ Accounts: [] });
		});
		await fetchAccountQuota({
			endpoint: "https://www.codebuddy.ai",
			accessToken: "t",
		});
		expect([...bodies.keys()].sort()).toEqual([
			"/billing/meter/get-user-resource-free-packages",
			"/billing/meter/get-user-resource-paid-packages",
		]);
		const free = bodies.get("/billing/meter/get-user-resource-free-packages");
		expect(free?.SlicePeriodStartTime).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
		expect(free?.SlicePeriodEndTime).toMatch(/^\d{4}-\d{2}-\d{2} 23:59:59$/);
		// Both endpoints reject requests without an explicit package-code list.
		expect(free?.PackageCodes).toEqual(
			expect.arrayContaining(["TCACA_code_002_AkiJS3ZHF5"]),
		);
		expect(
			bodies.get("/billing/meter/get-user-resource-paid-packages")
				?.PackageCodes,
		).toEqual(expect.arrayContaining(["TCACA_code_008_cfWoLwvjU4"]));
	});

	it("surfaces billing errors", async () => {
		stubBilling(() => envelope(undefined, 403));
		await expect(
			fetchAccountQuota({
				endpoint: "https://acme.copilot.qq.com",
				accessToken: "t",
			}),
		).rejects.toThrow(/code 403/);
	});
});

describe("QuotaService", () => {
	const quota: AccountQuota = { kind: "enterprise", used: 1, limit: 10 };
	const session = {
		endpoint: "https://acme.copilot.qq.com",
		accessToken: "t1",
		uid: "u",
	};

	it("caches within the TTL and refetches when forced or expired", async () => {
		let now = 0;
		const fetchQuota = vi.fn(async () => quota);
		const service = new QuotaService(fetchQuota, 1000, () => now);
		const identity = QuotaService.identity(session);

		await service.read(session);
		await service.read(session);
		expect(fetchQuota).toHaveBeenCalledTimes(1);
		await service.read(session, true);
		expect(fetchQuota).toHaveBeenCalledTimes(2);
		now = 2000;
		await service.read(session);
		expect(fetchQuota).toHaveBeenCalledTimes(3);
		expect(service.peek(identity)).toEqual({ status: "fresh", quota });
	});

	it("keeps the last snapshot as stale when a refresh fails", async () => {
		const fetchQuota = vi
			.fn(async () => quota)
			.mockRejectedValueOnce(new Error("boom"));
		const service = new QuotaService(fetchQuota, 0);

		expect(await service.read(session)).toEqual({
			status: "unavailable",
			error: "boom",
		});
		expect(await service.read(session)).toEqual({ status: "fresh", quota });
		fetchQuota.mockRejectedValueOnce(new Error("down"));
		expect(await service.read(session)).toEqual({
			status: "stale",
			quota,
			error: "down",
		});
	});

	it("deduplicates concurrent reads so only one fetch is in flight per account", async () => {
		let resolve!: (quota: AccountQuota) => void;
		const pending = new Promise<AccountQuota>((r) => {
			resolve = r;
		});
		const fetchQuota = vi.fn(() => pending);
		const service = new QuotaService(fetchQuota, 0);

		// Two concurrent reads for the same account must share one request.
		const first = service.read(session);
		const second = service.read(session);
		expect(fetchQuota).toHaveBeenCalledTimes(1);

		resolve(quota);
		expect(await first).toEqual({ status: "fresh", quota });
		expect(await second).toEqual({ status: "fresh", quota });
		expect(fetchQuota).toHaveBeenCalledTimes(1);

		// The pending slot is released once the request settles.
		await service.read(session);
		expect(fetchQuota).toHaveBeenCalledTimes(2);
	});

	it("keeps the snapshot across token refreshes but not across accounts", async () => {
		const service = new QuotaService(async () => quota, 60_000);
		await service.read(session);

		const identity = QuotaService.identity(session);
		const refreshed = service.read({ ...session, accessToken: "t2" });
		expect(service.peek(identity).status).toBe("fresh");
		await refreshed;

		const otherSession = { ...session, uid: "someone-else" };
		void service.read(otherSession);
		expect(service.peek(QuotaService.identity(otherSession)).status).toBe(
			"unavailable",
		);
		// The first account's snapshot survives the second account's refresh.
		expect(service.peek(identity).status).toBe("fresh");
	});
});
