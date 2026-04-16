import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type {
	CompletedSubagentResult,
	DetachParams,
	JoinParams,
	RunningSubagent,
	SubagentResult,
	WaitParams,
} from "./runtime-types.ts";

interface SubagentSyncDeps {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	cacheCompletedSubagentResult: (
		running: RunningSubagent,
		result: SubagentResult,
	) => CompletedSubagentResult;
	updateWidget: () => void;
	deliverCompletedSubagentResultViaSteer: (
		pi: Pick<ExtensionAPI, "sendMessage">,
		cached: CompletedSubagentResult,
	) => void;
}

export class SubagentSyncManager {
	private readonly deps: SubagentSyncDeps;

	constructor(deps: SubagentSyncDeps) {
		this.deps = deps;
	}

	getCompletedResult(id: string): CompletedSubagentResult | undefined {
		return this.deps.completedSubagentResults.get(id);
	}

	detachResult(
		params: DetachParams,
		pi?: Pick<ExtensionAPI, "sendMessage">,
	) {
		const cached = this.deps.completedSubagentResults.get(params.id);
		if (cached) {
			if (cached.deliveredTo || cached.deliveryState === "detached") {
				return this.getDetachErrorResult(
					`Sub-agent "${params.id}" is not currently owned by wait or join.`,
					"not_owned",
					{ id: params.id },
				);
			}
			cached.deliveryState = "detached";
			if (pi) this.deps.deliverCompletedSubagentResultViaSteer(pi, cached);
			return this.getDetachResult(params.id);
		}

		const running = this.deps.runningSubagents.get(params.id);
		if (!running) {
			return this.getDetachErrorResult(
				`No subagent matches "${params.id}".`,
				"not_found",
				{ id: params.id },
			);
		}
		if (
			running.deliveryState === "detached" ||
			(running.resultOwner?.kind !== "wait" && running.resultOwner?.kind !== "join")
		) {
			return this.getDetachErrorResult(
				`Sub-agent "${running.name}" is not currently owned by wait or join.`,
				"not_owned",
				{ id: running.id },
			);
		}

		running.resultOwner = undefined;
		running.deliveryState = "detached";
		this.deps.updateWidget();
		return this.getDetachResult(running.id);
	}

