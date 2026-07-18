import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./agents/definitions.ts";
import type { AgentListEntry } from "./agents/agent-list.ts";
import {
	getAgentListEntries as getAgentListEntriesFromDefinitions,
	getAgentListSignature,
	renderAgentListReminder,
} from "./agents/agent-list.ts";
import {
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
} from "./agents/definitions.ts";
import { getNoSessionSeedMode } from "./launch/seed-child-session.ts";
import {
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	resolveSubagentNoSession,
} from "./launch/policy.ts";
import { resolveSubagentCwd } from "./launch/runtime-paths.ts";
export { resolveSubagentConfigDir } from "./launch/runtime-paths.ts";
export { buildSkillLaunchPlan as buildSkillLaunchPlanForTest } from "./launch/skills.ts";
import {
	resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
	resolveTaskSessionMode as resolveTaskSessionModeFromSessionFiles,
	type SubagentSessionMode,
} from "./session/session-files.ts";
import {
	getMuxBackend,
	getZellijRuntimeError,
	initializeZellijRuntimeContext,
	isMuxAvailable,
	muxSetupHint,
	resetZellijRuntimeContext,
} from "./mux.ts";
import type { SubagentParamsInput } from "./types.ts";
import {
	formatElapsed,
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	launchBackgroundSubagent,
	launchSubagent,
	moduleAbortController,
	runningSubagents,
	shutdownSubagentsForParentExit,
	startWidgetRefresh,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	widgetManager,
	wireSubagentSteerBack,
} from "./runtime/wiring.ts";
export { getShellReadyDelayMs } from "./runtime/wiring.ts";
export {
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getPiInvocationForTest,
	getPiShellPartsForTest,
	getStartedSubagentDetailsForTest,
	getSubagentChildProcessEnvForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	waitForSubagentForTest,
} from "./runtime/wiring.ts";
import {
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
	stopAfterCurrentSubagentBatch,
} from "./runtime/state.ts";
import { classifyAssistantMessageForMixedBatch } from "./runtime/batch-classifier.ts";
import { ORCHESTRATOR_ALLOWED_TOOL_NAMES, SUBAGENT_TOOL_NAME } from "./tools/tool-names.ts";
import { registerSubagentCommands } from "./tools/commands.ts";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.ts";
import { registerSubagentResumeTool } from "./tools/resume-tool.ts";
import { markInitialPromptLaunchComplete, registerSubagentCoreTools } from "./tools/subagent-tools.ts";
import { traceSubagentLaunch } from "./launch/trace.ts";
import { registerSubagentsView } from "./tools/subagents-view.ts";

export { markSubagentBatchBlocking as markSubagentBatchBlockingForTest } from "./runtime/state.ts";
export { requestSubagentBatchStop as requestSubagentBatchStopForTest } from "./runtime/state.ts";
export { getSubagentBatchStopMetadata as getSubagentBatchStopMetadataForTest } from "./runtime/state.ts";
export { shouldAwaitSubagentLaunch as shouldAwaitSubagentLaunchForTest } from "./runtime/running-registry.ts";
export { classifyAssistantMessageForMixedBatch as classifyAssistantMessageForMixedBatchForTest } from "./runtime/batch-classifier.ts";
export * from "./testing/test-helpers.ts";

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(
		agentName,
		cwdHint,
		baseCwd,
		resolveSubagentCwd,
	);
}

function getAgentListEntries(
	baseCwd = process.cwd(),
): AgentListEntry[] {
	return getAgentListEntriesFromDefinitions(baseCwd, resolveTaskSessionMode);
}

function resolveEffectiveSessionMode(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}

function resolveTaskSessionMode(
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveTaskSessionModeFromSessionFiles(
		agentDefs,
		resolveSubagentNoSession,
		getNoSessionSeedMode,
	);
}

