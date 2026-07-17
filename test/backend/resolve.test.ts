import { assert, describe, it } from "../support/index.ts";
import { resolveSubagentBackend } from "../../src/backend/resolve.ts";

describe("subagent backend resolution", () => {
	it("uses local backend by default outside Paseo", () => {
		assert.deepEqual(resolveSubagentBackend({}), {
			kind: "local",
			preference: "unset",
			strictPaseo: false,
			reason: "no Paseo environment detected",
		});
	});

	it("uses strict Paseo backend when launched by Paseo", () => {
		assert.deepEqual(resolveSubagentBackend({ PASEO_AGENT_ID: "parent-1" }), {
			kind: "paseo",
			preference: "unset",
			strictPaseo: true,
			fallbackLocalOnUnavailable: false,
			parentAgentId: "parent-1",
			reason: "PASEO_AGENT_ID is set",
		});
	});

	it("lets explicit local override a Paseo environment", () => {
		assert.deepEqual(
			resolveSubagentBackend({
				PI_SUBAGENT_BACKEND: "local",
				PASEO_AGENT_ID: "parent-1",
			}),
			{
				kind: "local",
				preference: "local",
				strictPaseo: false,
				reason: "PI_SUBAGENT_BACKEND=local",
			},
		);
	});

	it("treats explicit paseo as strict even without a parent id", () => {
		assert.deepEqual(resolveSubagentBackend({ PI_SUBAGENT_BACKEND: "paseo" }), {
			kind: "paseo",
			preference: "paseo",
			strictPaseo: true,
			fallbackLocalOnUnavailable: false,
			reason: "PI_SUBAGENT_BACKEND=paseo",
		});
	});

	it("allows auto to fall back outside Paseo", () => {
		assert.deepEqual(resolveSubagentBackend({ PI_SUBAGENT_BACKEND: "auto" }), {
			kind: "local",
			preference: "auto",
			strictPaseo: false,
			reason: "PI_SUBAGENT_BACKEND=auto without PASEO_AGENT_ID",
		});
	});

	it("attempts Paseo with fallback when auto has a parent id", () => {
		assert.deepEqual(
			resolveSubagentBackend({
				PI_SUBAGENT_BACKEND: "auto",
				PASEO_AGENT_ID: "parent-1",
			}),
			{
				kind: "paseo",
				preference: "auto",
				strictPaseo: false,
				fallbackLocalOnUnavailable: true,
				parentAgentId: "parent-1",
				reason: "PI_SUBAGENT_BACKEND=auto with PASEO_AGENT_ID",
			},
		);
	});

	it("rejects invalid backend preferences", () => {
		assert.throws(
			() => resolveSubagentBackend({ PI_SUBAGENT_BACKEND: "mux" }),
			/Invalid PI_SUBAGENT_BACKEND/,
		);
	});
});