	async waitForResult(params: WaitParams, signal?: AbortSignal) {
		const cached = this.deps.completedSubagentResults.get(params.id);
		if (cached) {
			if (cached.deliveredTo) {
				return this.getWaitErrorResult(
					`Sub-agent result for "${params.id}" was already delivered via ${cached.deliveredTo}.`,
					"already_delivered",
					{ id: params.id },
				);
			}
			if (cached.deliveryState !== "detached") {
				return this.getWaitErrorResult(
					`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
					"already_owned",
					{ id: cached.id },
				);
			}
			cached.deliveryState = "awaited";
			cached.deliveredTo = "wait";
			return this.getWaitSuccessResult(cached);
		}

		const running = this.deps.runningSubagents.get(params.id);
		if (!running) {
			return this.getWaitErrorResult(
				`No subagent matches "${params.id}".`,
				"not_found",
				{ id: params.id },
			);
		}
		if (running.resultOwner) {
			return this.getWaitErrorResult(
				`Sub-agent "${running.name}" is already owned by another synchronization call.`,
				"already_owned",
				{ id: running.id },
			);
		}
		if (!running.completionPromise) {
			return this.getWaitErrorResult(
				`Sub-agent "${running.name}" is missing completion tracking.`,
				"not_found",
				{ id: running.id },
			);
		}

		const ownerId = `wait:${randomUUID()}`;
		running.resultOwner = { kind: "wait", ownerId };
		running.deliveryState = "awaited";
		this.deps.updateWidget();

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let abortCleanup = () => {};
		try {
			const completionPromise = running.completionPromise.then((result) => ({
				kind: "completed" as const,
				result,
			}));
			const races: Array<Promise<
				| { kind: "completed"; result: SubagentResult }
				| { kind: "timeout" }
				| { kind: "interrupted" }
			>> = [completionPromise];

			if (params.timeout && params.timeout > 0) {
				races.push(
					new Promise((resolve) => {
						timeoutHandle = setTimeout(
							() => resolve({ kind: "timeout" as const }),
							params.timeout! * 1000,
						);
					}),
				);
			}

			if (signal) {
				if (signal.aborted) {
					this.releaseWaitOwnership(running, ownerId);
					return this.getWaitErrorResult(
						`Waiting for sub-agent "${running.name}" was interrupted.`,
						"interrupted",
						{ id: running.id },
					);
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
				const completed =
					this.deps.completedSubagentResults.get(running.id) ??
					this.deps.cacheCompletedSubagentResult(running, outcome.result);
				if (completed.deliveredTo && completed.deliveredTo !== "wait") {
					return this.getWaitErrorResult(
						`Sub-agent result for "${running.id}" was already delivered via ${completed.deliveredTo}.`,
						"already_delivered",
						{ id: running.id },
					);
				}
				completed.deliveryState = "awaited";
				completed.deliveredTo = "wait";
				return this.getWaitSuccessResult(completed);
			}

			this.releaseWaitOwnership(running, ownerId);
			if (outcome.kind === "interrupted") {
				return this.getWaitErrorResult(
					`Waiting for sub-agent "${running.name}" was interrupted.`,
					"interrupted",
					{ id: running.id },
				);
			}
			if (params.onTimeout === "return_pending") {
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
			return this.getWaitErrorResult(
				`Timed out waiting for sub-agent "${running.name}".`,
				"timeout",
				{ id: running.id, timeout: params.timeout },
			);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			abortCleanup();
		}
	}

	async joinResults(
		params: JoinParams,
		signal?: AbortSignal,
		pi?: Pick<ExtensionAPI, "sendMessage">,
	) {
		if (params.ids.length === 0 || new Set(params.ids).size !== params.ids.length) {
			return this.getJoinErrorResult(
				"Join requires a non-empty set of unique child ids.",
				"invalid_ids",
				{ ids: params.ids },
			);
		}

		const ownerId = `join:${randomUUID()}`;
		const claimedRunning = new Map<string, RunningSubagent>();
		const claimedCached = new Map<string, CompletedSubagentResult>();
		for (const id of params.ids) {
			const cached = this.deps.completedSubagentResults.get(id);
			if (cached) {
				if (cached.deliveredTo) {
					return this.getJoinErrorResult(
						`Sub-agent result for "${id}" was already delivered via ${cached.deliveredTo}.`,
						"already_delivered",
						{ id },
					);
				}
				if (cached.deliveryState !== "detached") {
					return this.getJoinErrorResult(
						`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
						"already_owned",
						{ id: cached.id },
					);
				}
				claimedCached.set(id, cached);
				continue;
			}

			const running = this.deps.runningSubagents.get(id);
			if (!running) {
				return this.getJoinErrorResult(
					`No subagent matches "${id}".`,
					"not_found",
					{ id },
				);
			}
			if (running.resultOwner) {
				return this.getJoinErrorResult(
					`Sub-agent "${running.name}" is already owned by another synchronization call.`,
					"already_owned",
					{ id: running.id },
				);
			}
			if (!running.completionPromise) {
				return this.getJoinErrorResult(
					`Sub-agent "${running.name}" is missing completion tracking.`,
					"not_found",
					{ id: running.id },
				);
			}
			claimedRunning.set(id, running);
		}

		for (const cached of claimedCached.values()) {
			cached.deliveryState = "joined";
		}
		for (const running of claimedRunning.values()) {
			running.resultOwner = { kind: "join", ownerId };
			running.deliveryState = "joined";
		}
		this.deps.updateWidget();

