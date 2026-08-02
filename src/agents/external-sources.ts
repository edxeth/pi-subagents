import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults, AgentSourceMetadata } from "./definitions.ts";

/** Shared event used by extensions to discover external agent-source providers. */
export const AGENT_SOURCE_DISCOVERY_EVENT = "pi-subagents.agent-sources/discover";

const MAX_DEFINITIONS_PER_PROVIDER = 256;
const MAX_DEFINITIONS_TOTAL = 256;
const MAX_AGGREGATE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_STRING_BYTES = 8192;
const MAX_PATH_BYTES = 4096;
const MAX_EXTERNAL_RANK = 100;
const MAX_EXTERNAL_TIMEOUT_SECONDS = 3600;
const PROVIDER_TIMEOUT_MS = 1000;
const AGGREGATE_TIMEOUT_MS = 3000;

/**
 * A provider-owned, already-normalized v1 definition. Deliberately narrower
 * than AgentDefaults: external sources cannot provide child control-plane
 * fields such as flags, env, extensions, cwd, trust, or task expansion.
 */
export interface NormalizedExternalAgentDefinition {
	name: string;
	description?: string;
	body?: string;
	providerId: string;
	sourceId: string;
	scope: "project" | "user";
	path: string;
	rank: number;
	enabled?: boolean;
	model?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
	tools?: string;
	skills?: string;
	injectSkills?: string;
	thinking?: string;
	denyTools?: string;
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	mode?: "interactive" | "background";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	async?: boolean;
	blocking?: boolean;
	timeout?: number;
}

export interface AgentSourceProvider {
	/** Stable provider identifier. Event-bus registration is trusted in-process communication, not authentication. */
	id: string;
	/** Providers own parsing and return normalized definitions only. */
	discover: (context: AgentSourceProviderContext) =>
		| NormalizedExternalAgentDefinition[]
		| Promise<NormalizedExternalAgentDefinition[]>;
}

export interface AgentSourceProviderContext {
	cwd: string;
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	signal: AbortSignal;
}

interface DiscoveryRequest extends AgentSourceProviderContext {
	register(provider: AgentSourceProvider): boolean;
}

interface AcceptedDefinition {
	definition: NormalizedExternalAgentDefinition;
	metadata: AgentSourceMetadata;
}

interface SourceDiagnostic {
	code: string;
	providerId?: string;
	sourceId?: string;
}

interface DiscoverySnapshot {
	cwd: string;
	generation: number;
	definitions: readonly AcceptedDefinition[];
	diagnostics: readonly SourceDiagnostic[];
}

interface DiscoveryState {
	cwd: string;
	generation: number;
	closed: boolean;
	providers: Map<string, AgentSourceProvider>;
	definitions: AcceptedDefinition[];
	diagnostics: SourceDiagnostic[];
	payloadBytes: number;
}

let snapshotsByBus = new WeakMap<object, Map<string, DiscoverySnapshot>>();
let generation = 0;

const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/u;
const XML_TAG = /<\/?[A-Za-z][^>]*>/u;

const ACCEPTED_KEYS = new Set([
	"name", "description", "body", "providerId", "sourceId", "scope", "path", "rank", "enabled",
	"model", "allowedModels", "allowModelOverride", "tools", "skills", "injectSkills", "thinking",
	"denyTools", "autoExit", "systemPromptMode", "mode", "sessionMode", "async",
	"blocking", "timeout",
]);

const STRING_KEYS = [
	"description", "model", "allowedModels", "tools", "skills", "injectSkills", "thinking", "denyTools",
] as const;
const BOOLEAN_KEYS = [
	"enabled", "allowModelOverride", "autoExit", "async", "blocking",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isSafeId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && byteLength(value) <= 64 && SAFE_ID.test(value);
}

function isSafeSingleLine(value: unknown, maxBytes: number, allowXml = false): value is string {
	return typeof value === "string" && byteLength(value) <= maxBytes &&
		!CONTROL_CHARS.test(value) && !ANSI.test(value) && !value.includes("\r") && !value.includes("\n") &&
		(allowXml || !XML_TAG.test(value));
}

function isSafeBody(value: unknown): value is string {
	return typeof value === "string" && byteLength(value) <= MAX_BODY_BYTES &&
		!CONTROL_CHARS.test(value) && !ANSI.test(value);
}

function isSafePath(value: unknown): value is string {
	return isSafeSingleLine(value, MAX_PATH_BYTES) &&
		(value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value));
}

