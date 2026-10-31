import { describe, expect, it } from "vitest";
import {
	identityHeaders,
	lookupSession,
	rememberSession,
	uuidv7Hex,
} from "../src/http.ts";
import { fakeJwt } from "./helpers.ts";

describe("identityHeaders", () => {
	it("sends enterprise headers only when an enterprise id exists", () => {
		const personal = identityHeaders({
			endpoint: "https://www.codebuddy.ai",
			accessToken: "t",
			uid: "u",
		});
		expect(personal["X-User-Id"]).toBe("u");
		expect(personal["X-Enterprise-Id"]).toBeUndefined();
		expect(personal["X-Product"]).toBe("SaaS");

		const selfHosted = identityHeaders({
			endpoint: "https://ai.corp.example.com",
			accessToken: "t",
		});
		expect(selfHosted["X-Product"]).toBe("Self-Hosted");
		expect(selfHosted["X-Domain"]).toBe("ai.corp.example.com");
	});

	it("falls back to the subdomain enterprise id", () => {
		const headers = identityHeaders({
			endpoint: "https://acme.copilot.qq.com",
			accessToken: "t",
		});
		expect(headers["X-Enterprise-Id"]).toBe("acme");
		expect(headers["X-Tenant-Id"]).toBe("acme");
		expect(headers["X-Product"]).toBe("Cloud-Hosted");
	});

	it("classifies by the login domain when it differs from the endpoint", () => {
		const headers = identityHeaders({
			endpoint: "https://ai.corp.example.com",
			domain: "acme.copilot.qq.com",
			accessToken: "t",
		});
		expect(headers["X-Domain"]).toBe("acme.copilot.qq.com");
		// The endpoint alone would be Self-Hosted; the cloud-hosted login domain wins.
		expect(headers["X-Product"]).toBe("Cloud-Hosted");
	});

	it("falls back to the iOA SSO domain and default enterprise for iOA sessions", () => {
		// iOA shares the internal endpoint, so only the explicit environment marks it.
		const headers = identityHeaders({
			endpoint: "https://copilot.tencent.com",
			accessToken: "t",
			environment: "iOA",
		});
		expect(headers["X-Domain"]).toBe("tencent.sso.copilot.tencent.com");
		expect(headers["X-Enterprise-Id"]).toBe("etahzsqej0n4");
		expect(headers["X-Tenant-Id"]).toBe("etahzsqej0n4");
	});

	it("keeps the server domain and enterprise id on iOA sessions when present", () => {
		const headers = identityHeaders({
			endpoint: "https://copilot.tencent.com",
			domain: "copilot.tencent.com",
			accessToken: "t",
			environment: "iOA",
			enterpriseId: "my-ent",
		});
		expect(headers["X-Domain"]).toBe("copilot.tencent.com");
		expect(headers["X-Enterprise-Id"]).toBe("my-ent");
		expect(headers["X-Tenant-Id"]).toBe("my-ent");
	});
});

describe("uuidv7Hex", () => {
	it("produces 32 hex chars with version 7 and RFC variant", () => {
		const id = uuidv7Hex();
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(id[12]).toBe("7");
		expect("89ab").toContain(id[16]);
	});
});

describe("lookupSession", () => {
	it("prefers sessions captured from credentials", () => {
		rememberSession({
			endpoint: "https://known.copilot.qq.com",
			accessToken: "known-token",
			uid: "u1",
		});
		expect(lookupSession("known-token")?.endpoint).toBe(
			"https://known.copilot.qq.com",
		);
	});

	it("recovers endpoint and identity from JWT claims", () => {
		const token = fakeJwt({
			iss: "https://acme.copilot.qq.com/auth/realms/copilot",
			sub: "uid-1",
			enterprise_id: "acme",
		});
		expect(lookupSession(token)).toMatchObject({
			endpoint: "https://acme.copilot.qq.com",
			uid: "uid-1",
			enterpriseId: "acme",
		});
		expect(lookupSession("not-a-jwt")).toBeUndefined();
		expect(lookupSession(undefined)).toBeUndefined();
	});

	it("marks sessions as iOA when the JWT issuer is an iOA SSO domain", () => {
		const token = fakeJwt({
			iss: "https://tencent.sso.copilot.tencent.com/auth/realms/copilot",
			sub: "uid-1",
		});
		expect(lookupSession(token)).toMatchObject({
			endpoint: "https://tencent.sso.copilot.tencent.com",
			environment: "iOA",
		});
		const internal = fakeJwt({
			iss: "https://copilot.tencent.com/auth/realms/copilot",
			sub: "uid-1",
		});
		expect(lookupSession(internal)?.environment).toBeUndefined();
	});
});
