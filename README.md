# pi-subagents

`pi-subagents` gives [pi](https://github.com/badlogic/pi-mono) a real subagent runtime.

Pi is a minimal coding harness. It gives you extensions, skills, prompts, and packages, then stays out of your way. Subagents are not built into core on purpose. They belong in a package where the behavior is explicit and replaceable.

This package is that layer.

It began as a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). HazAT built the original async subagent extension and deserves full credit for the foundation. This fork, `edxeth/pi-subagents`, keeps the original idea, then pushes it much closer to Claude Code CLI territory: blocking launches, background workers, wait/join/detach ownership, stricter runtime control, and better separation between interactive and autonomous agents.

If you want the short version: this package gives pi a more complete subagent model, with explicit control over how child agents are launched, observed, synchronized, and resumed.

https://github.com/user-attachments/assets/e0b97493-6c9b-4710-ba26-a6c08230ba28

## Install

```bash
pi install git:github.com/edxeth/pi-subagents
```

## What it gives pi

- named subagents instead of ad-hoc prompt blobs
- detached async execution by default, with same-response coordinator-only guarding
- true blocking execution when you actually need sequential behavior
- interactive foreground children and headless background children
- explicit `wait`, `join`, and `detach` semantics
- resumable child sessions through `caller_ping` and `subagent_resume`
- session-scoped artifacts for passing reports, notes, and context around
- frontmatter that controls runtime, not just personality
- a live widget so you can see what your children are doing

That is the difference between “subagents exist” and “subagents are usable.”

## Why it exists

A scout, a reviewer, and an implementation worker are not the same thing.

Sometimes you want a child in a pane so you can watch it think. Sometimes you want it headless. Sometimes the parent should keep moving. Sometimes the parent must stop and wait. Sometimes the child should die with the parent. Sometimes it should survive.

Most tools flatten all of that into vague marketing words. This package does not. It exposes the actual runtime model.

That is why it has more than one mode. Not because complexity is fashionable. Because the problem is real.

## The model

Every subagent is a named agent definition.

By default, a child launches detached and reports back later. If the job is autonomous, it can run in the background. If the job needs visibility or direct steering, it can run interactively in its own pane. If the parent truly depends on the answer right now, the child can be awaited or launched as blocking.

So the runtime splits across a few hard boundaries:

- interactive vs background
- detached vs awaited/joined
- async vs blocking
- autonomous exit vs manual close
- terminate vs cancel vs abandon on parent shutdown

That is the core of the package.

## Agent definitions

Agents live in either of these places:

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` globally

Project-local agents override global ones with the same name.

This package leans heavily on frontmatter. Agent files are not just prompt wrappers. They are runtime declarations.

### Frontmatter reference

| Field | Default | What it does | When to use it |
| --- | --- | --- | --- |
| `name` | filename | Agent name used by `agent: "..."` | Always set it explicitly if you care about stable naming |
| `description` | unset | Human-readable description; also used for ambient routing | Write one short, sharp line if you want the parent to discover and route to it well |
| `enabled` | `true` | Hides the agent from discovery and blocks launch when `false` | Disable agents without deleting them |
| `model` | pi default | Sets the model for that agent | Pin a model when the role needs a specific speed/quality tradeoff |
| `thinking` | model default | Sets pi thinking level | Raise it for scouts/reviewers, lower it for cheap utility agents |
| `tools` | `all` | Built-in pi tools only: `all`, `none`, or a comma-separated subset of `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Omit or set `all` for normal built-ins, set `none` to disable built-ins while keeping extension/protocol tools, or list only what the agent needs |
| `skills` | unset | Auto-loads one or more named skills from a comma-separated list | Use when an agent always needs the same external guidance |
| `extensions` | unset | Comma-separated extension allowlist for child launch; if unset, child loads all extensions | Use to keep child agents off extensions |
| `system-prompt` | task-body routing | `append` uses `--append-system-prompt`; `replace` uses `--system-prompt` | Use `replace` for hard role isolation, `append` when you want to preserve more surrounding context |
| `spawning` | `true` | Allows or denies subagent-spawning tools | Set `false` for workers that should do the job themselves |
| `deny-tools` | unset | Denies specific child-session tools by name | Use for surgical restrictions without rewriting the whole tool set |
| `auto-exit` | `false` | Child exits automatically after a normal completion | Best for autonomous agents, especially background scouts and reviewers |
| `blocking` | `false` | Makes the parent wait for that agent by default | Use when the parent genuinely cannot continue without that answer |
| `no-context-files` | `false` | Disables automatic `AGENTS.md` / `CLAUDE.md` discovery for spawned child sessions | Use only when you want a clean child run without project context injection |
| `cwd` | parent cwd | Default working directory for the child | Use for role directories, monorepo packages, or project-specific specialists |
| `mode` | `interactive` | `interactive` pane or `background` headless child | Use `background` for autonomous work; keep `interactive` when visibility matters |
| `session-mode` | `standalone` | Session seeding mode: `standalone`, `lineage-only`, or `fork` | Use `lineage-only` when you want parent/child lineage without inheriting the conversation; use `fork` when the child needs the full branch |
| `fork` | `false` | Back-compat shorthand for `session-mode: fork` | Keep for older agents; prefer `session-mode` for new ones |
| `timeout` | unset | Background timeout in seconds | Use only for background agents that should never run forever |