function diagnostic(state: DiscoveryState, code: string, providerId?: string, sourceId?: string): void {
	const safeProviderId = isSafeId(providerId) ? providerId : undefined;
	const safeSourceId = isSafeId(sourceId) ? sourceId : undefined;
	state.diagnostics.push({ code, ...(safeProviderId ? { providerId: safeProviderId } : {}), ...(safeSourceId ? { sourceId: safeSourceId } : {}) });
}

function providerShapeIsValid(provider: unknown): provider is AgentSourceProvider {
	return isRecord(provider) && isSafeId(provider.id) && typeof provider.discover === "function";
}

function registerProvider(state: DiscoveryState, provider: AgentSourceProvider): boolean {
	if (state.closed) {
		diagnostic(state, "late-registration", isRecord(provider) && typeof provider.id === "string" ? provider.id : undefined);
		return false;
	}
	if (!providerShapeIsValid(provider)) {
		diagnostic(state, "invalid-provider");
		return false;
	}
	// First valid registration wins. A later extension must never erase a valid provider.
	if (state.providers.has(provider.id)) {
		diagnostic(state, "duplicate-provider", provider.id);
		return false;
	}
	state.providers.set(provider.id, provider);
	return true;
}

function validateDefinition(
	state: DiscoveryState,
	provider: AgentSourceProvider,
	value: unknown,
): NormalizedExternalAgentDefinition | null {
	if (!isRecord(value)) {
		diagnostic(state, "invalid-definition", provider.id);
		return null;
	}
	for (const key of Object.keys(value)) {
		if (!ACCEPTED_KEYS.has(key)) {
			diagnostic(state, "unknown-definition-field", provider.id);
			return null;
		}
	}
	if (!isSafeId(value.name) || !isSafeId(value.sourceId) || value.name.length > 64) {
		diagnostic(state, "invalid-identity", provider.id);
		return null;
	}
	if (value.providerId !== provider.id || !isSafeId(value.providerId)) {
		diagnostic(state, "provider-id-mismatch", provider.id, value.sourceId as string | undefined);
		return null;
	}
	if (value.scope !== "project" && value.scope !== "user") {
		diagnostic(state, "invalid-scope", provider.id, value.sourceId);
		return null;
	}
	if (!isSafePath(value.path)) {
		diagnostic(state, "invalid-source-path", provider.id, value.sourceId);
		return null;
	}
	if (typeof value.rank !== "number" || !Number.isFinite(value.rank) || !Number.isInteger(value.rank) || value.rank < 0 || value.rank > MAX_EXTERNAL_RANK) {
		diagnostic(state, "invalid-rank", provider.id, value.sourceId);
		return null;
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		diagnostic(state, "invalid-enabled", provider.id, value.sourceId);
		return null;
	}
	if (value.description !== undefined && !isSafeSingleLine(value.description, MAX_DESCRIPTION_BYTES)) {
		diagnostic(state, "invalid-description", provider.id, value.sourceId);
		return null;
	}
	if (value.body !== undefined && !isSafeBody(value.body)) {
		diagnostic(state, "invalid-body", provider.id, value.sourceId);
		return null;
	}
	for (const key of STRING_KEYS) {
		if (value[key] !== undefined && !isSafeSingleLine(value[key], MAX_STRING_BYTES)) {
			diagnostic(state, "invalid-string", provider.id, value.sourceId);
			return null;
		}
	}
	for (const key of BOOLEAN_KEYS) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") {
			diagnostic(state, "invalid-boolean", provider.id, value.sourceId);
			return null;
		}
	}
	if (value.systemPromptMode !== undefined && value.systemPromptMode !== "append" && value.systemPromptMode !== "replace") {
		diagnostic(state, "invalid-system-prompt-mode", provider.id, value.sourceId);
		return null;
	}
	if (value.mode !== undefined && value.mode !== "interactive" && value.mode !== "background") {
		diagnostic(state, "invalid-mode", provider.id, value.sourceId);
		return null;
	}
	if (value.sessionMode !== undefined && value.sessionMode !== "standalone" && value.sessionMode !== "lineage-only" && value.sessionMode !== "fork") {
		diagnostic(state, "invalid-session-mode", provider.id, value.sourceId);
		return null;
	}
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || !Number.isInteger(value.timeout) || value.timeout < 0 || value.timeout > MAX_EXTERNAL_TIMEOUT_SECONDS)) {
		diagnostic(state, "invalid-timeout", provider.id, value.sourceId);
		return null;
	}

	// Copy only the safe, normalized subset. In particular, never carry flags,
	// env, extensions, trustProject, taskExpansion, cwd, or cwdBase across the seam.
	const definition: NormalizedExternalAgentDefinition = {
		name: value.name,
		...(value.description !== undefined ? { description: value.description } : {}),
		...(value.body !== undefined ? { body: value.body } : {}),
		providerId: value.providerId,
		sourceId: value.sourceId,
		scope: value.scope,
		path: value.path,
		rank: value.rank,
		...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
		...Object.fromEntries([...STRING_KEYS, ...BOOLEAN_KEYS].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
		...(value.systemPromptMode !== undefined ? { systemPromptMode: value.systemPromptMode } : {}),
		...(value.mode !== undefined ? { mode: value.mode } : {}),
		...(value.sessionMode !== undefined ? { sessionMode: value.sessionMode } : {}),
		...(value.timeout !== undefined ? { timeout: value.timeout } : {}),
	} as NormalizedExternalAgentDefinition;
	return definition;
}

