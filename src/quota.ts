import { roundCredit } from "./credits.ts";
import { type CodeBuddySession, identityHeaders, requestEnvelope, sessionEnterpriseId } from "./http.ts";
import { arrayField, field, numberField, stringField } from "./json.ts";

/** Billing-cycle credit totals, as the CodeBuddy web console's usage page computes them. */
export interface AccountQuota {
  kind: "enterprise" | "personal";
  used: number;
  /** Undefined when the enterprise grants unlimited credits. */
  limit?: number;
  cycleStart?: string;
  cycleEnd?: string;
  resetAt?: string;
}

const PACKAGE_STATUS_VALID = 0;
const PACKAGE_STATUS_USED_UP = 3;
const CAPACITY_TYPE_SLICE = 4;
const UNLIMITED = -1;

/**
 * Both resource-package endpoints reject requests without an explicit package-code
 * list ("PackageCodes required"), so the web console's full commodity-code table is
 * sent: base plans, trials, top-ups and bonus packs. The API only returns packs the
 * account actually owns, so an exhaustive list behaves like the web's totals.
 */
const PACKAGE_CODES = [
  "TCACA_code_001_PqouKr6QWV", // free (trial)
  "TCACA_code_002_AkiJS3ZHF5", // pro monthly
  "TCACA_code_003_FAnt7lcmRT", // pro yearly
  "TCACA_code_006_DbXS0lrypC", // gift pack
  "TCACA_code_007_nzdH5h4Nl0", // activity pack
  "TCACA_code_008_cfWoLwvjU4", // free monthly (experience plan)
  "TCACA_code_009_0XmEQc2xOf", // legacy top-up
  "TCACA_code_023_4xbGhMrE6q",
  "TCACA_code_026_BaESVICNoi",
  "TCACA_code_027_0FCGVA6vSa",
  "TCACA_code_028_NtpWi0jzXs", // version bonus
  "TCACA_code_029_6wCGEWquYy", // failure compensation
  "TCACA_code_030_BjSt89qTvr", // new-user bonus
  "TCACA_code_035_ArVxJcGDsm", // free subscription
  "TCACA_code_036_lupO5WgNdG", // 500-credit top-up
  "TCACA_code_037_WxOD3MpI2o", // version bonus
  "TCACA_code_038_OhvqZtiPKr", // custom top-up
  "TCACA_code_039_KRcQj7wUat", // pro trial monthly
  "TCACA_code_040_mi9rCYg46x", // pro trial yearly
  "TCACA_code_043_6oIkxT7Z0S",
  "TCACA_code_043_6olxxT7Z0S",
  "TCACA_code_044_JRZ9sYCgua", // 200-credit top-up
  "TCACA_code_045_JuyAXGlovx", // 5000-credit top-up
  "TCACA_code_046_LfNpbzEa5X", // 10000-credit top-up
];

