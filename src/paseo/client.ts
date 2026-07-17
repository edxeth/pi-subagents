import { randomUUID } from "node:crypto";

type PaseoAgentStatus =
	| "initializing"
	| "idle"
	| "running"
	| "error"
	| "closed";

export interface PaseoAgentSnapshot {
	id: string;
	provider?: string;
	cwd: string;
	workspaceId?: string;
	model?: string | null;
	thinkingOptionId?: string | null;
	effectiveThinkingOptionId?: string | null;
	status: PaseoAgentStatus;
	title?: string | null;
	labels?: Record<string, string>;
	lastError?: string;
	lastUsage?: {
		totalTokens?: number;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

interface PaseoFetchAgentResult {
	agent: PaseoAgentSnapshot;
	project?: unknown;
}

export interface PaseoCreateAgentOptions {
	config: Record<string, unknown> & { provider: "pi"; cwd: string };
	env?: Record<string, string>;
	workspaceId?: string;
	initialPrompt?: string;
	labels?: Record<string, string>;
	requestId?: string;
}

export interface PaseoTimelineEntry {
	item?: {
		type?: string;
		callId?: string;
		messageId?: string;
		text?: string;
		message?: string;
		status?: string;
		detail?: { exitCode?: number | null };
	};
	[key: string]: unknown;
}

export interface PaseoFetchAgentTimelinePayload {
	agentId: string;
	agent?: PaseoAgentSnapshot | null;
	entries: PaseoTimelineEntry[];
	error?: string | null;
	[key: string]: unknown;
}

export interface PaseoWaitForFinishResult {
	status: "idle" | "error" | "permission" | "timeout";
	final: PaseoAgentSnapshot | null;
	error: string | null;
	lastMessage: string | null;
}

export interface PaseoClient {
	createAgent(options: PaseoCreateAgentOptions): Promise<PaseoAgentSnapshot>;
	sendAgentMessage(
		agentId: string,
		text: string,
		options?: { messageId?: string },
	): Promise<void>;
	fetchAgent(agentId: string): Promise<PaseoFetchAgentResult | null>;
	waitForFinish(
		agentId: string,
		options?: { timeoutMs?: number },
	): Promise<PaseoWaitForFinishResult>;
	fetchAgentTimeline(
		agentId: string,
		options?: { direction?: "tail" | "before" | "after"; limit?: number; projection?: "projected" | "canonical" },
	): Promise<PaseoFetchAgentTimelinePayload>;
	cancelAgent(agentId: string): Promise<void>;
	close(): Promise<void>;
}

export interface PaseoClientConnectOptions {
	host?: string;
	timeoutMs?: number;
	clientId?: string;
	env?: NodeJS.ProcessEnv;
}

class PaseoUnavailableError extends Error {
	override name = "PaseoUnavailableError";
}

export function isPaseoUnavailableError(error: unknown): boolean {
	return error instanceof PaseoUnavailableError;
}

let clientFactoryForTest:
	| ((options?: PaseoClientConnectOptions) => Promise<PaseoClient>)
	| null = null;

export function setPaseoClientFactoryForTest(
	factory: ((options?: PaseoClientConnectOptions) => Promise<PaseoClient>) | null,
): void {
	clientFactoryForTest = factory;
}

export async function createPaseoClient(
	options: PaseoClientConnectOptions = {},
): Promise<PaseoClient> {
	if (clientFactoryForTest) return clientFactoryForTest(options);
	const client = new RawPaseoClient(options);
	await client.connect();
	return client;
}

interface DaemonTarget {
	url: string;
	password?: string;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string[],
) => RawWebSocket;

interface RawWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: (event: any) => void, options?: unknown): void;
	removeEventListener(type: string, listener: (event: any) => void): void;
}

const DEFAULT_HOST = "localhost:6767";
const DEFAULT_TIMEOUT_MS = 15000;
// Paseo hides custom providers such as `pi` from pre-0.1.45 clients for
// protocol compatibility. This extension-only client needs to identify as a
// modern Paseo client or fetch/wait calls for Pi agents appear as "not found".
const PASEO_CLIENT_APP_VERSION = "0.1.45";

function resolveDaemonTarget(
	hostInput: string | undefined,
	env: NodeJS.ProcessEnv,
): DaemonTarget {
	const raw = (hostInput ?? env.PASEO_HOST ?? DEFAULT_HOST).trim();
	if (!raw) return resolveDaemonTarget(DEFAULT_HOST, env);

	if (raw.startsWith("unix://") || raw.startsWith("pipe://") || raw.startsWith("/")) {
		throw new PaseoUnavailableError(
			`Paseo IPC daemon target ${JSON.stringify(raw)} is not supported by the extension-only client. Set PASEO_HOST to a TCP host such as localhost:6767.`,
		);
	}

	if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
		return { url: raw, ...(env.PASEO_PASSWORD ? { password: env.PASEO_PASSWORD } : {}) };
	}

	if (raw.startsWith("tcp://")) {
		const parsed = new URL(raw);
		const useTls = parsed.searchParams.get("ssl") === "true";
		const password = parsed.searchParams.get("password") ?? env.PASEO_PASSWORD;
		return {
			url: `${useTls ? "wss" : "ws"}://${parsed.host}/ws`,
			...(password ? { password } : {}),
		};
	}

	const host = /^\d+$/.test(raw) ? `127.0.0.1:${raw}` : raw;
	return {
		url: `ws://${host.replace(/\/$/, "")}/ws`,
		...(env.PASEO_PASSWORD ? { password: env.PASEO_PASSWORD } : {}),
	};
}