function metadataFor(definition: NormalizedExternalAgentDefinition): AgentSourceMetadata {
	return Object.freeze({
		providerId: definition.providerId,
		sourceId: definition.sourceId,
		scope: definition.scope,
		path: definition.path,
		rank: definition.rank,
		effective: true,
	});
}

function collectProviderDefinitions(state: DiscoveryState, provider: AgentSourceProvider, output: unknown): void {
	if (!Array.isArray(output)) {
		diagnostic(state, "invalid-provider-output", provider.id);
		return;
	}
	if (output.length > MAX_DEFINITIONS_PER_PROVIDER) {
		diagnostic(state, "provider-definition-limit", provider.id);
		return;
	}
	let encoded: string;
	try {
		encoded = JSON.stringify(output);
	} catch {
		diagnostic(state, "provider-output-unserializable", provider.id);
		return;
	}
	const bytes = byteLength(encoded);
	if (bytes > MAX_AGGREGATE_BYTES || state.payloadBytes + bytes > MAX_AGGREGATE_BYTES) {
		diagnostic(state, "aggregate-payload-limit", provider.id);
		return;
	}
	state.payloadBytes += bytes;
	for (const value of output) {
		if (state.definitions.length >= MAX_DEFINITIONS_TOTAL) {
			diagnostic(state, "definition-limit", provider.id);
			return;
		}
		const definition = validateDefinition(state, provider, value);
		if (!definition || definition.enabled === false) continue;
		const duplicate = state.definitions.some((candidate) =>
			candidate.metadata.providerId === definition.providerId && candidate.metadata.sourceId === definition.sourceId);
		if (duplicate) {
			diagnostic(state, "duplicate-source", provider.id, definition.sourceId);
			continue;
		}
		state.definitions.push({ definition, metadata: metadataFor(definition) });
	}
}

function scopeRank(scope: string): number {
	return scope === "project" ? 2 : 1;
}

function candidateOrder(a: AcceptedDefinition, b: AcceptedDefinition): number {
	return b.metadata.rank - a.metadata.rank ||
		scopeRank(b.metadata.scope) - scopeRank(a.metadata.scope) ||
		a.metadata.providerId.localeCompare(b.metadata.providerId) ||
		a.metadata.sourceId.localeCompare(b.metadata.sourceId) ||
		a.metadata.path.localeCompare(b.metadata.path);
}

function finalize(state: DiscoveryState): DiscoverySnapshot {
	const byName = new Map<string, AcceptedDefinition[]>();
	for (const candidate of state.definitions) {
		const list = byName.get(candidate.definition.name) ?? [];
		list.push(candidate);
		byName.set(candidate.definition.name, list);
	}
	const definitions = state.definitions.map((candidate) => {
		const candidates = byName.get(candidate.definition.name) ?? [];
		const winner = [...candidates].sort(candidateOrder)[0];
		const effective = candidate === winner;
		const shadowedBy = effective ? undefined : Object.freeze({ ...winner.metadata, effective: true });
		return Object.freeze({
			definition: Object.freeze({ ...candidate.definition }),
			metadata: Object.freeze({ ...candidate.metadata, effective, ...(shadowedBy ? { shadowedBy } : {}) }),
		});
	}).sort((a, b) => a.definition.name.localeCompare(b.definition.name) || candidateOrder(a, b));
	state.closed = true;
	return Object.freeze({
		cwd: state.cwd,
		generation: state.generation,
		definitions: Object.freeze(definitions),
		diagnostics: Object.freeze([...state.diagnostics]),
	});
}

function snapshotFor(events?: EventBus, cwd?: string): DiscoverySnapshot | undefined {
	return events && cwd ? snapshotsByBus.get(events as object)?.get(cwd) : undefined;
}

function storeSnapshot(events: EventBus, snapshot: DiscoverySnapshot): void {
	const perBus = snapshotsByBus.get(events as object) ?? new Map<string, DiscoverySnapshot>();
	const previous = perBus.get(snapshot.cwd);
	if (!previous || previous.generation <= snapshot.generation) perBus.set(snapshot.cwd, snapshot);
	snapshotsByBus.set(events as object, perBus);

}