#### How `extensions` works

You only need to define `extensions` for agents that should be restricted.
If an agent does not set `extensions`, the child session behaves exactly as before and loads all extensions available to that child environment.

When you do set `extensions`, treat it as a comma-separated allowlist of normal `pi -e` extension sources.
The child session starts with `--no-extensions` and then adds only the listed sources back, plus the internal `subagent-done` helper that this package loads automatically.
You do **not** need to list `subagent-done` yourself.

Use local paths for local extensions:

```md
---
name: reviewer
extensions: .pi/extensions/my-safe-ext, ~/.pi/agent/extensions/other-ext
---
```

Use source prefixes for package or remote sources:

```md
---
name: reviewer
extensions: npm:@foo/bar, git:github.com/user/repo
---
```

Important details:

- Local paths do not need `npm:` or `git:` prefixes.
- Package and remote sources should keep their normal `npm:`, `git:`, `https:`, or `ssh:` prefixes.
- Bare names such as `subagents` are treated as paths, not package lookups. If you mean an installed or remote package, use its full source string.

### Practical presets

- **Scout / reviewer / analyzer**: `mode: background`, `auto-exit: true`, usually `spawning: false`
- **Interactive specialist**: `mode: interactive`, usually no `auto-exit`
- **Sequential gatekeeper**: `blocking: true`
- **Monorepo role agent**: `cwd: ./packages/...`
- **Locked-down worker**: narrow `tools`, `spawning: false`, maybe `deny-tools`, maybe `extensions`

If you want a concrete example of the style this package is built for, look at this scout agent:

- [Scout agent gist by edxeth](https://gist.github.com/edxeth/11b6a6cdf7c6068771a5e3f96ab5e34b)

That gist shows the intended shape: sharp role, explicit contract, minimal ambiguity.

## How subagents behave

A child can run in one of two ways.

### Interactive

The child gets its own pane or surface.

Use this when you want visibility, live steering, or just prefer seeing the work happen.

Supported backends:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/)

### Background

The child runs headlessly as its own `pi -p` process.

Use this for scouts, reviewers, analyzers, and other autonomous workers that do not need a pane.

### Detached, awaited, joined, blocking

Detached is the default. The child runs and the result comes back later.

There is one important runtime guard: after a detached launch, the parent's **current response** becomes coordinator-only by default. In that same response, the parent can launch more subagents or use subagent coordination tools, but direct implementation tools are blocked so the parent does not immediately redo delegated work.

While the guard is active, only `subagent`, `subagent_*`, and `subagents_*` tools are allowed. The guard clears after successful synchronization/control (`subagent_wait`, `subagent_join`, or `subagent_detach`), after failed launch or validation-like sync failure, at the end of the assistant response, on the next user input, and on session switch/start/shutdown.

If you want to disable this scoped same-response guard and take full control yourself, set `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1`. This lets the parent use normal tools immediately after detached launches; rely on your own prompts or process to avoid duplicate delegated work.

Session seeding defaults to `standalone`, but agents can choose `session-mode: lineage-only` or `session-mode: fork`. An explicit tool-call `fork: true` still forces fork mode for that specific launch.

If the parent depends on a child result, you can claim ownership of delivery with `subagent_wait` or `subagent_join`.

