# AGENTS.md

At the start of every task, read `README.md` first. Then inspect the relevant code paths before planning or changing anything so you understand the task's scope and the issue being addressed.

## Project structure contract

Keep the repository organized by ownership. Do not recreate a catch-all `src/subagents/` or generic `test/parts/` directory.

Source layout:

- `src/subagents.ts` is extension wiring only: event hooks, tool registration, and thin glue.
- `src/agents/` owns agent definitions, catalog messaging, and titles.
- `src/launch/` owns child launch preparation, launch policy, child command construction, resume args, prompt artifacts, runtime path resolution, and session seeding.
- `src/runtime/` owns running state, wait/join, shutdown, background/interactive watchers, result routing, and widgets.
- `src/session/` owns JSONL session helpers and trimmed fork-session logic.
- `src/tools/` owns Pi tool/command implementations and tool policy.
- `src/mux/` owns multiplexer internals; `src/mux.ts` is the public barrel.
- `src/artifact-storage.ts` owns artifact storage roots/paths. `src/launch/prompt-artifacts.ts` owns writing launch prompt/task artifact files. Do not blur these names.
- `src/types.ts` is shared runtime type surface only; do not turn it into a junk drawer.

Test layout:

- Use `test/`, not `tests/`; this repo follows Node package convention and `node --test` scripts already target `test/`.
- Mirror source ownership in tests: `test/agents/`, `test/launch/`, `test/runtime/`, `test/session/`, `test/tools/`, `test/mux/`, `test/artifacts/`.
- `test/test.ts` is an orchestrator that imports domain suites. Keep it small.
- `test/support/` is split by ownership: `node.ts`, `env.ts`, `fixtures.ts`, `project.ts`, `index.ts`. Do not recreate a fat `test/support.ts`.
- Never name split files `part-*`, `chunk-*`, or similar. File names must describe the behavior/domain they test.

## File size and split rules

- Source files should stay under ~600 LOC. If a source file approaches that, split by ownership before adding more logic.
- Test files should stay cohesive; ~600 LOC is a target, ~1000 LOC is the hard ceiling. Do not split tests just to satisfy a number if it creates artificial buckets.
- Prefer extracting a real lifecycle/domain module over making helper dumping grounds.
- Do not use `// @ts-nocheck`. If a test intentionally probes dynamic result shapes, use a local cast at that assertion instead of disabling type checking for the file.

## Naming rules

- Names should encode ownership, not implementation history. Good: `artifact-storage.ts`, `prompt-artifacts.ts`, `wait-join.test.ts`, `fork-session.test.ts`. Bad: `shared.ts`, `helpers2.ts`, `parts/`, `new-runtime.ts`.
- Avoid generic `shared/`, `utils/`, `helpers/`, or `common/` directories unless there are multiple clear consumers and no better domain name.
- Barrel files are allowed only as public/domain entrypoints (`src/mux.ts`, `test/support/index.ts`). Do not hide unused re-export files behind barrels.

## Validation gates

For ordinary code changes, run:

```bash
bunx tsc --noEmit
npm test
```

For structure/cleanup changes, also run temporary cleanup checks without adding dependencies:

```bash
bunx biome check .
bunx knip
```

Before handoff after structural work, verify file sizes:

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const roots = ['src', 'test'].filter((dir) => fs.existsSync(dir));
const exts = new Set(['.ts', '.tsx', '.js', '.jsx']);
const over = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (exts.has(path.extname(entry.name))) {
      const lines = fs.readFileSync(p, 'utf8').split('\n').length;
      const limit = p.startsWith('src/') ? 600 : 1000;
      if (lines > limit) over.push([lines, limit, p]);
    }
  }
}
for (const root of roots) walk(root);
if (over.length) {
  for (const [lines, limit, file] of over) console.log(`${lines}/${limit} ${file}`);
  process.exit(1);
}
console.log('src <= 600 LOC; test <= 1000 LOC');
NODE
```

## pi-subagents live behavior validation

For changes to subagent runtime behavior, do not rely on unit tests alone.

Run live `pi -p` repros for changes involving:

- detached/background launches
- blocking / wait / join / detach semantics
- prompt/runtime coordination
- frontmatter runtime behavior
- env-var-controlled runtime branches
- session / steer / resume behavior
- mux / pane lifecycle behavior

### Preferred live-test models

Use `thinking high`.

Preferred matrix:

- models by `nahcrof` provider (excluding `*-lightning` models) because they're cheap to run and quantized (for demonstrating weaknesses in pi-subagent's prompts)
- `zai-messages/glm-5-turbo:high`
- `zai-messages/glm-5.1:high`
- `openai-ws/gpt-5.4-mini:medium`
- `openai-ws/gpt-5.5:low`

Guidance:

- Use at least one GLM model and one GPT-5.5 model for non-trivial orchestration changes.
- Do not trust a single-model pass.

### Live-test agents

This repo does not commit fixed smoke agents (`.pi/` is gitignored). For each
live repro, create a temporary agent file shaped for the behavior under test,
either under `.pi/agents/` or under a temp root pointed at by
`PI_CODING_AGENT_DIR`, then delete it after.

Keep any such agent file temporary and remove it (or set `enabled: false`)
after testing.

### Standard live-test procedure

- Prefer `pi -p` for deterministic repros.
- Use a temporary `--session-dir`.
- Inspect session JSONL when behavior is subtle.
- Check both parent and child sessions.
- For env-var or frontmatter branches, test both enabled and disabled states.

### Classification

When evaluating parent/child behavior, classify outcomes as:

- `duplicate`
- `auxiliary`
- `clean_yield`

For guard or coordination changes, verify:

- whether direct parent tools were blocked when expected
- whether they were allowed when opt-out was enabled
- whether the behavior held for the full parent response, not just one internal continuation step

### Cleanup

After live testing:

- restore or delete any temporary agent files created for the repro
- remove temporary session dirs if no longer needed
- clear test-only environment variables
