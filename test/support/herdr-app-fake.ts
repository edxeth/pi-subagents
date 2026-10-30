import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDir } from "./fixtures.ts";

const TERMINAL_JSON = '"status":null,"app":null,"name":null,"sub_agents":[]';

/**
 * Fake `herdr-app` and `hc` binaries shaped like the real CLIs (see `herdr-app ls`, `hc get --json`).
 * Behaviour switches through FAKE_HERDR_APP_MODE: small, geometry-fail, split-fail, tab-fail, steal-focus,
 * kill-notfound, kill-fail, missing-parent, no-ls, send-fail, remote-space, steal-space, status-fail-once (comma-separate to combine). Uses shell builtins only so tests may set PATH to the fake dir.
 */
const FAKE_HERDR_APP = `#!/bin/sh
printf 'herdr-app %s\\n' "$*" >> "$FAKE_HERDR_APP_LOG"
mode="\${FAKE_HERDR_APP_MODE:-available}"
terms="$FAKE_HERDR_APP_COUNTER.terms"
flag="$FAKE_HERDR_APP_COUNTER.stolen"
has() { case ",$mode," in *",$1,"*) return 0 ;; esac; return 1; }
[ -f "$terms" ] || : > "$terms"
next_number() {
  IFS= read -r count < "$FAKE_HERDR_APP_COUNTER"
  echo $((count + 1)) > "$FAKE_HERDR_APP_COUNTER"
  number=$((count + 2))
}
terminal_json() { printf '{"terminal":"%s","pane":"%s",${TERMINAL_JSON}}' "$1" "$2"; }
case "$1" in
  ls)
    if has no-ls; then printf '%s\\n' '{"error":"window is not running"}'; exit 1; fi
    printf '{"spaces":[{"id":"sp1","name":"main","folder":"/parent","machine":null,"active":true,"tabs":['
    printf '{"id":"tb1","name":"1","active":true,"settled":false,"terminals":['
    first=1
    if ! has missing-parent; then terminal_json t1 p1; first=0; fi
    while read -r t p tb; do
      [ "$tb" = tb1 ] || continue
      [ "$first" = 0 ] && printf ','
      first=0
      terminal_json "$t" "$p"
    done < "$terms"
    printf ']}'
    while read -r t p tb; do
      [ "$tb" = tb1 ] && continue
      printf ',{"id":"%s","name":"child","active":false,"settled":false,"terminals":[' "$tb"
      terminal_json "$t" "$p"
      printf ']}'
    done < "$terms"
    printf ']}'
    if has remote-space; then
      printf ',{"id":"sp-remote","name":"vps","folder":"/srv","machine":"vps","active":false,"tabs":[{"id":"tb-r","name":"1","active":true,"settled":false,"terminals":['
      terminal_json t1 p-remote
      printf ']}]}'
    fi
    printf '],"recent":[]}\\n'
    exit 0
    ;;
  status)
    if has status-fail-once && [ ! -f "$flag.failed" ]; then
      : > "$flag.failed"; printf '%s\\n' '{"error":"status unavailable"}'; exit 1
    fi
    if [ -s "$flag" ] && has steal-space; then
      printf '%s\\n' '{"space":"sp2","tab":"tb-stolen","focused_pane":"p-stolen","layout":"main","errors":[]}'
    elif [ -s "$flag" ]; then
      printf '%s\\n' '{"space":"sp1","tab":"tb-stolen","focused_pane":"p-stolen","layout":"main","errors":[]}'
    else
      printf '%s\\n' '{"space":"sp1","tab":"tb1","focused_pane":"p1","layout":"main","errors":[]}'
    fi
    exit 0
    ;;
  do)
    command="$2"
    case "$command" in
      pane.split)
        if has split-fail; then printf '%s\\n' '{"error":"fake split refused"}'; exit 1; fi
        next_number
        printf 't%s p%s tb1\\n' "$number" "$number" >> "$terms"
        { has steal-focus || has steal-space; } && echo 1 > "$flag"
        printf '{\\n  "pane": "p%s",\\n  "terminal": "t%s"\\n}\\n' "$number" "$number"
        ;;
      tab.new)
        if has tab-fail; then printf '%s\\n' '{"error":"fake tab refused"}'; exit 1; fi
        next_number
        printf 't%s p%s tb%s\\n' "$number" "$number" "$number" >> "$terms"
        { has steal-focus || has steal-space; } && echo 1 > "$flag"
        printf '{\\n  "space": "sp1",\\n  "tab": "tb%s",\\n  "terminal": "t%s"\\n}\\n' "$number" "$number"
        ;;
      space.select|pane.focus) : > "$flag"; printf '%s\\n' '{"ok":true}' ;;
      *) printf '%s\\n' '{"ok":true}' ;;
    esac
    exit 0
    ;;
esac
printf '%s\\n' '{"error":"unsupported fake herdr-app command"}'
exit 1
`;

