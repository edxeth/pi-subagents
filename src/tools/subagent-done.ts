/**
 * Extension loaded into sub-agents.
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */

import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	findLatestAssistantError,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "../auto-exit.ts";
import { areSubagentSessionTitlesDisabled } from "../agents/titles.ts";
import {
	CALLER_PING_TOOL_NAME,
	SUBAGENT_DONE_TOOL_NAME,
} from "./tool-names.ts";

const require = createRequire(import.meta.url);

function applySubagentSessionTitle(
	ctx:
		| {
				sessionManager?: {
					getHeader?: () => unknown;
					getSessionName?: () => string | undefined;
				};
			}
		| undefined,
	pi: ExtensionAPI,
) {
	if (areSubagentSessionTitlesDisabled()) return;

	const title = process.env.PI_SUBAGENT_SESSION_TITLE?.trim();
	if (!title) return;

	const header = ctx?.sessionManager?.getHeader?.() as
		| { name?: string }
		| null
		| undefined;
	if (header && header.name !== title) header.name = title;

	if (ctx?.sessionManager?.getSessionName?.() === title) return;
	pi.setSessionName(title);
}

function isMissingOptionalDependency(error: unknown, id: string): boolean {
	const maybeError = error as { code?: unknown; message?: unknown } | null;
	const message =
		typeof maybeError?.message === "string" ? maybeError.message : "";
	const code = maybeError?.code;
	return (
		(code === "MODULE_NOT_FOUND" || code == null) &&
		(message.includes("Cannot find module") ||
			message.includes("Cannot find package")) &&
		message.includes(id)
	);
}

export function isMissingOptionalDependencyForTest(
	error: unknown,
	id: string,
): boolean {
	return isMissingOptionalDependency(error, id);
}

function optionalRequire(id: string): unknown | null {
	try {
		return require(id);
	} catch (error) {
		if (isMissingOptionalDependency(error, id)) {
			return null;
		}
		throw error;
	}
}

export function getDeniedToolNames(
	autoExit: boolean,
	deniedEnv = process.env.PI_DENY_TOOLS ?? "",
): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes(SUBAGENT_DONE_TOOL_NAME)) {
		denied.push(SUBAGENT_DONE_TOOL_NAME);
	}
	return denied;
}

