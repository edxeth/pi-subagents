import type { SessionEntryLike, SubagentParamsInput } from "../types.ts";

export function isSetTabTitleToolEnabled(): boolean {
	return process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1";
}

function areSubagentSessionTitlesDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_SESSION_TITLES === "1";
}

const MAX_SUBAGENT_SESSION_TITLE_DESCRIPTION = 72;
const MAX_SUBAGENT_SESSION_TITLE_WORDS = 15;

function sentenceCaseSubagentTitle(title: string): string {
	const words = title.split(/\s+/).filter(Boolean);
	const plainWords = words.filter((word) => /\p{L}/u.test(word));
	if (plainWords.length < 2) return title;

	const titleCaseWord =
		/^["'`([{]*\p{Lu}\p{Ll}+[\p{Ll}\p{N}'’-]*["'`\])},:;]*$/u;
	const titleCasedWords = plainWords.filter((word) => titleCaseWord.test(word));
	if (titleCasedWords.length / plainWords.length < 0.6) return title;

	let keptFirst = false;
	return title
		.split(/(\s+)/)
		.map((word) => {
			if (!titleCaseWord.test(word)) return word;
			if (!keptFirst) {
				keptFirst = true;
				return word;
			}
			return word.toLocaleLowerCase();
		})
		.join("");
}

function cleanSubagentSessionTitleDescription(raw: string): string {
	let title = raw
		.replace(/^[\'"`]+|[\'"`]+$/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[\p{Cf}]/gu, "")
		.trim();

	title = title
		.replace(/^(task|objective|goal|request|title)\s*:\s*/i, "")
		.replace(/\b(?:reply|respond)\s+(?:with\s+)?(?:just\s+)?ok\b.*$/i, "")
		.replace(/\s+/g, " ")
		.replace(/[.!?]+$/g, "")
		.trim();

	title = sentenceCaseSubagentTitle(title)
		.replace(/[.!?]+$/g, "")
		.trim();
	if (!title) return "";

	const words = title.split(/\s+/).filter(Boolean);
	if (words.length > MAX_SUBAGENT_SESSION_TITLE_WORDS) {
		title = words.slice(0, MAX_SUBAGENT_SESSION_TITLE_WORDS).join(" ");
	}
	if (title.length > MAX_SUBAGENT_SESSION_TITLE_DESCRIPTION) {
		title = title.slice(0, MAX_SUBAGENT_SESSION_TITLE_DESCRIPTION).trim();
		const lastSpace = title.lastIndexOf(" ");
		if (lastSpace > 18) title = title.slice(0, lastSpace).trim();
	}
	return title.replace(/[.!?]+$/g, "").trim();
}

function summarizeSubagentTaskForSessionTitle(task: string): string {
	const firstMeaningfulLine =
		task
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return cleanSubagentSessionTitleDescription(firstMeaningfulLine);
}

export function getSubagentDisplayTitle(
	params: Pick<SubagentParamsInput, "title" | "task">,
): string {
	return (
		cleanSubagentSessionTitleDescription(params.title ?? "") ||
		summarizeSubagentTaskForSessionTitle(params.task)
	);
}

export type SubagentTitleParams = Pick<
	SubagentParamsInput,
	"name" | "task" | "title"
> & { agent?: string };

export function buildSubagentSessionTitle(
	params: SubagentTitleParams,
): string | undefined {
	if (areSubagentSessionTitlesDisabled()) return undefined;
	const agentType = (params.agent ?? params.name).trim();
	if (!agentType) return undefined;
	const description = getSubagentDisplayTitle(params);
	return description
		? `[${agentType} agent] ${description}`
		: `[${agentType} agent]`;
}

export function getTerminalAssistantSummary(
	entries: SessionEntryLike[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") return null;
		if (message.stopReason === "toolUse") return null;
		const texts = (message.content ?? [])
			.filter(
				(block) =>
					block.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim() !== "",
			)
			.map((block) => block.text as string);
		return texts.length > 0 ? texts.join("\n") : null;
	}
	return null;
}

export function shouldReapStableTerminalSummary(
	running: Pick<{ autoExit?: boolean }, "autoExit">,
): boolean {
	return running.autoExit === true;
}