function getWebSocketConstructor(): WebSocketConstructor {
	const WebSocketImpl = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
	if (!WebSocketImpl) {
		throw new PaseoUnavailableError(
			"No global WebSocket implementation is available. Use Node.js 22+ or configure PI_SUBAGENT_BACKEND=local.",
		);
	}
	return WebSocketImpl;
}

function parseMessageEventData(data: unknown): unknown {
	if (typeof data === "string") return JSON.parse(data);
	if (data instanceof ArrayBuffer) {
		return JSON.parse(Buffer.from(data).toString("utf8"));
	}
	if (ArrayBuffer.isView(data)) {
		return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
	}
	return JSON.parse(String(data));
}

class RawPaseoClient implements PaseoClient {
	private readonly target: DaemonTarget;
	private readonly timeoutMs: number;
	private readonly clientId: string;
	private ws: RawWebSocket | null = null;
	private readonly sessionListeners = new Set<(message: any) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private closedError: Error | null = null;

	constructor(options: PaseoClientConnectOptions) {
		const env = options.env ?? process.env;
		this.target = resolveDaemonTarget(options.host, env);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.clientId = options.clientId ?? `pi-subagents-${process.pid}-${randomUUID()}`;
	}

	async connect(): Promise<void> {
		const WebSocketImpl = getWebSocketConstructor();
		const protocols = this.target.password
			? [`paseo.bearer.${this.target.password}`]
			: undefined;
		const ws = new WebSocketImpl(this.target.url, protocols);
		this.ws = ws;

		ws.addEventListener("message", this.handleMessage);
		ws.addEventListener("close", this.handleClose);
		ws.addEventListener("error", this.handleError);

		await this.waitForOpen(ws);
		this.sendRaw({
			type: "hello",
			clientId: this.clientId,
			clientType: "cli",
			protocolVersion: 1,
			appVersion: PASEO_CLIENT_APP_VERSION,
		});
		await this.waitForSessionMessage(
			(message) =>
				message?.type === "status" &&
				message.payload?.status === "server_info"
					? true
					: undefined,
			this.timeoutMs,
		);
	}

	async createAgent(options: PaseoCreateAgentOptions): Promise<PaseoAgentSnapshot> {
		const requestId = options.requestId ?? randomUUID();
		return this.sendSessionRequest<PaseoAgentSnapshot>({
			requestId,
			message: {
				type: "create_agent_request",
				requestId,
				config: options.config,
				...(options.env ? { env: options.env } : {}),
				...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
				...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
				...(options.labels ? { labels: options.labels } : {}),
			},
			select: (message) => {
				if (message?.type !== "status") return undefined;
				const payload = message.payload;
				if (payload?.requestId !== requestId) return undefined;
				if (payload.status === "agent_create_failed") {
					throw new Error(payload.error ?? "Paseo failed to create agent");
				}
				return payload.status === "agent_created" ? payload.agent : undefined;
			},
		});
	}

	async sendAgentMessage(
		agentId: string,
		text: string,
		options: { messageId?: string } = {},
	): Promise<void> {
		const requestId = randomUUID();
		await this.sendSessionRequest<true>({
			requestId,
			message: {
				type: "send_agent_message_request",
				requestId,
				agentId,
				text,
				messageId: options.messageId ?? randomUUID(),
			},
			select: (message) => {
				if (message?.type !== "send_agent_message_response") return undefined;
				const payload = message.payload;
				if (payload?.requestId !== requestId) return undefined;
				if (!payload.accepted) {
					throw new Error(payload.error ?? "Paseo rejected the agent message");
				}
				return true;
			},
		});
	}

	async fetchAgent(agentId: string): Promise<PaseoFetchAgentResult | null> {
		const requestId = randomUUID();
		return this.sendSessionRequest<PaseoFetchAgentResult | null>({
			requestId,
			message: {
				type: "fetch_agent_request",
				requestId,
				agentId,
			},
			select: (message) => {
				if (message?.type !== "fetch_agent_response") return undefined;
				const payload = message.payload;
				if (payload?.requestId !== requestId) return undefined;
				if (payload.error) throw new Error(payload.error);
				return payload.agent ? { agent: payload.agent, project: payload.project } : null;
			},
		});
	}

	async waitForFinish(
		agentId: string,
		options: { timeoutMs?: number } = {},
	): Promise<PaseoWaitForFinishResult> {
		const requestId = randomUUID();
		return this.sendSessionRequest<PaseoWaitForFinishResult>({
			requestId,
			message: {
				type: "wait_for_finish_request",
				requestId,
				agentId,
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			},
			select: (message) => {
				if (message?.type !== "wait_for_finish_response") return undefined;
				const payload = message.payload;
				return payload?.requestId === requestId ? payload : undefined;
			},
			timeoutMs: options.timeoutMs ? options.timeoutMs + 5000 : 24 * 60 * 60 * 1000,
		});
	}

