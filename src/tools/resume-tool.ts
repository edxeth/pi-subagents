import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { endedUnderContextPressure } from "../session/completion-reason.ts";
import { readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import { type ResumeServiceRuntime, resumeSubagentSession } from "../runtime/resume-service.ts";
import { shouldAwaitSubagentLaunch } from "../runtime/running-registry.ts";
import { getSubagentBatchStopMetadata, requestSubagentBatchStop } from "../runtime/state.ts";
import { readSubagentLaunchMetadata } from "../session/session-files.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";
import { formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";
import { SUBAGENT_RESUME_TOOL_NAME } from "./tool-names.ts";

export interface ResumeToolRuntime extends ResumeServiceRuntime {
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

export function registerSubagentResumeTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: ResumeToolRuntime,
): void {
	if (!shouldRegister(SUBAGENT_RESUME_TOOL_NAME)) return;
	pi.registerTool({
		name: SUBAGENT_RESUME_TOOL_NAME,
		label: "Resume Subagent",
		description: "Continue a previous subagent session from its session file, optionally sending a follow-up task.",
		promptSnippet:
			"Use subagent_resume when an earlier helper session was cancelled, left open, or needs follow-up work with its existing context.\n" +
			"\n" +
			"Provide sessionFile from the earlier subagent output. If you include task, it is sent as the next instruction in that resumed session.\n" +
			"\n" +
			"The resumed helper may run in a visible terminal or hidden process depending on saved metadata or the mode argument. The tool usually returns after starting it; the helper's final report appears later in this chat when it finishes. Do not invent or assume resumed-session results before that later message appears. " +
			"Leave model/thinking unset unless the user named concrete values for this resume. Do not infer them from quality, depth, urgency, safety, or cost language. " +
			"The result arrives automatically as a steer message. Do not poll for it.",
		parameters: Type.Object({
			sessionFile: Type.String({
				description: "Path to the session .jsonl file to resume",
			}),
			name: Type.Optional(
				Type.String({
					description: "Display name for the terminal tab. Default: 'Resume'",
				}),
			),
			task: Type.Optional(
				Type.String({
					description: "Optional follow-up task to send after resuming",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description: "Agent name for display. Use the original agent name from the session being resumed.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model routing/cost control only. Omit to keep the original launch model. " +
						"Set only when the user named a concrete model for this resume; do not infer it from quality, depth, urgency, safety, or cost language. " +
						"Format: provider/model[:thinking]. Ignored when allow-model-override: false.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Child runtime thinking level only. Omit to keep the original thinking level. " +
						"Set only when the user named a concrete thinking level for this resume; do not infer it from quality, depth, urgency, safety, or cost language. " +
						"Ignored when allow-model-override: false.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("background"), Type.Literal("interactive")], {
					description:
						"Fallback resume mode used only when launch metadata cannot be inferred. Persisted metadata always wins when present; an explicit mode here cannot override it.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			let name = args.name && args.name !== "Resume" ? args.name : "subagent";
			let agent = args.agent;
			if (args.sessionFile) {
				try {
					const lm = readSubagentLaunchMetadata(args.sessionFile);
					if (lm?.name) name = lm.name;
					if (lm?.agent) agent = lm.agent;
				} catch {}
			}
			const agentBadge = agent ? theme.fg("dim", ` (${agent})`) : "";
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(
				"▸ " +
					theme.fg("toolTitle", theme.bold("Resume")) +
					" " +
					theme.fg("accent", theme.bold(name)) +
					agentBadge +
					formatTaskPreview(args.task ?? "", context, theme),
			);
			return text;
		},
		renderResult(result, opts, theme, context) {
			const details = result.details as { status?: string } | undefined;
			if (details?.status === "started") return new Text("", 0, 0);
			if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
				return renderSubagentCompletionText(
					result,
					opts,
					theme,
					context.lastComponent instanceof Text ? context.lastComponent : undefined,
					true,
				);
			}
			const firstContent = result.content?.[0];
			const text = firstContent?.type === "text" ? firstContent.text : "";
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(theme.fg("dim", text));
			return component;
		},
		async execute(_toolCallId, params, signal) {
			if (!params.sessionFile) throw new Error("Session file is required.");
			// The child ended on instruction from its context-warning policy, so its
			// window is spent. Resuming buys no room and only repeats the wrap-up.
			// Operators can still resume it deliberately from the /subagents overlay.
			if (endedUnderContextPressure(params.sessionFile)) {
				throw new Error(
					"This sub-agent stopped early as instructed by its context-warning policy, and its context window is spent. " +
						"Resuming gives it no room to work. Launch a fresh sub-agent with the remaining work instead.",
				);
			}
			// A budget kill is recoverable by default — a resume re-arms the same
			// budget, so it cannot run away again. Only an agent that opted into
			// `on-timeout: block-resume` refuses, because a second partial run of a
			// non-idempotent child is not safe to attempt.
			const timedOut = readSubagentTimeoutSidecar(params.sessionFile);
			if (timedOut?.blocksResume) {
				throw new Error(
					`The system stopped this sub-agent because it went past its ${timedOut.kind === "idle-timeout" ? "limit for time without output" : "time limit"}. ` +
						"Its agent file does not allow a resume after that. Start a new sub-agent with a smaller task instead.",
				);
			}

			const running = await resumeSubagentSession(
				{
					sessionFile: params.sessionFile,
					task: params.task,
					name: params.name,
					agent: params.agent,
					mode: params.mode as "interactive" | "background" | undefined,
					model: params.model,
					thinking: params.thinking,
				},
				runtime,
			);

			runtime.wireSubagentSteerBack(pi, running, running.completionPromise!);

			const shouldAwait = shouldAwaitSubagentLaunch(running);
			if (shouldAwait) {
				return runtime.getLaunchedSubagentResult(running, signal);
			}

			requestSubagentBatchStop();
			return {
				content: [
					{
						type: "text" as const,
						text: `Session "${running.name}" resumed.`,
					},
				],
				details: {
					id: running.id,
					name: running.name,
					sessionFile: running.sessionFile,
					status: "started" as const,
					deliveryState: "detached" as const,
					async: running.async,
				},
				...getSubagentBatchStopMetadata(),
			};
		},
	});
}
