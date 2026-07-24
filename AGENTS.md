# AGENTS.md

Read `README.md` before doing anything. It documents the model, frontmatter, placement policies, and env vars this package exposes.

## Package facts

- This is a Pi package extension. Extension entrypoint is `src/index.ts`.
- Tests run on plain `node --test` (see `package.json` scripts). `npm test` and `bun test` both work.
- One-off checks (`tsc`, `biome`, `knip`) run via `bunx` so no extra deps are declared.

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

- Use `test/`, not `tests/`; `node --test` scripts already target `test/`.
- Mirror source ownership in tests. Each domain suite must be imported by `test/test.ts`, or `npm test` will not run it.
- `test/support/` is split by ownership; do not recreate a fat `test/support.ts`. Check the current files with `ls` rather than assuming.
- Never name split files `part-*`, `chunk-*`, or similar. File names must describe the behavior/domain they test.

## File size and split rules

- Source files should stay under ~600 LOC. If a source file approaches that, split by ownership before adding more logic.
- Test files should stay cohesive; ~600 LOC is the target, ~1000 LOC is the hard ceiling. Do not split tests just to satisfy a number if it creates artificial buckets.
- Do not use `// @ts-nocheck`. If a test probes a dynamic result shape, use a local cast at that assertion instead of disabling type checking for the file.

## Naming rules

- Names should encode ownership, not implementation history. Name files after the behavior they own, not after their history. Bad shapes: `shared.ts`, `helpers2.ts`, `parts/`, `new-runtime.ts`.
- Avoid generic `shared/`, `utils/`, `helpers/`, or `common/` directories unless there are multiple clear consumers and no better domain name.
- Barrels are allowed only as public/domain entrypoints. Do not hide unused re-export files behind them.

## Validation gates

For ordinary code changes, run:

```bash
bunx tsc --noEmit
npm test
```

For structure/cleanup changes, also run the one-off checks:

```bash
bunx biome check .
bunx knip
```

Before handoff after structural work, verify file sizes:

```bash
node scripts/check-file-sizes.mjs
```

That script enforces `src/**` <= 600 LOC and `test/**` <= 1000 LOC and exits non-zero on the first violation.

## Live behavior validation

Unit tests use fake mux backends. For changes to subagent runtime behavior, also run live repros. Do not rely on fakes alone for:

- detached/background launches
- blocking / wait / join / detach semantics
- prompt/runtime coordination
- frontmatter runtime behavior
- env-var-controlled runtime branches
- session / steer / resume behavior
- mux / pane lifecycle behavior

### Model refs are per-user

Model and provider refs are part of each user's own Pi config. Another contributor's Pi will not have the same providers.

- For any live Pi run, ask the user which model to use (`PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking]` for the Herdr smokes).
- Never hardcode provider/model refs in this file, in tests, or in scripts, and never assume a ref exists.
- Prefer `thinking high` for non-trivial orchestration changes.
- Do not trust a single-model pass; test with at least two models from different families the user has available.

### Live-test agents

This repo does not commit fixed smoke agents (`.pi/` is gitignored). For each live repro, create a temporary agent file shaped for the behavior under test, either under `.pi/agents/` or under a temp root pointed at by `PI_CODING_AGENT_DIR`, then delete it after. Remove it (or set `enabled: false`) once the repro is done.

### Standard live-test procedure

- Prefer `pi -p` for deterministic repros.
- Use a temporary `--session-dir`.
- Inspect session JSONL when behavior is subtle.
- Check both parent and child sessions.
- For env-var or frontmatter branches, test both enabled and disabled states.

### Classify parent/child outcomes

When evaluating parent/child behavior, classify each outcome:

- `duplicate` — parent and child did the same work.
- `auxiliary` — child did work that did not advance the parent's goal.
- `clean_yield` — child did the delegated work and the parent surfaced it.

For guard or coordination changes, verify whether direct parent tools were blocked when expected, allowed when opt-out was enabled, and whether the behavior held for the full parent response rather than one internal continuation step.

### Cleanup

After live testing:

- restore or delete any temporary agent files created for the repro
- remove temporary session dirs if no longer needed
- clear test-only environment variables
