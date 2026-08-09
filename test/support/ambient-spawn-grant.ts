import { afterEach, beforeEach } from "node:test";

const SPAWN_GRANT_VARS = [
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_SPAWN_DEPTH",
] as const;

type SavedSpawnGrant = ReadonlyArray<readonly [string, string | undefined]>;

let savedAmbientSpawnGrant: SavedSpawnGrant | undefined;

function restoreSpawnGrant(saved: SavedSpawnGrant): void {
	for (const [name, value] of saved) {
		if (value == null) delete process.env[name];
		else process.env[name] = value;
	}
}

// The support module is loaded by the suite's shared test entrypoint. Clear the
// operator grant for every test so files that exercise spawn policy stay root-like
// even when npm test inherits PI_SUBAGENT_* variables.
beforeEach(() => {
	savedAmbientSpawnGrant = SPAWN_GRANT_VARS.map((name) => [name, process.env[name]] as const);
	for (const [name] of savedAmbientSpawnGrant) delete process.env[name];
});

afterEach(() => {
	if (savedAmbientSpawnGrant !== undefined) restoreSpawnGrant(savedAmbientSpawnGrant);
	savedAmbientSpawnGrant = undefined;
});

/**
 * Keep tests that exercise a root-session launch independent of the operator's
 * ambient subagent spawn grant.
 */
export function withoutAmbientSpawnGrant<T>(run: () => T): T {
	const saved = SPAWN_GRANT_VARS.map((name) => [name, process.env[name]] as const);
	for (const [name] of saved) delete process.env[name];
	try {
		return run();
	} finally {
		restoreSpawnGrant(saved);
	}
}
