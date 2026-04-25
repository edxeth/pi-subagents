import type { ChildProcess } from "node:child_process";

export type DeliveryState = "detached" | "awaited" | "joined";
export type ParentClosePolicy = "terminate" | "cancel" | "abandon";
export type CompletedDelivery = "steer" | "wait" | "join";
export type SubagentCompletionStatus = "completed" | "failed" | "cancelled";
export type ParentShutdownAction = "terminate" | "cancel" | "abandon";

export interface SubagentParamsInput {
	name: string;
	task: string;
	agent: string;
	systemPrompt?: string;
	model?: string;
	skills?: string;
	tools?: string;
	cwd?: string;
	fork?: boolean;
	background?: boolean;
	async?: boolean;
	blocking?: boolean;
	parentClosePolicy?: ParentClosePolicy;
}

export interface WaitParams {
	id: string;
	timeout?: number;
	onTimeout?: "error" | "return_pending" | "detach" | "return";
}

export interface JoinParams {
	ids: string[];
	timeout?: number;
	onTimeout?: "error" | "return_partial" | "detach" | "return";
}

export interface DetachParams {
	id: string;
}

export interface SubagentPing {
	name: string;
	message: string;
}

export interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	outputTokens?: number;
	error?: string;
	ping?: SubagentPing;
}

export interface CompletedSubagentResult extends SubagentResult {
	id: string;
	agent?: string;
	mode: "interactive" | "background";
	status: SubagentCompletionStatus;
	deliveryState: DeliveryState;
	parentClosePolicy: ParentClosePolicy;
	blocking: boolean;
	async: boolean;
	autoExit?: boolean;
	deliveredTo: CompletedDelivery | null;
}

export interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	mode: "interactive" | "background";
	executionState: "starting" | "running";
	deliveryState: DeliveryState;
	parentClosePolicy: ParentClosePolicy;
	blocking: boolean;
	async: boolean;
	autoExit?: boolean;
	resultOwner?: { kind: CompletedDelivery; ownerId: string };
	completionPromise?: Promise<SubagentResult>;
	surface?: string;
	childProcess?: ChildProcess;
	startTime: number;
	sessionFile: string;
	entries?: number;
	bytes?: number;
	messageCount?: number;
	toolUses?: number;
	totalTokens?: number;
	modelContextWindow?: number;
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
}

export interface StartedSubagentToolDetails {
	id?: string;
	name?: string;
	status?: string;
	error?: string;
	deliveryState?: string;
	parentClosePolicy?: string;
	blocking?: boolean;
	async?: boolean;
	autoExit?: boolean;
}

export interface SyncSubagentToolDetails {
	id?: string;
	name?: string;
	status?: string;
	error?: string;
	mode?: string;
	deliveryState?: string;
	autoExit?: boolean;
	outputTokens?: number;
	ids?: string[];
}

export interface ListedSubagentInfo {
	name: string;
	description?: string;
	model?: string;
	mode?: string;
	source: string;
}

export interface SubagentsListToolDetails {
	agents?: ListedSubagentInfo[];
}

export interface ResumeToolDetails extends StartedSubagentToolDetails {
	sessionFile?: string;
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
	error?: string;
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