const FAKE_HC = `#!/bin/sh
printf 'hc %s\\n' "$*" >> "$FAKE_HERDR_APP_LOG"
mode="\${FAKE_HERDR_APP_MODE:-available}"
has() { case ",$mode," in *",$1,"*) return 0 ;; esac; return 1; }
terms="$FAKE_HERDR_APP_COUNTER.terms"
[ -f "$terms" ] || : > "$terms"
case "$1" in
  get)
    cols=200; rows=120
    if [ "$2" = "t1" ]; then
      cols=152; rows=32
      has small && { cols=80; rows=20; }
      if has geometry-fail; then
        printf '%s\\n' '{"error":{"kind":"internal","message":"fake geometry failure"}}' >&2
        exit 1
      fi
    fi
    printf '{"address":"%s","cols":%s,"rows":%s,"state":"live","parent":null,"notify":true,"die_with_parent":false,"labels":{}}\\n' "$2" "$cols" "$rows"
    ;;
  send)
    if has send-fail; then
      printf '%s\\n' '{"error":{"kind":"internal","message":"fake send failure","hint":""}}' >&2
      exit 1
    fi
    printf '{"ok":true}\\n'
    ;;
  keys|label|rm) printf '{"ok":true}\\n' ;;
  read)
    # --lines N adds N lines of history above the screen, like the real hc.
    if [ "$3" = "--lines" ] && [ "$4" -gt 0 ] && [ -f "$FAKE_HERDR_APP_SCREEN.history" ]; then
      while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$FAKE_HERDR_APP_SCREEN.history"
    fi
    if [ -f "$FAKE_HERDR_APP_SCREEN" ]; then
      while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$FAKE_HERDR_APP_SCREEN"
    fi
    ;;
  kill)
    if has kill-notfound; then
      printf '%s\\n' '{"error":{"kind":"not_found","message":"no such terminal","hint":""}}' >&2
      exit 3
    fi
    if has kill-fail; then
      printf '%s\\n' '{"error":{"kind":"internal","message":"fake kill failure","hint":""}}' >&2
      exit 1
    fi
    kept=""
    while read -r t p tb; do
      [ "$t" = "$2" ] || kept="$kept$t $p $tb
"
    done < "$terms"
    printf '%s' "$kept" > "$terms"
    printf '{"ok":true}\\n'
    ;;
  *)
    printf '%s\\n' '{"error":{"kind":"usage","message":"unsupported fake hc command","hint":""}}' >&2
    exit 2
    ;;
esac
`;

export function writeFakeHerdrApp(dir: string): { logFile: string; counterFile: string; screenFile: string } {
	const logFile = join(dir, "herdr-app.log");
	const counterFile = join(dir, "herdr-app-counter");
	const screenFile = join(dir, "herdr-app-screen.txt");
	writeFileSync(logFile, "");
	writeFileSync(counterFile, "0\n");
	writeFileSync(screenFile, "app line 1\napp line 2\napp line 3\n");
	writeFileSync(`${screenFile}.history`, "history line\n");
	for (const [name, content] of [
		["herdr-app", FAKE_HERDR_APP],
		["hc", FAKE_HC],
	] as const) {
		const file = join(dir, name);
		writeFileSync(file, content);
		chmodSync(file, 0o755);
	}
	return { logFile, counterFile, screenFile };
}

/** Make this process look like pi inside terminal t1 of a fake herdr-app window. */
export function useFakeHerdrApp(mode = "available"): {
	dir: string;
	logFile: string;
	screenFile: string;
	counterFile: string;
} {
	const dir = createTestDir();
	const fake = writeFakeHerdrApp(dir);
	process.env.PATH = dir;
	process.env.HC_TERMINAL_ID = "t1";
	process.env.FAKE_HERDR_APP_LOG = fake.logFile;
	process.env.FAKE_HERDR_APP_COUNTER = fake.counterFile;
	process.env.FAKE_HERDR_APP_SCREEN = fake.screenFile;
	process.env.FAKE_HERDR_APP_MODE = mode;
	process.env.PI_SUBAGENT_SESSION = `parent-${dir}`;
	return { dir, ...fake };
}
