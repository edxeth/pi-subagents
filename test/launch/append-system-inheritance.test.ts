import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAppendSystemInheritancePlan, PI_SUBAGENT_APPEND_SYSTEM_PROMPT } from "../../src/launch/append-system.ts";
import { getPersistedPromptLaunchArgs } from "../../src/launch/prep.ts";

const BOUNDARY = "Child boundary instructions.";

describe("APPEND_SYSTEM inheritance launch policy", () => {
	it("suppresses discovered APPEND_SYSTEM content by default", () => {
		assert.deepEqual(buildAppendSystemInheritancePlan({ inheritAppendSystem: false }), {
			promptArgs: ["--append-system-prompt", ""],
			env: { [PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: "" },
		});
	});

	it("leaves native Pi discovery untouched when inheritance is enabled", () => {
		assert.deepEqual(buildAppendSystemInheritancePlan({ inheritAppendSystem: true }), {
			promptArgs: [],
			env: { [PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: "" },
		});
	});

	it("preserves append-mode identity and boundary without replacing native discovery", () => {
		assert.deepEqual(
			buildAppendSystemInheritancePlan({
				inheritAppendSystem: true,
				systemPromptMode: "append",
				systemPrompt: "Reviewer identity.",
				boundarySystemPrompt: BOUNDARY,
			}),
			{
				promptArgs: [],
				env: {
					[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: `Reviewer identity.\n\n${BOUNDARY}`,
				},
			},
		);
	});

	it("keeps replace-mode identity native while injecting only additional child text", () => {
		assert.deepEqual(
			buildAppendSystemInheritancePlan({
				inheritAppendSystem: true,
				systemPromptMode: "replace",
				systemPrompt: "Reviewer identity.",
				boundarySystemPrompt: BOUNDARY,
			}),
			{
				promptArgs: ["--system-prompt", "Reviewer identity."],
				env: {
					[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: BOUNDARY,
				},
			},
		);
	});

	it("restores the same policy when resuming child sessions", () => {
		assert.deepEqual(getPersistedPromptLaunchArgs(undefined), ["--append-system-prompt", ""]);
		assert.deepEqual(
			getPersistedPromptLaunchArgs({
				inheritAppendSystem: true,
				systemPromptMode: "append",
				systemPrompt: "Reviewer identity.",
				boundarySystemPrompt: true,
			} as any),
			[],
		);
	});

	it("uses Pi append flags when inheritance is disabled", () => {
		assert.deepEqual(
			buildAppendSystemInheritancePlan({
				inheritAppendSystem: false,
				systemPromptMode: "append",
				systemPrompt: "Reviewer identity.",
				boundarySystemPrompt: BOUNDARY,
			}),
			{
				promptArgs: ["--append-system-prompt", "Reviewer identity.", "--append-system-prompt", BOUNDARY],
				env: { [PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: "" },
			},
		);
	});
});
