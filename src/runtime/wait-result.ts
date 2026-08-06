import { randomUUID } from "node:crypto";
import type { CompletedSubagentResult, DeliveryState, RunningSubagent, SubagentResult, WaitParams } from "../types.ts";
import { formatFinalContextUsage } from "./final-context-usage.ts";
import { hasRealSubagentOutput } from "./state.ts";
import type { WaitRuntime } from "./wait.ts";
import { formatElapsed } from "./wiring.ts";

function getSubagentWaitPingResult(running: RunningSubagent, result: SubagentResult, deliveryState: DeliveryState) {
	return {
		content: [
			{
				type: "text",
				text:
					`Sub-agent "${running.name}" requested help and exited. ` +
					`Resume it with subagent_resume using sessionFile ${result.sessionFile ?? "(missing)"}.` +
					`\n\nMessage from the subagent:\n${result.ping?.message ?? ""}`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			agent: running.agent,
			status: "pinged" as const,
			deliveryState,
			async: running.async !== false,
			elapsed: result.elapsed,
			outputTokens: result.outputTokens,
			sessionFile: result.sessionFile,
			message: result.ping?.message,
		},
	};
}

function getSubagentWaitSuccessResult(cached: CompletedSubagentResult) {
	const sessionRef = cached.sessionFile
		? `\n\nSession: ${cached.sessionFile}\nResume: pi --session ${cached.sessionFile}`
		: "";
	const contextRef = cached.reportContextUsage === false ? "" : formatFinalContextUsage(cached);
	let text: string;
	if (cached.errorMessage) {
		const resultBody = hasRealSubagentOutput(cached)
			? `Last output before the failure (may be incomplete — verify before trusting):\n\n${cached.summary}`
			: `The subagent did not produce a result. You can retry by spawning a new ` +
				`subagent or resume the session with subagent_resume.`;
		text =
			`Sub-agent "${cached.name}" failed after ${formatElapsed(cached.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${cached.errorMessage}\n\n${resultBody}${sessionRef}${contextRef}`;
	} else {
		const verb =
			cached.status === "completed" ? "completed" : cached.status === "cancelled" ? "was cancelled" : "failed";
		text =
			cached.status === "completed"
				? `Sub-agent "${cached.name}" completed (${formatElapsed(cached.elapsed)}).\n\n${cached.summary}${sessionRef}${contextRef}`
				: `Sub-agent "${cached.name}" ${verb} (exit ${cached.exitCode}).\n\n${cached.summary}${sessionRef}${contextRef}`;
	}
	return {
		content: [{ type: "text", text }],
		details: {
			id: cached.id,
			name: cached.name,
			agent: cached.agent,
			status: cached.status,
			mode: cached.mode,
			parentClosePolicy: cached.parentClosePolicy,
			deliveryState: "awaited" as const,
			async: cached.async,
			autoExit: cached.autoExit,
			exitCode: cached.exitCode,
			elapsed: cached.elapsed,
			outputTokens: cached.outputTokens,
			contextTokens: cached.contextTokens,
			contextWindow: cached.contextWindow,
			summary: cached.summary,
			sessionFile: cached.sessionFile,
			...(cached.errorMessage ? { errorMessage: cached.errorMessage } : {}),
		},
	};
}

function getSubagentWaitErrorResult(message: string, error: string, extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: message }],
		details: { error, ...extra },
	};
}

function releaseSubagentWaitOwnership(runtime: WaitRuntime, running: RunningSubagent, ownerId: string): void {
	if (runtime.runningSubagents.get(running.id) !== running) return;
	if (running.resultOwner?.kind !== "wait") return;
	if (running.resultOwner.ownerId !== ownerId) return;
	running.resultOwner = undefined;
	running.allowSteerDelivery = true;
	running.deliveryState = "detached";
	runtime.updateWidget();
}

