import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Keeps the model cache out of the real ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "codebuddy-test-"));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir,
}));