export function filterToolNames(
	toolNames: string[],
	deniedTools: string[],
): string[] {
	const denied = new Set(deniedTools);
	const seen = new Set<string>();
	return toolNames.filter((name) => {
		if (!name || denied.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export function shouldRegisterSubagentDone(
	autoExit: boolean,
	deniedTools: string[],
	isInteractive = false,
): boolean {
	if (deniedTools.includes(SUBAGENT_DONE_TOOL_NAME)) return false;
	if (autoExit) return false;
	if (isInteractive) return false;
	return true;
}

type ToolControlAPI = Pick<
	ExtensionAPI,
	"getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool"
>;

type WidgetThemeLike = {
	bg(tone: string, text: string): string;
	bold(text: string): string;
	fg(tone: string, text: string): string;
};

export function installDeniedToolGuards(
	pi: ToolControlAPI,
	autoExit: boolean,
	onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
	const originalRegisterTool = pi.registerTool.bind(pi);
	const originalSetActiveTools = pi.setActiveTools.bind(pi);

	const notify = (activeTools: string[], deniedTools: string[]) => {
		onChange?.([...activeTools].sort(), [...deniedTools]);
	};

	const applyDeniedTools = (): string[] => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
		return allowedTools;
	};

	pi.setActiveTools = (toolNames: string[]) => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(toolNames, deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
	};

	pi.registerTool = (definition) => {
		const result = originalRegisterTool(definition);
		applyDeniedTools();
		return result;
	};

	return { applyDeniedTools };
}

export default function (pi: ExtensionAPI) {
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	const doneParams = typebox?.Type?.Object
		? typebox.Type.Object({})
		: { type: "object", properties: {}, additionalProperties: false };
	const callerPingParams = typebox?.Type?.Object
		? typebox.Type.Object({
				message: typebox.Type.String({
					description: "What you need help with",
				}),
			})
		: {
				type: "object",
				properties: {
					message: { type: "string", description: "What you need help with" },
				},
				required: ["message"],
				additionalProperties: false,
			};

	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const isInteractive = !!process.env.PI_SUBAGENT_SURFACE;
	const denied: string[] = getDeniedToolNames(autoExit);
	let outputTokens = 0;

	function requestShutdown(ctx: { shutdown: () => void }) {
		setTimeout(() => {
			try {
				ctx.shutdown();
			} catch {
				// Context may already be stale after session shutdown/reload.
			}
		}, 0);
	}

	function writeExitSignal(payload: object) {
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (!sessionFile) return;
		const exitFile = `${sessionFile}.exit`;
		if (existsSync(exitFile)) return;
		writeFileSync(exitFile, JSON.stringify(payload), "utf8");
	}

	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

	function enforceDeniedTools() {
		const deniedNames = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedNames);
		try {
			pi.setActiveTools(allowedTools);
		} catch {
			// Tools may not be ready yet
		}
	}

	pi.on("session_start", (_event, ctx) => {
		applySubagentSessionTitle(ctx, pi);

		enforceDeniedTools();
		setTimeout(() => enforceDeniedTools(), 0);
		setTimeout(() => enforceDeniedTools(), 250);

		// Register a widget callback so pi can re-render on resize
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: unknown, theme: WidgetThemeLike) => ({
				render: () => {
					const avail = Math.max(1, ((_tui as { terminal?: { columns?: number } })?.terminal?.columns ?? 80) - 1);

					// Build visible text first, truncate BEFORE ANSI wrapping
					const visibleLabel = subagentAgent
						? `${subagentName} (${subagentAgent})`
						: subagentName;
					const visiblePrefix = "▸ Agent ";

					let displayLabel = visibleLabel;
					if (visiblePrefix.length + visibleLabel.length > avail) {
						const maxLabel = Math.max(0, avail - visiblePrefix.length - 1);
						displayLabel = visibleLabel.slice(0, maxLabel) + "…";
					}

					// Split truncated label into name and suffix for different styling
					const nameLen = Math.min(subagentName.length, displayLabel.length);
					const styledName = theme.bold(displayLabel.slice(0, nameLen));
					const styledSuffix =
						nameLen < displayLabel.length
							? theme.fg("muted", displayLabel.slice(nameLen))
							: "";

					const line =
						`${theme.fg("accent", "▸")} ${theme.fg("accent", "Agent")} ${styledName}${styledSuffix}`;
					return [line];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("before_agent_start", () => {
		enforceDeniedTools();
	});

	pi.on("message_end", (event) => {
		const message = event.message as {
			role?: string;
			usage?: { output?: number };
		};
		if (message.role !== "assistant" || !message.usage) return;
		outputTokens += message.usage.output ?? 0;
	});

	// Every subagent child reports Pi shutdown through the session sidecar. This is
	// the primary lifecycle signal; mux/shell sentinels are only pane-death fallback.
	pi.on("session_shutdown", () => {
		writeExitSignal({ type: "done", outputTokens });
	});

	// Auto-exit: when the agent loop ends, shut down automatically.
	// If the user interrupts (Escape) or sends any input, auto-exit is disabled
	// for that cycle — the user wants to steer. Once they're done and the agent
	// completes normally again, auto-exit re-engages.
	// Enabled via `auto-exit: true` in agent frontmatter.
	if (autoExit) {
		let userTookOver = false;
		let agentStarted = false;

		pi.on("agent_start", () => {
			agentStarted = true;
			userTookOver = false;
		});

		pi.on("input", (event) => {
			// Ignore the initial task message that starts an autonomous subagent.
			// Inputs while streaming, queued follow-ups, or later manual prompts mean
			// the operator is steering and the child should stay open for that turn.
			if (!shouldMarkUserTookOver(agentStarted, event.streamingBehavior)) return;
			userTookOver = true;
		});

		pi.on("agent_end", (event, ctx) => {
			const messages = event.messages as Parameters<
				typeof shouldAutoExitOnAgentEnd
			>[0];
			const shouldExit = shouldAutoExitOnAgentEnd(messages);
			if (!shouldExit || userTookOver) {
				// Agent turn was aborted (Escape). Leave the session open for
				// inspection or another prompt.
				return;
			}

			// Surface stopReason: "error" (auto-retry exhausted, provider overload, etc.)
			// via the .exit sidecar so the watcher reports a clear failure instead of
			// mistaking the crash for a successful completion.
			const errorInfo = findLatestAssistantError(messages);
			if (errorInfo) {
				const sessionFile = process.env.PI_SUBAGENT_SESSION;
				if (sessionFile) {
					try {
						writeFileSync(
							`${sessionFile}.exit`,
							JSON.stringify({
								type: "error",
								errorMessage: errorInfo.errorMessage,
								stopReason: errorInfo.stopReason,
							}),
						);
					} catch {
						// Best effort — session-file fallback can still recover errorMessage.
					}
				}
			}

			writeExitSignal({ type: "done", outputTokens });
			requestShutdown(ctx);
		});
	}

	// caller_ping is registered for most agents as an escape hatch.
	// Only interactive agents with autoExit: false don't get it —
	// the operator is in the pane and can handle things directly.
	if (!isInteractive || autoExit) {
		pi.registerTool({
			name: CALLER_PING_TOOL_NAME,
			label: "Caller Ping",
			description:
				"Ask the launching chat for help, send your message there, then close this helper session. " +
				"The launching chat can later send follow-up instructions to continue this helper.",
			parameters: callerPingParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (!sessionFile) {
				throw new Error(
					"caller_ping is only available in subagent contexts. " +
						"PI_SUBAGENT_SESSION environment variable is not set.",
				);
			}

			writeExitSignal({
				type: "ping",
				name: process.env.PI_SUBAGENT_NAME ?? "subagent",
				message: params.message,
				outputTokens,
			});
			requestShutdown(ctx);
			return {
				content: [
					{ type: "text", text: "Ping sent. Parent will be notified." },
				],
				details: {},
			};
		},
	});
}

	if (shouldRegisterSubagentDone(autoExit, denied, isInteractive)) {
		pi.registerTool({
			name: SUBAGENT_DONE_TOOL_NAME,
			label: "Subagent Done",
			description:
				"Call this tool when you have completed your task. " +
				"It will close this session and return your results to the main session. " +
				"Your LAST assistant message before calling this becomes the summary returned to the caller.",
			parameters: doneParams,
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				writeExitSignal({ type: "done", outputTokens });
				requestShutdown(ctx);
				return {
					content: [{ type: "text", text: "Shutting down subagent session." }],
					details: {},
				};
			},
		});
	}
}
