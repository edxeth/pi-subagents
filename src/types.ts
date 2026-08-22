import type { ChildProcess } from "node:child_process";
import type { PersistedSubagentLaunchMetadata } from "./session/session-files.ts";

export type DeliveryState = "detached" | "awaited";
export type ParentClosePolicy = "terminate" | "continue";
type CompletedDelivery = "steer" | "wait";
export type SubagentCompletionStatus = "completed" | "failed" | "cancelled";
export type SubagentSummarySource = "subagent" | "runtime";
export type ParentShutdownAction = "terminate" | "continue";
/** Which runtime budget a killed child exceeded. */
export type SubagentTimeoutKind = "timeout" | "idle-timeout";

/**
 * Wall-clock and idle budgets for one child. An omitted budget is unbounded,
 * which is the default for every agent.
 */
export interface SubagentTimeoutBudget {
	/** Seconds of total runtime since launch. */
	timeoutSeconds?: number;
	/** Seconds without the child's session file growing. */
	idleTimeoutSeconds?: number;
}

export interface SubagentParamsInput {
	name: string;
	task: string;
	title: string;
	agent: string;
	systemPrompt?: string;
	model?: string;
	thinking?: string;
	skills?: string;
	injectSkills?: string;
	tools?: string;
	cwd?: string;
	background?: boolean;
	async?: boolean;
	blocking?: boolean;
	/**
	 * Internal, runtime-only launch override: force the child process cwd
	 * (verified fan-out points each candidate at its own git worktree).
	 * Privileged — the model-callable subagent tool strips it at the boundary
	 * and its schema never advertises it.
	 */
	forcedCwd?: string;
	/**
	 * Internal, runtime-only per-candidate env applied on top of the frozen
	 * launch blueprint (e.g. COMPOSE_PROJECT_NAME/PORT_OFFSET per worktree).
	 * Wins over static frontmatter `env` on collision (warned). Stripped from
	 * model-callable tool input like `forcedCwd`.
	 */
	launchEnv?: Record<string, string>;
}

export interface WaitParams {
	id: string;
	timeout?: number;
	onTimeout?: "error" | "return_pending" | "detach" | "return";
}

interface SubagentPing {
	name: string;
	message: string;
}

export interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	/** Origin of the summary text. Omitted legacy results are treated as subagent output. */
	summarySource?: SubagentSummarySource;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	outputTokens?: number;
	/** Context tokens used by the child when it finished. */
	contextTokens?: number;
	/** Context-window size for the child's final usage snapshot. */
	contextWindow?: number;
	/** True when the child's exit was owned by its context-warning policy. */
	contextWarned?: boolean;
	/** True when the child failed while its context was already spent. */
	contextExhausted?: boolean;
	/** Set when the runtime killed the child for exceeding a timeout budget. */
	timedOut?: SubagentTimeoutKind;
	/** The budget, in seconds, that expired. */
	timedOutAfter?: number;
	/** True when the agent's `on-timeout` policy refuses a resume of this session. */
	timeoutBlocksResume?: boolean;
	/** True when the runtime could not confirm the child was terminated. */
	timeoutKillFailed?: boolean;
	/** The soft deadline that interrupted work and started a report-only continuation. */
	timeoutWrapUp?: { kind: SubagentTimeoutKind; seconds: number; threshold: number };
	error?: string;
	errorMessage?: string;
	ping?: SubagentPing;
}

export interface CompletedSubagentResult extends SubagentResult {
	id: string;
	agent?: string;
	mode: "interactive" | "background";
	status: SubagentCompletionStatus;
	deliveryState: DeliveryState;
	parentClosePolicy: ParentClosePolicy;
	/** @deprecated compat — stop writing. Readers treat blocking: true as async: false. */
	blocking?: boolean;
	async: boolean;
	autoExit?: boolean;
	reportContextUsage?: boolean;
	deliveredTo: CompletedDelivery | null;
}

export interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	title?: string;
	agent?: string;
	mode: "interactive" | "background";
	executionState: "starting" | "running";
	deliveryState: DeliveryState;
	parentClosePolicy: ParentClosePolicy;
	blocking?: boolean;
	async?: boolean;
	autoExit?: boolean;
	noSession?: boolean;
	reportContextUsage?: boolean;
	/** Budgets the watcher enforces for this child. Absent means unbounded. */
	timeoutBudget?: SubagentTimeoutBudget;
	/** Mirrors the agent's `on-timeout` policy for the result the parent reads. */
	timeoutBlocksResume?: boolean;
	/** Percentage of a configured budget reserved for the report-only continuation. */
	timeoutWarnThreshold?: number;
	/** Set once the watcher has interrupted this run for its report-only continuation. */
	timeoutWrapUp?: { kind: SubagentTimeoutKind; seconds: number; threshold: number };
	/** True after the interrupted generation has been replaced by the continuation. */
	timeoutWrapUpMode?: boolean;
	/** Fixed hard deadline for the budget that triggered the wrap-up. */
	timeoutWrapUpDeadlineAt?: number;
	/** Last time the child's session file grew, for the idle budget. */
	lastProgressAt?: number;
	/** Set once the watcher has decided to kill this child on a budget. */
	timeoutExpiry?: { kind: SubagentTimeoutKind; seconds: number };
	/** Pending SIGKILL escalation for a timeout kill. */
	timeoutKillTimer?: ReturnType<typeof setTimeout>;
	/** Set when closing a pane child's surface failed, so the kill may not have taken. */
	timeoutKillFailed?: boolean;
	resultOwner?: { kind: CompletedDelivery; ownerId: string };
	completionPromise?: Promise<SubagentResult>;
	spawnWidthSlotAcquired?: boolean;
	surface?: string;
	childProcess?: ChildProcess;
	stderrTail?: string;
	stdoutTail?: string;
	startTime: number;
	sessionFile: string;
	entries?: number;
	bytes?: number;
	launchEntryCount?: number;
	messageCount?: number;
	toolUses?: number;
	totalTokens?: number;
	/** Snapshot of the latest assistant message's usage total, for context-window ratio display. */
	contextTokens?: number;
	modelContextWindow?: number;
	/** Resolved provider/model:thinking ref for this child, for display in the widget/overlay. */
	modelRef?: string;
	/** Exact launch contract reused by an internal timeout wrap-up restart. */
	launchMetadata?: PersistedSubagentLaunchMetadata;
	contextLabel?: string;
	activity?: string;
	taskPreview?: string;
	lastAssistantText?: string;
	lastSessionSize?: number;
	pendingToolCount?: number;
	abortController?: AbortController;
	allowSteerDelivery?: boolean;
	shutdownTimer?: ReturnType<typeof setTimeout>;
	doneSentinelFile?: string;
	/** Verified fan-out (ticket 07): run dir of the supervised fan-out this entry fronts. */
	verifiedRunDir?: string;
	/** Verified fan-out: durable run id (manifest name). */
	verifiedRunId?: string;
	zellijTarget?: { sessionName: string; parentPaneId: number };
	surfaceClosePromise?: Promise<void>;
}

export interface StartedSubagentToolDetails {
	id?: string;
	name?: string;
	title?: string;
	status?: string;
	error?: string;
	deliveryState?: string;
	parentClosePolicy?: string;
	async?: boolean;
	autoExit?: boolean;
}

export interface SessionUsage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface SessionContentBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
}

export interface SessionMessageLike {
	role?: string;
	content?: SessionContentBlock[];
	usage?: SessionUsage;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	provider?: string;
	model?: string;
}

export interface SessionEntryLike {
	type?: string;
	message?: SessionMessageLike;
}

export interface SubagentResultMessageDetails {
	name?: string;
	agent?: string;
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	outputTokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Which budget the runtime killed this child on, when it did. */
	timedOut?: SubagentTimeoutKind;
	/** The budget, in seconds, that expired. */
	timedOutAfter?: number;
	/** True when the agent's `on-timeout` policy refuses a resume. */
	timeoutBlocksResume?: boolean;
	/** The soft deadline that interrupted work and started a report-only continuation. */
	timeoutWrapUp?: { kind: SubagentTimeoutKind; seconds: number; threshold: number };
	error?: string;
	errorMessage?: string;
}

export interface SubagentPingMessageDetails {
	id?: string;
	name?: string;
	task?: string;
	agent?: string;
	mode?: "interactive" | "background";
	deliveryState?: DeliveryState;
	parentClosePolicy?: ParentClosePolicy;
	blocking?: boolean;
	async?: boolean;
	elapsed?: number;
	sessionFile?: string;
	outputTokens?: number;
	message?: string;
}

export interface WidgetThemeLike {
	fg(tone: string, text: string): string;
	bold(text: string): string;
}

export interface WidgetTuiLike {
	terminal?: {
		columns?: number;
	};
}
