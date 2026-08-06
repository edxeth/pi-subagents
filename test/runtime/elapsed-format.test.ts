import { formatElapsed } from "../../src/runtime/wiring.ts";
import { assert, describe, it } from "../support/index.ts";

describe("elapsed formatting", () => {
	it("formats watcher elapsed values as seconds, not milliseconds", () => {
		assert.equal(formatElapsed(7), "7s");
		assert.equal(formatElapsed(65), "1m 5s");
	});
});