	async fetchAgentTimeline(
		agentId: string,
		options: { direction?: "tail" | "before" | "after"; limit?: number; projection?: "projected" | "canonical" } = {},
	): Promise<PaseoFetchAgentTimelinePayload> {
		const requestId = randomUUID();
		return this.sendSessionRequest<PaseoFetchAgentTimelinePayload>({
			requestId,
			message: {
				type: "fetch_agent_timeline_request",
				requestId,
				agentId,
				direction: options.direction ?? "tail",
				limit: options.limit ?? 100,
				projection: options.projection ?? "projected",
			},
			select: (message) => {
				if (message?.type !== "fetch_agent_timeline_response") return undefined;
				const payload = message.payload;
				if (payload?.requestId !== requestId) return undefined;
				if (payload.error) throw new Error(payload.error);
				return payload;
			},
		});
	}

	async cancelAgent(agentId: string): Promise<void> {
		const requestId = randomUUID();
		await this.sendSessionRequest<true>({
			requestId,
			message: {
				type: "cancel_agent_request",
				requestId,
				agentId,
			},
			select: (message) => {
				if (message?.type !== "cancel_agent_response") return undefined;
				return message.payload?.requestId === requestId ? true : undefined;
			},
		});
	}

	async close(): Promise<void> {
		this.ws?.close();
		this.ws = null;
	}

	private waitForOpen(ws: RawWebSocket): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new PaseoUnavailableError(`Timed out connecting to Paseo daemon at ${this.target.url}`));
			}, this.timeoutMs);

			const cleanup = () => {
				clearTimeout(timer);
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
				ws.removeEventListener("close", onClose);
			};
			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = (event: any) => {
				cleanup();
				reject(new PaseoUnavailableError(`Failed to connect to Paseo daemon at ${this.target.url}: ${event?.message ?? "WebSocket error"}`));
			};
			const onClose = () => {
				cleanup();
				reject(new PaseoUnavailableError(`Paseo daemon closed the connection at ${this.target.url}`));
			};

			ws.addEventListener("open", onOpen, { once: true });
			ws.addEventListener("error", onError, { once: true });
			ws.addEventListener("close", onClose, { once: true });
		});
	}

	private sendRaw(message: unknown): void {
		if (!this.ws) throw new PaseoUnavailableError("Paseo client is not connected");
		this.ws.send(JSON.stringify(message));
	}

	private sendSession(message: unknown): void {
		this.sendRaw({ type: "session", message });
	}

	private async sendSessionRequest<T>(params: {
		requestId: string;
		message: Record<string, unknown>;
		select(message: any): T | undefined;
		timeoutMs?: number;
	}): Promise<T> {
		const response = this.waitForSessionMessage<T>(
			(message) => {
				if (
					message?.type === "rpc_error" &&
					message.payload?.requestId === params.requestId
				) {
					throw new Error(message.payload.error ?? "Paseo RPC error");
				}
				return params.select(message);
			},
			params.timeoutMs ?? this.timeoutMs,
		);
		this.sendSession(params.message);
		return response;
	}

	private waitForSessionMessage<T>(
		selector: (message: any) => T | undefined,
		timeoutMs: number,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.closedError) {
				reject(this.closedError);
				return;
			}
			const timer = setTimeout(() => {
				cleanup();
				reject(new PaseoUnavailableError(`Timed out waiting for Paseo daemon response after ${timeoutMs}ms`));
			}, timeoutMs);

			const cleanup = () => {
				clearTimeout(timer);
				this.sessionListeners.delete(onMessage);
				this.closeListeners.delete(onClose);
			};
			const onClose = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onMessage = (message: any) => {
				let selected: T | undefined;
				try {
					selected = selector(message);
				} catch (error) {
					cleanup();
					reject(error);
					return;
				}
				if (selected === undefined) return;
				cleanup();
				resolve(selected);
			};

			this.sessionListeners.add(onMessage);
			this.closeListeners.add(onClose);
		});
	}

	private handleMessage = (event: any) => {
		let parsed: any;
		try {
			parsed = parseMessageEventData(event?.data);
		} catch {
			return;
		}
		if (parsed?.type === "ping") {
			this.sendRaw({ type: "pong" });
			return;
		}
		if (parsed?.type !== "session") return;
		for (const listener of [...this.sessionListeners]) listener(parsed.message);
	};

	private handleClose = (event: any) => {
		this.closedError = new PaseoUnavailableError(
			`Paseo daemon connection closed${event?.reason ? `: ${event.reason}` : ""}`,
		);
		for (const listener of [...this.closeListeners]) listener(this.closedError);
	};

	private handleError = (event: any) => {
		this.closedError = new PaseoUnavailableError(
			`Paseo daemon connection error${event?.message ? `: ${event.message}` : ""}`,
		);
		for (const listener of [...this.closeListeners]) listener(this.closedError);
	};
}