/**
 * Register a provider using the shared Pi event bus. The event bus is trusted
 * in-process communication; it is not an authentication or identity boundary.
 */
export function registerAgentSourceProvider(events: EventBus, provider: AgentSourceProvider): () => void {
	return events.on(AGENT_SOURCE_DISCOVERY_EVENT, (value) => {
		if (!isRecord(value) || typeof value.register !== "function") return;
		(value.register as (provider: AgentSourceProvider) => boolean)(provider);
	});
}

async function discoverOne(
	state: DiscoveryState,
	provider: AgentSourceProvider,
	context: Omit<AgentSourceProviderContext, "signal">,
	aggregateSignal: AbortSignal,
): Promise<void> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	aggregateSignal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
	try {
		const output = await Promise.race([
			Promise.resolve().then(() => provider.discover({ ...context, signal: controller.signal })),
			new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		]);
		if (!state.closed && !aggregateSignal.aborted) collectProviderDefinitions(state, provider, output);
	} catch {
		if (state.closed) return;
		diagnostic(state, aggregateSignal.aborted ? "aggregate-timeout" : controller.signal.aborted ? "provider-timeout" : "provider-threw", provider.id);
	} finally {
		clearTimeout(timer);
		aggregateSignal.removeEventListener("abort", abort);
	}
}

/** Discover providers for one session. Discovery is fail-open and bounded. */
export async function discoverExternalAgentSources(
	events: EventBus,
	cwd: string,
	reason: AgentSourceProviderContext["reason"],
): Promise<void> {
	const state: DiscoveryState = {
		cwd,
		generation: ++generation,
		closed: false,
		providers: new Map(),
		definitions: [],
		diagnostics: [],
		payloadBytes: 0,
	};
	const request: DiscoveryRequest = {
		cwd,
		reason,
		signal: new AbortController().signal,
		register: (provider) => registerProvider(state, provider),
	};
	// Registration is deliberately synchronous. Providers are discovered in
	// parallel after the handshake, so one unavailable source cannot delay native startup.
	try {
		events.emit(AGENT_SOURCE_DISCOVERY_EVENT, request);
	} catch {
		diagnostic(state, "discovery-handshake-error");
	}
	const providers = [...state.providers.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_DEFINITIONS_PER_PROVIDER);
	const aggregateController = new AbortController();
	const aggregateTimer = setTimeout(() => aggregateController.abort(), AGGREGATE_TIMEOUT_MS);
	try {
		await Promise.all(providers.map((provider) => discoverOne(state, provider, { cwd, reason }, aggregateController.signal)));
	} finally {
		clearTimeout(aggregateTimer);
	}
	const snapshot = finalize(state);
	storeSnapshot(events, snapshot);
}

/** Effective external definitions for a session; prompt bodies are returned only for child construction. */
export function getExternalAgentDefinitions(
	baseCwd: string,
	nativeNames: ReadonlySet<string> = new Set(),
	events?: EventBus,
): Array<AgentDefaults & { name: string; description?: string; source: "external"; path: string; sourceMetadata: AgentSourceMetadata }> {
	const snapshot = snapshotFor(events, baseCwd);
	if (!snapshot) return [];
	return snapshot.definitions
		.filter((candidate) => candidate.metadata.effective && !nativeNames.has(candidate.definition.name))
		.map(({ definition, metadata }) => ({
			...definition,
			source: "external" as const,
			sourceMetadata: { ...metadata },
		}));
}

/** Sanitized source metadata for operator diagnostics; it contains no bodies or paths. */
export function getExternalAgentSourceDiagnostics(events?: EventBus, cwd?: string): readonly Omit<AgentSourceMetadata, "path" | "shadowedBy">[] {
	const snapshot = snapshotFor(events, cwd);
	return snapshot?.definitions.map(({ metadata }) => {
		const { path: _path, shadowedBy: _shadowedBy, ...safe } = metadata;
		return safe;
	}) ?? [];
}

export function getExternalAgentSourceDiagnosticsMessages(events?: EventBus, cwd?: string): readonly string[] {
	return snapshotFor(events, cwd)?.diagnostics.map(({ code, providerId, sourceId }) =>
		[code, providerId, sourceId].filter(Boolean).join(":")) ?? [];
}

/** Test-only reset; intentionally not exported from the package entrypoint. */
export function resetExternalAgentSourceStateForTest(): void {
	generation = 0;
	snapshotsByBus = new WeakMap();
}