async function postBilling(
  session: CodeBuddySession,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const envelope = await requestEnvelope<unknown>(
    `${session.endpoint}/billing/meter/${path}`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(session),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (envelope.code !== 0)
    throw new Error(`CodeBuddy ${path} failed (code ${envelope.code}): ${envelope.msg ?? "unknown error"}`);
  return envelope.data;
}

/** The web console's enterprise card: monthly allowance plus an optional exclusive gift pack. */
export function parseEnterpriseUsage(data: unknown): AccountQuota {
  const limitNum = numberField(data, "limitNum");
  const unlimited = limitNum === UNLIMITED;
  const hasGift = field(data, "exclusiveGift", "hasGift") === true;
  const giftUsed = hasGift ? (numberField(data, "exclusiveGift", "usedCredits") ?? 0) : 0;
  const giftTotal = hasGift ? (numberField(data, "exclusiveGift", "totalCredits") ?? 0) : 0;
  return {
    kind: "enterprise",
    used: roundCredit((numberField(data, "credit") ?? 0) + giftUsed),
    limit: unlimited || limitNum === undefined ? undefined : roundCredit(limitNum + giftTotal),
    cycleStart: stringField(data, "cycleStartTime"),
    cycleEnd: stringField(data, "cycleEndTime"),
    resetAt: stringField(data, "cycleResetTime") ?? stringField(data, "cycleEndTime"),
  };
}

/** Daily-slice packs report today's slice; every other pack reports its billing cycle. */
function packageCapacity(account: unknown): { total: number; left: number } | undefined {
  const status = numberField(account, "Status");
  if (status !== PACKAGE_STATUS_VALID && status !== PACKAGE_STATUS_USED_UP) return undefined;
  const today =
    numberField(account, "CapacityType") === CAPACITY_TYPE_SLICE
      ? arrayField(account, "SlicePeriodUsageDetails")[0]
      : undefined;
  const total = today
    ? numberField(today, "SlicePeriodCapacitySizePrecise")
    : numberField(account, "CycleCapacitySizePrecise");
  const left = today
    ? numberField(today, "SlicePeriodCapacityRemainPrecise")
    : numberField(account, "CycleCapacityRemainPrecise");
  return total === undefined || left === undefined ? undefined : { total, left };
}

export function parsePersonalPackages(...responses: unknown[]): AccountQuota {
  let total = 0;
  let left = 0;
  for (const data of responses) {
    for (const account of arrayField(data, "Accounts")) {
      const capacity = packageCapacity(account);
      if (!capacity) continue;
      total += capacity.total;
      left += capacity.left;
    }
  }
  return {
    kind: "personal",
    used: roundCredit(total - left),
    limit: roundCredit(total),
  };
}

function localDateTime(date: Date, endOfDay: boolean): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

export async function fetchAccountQuota(session: CodeBuddySession, signal?: AbortSignal): Promise<AccountQuota> {
  if (sessionEnterpriseId(session)) {
    return parseEnterpriseUsage(await postBilling(session, "get-enterprise-user-usage", {}, signal));
  }
  const now = new Date();
  const [paid, free] = await Promise.all([
    postBilling(
      session,
      "get-user-resource-paid-packages",
      {
        PageNumber: 1,
        PageSize: 200,
        Status: [PACKAGE_STATUS_VALID, PACKAGE_STATUS_USED_UP],
        PackageCodes: PACKAGE_CODES,
      },
      signal,
    ),
    postBilling(
      session,
      "get-user-resource-free-packages",
      {
        PageNumber: 1,
        PageSize: 200,
        Status: [PACKAGE_STATUS_VALID],
        PackageCodes: PACKAGE_CODES,
        SlicePeriodStartTime: localDateTime(now, false),
        SlicePeriodEndTime: localDateTime(now, true),
      },
      signal,
    ),
  ]);
  return parsePersonalPackages(paid, free);
}

export function formatAccountQuota(quota: AccountQuota): string {
  const allowance = quota.limit === undefined ? "unlimited" : `${quota.limit}`;
  return `CodeBuddy cycle: ${quota.used} / ${allowance} credits`;
}

export function describeAccountQuota(quota: AccountQuota): string[] {
  const lines = [formatAccountQuota(quota)];
  if (quota.limit !== undefined && quota.limit > 0) {
    lines.push(
      `Remaining: ${roundCredit(Math.max(0, quota.limit - quota.used))} credits (${((quota.used / quota.limit) * 100).toFixed(1)}% used)`,
    );
  }
  if (quota.cycleStart && quota.cycleEnd) lines.push(`Cycle: ${quota.cycleStart} – ${quota.cycleEnd}`);
  if (quota.resetAt) lines.push(`Resets: ${quota.resetAt}`);
  return lines;
}

export type QuotaState =
  | { status: "unavailable"; error?: string }
  | { status: "fresh" | "stale"; quota: AccountQuota; error?: string };

/** Caches every account's quota so status refreshes after every turn do not hammer the billing API. */
export class QuotaService {
  private states = new Map<string, QuotaState>();
  private checkedAt = new Map<string, number>();
  private pending = new Map<string, Promise<QuotaState>>();
  private readonly fetchQuota: typeof fetchAccountQuota;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(fetchQuota = fetchAccountQuota, ttlMs = 60_000, now: () => number = Date.now) {
    this.fetchQuota = fetchQuota;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Token refreshes keep the account; only a different endpoint or user resets the snapshot. */
  static identity(session: CodeBuddySession): string {
    return `${session.endpoint}|${session.uid ?? ""}|${sessionEnterpriseId(session) ?? ""}`;
  }

  peek(identity: string): QuotaState {
    return this.states.get(identity) ?? { status: "unavailable" };
  }

  read(session: CodeBuddySession, force = false): Promise<QuotaState> {
    const identity = QuotaService.identity(session);
    const state = this.peek(identity);
    const checkedAt = this.checkedAt.get(identity);
    const inflight = this.pending.get(identity);
    if (inflight) return inflight;
    if (!force && checkedAt !== undefined && this.now() - checkedAt < this.ttlMs) return Promise.resolve(state);
    const request = this.fetchQuota(session, AbortSignal.timeout(10_000))
      .then((quota): QuotaState => ({ status: "fresh", quota }))
      .catch((error: unknown): QuotaState => {
        const message = error instanceof Error ? error.message : String(error);
        return state.status === "unavailable"
          ? { status: "unavailable", error: message }
          : { status: "stale", quota: state.quota, error: message };
      })
      .then((next) => {
        if (QuotaService.identity(session) === identity) {
          this.states.set(identity, next);
          this.checkedAt.set(identity, this.now());
          this.pending.delete(identity);
        }
        return next;
      });
    this.pending.set(identity, request);
    return request;
  }
}
