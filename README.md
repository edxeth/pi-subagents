# pi-subagents

`pi-subagents` is a highly curated multi-agent framework for [Pi agent harness](https://github.com/earendil-works/pi).

It began as a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), then grew into a monumental refactor: named agents, interactive panes, background workers, async parallelism, blocking agents, child-to-parent communication, forked context, a beautiful TUI widget, orchestrator mode, and much more!

Use it when one agent should hand work to another agent instead of trying to do everything in one transcript. Interactive children open in Herdr, cmux, tmux, zellij, or WezTerm; background children run headlessly.

https://github.com/user-attachments/assets/e0b97493-6c9b-4710-ba26-a6c08230ba28

## Acknowledgements

Special thanks to [@FasalZein](https://github.com/FasalZein) and [@isthatyousaf](https://github.com/isthatyousaf) — for their contributions, ideas, and for providing access to frontier models like GPT and Claude, which made it possible to experiment and build this extension. Good guys, I owe them a lot!

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

## Install

```bash
pi install git:github.com/edxeth/pi-subagents
```

## The model

A subagent is a named agent file plus a launch policy.

The agent file says who the child is and how it should run. The parent still owns the decision to launch it. The child owns the task it receives.

Two axes matter:

- `interactive` or `background`: where the child runs
- async or sync: whether the parent waits

`interactive` means foreground. Pi opens a visible surface through Herdr, cmux, tmux, zellij, or WezTerm. Normal launches use a backend-specific surface, such as a tab, window, split, or stacked pane.

`background` means headless. Pi starts a `pi -p` child process without opening a pane.

Async means the parent gets a “started” result and the child answer comes back later. Sync means the parent waits for the child answer before it continues.

### Interactive mux backends

Interactive children open in your current terminal backend. `pi-subagents` supports Herdr, cmux, tmux, zellij, and WezTerm.

Start `pi` inside the backend you want to use. Leave `PI_SUBAGENT_MUX` unset to let Pi detect it, or set it to `herdr`, `cmux`, `tmux`, `zellij`, or `wezterm` to force one.

The backend command must exist, and Pi must be able to see the current pane or session context. If no supported backend is active, interactive launches fail with a setup hint.

Normal launches use a backend-specific surface. Herdr creates a new tab in the parent workspace and labels child agent tabs with the child session title, such as `[reviewer] Auth implementation review`. Other backends may use windows, splits, or stacked panes.

### Orchestrator mode

You can turn the parent session into an orchestrator — an agent that can only
delegate. It spawns sub-agents, waits for results, and synthesizes answers.
It cannot read files, run commands, edit code, or search the codebase itself.

```bash
PI_ORCHESTRATOR_MODE=1 pi
```

Export it in your shell rc to enable permanently:

```bash
export PI_ORCHESTRATOR_MODE=1
```

Enable that and two things change:

1. **Tool restriction.** Removes read, bash, edit, write,
   grep, find, and every other tool except subagent,
   subagent_kill, subagent_resume. The LLMs cannot call what they cannot see.
2. **System prompt replacement.** Pi's "expert coding assistant" prompt gets
   replaced with one that defines the orchestrator role: decompose, delegate,
   synthesize. The replacement preserves Pi's `APPEND_SYSTEM.md` content.

Children do not inherit any of this. Each child is a separate pi process with
its own system prompt chain — Pi default plus the child's agent body.
`system-prompt: append` appends to Pi's default, not the orchestrator prompt.
`system-prompt: replace` replaces Pi's default with the child's body. Neither
sees the orchestrator identity.

#### Why orchestrator mode exists

Models default to doing work themselves. Given the chance, they read the file,
write the fix, run the test. That works for single-agent tasks. For
multi-agent workflows it defeats the purpose — you pay for two agents to race
each other, and the parent floods its context with execution details instead
of staying focused on coordination.

Every production multi-agent framework hits this same limit. Anthropic's
Claude Code has `COORDINATOR_MODE` with the same mechanism: restricted tool
set, replacement system prompt, worker isolation. OpenAI Codex users file
issues asking for a mode where the main agent "cannot execute, only
delegate." The ADCS delegation chain spec encodes it as a scope-intersection
invariant: each hop narrows permissions, never widens.

The research calls it brain/hands separation. The orchestrator holds the
plan. Workers hold the execution context. You keep them apart because mixing
them makes both worse — the orchestrator loses sight of the plan when it
starts reading files, and workers get confused about their role when they see
orchestrator-level strategy in their context.

#### When to use it

Orchestrator mode shines on tasks that decompose into parallel work:
independent research questions, multiple implementation targets, verify-after-
write cycles. The orchestrator defines the structure, dispatches each piece
to the right agent, reads results, and writes the next round of instructions.

Simple requests do not benefit. A single sub-agent handles those faster.

## Agent definitions

Agents live here:

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` globally, or `$PI_CODING_AGENT_DIR/agents/` when that env var is set

Project agents override global agents with the same name.

A minimal agent:

```md
---
name: scout
description: Inspect the codebase and report the relevant files.
mode: background
auto-exit: true
tools: read,grep,find,ls
---

You are a codebase scout. Find the relevant files, read enough to be useful, and return a concise map of what matters.
```

The `description` matters. Pi uses it for ambient awareness, explained next.

For a fuller example of the intended style, see the [scout agent gist by edxeth](https://gist.github.com/edxeth/11b6a6cdf7c6068771a5e3f96ab5e34b). It shows the shape this package works best with: a sharp role, an explicit contract, and little room for interpretation.

### Frontmatter reference

| Field | Default | What it controls |
| --- | --- | --- |
| `name` | filename | Stable agent name used by `agent: "..."` |
| `description` | unset | One-line routing hint for ambient awareness |
| `enabled` | `true` | Set `false` to hide and block the agent |
| `model` | Pi default | Child default model, including optional thinking suffix. When unset, the child inherits the parent's model. |
| `thinking` | model default | Child thinking level. When unset, the child inherits the parent's thinking level. |
| `allow-model-override` | `true` | Whether the parent Pi session may launch or resume this agent with a different model or thinking level. Leave it alone if you want to choose models per task from the parent chat. Set `false` when this agent should always use the model written in its file. |
| `allowed-models` | unset | Extra exact model refs the parent may choose when `allow-model-override` is enabled. The agent `model` is implicitly allowed and does not need to be repeated. `provider/model` allows any thinking level for that model; `provider/model:thinking` allows only that thinking level. |
| `cwd` | parent cwd | Working directory for the child |
| `extensions` | `all` | Which extension code loads in the child: `all`, `none`, or a comma-separated allowlist |
| `tools` | `all` | Child tool availability: `all`, `none`, or a comma-separated allowlist of Pi tool names. Lists may include built-in, extension/custom, and protocol tools. `none` disables built-in tools while preserving extension/custom tools unless denied. |
| `deny-tools` | unset | Final comma-separated tool names to remove from the child after built-in tools, extensions, and protocol tools are selected |
| `skills` | `all` | Child skill availability: `all`, `none`, or a comma-separated allowlist resolved by skill name |
| `inject-skills` | unset | Comma-separated skills to load into the child prompt before the task |
| `no-context-files` | `false` | Skip trusted project context-file discovery in the child. With the default `trust-project: false`, Pi already ignores project-local context files. |
| `no-session` | `false` | Use an ephemeral child session file and delete it after completion |
| `trust-project` | `false` | Whether interactive child launches pass Pi's `--approve` flag and trust project-local files/settings. Background children always generate `--no-approve` for safety; use `flags` only as an explicit advanced override. |
| `auto-exit` | `false` | Close the child after a normal completion |
| `system-prompt` | task body | `append` uses `--append-system-prompt`; `replace` uses `--system-prompt` |
| `session-mode` | `lineage-only` | `standalone`, `lineage-only`, or `fork` |
| `flags` | unset | Extra CLI flags passed to the child pi process (e.g. `--verbose` or `--some-custom-flag`). Appended after all generated args — last-wins semantics against conflicting generated args, including `--approve` / `--no-approve`. Use only as an advanced escape hatch for extension-registered flags or pi built-in flags not covered by other frontmatter fields. |
| `env` | unset | Line-based `KEY=VALUE` pairs passed as environment variables to the child process. Use YAML block syntax for values with commas or `=`. `PI_CODING_AGENT_DIR` is special: when set here, it is resolved before launch and becomes the child's Pi config/session root. `~/` is expanded. Internal PI vars such as PI\_SUBAGENT\_\* still take precedence if names conflict. |
| `task-expansion` | unset | Set `shell` when the task may include shell placeholders that Pi resolves before launch. Pi runs each placeholder from the child's target `cwd`, gives it 30 seconds, replaces it with captured output, and gives that prepared task to the child. The command receives `PI_WORKSPACE`; long output is cut with `[output truncated]`. Leave unset unless you trust the task text to execute shell commands. |
| `spawning` | `false` | Allow the child to launch subagents |
| `async` | `true` | `false` makes the launch sync |
| `mode` | `interactive` | `interactive` pane or `background` process |
| `parent-close-policy` | `terminate` | What happens to the child when the parent session exits: `terminate` (kill) or `continue` (leave running) |

Use YAML block syntax for more than one env var:

```yaml
env: |
  PI_CODING_AGENT_DIR=~/.pi-scout/agent
  PI_SAFETYNET_DEFAULT_MODE=explore
  SOME_VALUE=value,with,commas
```

Pi splits `env` by line. It does not split values by comma. When you set `PI_CODING_AGENT_DIR`, the child uses that directory for its Pi config and sessions. For per-agent Zellij placement, set `PI_SUBAGENT_ZELLIJ_PLACEMENT` here; the parent reads that value at launch before the child pane exists. See [Zellij placement](#zellij-placement).

`trust-project` controls Pi's project-local trust boundary. The default `false` passes `--no-approve`, so child sessions ignore project-local settings and project-local context files such as `AGENTS.md`/`CLAUDE.md` even when the parent project was previously approved. Set `trust-project: true` only for interactive children that should inherit those project-local resources. Background children still generate `--no-approve`; `flags` is the explicit advanced escape hatch if you need to override that safety default.

`task-expansion: shell` prepares task context before launch for small models that should not have to plan tool calls. It is opt-in because the parent task text becomes shell input and runs in the parent Pi process before the child starts. Commands execute in source order from the child's effective `cwd`; each placeholder gets 30 seconds before Pi inserts a timeout diagnostic. Use `$PI_WORKSPACE` or `${PI_WORKSPACE}` inside the shell command to read the workspace path from the environment. This explicit opt-in works in every parent mode, including orchestrator mode. Use explicit shell placeholders:

````md
Summarize the files changed.

Inline status: !`git status --short`

Changed files:
```!
git diff --name-only
```

Follow these conventions:
!`cat daily-git-brief.md`
````

Pi expands those placeholders into command output before writing the child task artifact. Ordinary Markdown code fences are treated as literal examples, so inline placeholders inside language-tagged code fences such as `sh` or `text` do not execute. Plain standalone lines like `!git status` are not expanded; use inline ``!`git status` `` or a fenced shell command block. Because project-local agent files can opt into this behavior, only use `task-expansion: shell` in agents whose launch tasks you trust to become shell input.

Named-agent frontmatter wins over duplicate launch-time fields such as `tools`, `cwd`, and `mode`. `model` and `thinking` are different: while you are in a parent Pi session, you can ask Pi to run a subagent with a specific model or thinking level for that one launch or resume. That works by default. If an agent file sets `allow-model-override: false`, Pi ignores those per-launch model choices and uses the model from the agent file, or the inherited Pi model if the file does not name one. Use that opt-out for agents whose quality, cost, or safety depends on a specific model.

Use `allowed-models` when an agent should have a small exact model menu:

```yaml
---
name: reviewer
model: zai/glm-5.1:high
allow-model-override: true
allowed-models: openai/gpt-5.5:low, nahcrof/glm-5.1:off, anthropic/claude-opus-4-8
---
```

`model` is the default and is always allowed. `allowed-models` lists the other models Pi may use for this agent, so you do not need to repeat `model`. The `:thinking` suffix is optional: `provider/model:low` allows only that thinking level, while `provider/model` allows the model with whatever thinking level Pi resolves. If `allow-model-override: false`, Pi ignores launch-time and resume-time model choices as usual.

## Ambient awareness

Ambient awareness is the quiet note Pi gives the parent model about available agents.

Pi stores that note as a hidden custom message. The user does not see it as chat. The LLM sees it as context before it decides whether to call `subagent`.

The note contains agents with `description` fields and labels each one by what the child would see:

- `isolated context` means the child starts clean. The parent must write a self-contained task.
- `forked context` means the child sees the parent transcript. The parent can rely on context already in the chat.

Pi sends ambient awareness once when a top-level session first needs it, then sends a fresh copy after reload if the agent list changed.

Normal child sessions do not receive ambient awareness, even with `spawning: true`. They sit under a parent that made the first routing decision. A `standalone` child can receive its own ambient awareness because Pi treats it as a root session.

Agents without descriptions remain launchable, but they do not appear in ambient awareness.

## Launching and waiting

Async launch:

1. parent calls `subagent`
2. child starts
3. parent receives a “started” result
4. child result comes back later by steer

Sync launch:

1. the agent has `async: false` in frontmatter
2. parent waits
3. tool result contains the child result

#### Mixed sync and async batches

When one tool-call batch contains at least one sync/blocking subagent, the whole batch becomes a barrier. Pi still launches every child with its own frontmatter, so an `async: true` child keeps async launch metadata for resume, but the parent waits until every child in that batch completes and receives all results as tool results.

```
subagent(sync), subagent(async), subagent(async) → all launch
→ parent waits until all three finish
→ returns all three completed results
```

Pure async batches stay detached: the parent receives started results and child results arrive later by steer.

After a pure async launch, the parent should get out of the way unless it has separate work. If the parent keeps solving the delegated task, you paid for two agents to race each other.

By default, a successful async launch ends the parent turn after the current tool batch. The children keep running. Their results come back later.

Leave `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` unset, or set it to `0`, to keep that guard. Set it to `1` when you want the parent model to keep going after async launches.

```bash
PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1 pi
```

That only removes the runtime stop. The parent still owns only work it did not delegate.

## Session modes

A child session has two questions:

- should Pi attach it to the parent session tree?
- should the child model see the parent transcript?

`lineage-only` attaches the child to the tree and starts the model clean. This is the default. You keep lineage, resume paths, and artifact attribution without copying the whole parent chat.

`standalone` starts clean and skips the parent link. Use it for unrelated work.

`fork` attaches the child to the tree and copies parent context. Use it when the child needs decisions, files, or prior results already in the parent transcript.

The `isolated context` and `forked context` labels from ambient awareness describe model memory. They do not describe where Pi stores the child in the session tree. A `lineage-only` child is still a child of the parent session even though its model starts clean.

For nested launches, `parent` means the session that spawned the child:

```text
top-level session
└── child session
    └── grandchild session
```

### Forked sessions

A fork copies the entire parent session into a new child run. The child inherits all user messages, assistant responses, tool calls, and tool results from the parent transcript.

When the parent model has a larger context window than the child model, the inherited history may exceed what the child can fit. Pi handles this automatically — the child's native compaction trims inherited messages at LLM call time using the child model's actual context window and tokenizer. No manual budget configuration is needed.

A fork also gets a handoff marker. Pi appends a short system-prompt note, then writes a hidden custom message with a `<subagent-boundary>` tag at the end of the copied transcript. The tag says: the old messages are background, and the next user message is the child task.

That marker prevents a common failure. A child can read the parent's old role, old tools, or old task and start acting like the parent. The marker tells it where the fork begins.

The marker also steers the model. If you want a raw fork with no marker and no boundary instruction, set:

```bash
PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY=1
```

### `no-session: true`

`no-session: true` gives the child a temporary session file and deletes it after completion.

For `fork`, Pi seeds that temporary file with the parent session content. For `lineage-only`, Pi also gives the child inherited context because there is no persistent child file where it can store lineage metadata.

Use `no-session: true` for disposable children. Do not use it when you need resume, `caller_ping`, or durable child history.


## Child lifecycle

A child can finish in three ways.

### `auto-exit`

Use `auto-exit: true` for autonomous agents. The child exits after a normal assistant completion.

### `subagent_done`

Manual-lifecycle children get a `subagent_done` tool. The child writes its final assistant message, calls `subagent_done`, and Pi returns that final message to the parent.

Pi hides `subagent_done` for `auto-exit: true` agents. If you want an interactive child that only the operator can close, add `subagent_done` to `deny-tools`.

### `caller_ping`

Use `caller_ping` when the child needs the parent. The child sends a message up, exits, and leaves a session file that the parent can resume.

## Resuming child sessions

`subagent_resume` starts an existing child session again. You can pass a follow-up task.

Resume tries to preserve the original launch shape: mode, model, prompt style, cwd, tools, extensions, and lifecycle settings. A resumed child should continue as the same child, even if the agent file changed after the first launch.

## Child output

The child's final assistant message is its output.

For large output, let the child use Pi's `write` tool and mention the path in its final message.

## Child tools and extensions

`extensions`, `tools`, and `deny-tools` shape the Pi capabilities available to the child model. They are not a sandbox for untrusted code. Loaded extensions still execute with the child process permissions, and freeform `flags` can override generated CLI arguments. Use OS or container isolation for hard security boundaries.

Children load all extensions by default. Omit `extensions` or set `extensions: all` for the default Pi extension set.

Set `extensions: none` to launch with no normal extensions. `pi-subagents` still injects its mandatory internal helper so child lifecycle and result delivery continue to work.

Set a comma-separated allowlist when you want a smaller child environment.

```md
---
name: reviewer
extensions: .pi/extensions/safe-tools.ts, npm:@foo/bar
---
```

When `extensions` is `none` or an allowlist, Pi launches the child with `--no-extensions`, injects the subagent protocol helper, then loads only the allowlisted extensions.

For an unversioned `npm:` source that is already configured and installed in the child's effective Pi settings, pi-subagents reuses Pi's managed package directory instead of creating a second temporary CLI installation. Exactly matching configured Git sources are reused too, including the same explicit ref when one is present. Resolution uses Pi's settings and package APIs, so it respects the child's Pi config root and configured `npmCommand` such as Bun. Unconfigured, filtered, explicitly versioned, and tagged npm sources retain Pi's normal temporary `-e` behavior; Git sources that do not exactly match the configured source do the same. Project-installed packages are reused only when the child's final approval flags trust the project.

Local paths stay paths. Package and remote sources keep their normal prefixes when managed reuse does not apply:

```md
---
name: reviewer
extensions: ./extensions/local.ts, npm:@foo/bar, git:github.com/user/repo
---
```

### Child skills

`skills` controls which skills the child Pi process can use.

```md
---
name: reviewer
skills: all
---
```

`skills: all` is the default. Pi keeps its normal skill discovery: project skills, global skills, settings, packages, and extension-provided skills.

```md
---
name: reviewer
skills: none
---
```

`skills: none` launches the child with `--no-skills`. The child has no discovered skills, and `inject-skills` is not allowed.

```md
---
name: reviewer
skills: pua,torpathy
---
```

A comma-separated list is an allowlist. `pi-subagents` resolves each name through Pi's resource loader, then launches the child with `--no-skills --skill <resolved-path> ...`. Only those named skills are available.

`skills` resolves names from the same places Pi sees skills, including:

- `.pi/skills/`
- `.agents/skills/`
- global skill directories
- settings and package resources
- skills bundled by extension packages listed in `extensions`

Package skill example:

```json
{
  "name": "my-pi-package",
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

An agent can allowlist a skill from that package by loading the package and naming the skill:

```md
---
name: reviewer
extensions: ./path/to/my-pi-package
skills: packaged-reviewer
---
```

`inject-skills` controls which available skills start inside the child task context.

```md
---
name: reviewer
skills: pua,torpathy
inject-skills: torpathy
---
```

`inject-skills` reads the selected `SKILL.md` files, strips frontmatter, and prepends `<skill>` blocks to the child task artifact. Multiple injected skills appear in order before the task. The child gets one startup task, so it cannot answer between injected skills and the task.

Injected skills must be available under `skills`. These fail before launch:

```md
skills: none
inject-skills: pua
```

```md
skills: pua
inject-skills: torpathy
```

By default, injected skills use Pi's native skill shape:

```xml
<skill name="pua">
References are relative to /path/to/pua.

...skill body...
</skill>
```

If [`pi-better-skills`](https://github.com/edxeth/pi-better-skills) is loaded for the child, injected skills use its path-context shape:

```xml
<skill name="pua">
<skill_context>
  <skill_dir>/path/to/pua</skill_dir>
  <workspace_dir>/path/to/workspace</workspace_dir>

  <path_policy>
    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.
    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.
    Use $PI_SKILL_DIR/path for explicit bundled skill files.
    Use $PI_WORKSPACE/path for explicit workspace/project files.
  </path_policy>
</skill_context>

...skill body...
</skill>
```

Load `pi-better-skills` like any other child extension:

```md
---
name: researcher
extensions: git:github.com/edxeth/pi-better-skills
skills: deep-research
inject-skills: deep-research
---
```

The `tools` field narrows the child to a Pi tool allowlist. Use built-in names such as `read` and `bash`, extension/custom names such as `mcp`, and protocol names such as `caller_ping` when they should be part of the final allowlist. Pi-subagents keeps required child protocol tools available in narrowed allowlists. The optional `set_tab_title` protocol tool is added only when `PI_SUBAGENT_ENABLE_SET_TAB_TITLE=1`. When `tools` is omitted or set to `all`, Pi keeps its default active tool set. When `tools` is `none`, Pi disables built-in tools while preserving extension/custom tools unless you deny them.

Pi silently ignores `--tools` names that are not registered by a built-in or a loaded extension. That means a typo (for example `tools: read,edti`) leaves the child silently without `edit`. pi-subagents surfaces a non-blocking warning in the subagent result when a name is within one edit of a built-in (`edti`→`edit`, `raed`→`read`); the launch still proceeds, because a near-miss name can be a legitimate custom tool (for example `hash` is one edit from `bash`). pi-subagents cannot validate arbitrary extension/custom tool names before the child loads its extensions, so ensure every custom/extension name in `tools:` is registered by an extension listed in `extensions:`.

`deny-tools` is a final named tool denylist. It can remove built-in Pi tools, extension/custom tools, or pi-subagents protocol tools after they have otherwise been selected.

```md
---
name: reviewer
tools: read,grep,mcp
extensions: npm:pi-mcp-adapter
deny-tools: bash,edit,write,ask_user
---
```

`spawning` defaults to `false`. That removes `subagent` and `subagent_resume` from children. Set `spawning: true` only for coordinator agents.

## Parent shutdown policy

Set `parent-close-policy` in the agent frontmatter:

```yaml
---
name: scout
parent-close-policy: continue
---
```

| Value | Effect |
| --- | --- |
| `terminate` | Stop the child when the parent session exits |
| `continue` | Leave the child running and stop delivering its result to the closed parent |

The default is `terminate`.

## UI

The parent session gets a live widget above the editor. It shows running children, elapsed time, activity, and context usage.

Every `subagent` call requires both a strict `name` and a short `title`.

- `name` is the machine handle used in launch/result text and kill/wait targeting. Use lower-kebab `<scope>-<role>`, 2-4 words, max 32 characters: `auth-scout`, `diff-reviewer`, `session-tester`.
- `title` is the human label shown in the widget/session UI. Use sentence-case prose, 3-8 words: `Auth implementation map`, `Local diff bug review`.

Child sessions can also get session titles like:

```text
[scout] Auth flow reconnaissance
```

Disable child session titles with `PI_SUBAGENT_DISABLE_SESSION_TITLES=1`.

## Launching children through a wrapper

By default, the extension launches children with the same Pi entrypoint it can infer from the parent. If your real Pi command goes through a wrapper, set it:

```bash
PI_SUBAGENT_PI_COMMAND="my-wrapper pi" my-wrapper pi
```

The wrapper applies to new children and resumed children. Quoted paths work:

```bash
PI_SUBAGENT_PI_COMMAND="'/path with spaces/my-wrapper' pi" pi
```

## Environment variables

User-facing knobs:

| Variable | Use |
| --- | --- |
| `PI_ORCHESTRATOR_MODE` | Set `1` to turn the parent into an orchestrator (delegation-only tools, replacement system prompt) |
| `PI_SUBAGENT_PI_COMMAND` | Launch children through a wrapper command |
| `PI_SUBAGENT_MUX` | Force `herdr`, `cmux`, `tmux`, `zellij`, or `wezterm` |
| `PI_CODING_AGENT_DIR` | Use a different Pi agent config root |
| `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` | Set `1` to let the parent keep running after async launches |
| `PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY` | Set `1` for raw forks with no boundary marker |
| `PI_SUBAGENT_DISABLE_SESSION_TITLES` | Disable automatic child session names |
| `PI_ARTIFACT_PROJECT_ROOT` | Override internal artifact storage root |
| `PI_SUBAGENT_SHELL_READY_DELAY_MS` | Change the fixed pane startup delay before Pi sends the child command (default: 500ms) |
| `PI_SUBAGENT_ENABLE_SET_TAB_TITLE` | Register the optional `set_tab_title` tool |
| `PI_SUBAGENT_RENAME_TMUX_WINDOW` | Let `set_tab_title` rename the tmux window |
| `PI_SUBAGENT_RENAME_TMUX_SESSION` | Let `set_tab_title` rename the tmux session |
| `PI_SUBAGENT_ZELLIJ_PLACEMENT` | Zellij policy: `auto`, `right-stack`, `down-stack`, `floating`, or `tab-stack` |
| `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` | Minimum usable columns for each side of a Zellij split (default: `50`) |
| `PI_SUBAGENT_ZELLIJ_MIN_ROWS` | Minimum usable rows for each side of a Zellij split (default: `10`) |

Runtime internals you may see while debugging:

- `PI_DENY_TOOLS`
- `PI_SUBAGENT_EXTENSIONS`
- `PI_SUBAGENT_NAME`
- `PI_SUBAGENT_AGENT`
- `PI_SUBAGENT_PARENT_SESSION`
- `PI_SUBAGENT_SESSION`
- `PI_SUBAGENT_SURFACE`
- `PI_SUBAGENT_AUTO_EXIT`

Live test knobs:

- `PI_SUBAGENT_ALLOW_LIVE_WINDOWS`
- `PI_SUBAGENT_LIVE_MODEL`
- `PI_SUBAGENT_KEEP_E2E_TMP`
- `PI_SUBAGENT_LIVE_LOCK_PATH`
- `PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS` — override the provider-error recovery backoff windows (comma-separated ms, e.g. `10000,11000,12000`) so a live Pi process can exercise the wait → nudge → kill path without waiting the full 30/60/90s. Values below 10000ms are clamped so recovery does not race Pi's own default auto-retry backoff. Defaults to the production `30000,60000,90000`.

## Zellij placement

Zellij groups children by their immediate parent session. The first child splits that parent; later siblings stack on the same pane. Set `PI_SUBAGENT_ZELLIJ_PLACEMENT`:

- `auto` (default): split the parent pane when there is room, otherwise open a dedicated tab. Later siblings stack on the first pane owned by that parent.
- `right-stack`: first child goes right, siblings stack there.
- `down-stack`: first child goes below, siblings stack there.
- `floating`: each child opens as a pinned floating pane.
- `tab-stack`: first child opens a dedicated tab, siblings stack in that tab.

`right-stack`, `down-stack`, and `auto` fall back to a dedicated tab when a split would fall below `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` or `PI_SUBAGENT_ZELLIJ_MIN_ROWS`.

The parent environment sets the default for all interactive subagents. An agent can override it for its own launches through the existing [`env`](#agent-definitions) frontmatter:

```yaml
env: PI_SUBAGENT_ZELLIJ_PLACEMENT=down-stack
```

This is a parent-read exception to the usual child-environment contract because placement must be resolved before the child pane exists. The agent value overrides the parent default. Placement groups are scoped by immediate parent and resolved policy, so agents with different policies do not overwrite each other's stack anchors. On resume, a persisted per-agent `env` value still wins; without one, the current parent default wins, then the originally persisted policy is the fallback.

Zellij 0.44.x needs a short focus transaction for directional and stacked placement, and stacked insertion changes client focus. Those policies require exactly one attached Zellij client. With more clients, use `floating` or detach the extras.

## Testing

Unit tests:

```bash
bunx tsc --noEmit
npm test
```

Herdr-focused fake tests:

```bash
node --test test/mux/herdr.test.ts
node --test test/launch/herdr-interactive-launch.test.ts
```

The mux test covers Herdr detection, forced preferences, adapter error reporting, non-shrinking numbered-tab creation in the parent workspace, split limitations, command send, screen reads, title and workspace labels, and cleanup. The launch test covers Herdr parity for cwd, env, flags, trust-project approval, session settings, model and thinking resolution, tool narrowing, skills, lifecycle policy, and explicit `PI_SUBAGENT_MUX=herdr` selection.

Live tests:

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-blocking
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-mix-blocking
npm run test:e2e-live-deny-tools
npm run test:e2e-live-tools
npm run test:e2e-live-extensions
npm run test:e2e-live-stop-after-turn
```

The live window tests require an explicit opt-in because they open real terminal windows.

Herdr live smoke tests are guarded and bounded:

```bash
npm run test:live-herdr-mux
npm run test:live-herdr-pi
```

Without opt-in variables, each Herdr smoke prints a `SKIP` line and exits before creating Herdr surfaces. Use the skip output as guard evidence only. It is not a real live smoke run.

Run the real Herdr mux smoke only when you are ready to create temporary Herdr surfaces:

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:live-herdr-mux
```

Run the real Pi Herdr smoke with both live opt-ins and a model. This script starts an interactive parent Pi session inside a Herdr-managed pane. It does not use `pi -p` as proof of interactive child behavior.

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 \
PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking] \
npm run test:live-herdr-pi
```

Both Herdr smoke scripts check the `herdr` command, server running status, and protocol compatibility before mutating panes. They label created tabs and panes with a unique marker, then close marked surfaces during cleanup.

Herdr validation record for this release:

- `node --test test/mux/herdr.test.ts` passes the fake Herdr mux contract suite.
- `node --test test/launch/herdr-interactive-launch.test.ts` passes the fake Herdr launch parity suite.
- `bunx tsc --noEmit` passes type checking.
- `npm test` runs the registered Herdr mux and launch suites through the repository test entrypoint.
- `npm run test:live-herdr-mux` and `npm run test:live-herdr-pi` pass their skip guards when `PI_SUBAGENT_ALLOW_LIVE_WINDOWS` and `PI_SUBAGENT_LIVE_MODEL` are unset. A real live run requires the opt-in variables above.

## Credits

- upstream foundation: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
- this fork: [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents)

## License

MIT
