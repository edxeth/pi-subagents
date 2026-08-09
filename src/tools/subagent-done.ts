/**
 * Extension loaded into sub-agents.
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */

import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	findLatestAssistantError,
	isOperatorInput,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "../auto-exit.ts";
import { PI_SUBAGENT_APPEND_SYSTEM_PROMPT } from "../launch/append-system.ts";
import { installSubagentContextReminders } from "./context-reminders.ts";
import { createExitSignalWriter } from "./exit-signal.ts";
import { type FinalContextSnapshot, getFinalContextSnapshot } from "./final-context-snapshot.ts";
import { ProviderErrorRecoveryController, resolveProviderRecoveryDelaysMs } from "./provider-error-recovery.ts";
import { registerSetTabTitleTool, shouldRegisterSetTabTitleTool } from "./set-tab-title.ts";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "./tool-names.ts";

const require = createRequire(import.meta.url);
const TOOL_BOUNDARY_RECOVERY_NUDGE = "continue";
const MAX_CONSECUTIVE_TOOL_BOUNDARY_ENDS = 3;

function endedAtToolUseBoundary(messages: unknown[] | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.stopReason !== "string") return false;
		return message.stopReason.replace(/[-_]/g, "").toLowerCase() === "tooluse";
	}
	return false;
}

function isMissingOptionalDependency(error: unknown, id: string): boolean {
	const maybeError = error as { code?: unknown; message?: unknown } | null;
	const message = typeof maybeError?.message === "string" ? maybeError.message : "";
	const code = maybeError?.code;
	return (
		(code === "MODULE_NOT_FOUND" || code == null) &&
		(message.includes("Cannot find module") || message.includes("Cannot find package")) &&
		message.includes(id)
	);
}

export function isMissingOptionalDependencyForTest(error: unknown, id: string): boolean {
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

export function getDeniedToolNames(autoExit: boolean, deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes(SUBAGENT_DONE_TOOL_NAME)) {
		denied.push(SUBAGENT_DONE_TOOL_NAME);
	}
	return denied;
}

