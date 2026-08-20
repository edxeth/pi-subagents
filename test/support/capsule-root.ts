import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Process-wide capsule redirection for the test suite: interactive launches
// snapshot the ambient environment, and without this seam every test that
// drives a launch writes real credentials into the shared system tmpdir.
// Capsules land in a private 0700 directory that is removed when the test
// process exits.
if (!process.env.PI_SUBAGENT_ENV_CAPSULE_DIR) {
	const capsuleRoot = mkdtempSync(join(tmpdir(), "pi-subagents-test-capsules-"));
	process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
	process.on("exit", () => {
		try {
			rmSync(capsuleRoot, { recursive: true, force: true });
		} catch {
			// Best effort; the age sweep in production code is the backstop.
		}
	});
}