let lastAmbientRosterSignature: string | null = null;
let pendingAmbientRoster: {
	signature: string;
	content: string;
	entries: AgentListEntry[];
	supersedes?: true;
} | null = null;

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	const text = kind === "tab-title"
		? `Terminal multiplexer not available. ${muxSetupHint()}`
		: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { error: "mux not available" },
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	function applySubagentLineage(ctx: ExtensionContext) {
		const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
		if (!parentSession) return;
		const header = ctx.sessionManager.getHeader?.();
		if (!header || header.parentSession) return;
		header.parentSession = parentSession;
	}

	// Orchestrator mode constants (defined before use in session_start/before_agent_start)
	const ORCHESTRATOR_MODE = process.env.PI_ORCHESTRATOR_MODE === "1";
	const ORCHESTRATOR_ALLOWED_TOOLS = ORCHESTRATOR_ALLOWED_TOOL_NAMES;
	let latestContext: ExtensionContext | undefined;

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (event, ctx) => {
		latestContext = ctx;
		resetSubagentBatchStopRequest();
		// Resolve Zellij identity before any tool can create a pane. Existing shells
		// can retain an old session name after rename, so launch-time env is not safe.
		if (getMuxBackend() === "zellij") {
			const runtime = initializeZellijRuntimeContext(ctx.cwd);
			traceSubagentLaunch("zellij.runtime", {
				sessionName: runtime?.sessionName,
				parentPaneId: runtime?.parentPaneId,
				error: runtime ? undefined : getZellijRuntimeError(),
			});
		} else {
			// Module state survives extension reloads; clear Zellij data when another
			// backend owns this Pi session so it cannot leak into later actions.
			resetZellijRuntimeContext();
		}
		applySubagentLineage(ctx);
		attachWidgetContext(ctx);

		// Restrict active tools in orchestrator mode
		if (ORCHESTRATOR_MODE) {
			const allTools = pi.getAllTools().map((t: { name: string }) => t.name);
			const allowed = allTools.filter((t: string) =>
				ORCHESTRATOR_ALLOWED_TOOLS.has(t),
			);
			pi.setActiveTools(allowed);
		}

		if (!shouldRegister(SUBAGENT_TOOL_NAME)) return;

		// Reset the cached signature on every fresh session so module-level state
		// does not leak between sessions. The reload path still uses the cached
		// signature to avoid duplicating the notification within the same session.
		if (event.reason !== "reload") {
			lastAmbientRosterSignature = null;
		}

		const entries = getAgentListEntries(ctx.cwd);
		const signature = getAgentListSignature(entries);
		if (entries.length === 0) {
			if (event.reason === "reload") pendingAmbientRoster = null;
			lastAmbientRosterSignature = null;
			return;
		}

		if (signature === lastAmbientRosterSignature) {
			pendingAmbientRoster = null;
			return;
		}

		pendingAmbientRoster = {
			signature,
			content: renderAgentListReminder(entries),
			entries,
			supersedes: event.reason === "reload" ? true : undefined,
		};
	});

	const ORCHESTRATOR_BASE_PROMPT = `You are an orchestrator — a coordination agent that delegates software engineering work to specialized sub-agents. You do not inspect files, run commands, edit code, or perform implementation work yourself. Your job is to understand the request, direct sub-agents to execute the work, and synthesize their results.

## Your tools

- **subagent** — Spawn one or more sub-agents for research, implementation, review, or other substantive work. Each sub-agent has its own tools and context based on its agent definition.
- **subagent_resume** — Continue a previous sub-agent session with follow-up instructions. The sub-agent retains its full context from the previous run.
- **subagent_kill** — Stop a running sub-agent.

Sub-agent results arrive as tool output when the agent was launched with blocking mode, or as later messages in the conversation when launched in non-blocking mode. Never fabricate or predict results that have not arrived.

## How to delegate

When calling subagent, every task description must be self-contained. Sub-agents have their own context — they cannot see your conversation history. Include all relevant file paths, error messages, constraints, and expectations explicitly.

**Good task description:**
\`\`\`
Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when the session expires but the token remains cached. Add a null check before accessing user.id — if null, return 401 with "Session expired". Run the tests, commit, and report the hash.
\`\`\`

**Bad task description:**
\`\`\`
Based on your findings, fix the auth bug.
\`\`\`

### Continue vs spawn fresh

When you have sub-agent results and need follow-up work:

| Situation | Mechanism |
|-----------|-----------|
| Sub-agent just explored the files that need editing | **Resume** — it already has relevant context |
| Research was broad but the implementation is narrow | **Spawn fresh** — avoid dragging exploration noise |
| Correcting a failure or extending recent work | **Resume** — it has the error context |
| Verifying code a different agent just wrote | **Spawn fresh** — fresh eyes avoid confirmation bias |
| First attempt used the wrong approach entirely | **Spawn fresh** — clean slate avoids anchoring |

Think about how much of the sub-agent\'s context overlaps with the next task. High overlap → resume. Low overlap → spawn fresh.

### Parallel delegation

Launch independent subtasks in parallel using the \`children\` parameter. Parallel execution is the primary benefit of multi-agent orchestration. Do not serialize work that can run simultaneously.

## Task workflow

Most tasks benefit from this general flow:

1. **Research phase** — Delegate parallel investigations to understand the codebase, identify affected files, and explore approaches.
2. **Synthesis phase** — Read the findings. Understand the problem. Craft specific implementation instructions that prove you understood (include actual file paths, line numbers, and what to change).
3. **Implementation phase** — Delegate the actual code changes per your synthesized spec.
4. **Verification phase** — Deploy a verification agent to independently confirm the changes work.

Your most important job is synthesis: reading sub-agent outputs, understanding them, and writing precise follow-up instructions. Never hand off understanding to another agent — that defeats the purpose of having you as the coordinator.

## Rules

- Do not use sub-agents for trivial work you can handle by chatting with the user — answer questions directly when possible.
- Do not set the model parameter on sub-agents — their agent definitions handle model selection.`;

	pi.on("before_agent_start", (event) => {
		const rosterResult = pendingAmbientRoster
			? {
					message: {
						customType: "subagent_roster",
						content: pendingAmbientRoster.content,
						display: false,
						details: {
							entries: pendingAmbientRoster.entries,
							signature: pendingAmbientRoster.signature,
							...(pendingAmbientRoster.supersedes
								? { supersedes: true }
								: {}),
						},
					},
				}
			: undefined;
		if (pendingAmbientRoster) {
			lastAmbientRosterSignature = pendingAmbientRoster.signature;
			pendingAmbientRoster = null;
		}

		if (!ORCHESTRATOR_MODE) {
			return rosterResult;
		}

		// Orchestrator mode: replace system prompt, but preserve user's APPEND_SYSTEM.md
		const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
		const systemPrompt = appendPrompt
			? `${ORCHESTRATOR_BASE_PROMPT}\n\n${appendPrompt}`
			: ORCHESTRATOR_BASE_PROMPT;

		return {
			...(rosterResult ?? {}),
			systemPrompt,
		};
	});

	pi.on("input", () => {
		resetSubagentBatchStopRequest();
		return { action: "continue" as const };
	});

	pi.on("message_end", (event) => {
		// Mixed-batch barrier: when an assistant message contains BOTH an async
		// subagent launch (subagent or subagent_resume) AND a non-subagent tool,
		// mark the batch blocking before any tool runs. The shared
		// shouldAwaitSubagentLaunch predicate then routes both subagent and
		// subagent_resume launches through the await path so the parent's
		// next turn sees completed results instead of racing the children.
		// Gated by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN to share a kill
		// switch with the existing coordinator-only-turn behavior.
		const message = event?.message;
		if (!message) return;
		classifyAssistantMessageForMixedBatch(message, (agent, cwd) =>
			agent ? loadAgentDefaults(agent, cwd) : null,
		);
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return {};
		const input = event.input as Partial<SubagentParamsInput>;
		const agentDefs =
			typeof input.agent === "string"
				? loadAgentDefaults(
						input.agent,
						typeof input.cwd === "string" ? input.cwd : undefined,
					)
				: null;
		const agentError = getSubagentAgentRequirementError(input, agentDefs);
		const agentOverrideError = getSubagentAgentOverrideError(input, agentDefs);
		if (!agentError && !agentOverrideError) {
			if (resolveSubagentBlocking(input, agentDefs)) {
				markSubagentBatchBlocking();
			} else {
				requestSubagentBatchStop();
			}
		}
		return {};
	});

	pi.on("turn_start", () => {
		resetSubagentBatchStopRequest();
	});

	pi.on("agent_end", () => {
		resetSubagentBatchStopRequest();
		markInitialPromptLaunchComplete();
	});

	// Clean up on real session shutdown. Pi also emits this event for the
	// coordinator-only turn stop after async launches; that must not kill the
	// children that the stop was created to leave running.
	pi.on("session_shutdown", (event, ctx) => {
		traceSubagentLaunch("session.shutdown", {
			coordinatorOnlyTurnStop: stopAfterCurrentSubagentBatch,
			eventKeys: Object.keys((event ?? {}) as unknown as Record<string, unknown>),
			running: runningSubagents.size,
		});
		if (stopAfterCurrentSubagentBatch) return;

		moduleAbortController.abort();
		widgetManager.reset();
		resetSubagentBatchStopRequest();
		shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);

	registerSubagentCoreTools(pi, shouldRegister, {
		loadAgentDefaults: (agentName, cwd) => agentName ? loadAgentDefaults(agentName, undefined, cwd) : null,
		resolveEffectiveSessionMode,
		resolveTaskSessionMode,
		launchBackgroundSubagent,
		launchSubagent,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		stopRunningSubagent,
		muxUnavailableResult: () => muxUnavailableResult("tab-title"),
	});

	registerSubagentResumeTool(pi, shouldRegister, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		runningSubagents,
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
		modelRegistry: {
			getAvailable: () => latestContext?.modelRegistry.getAvailable() ?? [],
		},
	});

	registerSubagentCommands(pi, {
		stopRunningSubagent,
	});

	registerSubagentMessageRenderers(pi, formatElapsed);

	registerSubagentsView(pi, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		startWidgetRefresh,
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
		runningSubagents,
		pi,
		wireSubagentSteerBack,
	});

}
