import {
	CLI_VERSION,
	deploymentType,
	enterpriseIdFromEndpoint,
	hostOf,
	IOA_DEFAULT_DOMAIN,
	IOA_DEFAULT_ENTERPRISE_ID,
	isIOADomain,
	type NetworkEnvironment,
	networkEnvironment,
	PLATFORM,
} from "./product.ts";

export interface CodeBuddySession {
	endpoint: string;
	accessToken: string;
	/** Login domain returned with the token; defaults to the endpoint host. */
	domain?: string;
	/** Only iOA needs to be carried explicitly; every other environment is derivable from the domain. */
	environment?: Extract<NetworkEnvironment, "iOA">;
	uid?: string;
	enterpriseId?: string;
}

export interface Envelope<T> {
	code?: number;
	msg?: string;
	requestId?: string;
	data?: T;
}

export class HttpError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export async function requestEnvelope<T>(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Envelope<T>> {
	const response = await fetch(url, { ...init, signal });
	const text = await response.text();
	const path = new URL(url).pathname;
	let body: Envelope<T>;
	try {
		body = JSON.parse(text) as Envelope<T>;
	} catch {
		throw new HttpError(
			`CodeBuddy ${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
			response.status,
		);
	}
	if (!response.ok) {
		throw new HttpError(
			`CodeBuddy ${path} returned HTTP ${response.status}: ${body.msg ?? text.slice(0, 200)}`,
			response.status,
		);
	}
	return body;
}

export function sessionDomain(session: CodeBuddySession): string {
	if (session.domain) return session.domain;
	// iOA shares the internal endpoint, so the host alone routes to the wrong gateway domain.
	if (session.environment === "iOA") return IOA_DEFAULT_DOMAIN;
	return hostOf(session.endpoint);
}

export function sessionEnterpriseId(
	session: CodeBuddySession,
): string | undefined {
	return session.enterpriseId || enterpriseIdFromEndpoint(session.endpoint);
}

/** Headers the CLI's axios interceptors attach to every authenticated request. */
export function identityHeaders(
	session: CodeBuddySession,
): Record<string, string> {
	const domain = sessionDomain(session);
	const environment = session.environment ?? networkEnvironment(domain);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${session.accessToken}`,
		"X-Domain": domain,
		"X-Product": deploymentType(session.endpoint, networkEnvironment(domain)),
		"X-IDE-Type": PLATFORM,
		"X-IDE-Name": PLATFORM,
		"X-IDE-Version": CLI_VERSION,
		"User-Agent": `${PLATFORM}/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
	};
	if (session.uid) headers["X-User-Id"] = session.uid;
	const enterpriseId = sessionEnterpriseId(session);
	if (enterpriseId) {
		headers["X-Enterprise-Id"] = enterpriseId;
		headers["X-Tenant-Id"] = enterpriseId;
	} else if (environment === "iOA") {
		// The CLI's applyIOADefaultHeaders: iOA requests without an enterprise still route
		// through the default enterprise tenant.
		headers["X-Enterprise-Id"] = IOA_DEFAULT_ENTERPRISE_ID;
		headers["X-Tenant-Id"] = IOA_DEFAULT_ENTERPRISE_ID;
	}
	return headers;
}

/** GETs an authenticated endpoint and unwraps the `{ code, msg, data }` envelope. */
export async function getData<T>(
	session: CodeBuddySession,
	path: string,
	signal?: AbortSignal,
): Promise<T | undefined> {
	const body = await requestEnvelope<T>(
		`${session.endpoint}${path}`,
		{ headers: identityHeaders(session) },
		signal,
	);
	if (body.code !== 0)
		throw new Error(
			`CodeBuddy ${path} failed (code ${body.code}): ${body.msg ?? "unknown error"}`,
		);
	return body.data;
}

/** UUIDv7 without hyphens, the CLI's format for `X-Request-ID`. */
export function uuidv7Hex(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const ts = BigInt(Date.now());
	for (let i = 0; i < 6; i++)
		bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hosts hand streams and model fetches only the access token, so identity is looked up by token. */
const sessionsByToken = new Map<string, CodeBuddySession>();

export function rememberSession(session: CodeBuddySession): void {
	sessionsByToken.set(session.accessToken, session);
}

export function lookupSession(
	accessToken: string | undefined,
): CodeBuddySession | undefined {
	if (!accessToken) return undefined;
	const known = sessionsByToken.get(accessToken);
	if (known) return known;
	const recovered = sessionFromJwt(accessToken);
	if (recovered) sessionsByToken.set(accessToken, recovered);
	return recovered;
}

/**
 * omp hands `fetchDynamicModels` the raw stored token without calling `getApiKey`,
 * so the session is recovered from the JWT claims (`iss` origin, `sub`, `enterprise_id`).
 */
export function sessionFromJwt(
	accessToken: string,
): CodeBuddySession | undefined {
	try {
		const claims = JSON.parse(
			Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		) as {
			iss?: string;
			sub?: string;
			enterprise_id?: string;
		};
		if (!claims.iss) return undefined;
		const issuer = new URL(claims.iss);
		return {
			endpoint: issuer.origin,
			accessToken,
			uid: claims.sub,
			enterpriseId: claims.enterprise_id || undefined,
			// iOA tokens issued from an SSO domain carry no other marker (see test/http.test.ts).
			environment: isIOADomain(issuer.hostname) ? "iOA" : undefined,
		};
	} catch {
		return undefined;
	}
}