		const results: Record<string, ReturnType<typeof this.getJoinResultFields>> = {};
		for (const [id, cached] of claimedCached.entries()) {
			results[id] = this.getJoinResultFields(cached);
		}

		const completedIds = new Set(Object.keys(results));
		const pending = new Map(claimedRunning);
		if (pending.size === 0) {
			this.markJoinedResultsDelivered([...completedIds]);
			return this.getJoinSuccessResult(params.ids, results);
		}

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let abortCleanup = () => {};
		let timeoutPromise: Promise<{ kind: "timeout" }> | undefined;
		let interruptPromise: Promise<{ kind: "interrupted" }> | undefined;
		try {
			if (params.timeout && params.timeout > 0) {
				timeoutPromise = new Promise((resolve) => {
					timeoutHandle = setTimeout(
						() => resolve({ kind: "timeout" as const }),
						params.timeout! * 1000,
					);
				});
			}
			if (signal) {
				if (signal.aborted) {
					for (const running of pending.values()) {
						this.releaseJoinOwnership(running, ownerId);
					}
					this.releaseCompletedJoinResultsToSteer([...completedIds], pi);
					return this.getJoinErrorResult(
						"Joining sub-agents was interrupted.",
						"interrupted",
						{ ids: params.ids },
					);
				}
				interruptPromise = new Promise((resolve) => {
					const onAbort = () => resolve({ kind: "interrupted" as const });
					signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => signal.removeEventListener("abort", onAbort);
				});
			}

			while (pending.size > 0) {
				const races: Array<Promise<
					| { kind: "completed"; id: string; result: SubagentResult }
					| { kind: "timeout" }
					| { kind: "interrupted" }
				>> = [...pending.entries()].map(([id, running]) =>
					running.completionPromise!.then((result) => ({
						kind: "completed" as const,
						id,
						result,
					})),
				);
				if (timeoutPromise) races.push(timeoutPromise);
				if (interruptPromise) races.push(interruptPromise);

				const outcome = await Promise.race(races);
				if (outcome.kind === "completed") {
					pending.delete(outcome.id);
					const running = claimedRunning.get(outcome.id)!;
					const completed =
						this.deps.completedSubagentResults.get(outcome.id) ??
						this.deps.cacheCompletedSubagentResult(running, outcome.result);
					if (completed.deliveredTo && completed.deliveredTo !== "join") {
						for (const pendingRunning of pending.values()) {
							this.releaseJoinOwnership(pendingRunning, ownerId);
						}
						this.releaseCompletedJoinResultsToSteer([...completedIds], pi);
						return this.getJoinErrorResult(
							`Sub-agent result for "${outcome.id}" was already delivered via ${completed.deliveredTo}.`,
							"already_delivered",
							{ id: outcome.id },
						);
					}
					completed.deliveryState = "joined";
					results[outcome.id] = this.getJoinResultFields(completed);
					completedIds.add(outcome.id);
					continue;
				}

				for (const pendingRunning of pending.values()) {
					this.releaseJoinOwnership(pendingRunning, ownerId);
				}
				if (outcome.kind === "interrupted") {
					this.releaseCompletedJoinResultsToSteer([...completedIds], pi);
					return this.getJoinErrorResult(
						"Joining sub-agents was interrupted.",
						"interrupted",
						{ ids: params.ids },
					);
				}
				if (params.onTimeout === "return_partial") {
					this.markJoinedResultsDelivered([...completedIds]);
					return this.getJoinSuccessResult(
						params.ids,
						results,
						[...pending.keys()],
						params.timeout,
					);
				}
				this.releaseCompletedJoinResultsToSteer([...completedIds], pi);
				return this.getJoinErrorResult(
					"Timed out joining sub-agents.",
					"timeout",
					{ ids: params.ids, timeout: params.timeout },
				);
			}

			this.markJoinedResultsDelivered([...completedIds]);
			return this.getJoinSuccessResult(params.ids, results);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			abortCleanup();
		}
	}

	private getWaitSuccessResult(cached: CompletedSubagentResult) {
		return {
			content: [{ type: "text", text: cached.summary }],
			details: {
				id: cached.id,
				name: cached.name,
				status: cached.status,
				deliveryState: cached.deliveryState,
				exitCode: cached.exitCode,
				elapsed: cached.elapsed,
				...(cached.sessionFile ? { sessionFile: cached.sessionFile } : {}),
			},
		};
	}

	private getWaitErrorResult(
		message: string,
		error: string,
		extra: Record<string, unknown> = {},
	) {
		return {
			content: [{ type: "text", text: message }],
			details: { error, ...extra },
		};
	}

	private releaseWaitOwnership(running: RunningSubagent, ownerId: string): void {
		if (this.deps.runningSubagents.get(running.id) !== running) return;
		if (running.resultOwner?.kind !== "wait") return;
		if (running.resultOwner.ownerId !== ownerId) return;
		running.resultOwner = undefined;
		running.deliveryState = "detached";
		this.deps.updateWidget();
	}

	private getDetachResult(id: string) {
		return {
			content: [{ type: "text", text: `Sub-agent "${id}" detached.` }],
			details: {
				id,
				status: "detached" as const,
				deliveryState: "detached" as const,
			},
		};
	}

	private getDetachErrorResult(
		message: string,
		error: string,
		extra: Record<string, unknown> = {},
	) {
		return {
			content: [{ type: "text", text: message }],
			details: { error, ...extra },
		};
	}

	private getJoinResultFields(cached: CompletedSubagentResult) {
		return {
			exitCode: cached.exitCode,
			elapsed: cached.elapsed,
			...(cached.sessionFile ? { sessionFile: cached.sessionFile } : {}),
		};
	}

	private getJoinErrorResult(
		message: string,
		error: string,
		extra: Record<string, unknown> = {},
	) {
		return {
			content: [{ type: "text", text: message }],
			details: { error, ...extra },
		};
	}

	private releaseJoinOwnership(
		running: RunningSubagent,
		ownerId: string,
	): void {
		if (this.deps.runningSubagents.get(running.id) !== running) return;
		if (running.resultOwner?.kind !== "join") return;
		if (running.resultOwner.ownerId !== ownerId) return;
		running.resultOwner = undefined;
		running.deliveryState = "detached";
		this.deps.updateWidget();
	}

	private releaseCompletedJoinResultsToSteer(
		ids: string[],
		pi?: Pick<ExtensionAPI, "sendMessage">,
	): void {
		for (const id of ids) {
			const cached = this.deps.completedSubagentResults.get(id);
			if (!cached || cached.deliveredTo) continue;
			cached.deliveryState = "detached";
			if (pi) this.deps.deliverCompletedSubagentResultViaSteer(pi, cached);
		}
	}

	private markJoinedResultsDelivered(ids: string[]): void {
		for (const id of ids) {
			const cached = this.deps.completedSubagentResults.get(id);
			if (!cached) continue;
			cached.deliveryState = "joined";
			cached.deliveredTo = "join";
		}
	}

	private getJoinSuccessResult(
		ids: string[],
		results: Record<string, ReturnType<typeof this.getJoinResultFields>>,
		pendingIds: string[] = [],
		timeout?: number,
	) {
		const completedCount = Object.keys(results).length;
		const isPartial = pendingIds.length > 0;
		return {
			content: [
				{
					type: "text",
					text: isPartial
						? `Joined ${completedCount} of ${ids.length} sub-agents before timeout.`
						: `Joined ${ids.length} sub-agent${ids.length === 1 ? "" : "s"}.`,
				},
			],
			details: {
				ids,
				status: isPartial ? ("partial" as const) : ("completed" as const),
				deliveryState: "joined" as const,
				results,
				...(isPartial ? { pendingIds, timeout } : {}),
			},
		};
	}
}
