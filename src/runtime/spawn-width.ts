export const MAX_SPAWN_WIDTH = 16;

let liveSlotCount = 0;
let configuredWidth: number | null | undefined;
const slotOwners = new Set<{ spawnWidthSlotAcquired?: boolean }>();

function parseConfiguredWidth(raw: string | undefined): number | null {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
	const parsed = Number(raw.trim());
	return Number.isFinite(parsed) ? parsed : null;
}

export function getEffectiveSpawnWidthLimit(configured?: number | null): number {
	if (configured === undefined) {
		if (configuredWidth === undefined) initializeSpawnWidthForSession();
		configured = configuredWidth ?? null;
	}
	return Math.min(configured ?? Number.POSITIVE_INFINITY, MAX_SPAWN_WIDTH);
}

export function initializeSpawnWidthForSession(env: Record<string, string | undefined> = process.env): void {
	const raw = env.PI_SUBAGENT_AGENT?.trim() && env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE !== undefined
		? env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE
		: env.PI_SUBAGENT_SPAWN_WIDTH;
	configuredWidth = parseConfiguredWidth(raw);
}

export function getSpawnWidthLimit(): number {
	if (configuredWidth === undefined) initializeSpawnWidthForSession();
	return getEffectiveSpawnWidthLimit(configuredWidth ?? null);
}

/**
 * Reserve all requested slots before an async launch begins. The caller must
 * release reservations for children that never become live owners.
 */
export function tryAcquireSlots(count: number, limit: number | null): boolean {
	if (count <= 0) return true;
	const effectiveLimit = limit === null ? null : getEffectiveSpawnWidthLimit(limit);
	if (effectiveLimit !== null && liveSlotCount + count > effectiveLimit) return false;
	liveSlotCount += count;
	return true;
}

export function releaseSlots(count: number): void {
	if (count <= 0) return;
	liveSlotCount = Math.max(0, liveSlotCount - count);
}

export function getLiveSlotCount(): number {
	return liveSlotCount;
}

export function claimSpawnWidthSlot(owner: { spawnWidthSlotAcquired?: boolean }): void {
	owner.spawnWidthSlotAcquired = true;
	slotOwners.add(owner);
}

export function releaseSpawnWidthSlot(owner: { spawnWidthSlotAcquired?: boolean }): void {
	if (!slotOwners.delete(owner)) return;
	owner.spawnWidthSlotAcquired = false;
	releaseSlots(1);
}

export function releaseSpawnWidthSlotOnCompletion<T>(
	owner: { spawnWidthSlotAcquired?: boolean },
	promise: Promise<T>,
): Promise<T> {
	return promise.finally(() => releaseSpawnWidthSlot(owner));
}

export function resetSpawnWidthForTest(): void {
	for (const owner of slotOwners) owner.spawnWidthSlotAcquired = false;
	slotOwners.clear();
	liveSlotCount = 0;
	configuredWidth = undefined;
}