export function filterToolNames(toolNames: string[], deniedTools: string[]): string[] {
	const denied = new Set(deniedTools);
	const seen = new Set<string>();
	return toolNames.filter((name) => {
		if (!name || denied.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export function shouldRegisterSubagentDone(autoExit: boolean, deniedTools: string[], isInteractive = false): boolean {
	if (deniedTools.includes(SUBAGENT_DONE_TOOL_NAME)) return false;
	if (autoExit) return false;
	if (isInteractive) return false;
	return true;
}

type ToolControlAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool">;

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
	let finalContextUsage: FinalContextSnapshot | undefined;
	const contextReminders = installSubagentContextReminders(pi);

	function requestShutdown(ctx: { shutdown: () => void }) {
		setTimeout(() => {
			try {
				ctx.shutdown();
			} catch {
				// Context may already be stale after session shutdown/reload.
			}
		}, 0);
	}

	const writeExitSignal = createExitSignalWriter({
		pi,
		getFinalContextUsage: () => finalContextUsage,
		hasDeliveredFinalWarning: () => contextReminders.hasDeliveredFinalWarning(),
	});

	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
	const recoveryStatusKey = "pi-subagent-recovery";
	const piRecoveryNoCompactionGraceMs = 180_000;
	const piRecoveryCompactionTimeoutMs = 180_000;
	const providerErrorRecovery = new ProviderErrorRecoveryController(
		{
			sendUserMessage: (message) => pi.sendUserMessage(message),
			requestShutdown,
			writeExitSignal,
			getOutputTokens: () => outputTokens,
			// Only interactive panes have a status bar worth updating; background
			// `pi -p` children have no operator watching and no TUI footer.
			showRecoveryCountdown: (ctx, message) => {
				if (isInteractive) ctx.ui.setStatus(recoveryStatusKey, message);
			},
			clearRecoveryCountdown: (ctx) => {
				if (isInteractive) ctx.ui.setStatus(recoveryStatusKey, undefined);
			},
		},
		{ recoveryDelaysMs: resolveProviderRecoveryDelaysMs() },
	);

	// The latest provider error whose recovery window has not yet been superseded
	// by a successful assistant turn. `session_shutdown` uses it to report a clean
	// failure when the process is about to exit before a delayed nudge can fire
	// (notably `pi -p` background children, which exit as soon as Pi's own retries
	// finish).
	let pendingProviderError: {
		errorMessage: string;
		stopReason: "error";
	} | null = null;
	type PendingPiRecovery = {
		token: number;
		errorMessage: string;
		stopReason: "error";
		ctx: Parameters<typeof requestShutdown>[0];
		timer?: ReturnType<typeof setTimeout>;
	};
	let pendingPiRecovery: PendingPiRecovery | null = null;
	let piRecoveryGeneration = 0;

	function cancelPendingPiRecovery() {
		piRecoveryGeneration++;
		if (pendingPiRecovery?.timer) clearTimeout(pendingPiRecovery.timer);
		pendingPiRecovery = null;
	}

	function failPendingPiRecovery(token: number) {
		const pending = pendingPiRecovery;
		if (!pending || pending.token !== token) return;
		pendingPiRecovery = null;
		writeExitSignal({
			type: "error",
			errorMessage: pending.errorMessage,
			stopReason: pending.stopReason,
			outputTokens,
		});
		requestShutdown(pending.ctx);
	}

	function armPiRecoveryFailureTimer(delayMs: number) {
		if (!pendingPiRecovery) return;
		const token = pendingPiRecovery.token;
		if (pendingPiRecovery.timer) clearTimeout(pendingPiRecovery.timer);
		const timer = setTimeout(() => failPendingPiRecovery(token), delayMs);
		timer.unref?.();
		pendingPiRecovery.timer = timer;
	}

	function deferToPiNativeRecovery(
		errorInfo: { errorMessage: string; stopReason: "error" },
		ctx: Parameters<typeof requestShutdown>[0],
	) {
		cancelPendingPiRecovery();
		pendingPiRecovery = { token: piRecoveryGeneration, ...errorInfo, ctx };
		armPiRecoveryFailureTimer(piRecoveryNoCompactionGraceMs);
	}

	function enforceDeniedTools() {
		try {
			const deniedNames = getDeniedToolNames(autoExit);
			const allowedTools = filterToolNames(pi.getActiveTools(), deniedNames);
			pi.setActiveTools(allowedTools);
		} catch {
			// Tools may not be ready yet, or the extension context may be stale after
			// session shutdown/reload while delayed startup guards are still pending.
		}
	}

	pi.on("session_start", (_event, ctx) => {
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
					const visibleLabel = subagentAgent ? `${subagentName} (${subagentAgent})` : subagentName;
					const visiblePrefix = "▸ Agent ";

					let displayLabel = visibleLabel;
					if (visiblePrefix.length + visibleLabel.length > avail) {
						const maxLabel = Math.max(0, avail - visiblePrefix.length - 1);
						displayLabel = visibleLabel.slice(0, maxLabel) + "…";
					}

					// Split truncated label into name and suffix for different styling
					const nameLen = Math.min(subagentName.length, displayLabel.length);
					const styledName = theme.bold(displayLabel.slice(0, nameLen));
					const styledSuffix = nameLen < displayLabel.length ? theme.fg("muted", displayLabel.slice(nameLen)) : "";

					const line = `${theme.fg("accent", "▸")} ${theme.fg("accent", "Agent")} ${styledName}${styledSuffix}`;
					return [line];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("before_agent_start", (event) => {
		enforceDeniedTools();
		const appendSystemPrompt = process.env[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]?.trim();
		if (!appendSystemPrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${appendSystemPrompt}`,
		};
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			stopReason?: string;
			usage?: { output?: number };
		};
		if (message.role !== "assistant") return;
		if (!message.usage) return;
		outputTokens += message.usage.output ?? 0;
		finalContextUsage = getFinalContextSnapshot(ctx) ?? finalContextUsage;
	});

	// Every subagent child reports Pi shutdown through the session sidecar. This is
	// the primary lifecycle signal; mux/shell sentinels are only pane-death fallback.
	// If the run ended on an unrecovered provider error, surface that instead of a
	// phony "done" so the parent learns it was a failure, not a clean completion.
	pi.on("session_shutdown", () => {
		providerErrorRecovery.cancelPendingRecovery();
		cancelPendingPiRecovery();
		if (pendingProviderError) {
			writeExitSignal({
				type: "error",
				errorMessage: pendingProviderError.errorMessage,
				stopReason: pendingProviderError.stopReason,
				outputTokens,
			});
			return;
		}
		// A shutdown is a lifecycle event, not the child deciding to stop.
		writeExitSignal({ type: "done", outputTokens }, { autonomous: false });
	});

	pi.on("session_before_compact", (event) => {
		const pending = pendingPiRecovery;
		if (!pending) return;
		if (event.reason !== "overflow" || !event.willRetry) return;
		armPiRecoveryFailureTimer(piRecoveryCompactionTimeoutMs);
		event.signal.addEventListener("abort", () => failPendingPiRecovery(pending.token), { once: true });
	});

	pi.on("session_compact", (event) => {
		if (!pendingPiRecovery) return;
		if (event.reason !== "overflow" || !event.willRetry) return;
		cancelPendingPiRecovery();
	});

	// Auto-exit: when the agent loop ends, shut down automatically.
	// If the user interrupts (Escape) or sends any input, auto-exit is
	// permanently disabled for the rest of the session — the operator has
	// taken over and the child stays open until closed or re-armed with
	// /auto-exit.
	// Enabled via `auto-exit: true` in agent frontmatter.
	const AUTO_EXIT_STATUS_KEY = "pi-subagent-auto-exit";
	if (autoExit) {
		let operatorInputQueuedThisRun = false;
		let autoExitDisabledByOperator = false;
		let autoExitReArmed = false;
		let agentStarted = false;
		let consecutiveToolBoundaryEnds = 0;
		let toolExecutionsThisTurn = 0;
		let terminatingToolExecutionsThisTurn = 0;

		const AUTO_EXIT_DISABLED_MSG = "Auto-exit disabled — close manually or /auto-exit to re-enable";
		// Single owner of the disabled latch and the operator-facing status/toast.
		// Called from the `input` handler (every qualifying operator input except the
		// one-shot /auto-exit re-arm) and the aborted `agent_end` branch (Escape fires
		// no input event). Notifying at the disable moment — not from an agent_end
		// branch gated on operatorInputQueuedThisRun, which a follow-up/idle prompt's
		// new agent_start clears — keeps follow-ups and idle prompts from going silent.
		const disableAutoExitByOperator = (
			ctx: { ui: { setStatus(key: string, message?: string): void; notify(message: string, tone?: string): void } },
		) => {
			autoExitDisabledByOperator = true;
			if (!isInteractive) return;
			ctx.ui.setStatus(AUTO_EXIT_STATUS_KEY, AUTO_EXIT_DISABLED_MSG);
			ctx.ui.notify(AUTO_EXIT_DISABLED_MSG, "warning");
		};

		pi.on("agent_start", () => {
			agentStarted = true;
			operatorInputQueuedThisRun = false;
		});

		pi.on("turn_start", () => {
			toolExecutionsThisTurn = 0;
			terminatingToolExecutionsThisTurn = 0;
		});

		pi.on("tool_execution_end", (event) => {
			toolExecutionsThisTurn += 1;
			const result = event.result as { terminate?: unknown } | undefined;
			if (result?.terminate === true) terminatingToolExecutionsThisTurn += 1;
		});

		pi.on("input", (event, ctx) => {
			// The recovery controller sends `source: "extension"` nudges. Those
			// must never read as operator takeover — treating them as manual input
			// would reset the consecutive-failure chain and loop forever.
			if (!isOperatorInput((event as { source?: unknown }).source)) return;
			// Ignore the initial task message that starts an autonomous subagent.
			// Inputs while streaming, queued follow-ups, or later manual prompts mean
			// the operator is steering and the child should stay open for that turn.
			if (!shouldMarkUserTookOver(agentStarted, event.streamingBehavior)) return;
			operatorInputQueuedThisRun = true;
			if (autoExitReArmed) {
				autoExitReArmed = false;
			} else {
				disableAutoExitByOperator(ctx);
			}
			providerErrorRecovery.cancelPendingRecovery(true);
			cancelPendingPiRecovery();
		});

		pi.on("agent_end", (event, ctx) => {
			const messages = event.messages as Parameters<typeof shouldAutoExitOnAgentEnd>[0];
			const shouldExit = shouldAutoExitOnAgentEnd(messages);
			if (!shouldExit || operatorInputQueuedThisRun) {
				// Agent turn was aborted (Escape), or the operator sent a queued
				// steering message. Leave the session open and cancel any pending
				// autonomous recovery action. Escape fires no `input` event, so this
				// aborted branch is the only place it can disable + notify; operator
				// steers/follow-ups already notified from the `input` handler.
				if (!shouldExit && isInteractive) {
					disableAutoExitByOperator(ctx);
				}
				providerErrorRecovery.cancelPendingRecovery(operatorInputQueuedThisRun);
				cancelPendingPiRecovery();
				return;
			}
			// An agent loop cannot be complete when its last assistant message still
			// requests tool execution. Some providers occasionally stop Pi at this
			// boundary instead of continuing after the tool result. Nudge immediately
			// so background children do not exit before a delayed retry can fire, but
			// bound the retries so a persistently broken provider cannot loop forever.
			const intentionallyTerminatedToolBatch =
				toolExecutionsThisTurn > 0 && toolExecutionsThisTurn === terminatingToolExecutionsThisTurn;
			if (endedAtToolUseBoundary(messages) && !intentionallyTerminatedToolBatch) {
				pendingProviderError = null;
				providerErrorRecovery.cancelPendingRecovery();
				cancelPendingPiRecovery();
				consecutiveToolBoundaryEnds += 1;
				if (consecutiveToolBoundaryEnds < MAX_CONSECUTIVE_TOOL_BOUNDARY_ENDS) {
					pi.sendUserMessage(TOOL_BOUNDARY_RECOVERY_NUDGE, {
						deliverAs: "steer",
					});
					return;
				}
				writeExitSignal({
					type: "error",
					errorMessage:
						`Subagent recovery exhausted after ${consecutiveToolBoundaryEnds} consecutive ` +
						"tool-use boundary endings.",
					stopReason: "toolUse",
					outputTokens,
				});
				requestShutdown(ctx);
				return;
			}

			// Provider errors can arrive before Pi's own retry machinery is truly done:
			// a retryable error fires an agent_end, then Pi retries and may fire a
			// second agent_end that succeeds. Arm a recovery window instead of killing
			// immediately; any later successful assistant turn cancels it. The parent
			// only receives a failure once the window actually fires (interactive panes)
			// or the process exits still unrecovered (background `pi -p` children).
			const errorInfo = findLatestAssistantError(messages);
			if (errorInfo) {
				pendingProviderError = errorInfo;
				if (errorInfo.recoveryKind === "pi") {
					// Context overflow is recoverable by Pi's native compaction path,
					// which runs after extension agent_end handlers. Do not enqueue a
					// generic "continue" nudge here: ctx.isIdle() can become true while
					// compaction is still in flight, racing the native compact-and-retry.
					// If Pi does not start or finish that native path, fail explicitly so
					// interactive auto-exit children do not stay open forever.
					providerErrorRecovery.cancelPendingRecovery();
					deferToPiNativeRecovery(errorInfo, ctx);
					return;
				}
				if (errorInfo.recoveryKind === "none") {
					providerErrorRecovery.cancelPendingRecovery();
					cancelPendingPiRecovery();
					// Defer stamping the failure while Pi's in-flight retry may still
					// recover. If the child really dies, session_shutdown reports it
					// from pendingProviderError.
					requestShutdown(ctx);
					return;
				}
				cancelPendingPiRecovery();
				providerErrorRecovery.handleProviderError(errorInfo, ctx);
				return;
			}
			if (ctx.hasPendingMessages?.()) return;
			pendingProviderError = null;
			consecutiveToolBoundaryEnds = 0;
			providerErrorRecovery.cancelPendingRecovery(true);
			cancelPendingPiRecovery();
			if (autoExitDisabledByOperator) return;
			writeExitSignal({ type: "done", outputTokens }, { supersede: true });
			requestShutdown(ctx);
		});

		// /auto-exit re-enables auto-exit after operator interaction disabled it.
		pi.registerCommand?.("auto-exit", {
			description: "Re-enable auto-exit after operator interaction",
			handler: async (_args, ctx) => {
				if (!autoExitDisabledByOperator) {
					ctx.ui.notify("Auto-exit is already enabled.", "info");
					return;
				}
				autoExitDisabledByOperator = false;
				autoExitReArmed = true;
				ctx.ui.setStatus(AUTO_EXIT_STATUS_KEY, undefined);
				ctx.ui.notify("Auto-exit re-enabled — will close after next response.", "info");
			},
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

				writeExitSignal(
					{
						type: "ping",
						name: process.env.PI_SUBAGENT_NAME ?? "subagent",
						message: params.message,
						outputTokens,
					},
					{ supersede: true },
				);
				requestShutdown(ctx);
				return {
					content: [{ type: "text", text: "Ping sent. Parent will be notified." }],
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
				writeExitSignal({ type: "done", outputTokens }, { supersede: true });
				requestShutdown(ctx);
				return {
					content: [{ type: "text", text: "Shutting down subagent session." }],
					details: {},
				};
			},
		});
	}

	// set_tab_title is a child-side protocol tool.
	// The mandatory child extension registers it under the same opt-in as the
	// parent so the declared contract holds even when `extensions: none` strips
	// the main pi-subagents extension from the child.
	if (shouldRegisterSetTabTitleTool(new Set(denied))) {
		registerSetTabTitleTool(pi);
	}
}
