export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a nested property of untrusted JSON, returning undefined wherever the shape does not match. */
export function field(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

/** Accepts finite numbers and numeric strings, which CodeBuddy uses interchangeably for amounts. */
export function numberField(
	value: unknown,
	...path: string[]
): number | undefined {
	const raw = field(value, ...path);
	const parsed =
		typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	return typeof parsed === "number" && Number.isFinite(parsed)
		? parsed
		: undefined;
}

export function stringField(
	value: unknown,
	...path: string[]
): string | undefined {
	const raw = field(value, ...path);
	return typeof raw === "string" && raw !== "" ? raw : undefined;
}

export function arrayField(value: unknown, ...path: string[]): unknown[] {
	const raw = field(value, ...path);
	return Array.isArray(raw) ? raw : [];
}