export async function waitForSubagentResult(params: WaitParams, runtime: WaitRuntime, signal?: AbortSignal) {
	const match = runtime.findTrackedSubagent(params.id);
	if (match.error || (!match.cached && !match.running)) {
		return getSubagentWaitErrorResult(match.error ?? `No subagent matches "${params.id}".`, "not_found", {
			id: params.id,
		});
	}

	const cached = match.cached;
	if (cached) {
		if (cached.deliveryState !== "detached" && !cached.deliveredTo) {
			return getSubagentWaitErrorResult(
				`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
				"already_owned",
				{ id: cached.id },
			);
		}
		cached.deliveryState = "awaited";
		cached.deliveredTo = "wait";
		return getSubagentWaitSuccessResult(cached);
	}

	const running = match.running!;
	if (running.resultOwner) {
		return getSubagentWaitErrorResult(
			`Sub-agent "${running.name}" is already owned by another synchronization call.`,
			"already_owned",
			{ id: running.id },
		);
	}
	if (!running.completionPromise) {
		return getSubagentWaitErrorResult(`Sub-agent "${running.name}" is missing completion tracking.`, "not_found", {
			id: running.id,
		});
	}

	const ownerId = `wait:${randomUUID()}`;
	running.resultOwner = { kind: "wait", ownerId };
	running.allowSteerDelivery = false;
	running.deliveryState = "awaited";
	runtime.updateWidget();

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortCleanup = () => {};
	try {
		const completionPromise = running.completionPromise.then((result) => ({
			kind: "completed" as const,
			result,
		}));
		const races: Array<
			Promise<{ kind: "completed"; result: SubagentResult } | { kind: "timeout" } | { kind: "interrupted" }>
		> = [completionPromise];

		if (params.timeout && params.timeout > 0) {
			races.push(
				new Promise((resolve) => {
					timeoutHandle = setTimeout(() => resolve({ kind: "timeout" as const }), params.timeout! * 1000);
				}),
			);
		}

		if (signal) {
			if (signal.aborted) {
				await runtime.stopRunningSubagent(running);
				runtime.runningSubagents.delete(running.id);
				runtime.updateWidget();
				return getSubagentWaitErrorResult(`Waiting for sub-agent "${running.name}" was interrupted.`, "interrupted", {
					id: running.id,
				});
			}
			races.push(
				new Promise((resolve) => {
					const onAbort = () => resolve({ kind: "interrupted" as const });
					signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => signal.removeEventListener("abort", onAbort);
				}),
			);
		}

		const outcome = await Promise.race(races);
		if (outcome.kind === "completed") {
			if (outcome.result.ping) {
				return getSubagentWaitPingResult(running, outcome.result, "awaited");
			}
			const completed =
				runtime.completedSubagentResults.get(running.id) ??
				runtime.cacheCompletedSubagentResult(running, outcome.result);
			if (completed.deliveredTo && completed.deliveredTo !== "wait" && completed.deliveredTo !== "steer") {
				return getSubagentWaitErrorResult(
					`Sub-agent result for "${running.id}" was already delivered via ${completed.deliveredTo}.`,
					"already_delivered",
					{ id: running.id },
				);
			}
			completed.deliveryState = "awaited";
			completed.deliveredTo = "wait";
			return getSubagentWaitSuccessResult(completed);
		}

		releaseSubagentWaitOwnership(runtime, running, ownerId);
		if (outcome.kind === "interrupted") {
			await runtime.stopRunningSubagent(running);
			runtime.runningSubagents.delete(running.id);
			runtime.updateWidget();
			return getSubagentWaitErrorResult(`Waiting for sub-agent "${running.name}" was interrupted.`, "interrupted", {
				id: running.id,
			});
		}
		if (params.onTimeout === "return_pending" || params.onTimeout === "detach" || params.onTimeout === "return") {
			return {
				content: [
					{
						type: "text",
						text: `Sub-agent "${running.name}" is still running.`,
					},
				],
				details: {
					id: running.id,
					status: "pending" as const,
					deliveryState: "detached" as const,
					timeout: params.timeout,
				},
			};
		}
		return getSubagentWaitErrorResult(`Timed out waiting for sub-agent "${running.name}".`, "timeout", {
			id: running.id,
			timeout: params.timeout,
		});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		abortCleanup();
	}
}
