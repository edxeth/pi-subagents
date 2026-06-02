import { assert, describe, it } from "../support/index.ts";
import { MuxRuntimeProbe } from "../../src/mux/runtime-probe.ts";

describe("mux runtime probe", () => {
	it("caches command availability per PATH and re-probes after PATH changes", () => {
		let path = "/first";
		const calls: Array<{ command: string; path: string }> = [];
		const probe = new MuxRuntimeProbe({
			getPath: () => path,
			commandExists: (command) => {
				calls.push({ command, path });
				return path === "/second";
			},
		});

		assert.equal(probe.hasCommand("tmux"), false);
		assert.equal(probe.hasCommand("tmux"), false);
		path = "/second";
		assert.equal(probe.hasCommand("tmux"), true);
		assert.equal(probe.hasCommand("tmux"), true);

		assert.deepEqual(calls, [
			{ command: "tmux", path: "/first" },
			{ command: "tmux", path: "/second" },
		]);
	});
});