If a child should gate the parent immediately, use blocking execution. Agent frontmatter can set `blocking: true` to make that agent block by default, and a specific launch can pass `blocking: true` to opt into waiting. Passing `blocking: false` is accepted as a harmless explicit default, but it never disables an agent whose frontmatter already forces blocking.

That does **not** turn the whole system into sequential mode. It only means that specific child is awaited at launch time. Detached siblings keep running.

## Why the runtime has so many settings

Because there is no single sane policy for all agents.

A codebase scout should usually run autonomously and get out of the way. A reviewer may need blocking behavior. A long-running background worker may need a timeout. An interactive child may need to stay open after user takeover instead of auto-exiting. A parent may want to cancel one child and abandon another.

This package exposes those differences instead of pretending they are the same thing.

That is the whole philosophy.

## Child-to-parent handoff

There are three main ways a child finishes.

### `auto-exit`

Best for autonomous workers. The child exits when its turn finishes normally.

### `subagent_done`

Best when the child should explicitly decide when it is done.

### `caller_ping`

Best when the child needs help from the parent.

A child can stop, send a message upward, and hand back a resumable session file. The parent can answer and resume that exact session later. That gives you a real feedback loop instead of a dead end.

## Session artifacts

Subagents can write artifacts into a session-scoped store under pi history.

This is the clean handoff layer for:

- scouting reports
- review notes
- research
- intermediate context
- resumable work products

Top-level sessions get `read_artifact`.
Spawned subagents get both `write_artifact` and `read_artifact`.

The point is simple: if a child produces something structured, it should have a place to put it that is not random repo clutter.

## Ambient awareness

Top-level sessions can receive a hidden catalog of available named subagents built from agent descriptions.

That lets the parent model know which specialists exist without spamming visible history. Child sessions do not get this catalog. Agents without descriptions remain launchable, but they are omitted from the ambient routing hint.

If you do not want that behavior, disable it.

## Environment variables

These are the ones worth knowing.

### Core runtime

- `PI_SUBAGENT_MUX` — force the mux backend: `cmux`, `tmux`, `zellij`, or `wezterm`
- `PI_CODING_AGENT_DIR` — override the global pi agent config root
- `PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS` — disable the hidden top-level subagent catalog
- `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` — disable the scoped same-response guard after detached launches
- `PI_ARTIFACT_PROJECT_ROOT` — override artifact root resolution
- `PI_SUBAGENT_SHELL_READY_DELAY_MS` — override the interactive shell startup delay before sending a child command (default `500`)
- `PI_SUBAGENT_ENABLE_SET_TAB_TITLE` — opt in to registering the `set_tab_title` tool
- `PI_SUBAGENT_RENAME_TMUX_WINDOW` — opt in to tmux window renaming
- `PI_SUBAGENT_RENAME_TMUX_SESSION` — opt in to tmux session renaming

### Runtime-managed internals

These are normally set by the extension itself, but they matter if you are reading the codebase or debugging behavior:

- `PI_DENY_TOOLS`
- `PI_SUBAGENT_EXTENSIONS`
- `PI_SUBAGENT_NAME`
- `PI_SUBAGENT_AGENT`
- `PI_SUBAGENT_SESSION`
- `PI_SUBAGENT_SURFACE`
- `PI_SUBAGENT_AUTO_EXIT`

### Live test knobs

- `PI_SUBAGENT_ALLOW_LIVE_WINDOWS`
- `PI_SUBAGENT_LIVE_MODEL`
- `PI_SUBAGENT_KEEP_E2E_TMP`
- `PI_SUBAGENT_LIVE_LOCK_PATH`

## UI

The package adds two useful pieces of UI.

The parent session gets a live subagent widget above the editor showing running children, elapsed time, activity, and basic context usage.

Each child session also gets its own tools widget so you can see what is available and what is denied.

That sounds minor until you start juggling several agents. Then it stops sounding minor.

## Testing

There are ordinary tests and live end-to-end smoke tests.

```bash
npm test
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-blocking
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-mix-blocking
npm run test:e2e-live-deny-tools
npm run test:e2e-live-tools
npm run test:e2e-live-extensions
```

The live tests are intentionally gated so they do not spray terminal windows all over your machine by accident.

## Credits

- upstream foundation: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
- this fork: [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents)

## License

MIT
