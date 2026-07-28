export const PI_SUBAGENT_APPEND_SYSTEM_PROMPT =
	"PI_SUBAGENT_APPEND_SYSTEM_PROMPT";

export interface AppendSystemInheritanceInput {
	inheritAppendSystem: boolean;
	systemPromptMode?: "append" | "replace";
	systemPrompt?: string;
	boundarySystemPrompt?: string;
}

export interface AppendSystemInheritancePlan {
	promptArgs: string[];
	env: Record<string, string>;
}

export function buildAppendSystemInheritancePlan(
	input: AppendSystemInheritanceInput,
): AppendSystemInheritancePlan {
	const generatedAppend = [
		input.systemPromptMode === "append" ? input.systemPrompt : undefined,
		input.boundarySystemPrompt,
	].filter((value): value is string => !!value);

	if (input.inheritAppendSystem) {
		const promptArgs =
			input.systemPromptMode === "replace" && input.systemPrompt
				? ["--system-prompt", input.systemPrompt]
				: [];
		return {
			promptArgs,
			env: {
				[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: generatedAppend.join("\n\n"),
			},
		};
	}

	const promptArgs: string[] = [];
	if (input.systemPromptMode && input.systemPrompt) {
		promptArgs.push(
			input.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			input.systemPrompt,
		);
	}
	if (input.boundarySystemPrompt) {
		promptArgs.push("--append-system-prompt", input.boundarySystemPrompt);
	}
	if (!promptArgs.includes("--append-system-prompt")) {
		promptArgs.push("--append-system-prompt", "");
	}
	return {
		promptArgs,
		env: { [PI_SUBAGENT_APPEND_SYSTEM_PROMPT]: "" },
	};
}
