#!/usr/bin/env node
// Enforce the AGENTS.md file-size contract:
//   src/**/*.{ts,tsx,js,jsx}  <= 600 lines
//   test/**/*.{ts,tsx,js,jsx} <= 1000 lines (hard ceiling)
// Run from anywhere; paths resolve from the repo root (parent of this file).
// Exits 1 with a per-file report on the first violation, 0 when all are within limits.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);
const limits = { src: 600, test: 1000 };

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const p = join(dir, entry.name);
		if (entry.isDirectory()) walk(p, out);
		else if (exts.has(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(p);
	}
	return out;
}

const over = [];
for (const root of Object.keys(limits)) {
	const dir = join(repoRoot, root);
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
	for (const file of walk(dir)) {
		const lines = readFileSync(file, "utf8").split("\n").length;
		if (lines > limits[root]) {
			over.push(`${lines}/${limits[root]} ${relative(repoRoot, file)}`);
		}
	}
}

if (over.length) {
	for (const line of over) console.log(line);
	process.exit(1);
}
console.log("src <= 600 LOC; test <= 1000 LOC");
