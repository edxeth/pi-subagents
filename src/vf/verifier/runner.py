#!/usr/bin/env python3
"""One-shot NDJSON bridge between pi-subagents and the official llm-verifier library.

Protocol: read ONE NDJSON request line on stdin, run the requested operation,
write ONE NDJSON response line on stdout, diagnostics on stderr, exit.

Exit codes (mirrored by the TypeScript side in bridge.ts):
    0  ok (response line carries the result)
    2  malformed request (unreadable NDJSON, missing/invalid fields)
   22  criteria file missing or unparseable (fail closed before any spend)
    3  missing verifier credentials
    4  verifier backend/scoring error (on_error="raise" re-raised)
    5  halt: comparison-count or cache assertion failed (never a winner)
    6  capability: the backend failed the preflight probe/canary (never a winner)

No scoring math is reimplemented here; llm_verifier.select() is called verbatim.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from types import SimpleNamespace

EXIT_OK = 0
EXIT_MALFORMED = 2
EXIT_CRITERIA = 22
EXIT_CREDENTIALS = 3
EXIT_VERIFIER = 4
EXIT_HALT = 5
EXIT_CAPABILITY = 6

N_EVALUATIONS_DEFAULT = 4
N_EVALUATIONS_BENCHMARK = 8
PIVOTS_DEFAULT = 2
SEED_DEFAULT = 0
ON_ERROR = "raise"
DEGENERATE_SPREAD_EPSILON = 1e-6
# Distinct A-T letters the score-tag distribution must cover for the
# backend to count as logprob-capable (calibrated against DeepSeek).
MIN_SCORE_LETTERS_COVERED = 3

VALID_THINKING = ("off", "low", "high", "max")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(kind: str, message: str, code: int, **detail) -> "None":
    error = {"kind": kind, "message": message}
    error.update(detail)
    emit({"ok": False, "error": error})
    print(f"verifier-bridge: {kind}: {message}", file=sys.stderr)
    sys.exit(code)


def expected_comparisons(n: int, pivots: int) -> int:
    """PPT comparison count: ring (N) + non-pivot x pivot (k(N-k)) + C(k,2)."""
    k = min(pivots, n)
    return n + k * (n - k) + k * (k - 1) // 2


def inspect_cache(cache_path):
    """(ok, detail) for the post-selection cache assertion. A cache that is
    missing, empty, or unparseable means the run silently lost its ring-pass
    scores (upstream issue #14) — the caller must halt, not pick a winner."""
    if os.path.isfile(cache_path):
        size = os.path.getsize(cache_path)
        if size > 0:
            try:
                with open(cache_path, encoding="utf-8") as handle:
                    parsed = json.load(handle)
                if isinstance(parsed, dict) and parsed:
                    return True, f"{size} bytes, {len(parsed)} entries"
                return False, f"{size} bytes but not a non-empty object"
            except (OSError, json.JSONDecodeError) as exc:
                return False, f"unreadable: {exc}"
        return False, "empty"
    return False, "missing"


def _require_str(req: dict, field: str) -> str:
    value = req.get(field)
    if not isinstance(value, str) or not value.strip():
        fail("malformed-request", f'field "{field}" must be a non-empty string', EXIT_MALFORMED)
    return value


def _require_int(req: dict, field: str, default: int, minimum: int) -> int:
    value = req.get(field, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        fail("malformed-request", f'field "{field}" must be an integer >= {minimum}', EXIT_MALFORMED)
    return value


def parse_request() -> dict:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("malformed-request", f"stdin is not one NDJSON line: {exc}", EXIT_MALFORMED)
    if not isinstance(req, dict):
        fail("malformed-request", "request must be a JSON object", EXIT_MALFORMED)
    return req


def validate_select_request(req: dict) -> dict:
    problem = _require_str(req, "problem")
    candidates = req.get("candidates")
    if not isinstance(candidates, list) or len(candidates) == 0:
        fail("malformed-request", 'field "candidates" must be a non-empty array', EXIT_MALFORMED)
    for index, trace in enumerate(candidates):
        if not isinstance(trace, str) or not trace.strip():
            fail("malformed-request", f"candidates[{index}] must be a non-empty string", EXIT_MALFORMED)
    criteria_path = _require_str(req, "criteriaPath")
    if not os.path.isabs(criteria_path):
        fail("malformed-request", 'field "criteriaPath" must be an absolute path', EXIT_MALFORMED)
    model = _require_str(req, "model")
    thinking = req.get("thinking")
    if thinking is not None and thinking not in VALID_THINKING:
        fail("malformed-request", f'field "thinking" must be one of {list(VALID_THINKING)}', EXIT_MALFORMED)
    on_error = req.get("onError", ON_ERROR)
    if on_error != "raise":
        fail("malformed-request", 'field "onError" must be "raise" (fail-closed selection)', EXIT_MALFORMED)
    n_evaluations = _require_int(req, "nEvaluations", N_EVALUATIONS_DEFAULT, 1)
    pivots = _require_int(req, "pivots", PIVOTS_DEFAULT, 1)
    seed = _require_int(req, "seed", SEED_DEFAULT, 0)
    max_workers = req.get("maxWorkers")
    if max_workers is not None and (not isinstance(max_workers, int) or isinstance(max_workers, bool) or max_workers < 1):
        fail("malformed-request", 'field "maxWorkers" must be null or an integer >= 1', EXIT_MALFORMED)
    cache_path = req.get("cachePath")
    if cache_path is not None and (not isinstance(cache_path, str) or not cache_path.strip()):
        fail("malformed-request", 'field "cachePath" must be null or a non-empty string', EXIT_MALFORMED)
    env = req.get("env")
    if env is None:
        env = {}
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        fail("malformed-request", 'field "env" must be an object of string -> string', EXIT_MALFORMED)
    mock = req.get("mockVerifier")
    if mock is not None and not isinstance(mock, dict):
        fail("malformed-request", 'field "mockVerifier" must be null or an object (test seam)', EXIT_MALFORMED)
    return {
        "problem": problem,
        "candidates": candidates,
        "criteria_path": criteria_path,
        "model": model,
        "thinking": thinking,
        "n_evaluations": n_evaluations,
        "pivots": pivots,
        "seed": seed,
        "max_workers": max_workers,
        "cache_path": cache_path,
        "env": env,
        "mock": mock,
    }


def validate_probe_request(req: dict) -> dict:
    model = _require_str(req, "model")
    criteria_path = _require_str(req, "criteriaPath")
    if not os.path.isabs(criteria_path):
        fail("malformed-request", 'field "criteriaPath" must be an absolute path', EXIT_MALFORMED)
    thinking = req.get("thinking")
    if thinking is not None and thinking not in VALID_THINKING:
        fail("malformed-request", f'field "thinking" must be one of {list(VALID_THINKING)}', EXIT_MALFORMED)
    env = req.get("env")
    if env is None:
        env = {}
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        fail("malformed-request", 'field "env" must be an object of string -> string', EXIT_MALFORMED)
    mock = req.get("mockVerifier")
    if mock is not None and not isinstance(mock, dict):
        fail("malformed-request", 'field "mockVerifier" must be null or an object (test seam)', EXIT_MALFORMED)
    return {
        "model": model,
        "criteria_path": criteria_path,
        "thinking": thinking,
        "env": env,
        "mock": mock,
    }


# ---------------------------------------------------------------------------
# Mock verifier client (test seam). Speaks the OpenAI/DeepSeek response shape
# the library's call_deepseek path reads: tokens + per-position logprobs with
# the score letters concentrated where the mock wants them. Production
# requests never set mockVerifier; they use the library's real create_client.
# ---------------------------------------------------------------------------

LETTERS = [chr(ord("A") + i) for i in range(20)]
LETTER_VALUE = {chr(ord("A") + i): 20 - i for i in range(20)}


def _letter_distribution(letter: str):
    peak = -0.05
    rest = -8.0
    alts = [
        SimpleNamespace(token=f" {c}", logprob=(peak if c == letter else rest))
        for c in LETTERS
    ]
    return alts


def build_mock_client(config: dict, force_flat: bool = False):
    good_marker = config.get("goodMarker", "")
    mid_marker = config.get("midMarker", "")
    fail_calls = bool(config.get("failCalls", False))
    sleep_seconds = float(config.get("sleepSeconds", 0) or 0)
    log_file = config.get("logFile")
    # Ticket-06 test modes: `flatScores` makes every letter distribution
    # uniform (the backend "cannot discriminate" — scores come back exactly
    # 0.5/0.5); `stripLogprobs` returns text score letters with NO logprob
    # distributions (the logprob-less proxy: text parsing alone would
    # fabricate confident 0/1 scores, which only the probe catches).
    # `degradeForSelect` is a bridge-level flag (not read here): the caller
    # constructs the mock with force_flat so the probe discriminates while
    # the tournament goes flat — a backend that degraded after preflight.
    flat_scores = bool(config.get("flatScores", False))
    strip_logprobs = bool(config.get("stripLogprobs", False))
    state = {"calls": 0}

    def create(**kwargs):
        state["calls"] += 1
        if log_file:
            with open(log_file, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"model": kwargs.get("model"), "call": state["calls"]}) + "\n")
        if fail_calls:
            raise RuntimeError("mock verifier backend failure (injected)")
        if sleep_seconds:
            time.sleep(sleep_seconds)
        prompt = kwargs["messages"][0]["content"]
        marker_a = prompt.find("**Trajectory A:**")
        marker_b = prompt.find("**Trajectory B:**")
        trace_a = prompt[marker_a + len("**Trajectory A:**"): marker_b] if marker_a != -1 and marker_b != -1 else ""
        trace_b = prompt[marker_b + len("**Trajectory B:**"):] if marker_b != -1 else ""

        def grade(trace: str) -> str:
            if good_marker and good_marker in trace:
                return "A"
            if mid_marker and mid_marker in trace:
                return "C"
            return "T"

        if flat_scores or force_flat:
            letter_a, letter_b = "J", "J"
        else:
            letter_a, letter_b = grade(trace_a), grade(trace_b)
        text = (
            "mock analysis\n"
            f"<score_A> {letter_a} </score_A>\n"
            f"<score_B> {letter_b} </score_B>"
        )
        if flat_scores or force_flat:
            uniform = lambda: [SimpleNamespace(token=f" {c}", logprob=math.log(1 / 20)) for c in LETTERS]
            dist_a, dist_b = uniform(), uniform()
        else:
            dist_a, dist_b = _letter_distribution(letter_a), _letter_distribution(letter_b)
        if strip_logprobs:
            content = None  # a proxy that answers but exposes no logprobs
        else:
            content = [
                SimpleNamespace(token="<score_A>", logprob=-0.1, top_logprobs=dist_a),
                SimpleNamespace(token=f" {letter_a}", logprob=-0.05, top_logprobs=dist_a),
                SimpleNamespace(token=" </score_A>", logprob=-0.1, top_logprobs=dist_a),
                SimpleNamespace(token="\n", logprob=-0.1, top_logprobs=dist_a),
                SimpleNamespace(token="<score_B>", logprob=-0.1, top_logprobs=dist_b),
                SimpleNamespace(token=f" {letter_b}", logprob=-0.05, top_logprobs=dist_b),
                SimpleNamespace(token=" </score_B>", logprob=-0.1, top_logprobs=dist_b),
            ]
        choice = SimpleNamespace(
            message=SimpleNamespace(content=text),
            logprobs=SimpleNamespace(content=content),
            finish_reason="stop",
        )
        return SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=1200, completion_tokens=80,
                                  prompt_tokens_details=None,
                                  completion_tokens_details=None),
            choices=[choice],
        )

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
    )
    # Tag as DeepSeek-style so the library reads our self-emitted tags
    # instead of trying the vLLM-only prefill trick. The stripLogprobs mode
    # deliberately stays untagged: it simulates an OpenAI-compatible proxy
    # that answers with text but no logprob distributions.
    client._llm_verifier_deepseek = not strip_logprobs
    return client


def check_credentials(req: dict) -> None:
    if req["mock"] is not None:
        return
    env = {**os.environ, **req["env"]}
    if env.get("OPENAI_BASE_URL") or env.get("DEEPSEEK_API_KEY") or env.get("VERTEX_API_KEY"):
        return
    fail(
        "credentials",
        "no verifier credentials: set DEEPSEEK_API_KEY, OPENAI_BASE_URL, or VERTEX_API_KEY "
        "(in the verifier profile env block or your environment)",
        EXIT_CREDENTIALS,
    )


def run_preview(req: dict) -> None:
    from llm_verifier.prompts import load_prompts

    path = req.get("criteriaPath")
    if not isinstance(path, str) or not path.strip():
        fail("malformed-request", 'field "criteriaPath" must be a non-empty string', EXIT_MALFORMED)
    try:
        note, criteria = load_prompts(path)
    except FileNotFoundError as exc:
        fail("criteria", f"criteria file not found: {exc}", EXIT_CRITERIA, path=path)
    except ValueError as exc:
        fail("criteria", f"criteria file is not valid: {exc}", EXIT_CRITERIA, path=path)
    emit({
        "ok": True,
        "kind": "preview",
        "criteriaPath": path,
        "groundTruthNote": note,
        "criteria": [{"id": c["id"], "name": c["name"], "description": c["description"]} for c in criteria],
    })


# ---------------------------------------------------------------------------
# Preflight capability probe + deterministic canary (ticket 06).
#
# ONE real scoring call against the configured backend, made before any
# candidate launches: an obviously-good trace is scored against an
# obviously-bad one through the library's own prompt/call/extract path. The
# backend passes only when (a) the score-tag positions expose a token
# logprob distribution covering several A-T letters (a text-only or
# logprob-less proxy fails here even though it "answers"), and (b) the
# good trace strictly outranks the bad one (a flat backend cannot
# discriminate and would fabricate a winner).
# ---------------------------------------------------------------------------

CANARY_PROBLEM = (
    "Print the integer stored in answer.txt and state it in the final "
    "report; the correct value is 42."
)


def canary_traces(mock) -> "tuple[str, str]":
    """Deterministic obviously-good vs obviously-bad traces. With the mock
    seam active, the good trace carries the configured good marker so the
    mock's grading rules apply to the canary exactly as to real traces."""
    good_marker = mock.get("goodMarker", "") if isinstance(mock, dict) else ""
    good = (
        "[Command] cat answer.txt\n"
        "[Output]\n42\n"
        "[Command] ./run_tests.sh\n"
        "[Output]\nOK: 3 passed, 0 failed\n"
        "Final report: the value is 42, verified by reading the file and "
        "running the test suite."
    )
    if good_marker:
        good += f"\ncanary marker: {good_marker}"
    bad = (
        "[Command] cat answer.txt\n"
        "[Output]\ncat: answer.txt: No such file or directory\n"
        "[Command] echo done\n"
        "[Output]\ndone\n"
        "Final report: I could not read the file; my best guess is 7."
    )
    return good, bad


def _tag_letter_coverage(tokens, position_logprobs, tag) -> dict:
    """Distinct valid score letters -> max probability at the position after
    `tag`, mirroring extract_score's token normalization ('>A' fusions,
    case folding). Empty when the backend exposed no distribution there."""
    from llm_verifier import fine_grained_reward as fgr

    letters: dict[str, float] = {}
    if tokens is None or position_logprobs is None:
        return letters
    tag_lp = fgr._find_tag_logprobs(tokens, position_logprobs, tag)
    if tag_lp:
        for tok_str, logprob in tag_lp:
            tok = tok_str.strip()
            if tok.startswith(">"):  # DeepSeek fuses '>' with the letter
                tok = tok[1:].strip()
            if tok in fgr.SCALE["valid_tokens"]:
                key = tok.upper()
                letters[key] = max(letters.get(key, 0.0), math.exp(logprob))
    return letters


def run_probe(req: dict) -> None:
    import llm_verifier
    from llm_verifier import fine_grained_reward as fgr
    from llm_verifier.prompts import load_prompts

    os.environ.update(req["env"])
    if req["thinking"]:
        os.environ["DEEPSEEK_EFFORT"] = req["thinking"]

    try:
        note, criteria = load_prompts(req["criteria_path"])
    except FileNotFoundError as exc:
        fail("criteria", f"criteria file not found: {exc}", EXIT_CRITERIA, path=req["criteria_path"])
    except ValueError as exc:
        fail("criteria", f"criteria file is not valid: {exc}", EXIT_CRITERIA, path=req["criteria_path"])

    if req["mock"] is not None:
        client = build_mock_client(req["mock"])
        fgr.create_client = lambda: client
    else:
        # The backend-configured check must run BEFORE the client is built:
        # create_client itself raises MissingAPIKeyError for a keyless env,
        # which would surface as a raw traceback instead of exit-credentials.
        check_credentials(req)
        try:
            client = fgr.create_client()
        except Exception as exc:
            name = type(exc).__name__
            if name == "MissingAPIKeyError":
                fail("credentials", f"verifier probe needs credentials: {exc}", EXIT_CREDENTIALS)
            fail("verifier-error", f"verifier client could not be created: {exc}", EXIT_VERIFIER)

    print(
        f"verifier-bridge: capability probe model={req['model']} "
        f"criteria={req['criteria_path']}",
        file=sys.stderr,
    )
    good_trace, bad_trace = canary_traces(req["mock"])
    prompt = fgr.build_prompt(CANARY_PROBLEM, good_trace, bad_trace, criteria[0], note)
    llm_verifier.USAGE.reset()
    started = time.monotonic()
    try:
        text, tokens, position_logprobs = fgr.call_verifier(client, prompt, model=req["model"])
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        name = type(exc).__name__
        if name == "MissingAPIKeyError":
            fail("credentials", f"verifier probe needs credentials: {exc}", EXIT_CREDENTIALS)
        fail(
            "capability",
            f"verifier probe call against model {req['model']} failed: {name}: {exc}",
            EXIT_CAPABILITY,
            model=req["model"],
        )

    letters_a = _tag_letter_coverage(tokens, position_logprobs, "<score_A>")
    letters_b = _tag_letter_coverage(tokens, position_logprobs, "<score_B>")
    score_good = fgr.extract_score(text, tokens, position_logprobs, "<score_A>")
    score_bad = fgr.extract_score(text, tokens, position_logprobs, "<score_B>")

    problems: list[str] = []
    if not letters_a or not letters_b:
        problems.append(
            "backend exposed no A-T score-token logprobs at the score tags "
            "(logprob-less or text-only backend; ranking would be fabricated)"
        )
    else:
        thin = [
            f"{len(letters)} letters at {label}"
            for letters, label in ((letters_a, "<score_A>"), (letters_b, "<score_B>"))
            if len(letters) < MIN_SCORE_LETTERS_COVERED
        ]
        if thin:
            problems.append(
                "score-token logprob coverage too thin: "
                + ", ".join(thin)
                + f" (need >= {MIN_SCORE_LETTERS_COVERED} distinct A-T letters)"
            )
    if score_good <= score_bad + 1e-9:
        problems.append(
            f"canary failed: the obviously-good trace scored {score_good:.4f} "
            f"against {score_bad:.4f} for the obviously-bad one (good must rank higher; "
            "a flat distribution cannot pick a real winner)"
        )
    if problems:
        fail(
            "capability",
            f"verifier backend failed the preflight probe for model {req['model']}: "
            + "; ".join(problems),
            EXIT_CAPABILITY,
            model=req["model"],
            coverageA=sorted(letters_a),
            coverageB=sorted(letters_b),
            canaryGood=score_good,
            canaryBad=score_bad,
        )

    emit({
        "ok": True,
        "kind": "probe",
        "model": req["model"],
        "thinking": req["thinking"],
        "coverage": {
            "scoreA": sorted(letters_a),
            "scoreB": sorted(letters_b),
        },
        "canary": {
            "goodScore": score_good,
            "badScore": score_bad,
            "margin": score_good - score_bad,
        },
        "usage": llm_verifier.token_usage(),
        "elapsedMs": round((time.monotonic() - started) * 1000),
    })


def run_select(req: dict) -> None:
    import llm_verifier
    from llm_verifier import fine_grained_reward as fgr
    from llm_verifier.prompts import load_prompts

    os.environ.update(req["env"])
    if req["thinking"]:
        os.environ["DEEPSEEK_EFFORT"] = req["thinking"]

    # Fail closed on an unresolvable criteria file BEFORE any spend: the
    # library would raise this inside select() after the runtime is up, and
    # callers must be able to distinguish "criteria invalid" from "backend
    # failed mid-tournament".
    try:
        load_prompts(req["criteria_path"])
    except FileNotFoundError as exc:
        fail("criteria", f"criteria file not found: {exc}", EXIT_CRITERIA, path=req["criteria_path"])
    except ValueError as exc:
        fail("criteria", f"criteria file is not valid: {exc}", EXIT_CRITERIA, path=req["criteria_path"])

    if req["mock"] is not None:
        # The mock's degradeForSelect mode models a backend that passed the
        # preflight probe and went flat for the real tournament: the probe
        # (a separate process) still discriminates, the tournament is flat.
        client = build_mock_client(req["mock"], force_flat=bool(req["mock"].get("degradeForSelect", False)))
        fgr.create_client = lambda: client

    print(
        f"verifier-bridge: llm-verifier {getattr(llm_verifier, '__version__', '?')} "
        f"model={req['model']} N={len(req['candidates'])} K={req['n_evaluations']} "
        f"pivots={req['pivots']} seed={req['seed']} on_error={ON_ERROR}",
        file=sys.stderr,
    )
    check_credentials(req)

    llm_verifier.USAGE.reset()
    started = time.monotonic()
    try:
        result = llm_verifier.select(
            req["problem"],
            req["candidates"],
            criteria=req["criteria_path"],
            n_evaluations=req["n_evaluations"],
            pivots=req["pivots"],
            seed=req["seed"],
            max_workers=req["max_workers"],
            model=req["model"],
            cache=req["cache_path"],
            progress=False,
            on_error=ON_ERROR,
        )
    except Exception as exc:  # on_error="raise" propagates backend failures here.
        traceback.print_exc(file=sys.stderr)
        kind = "credentials" if type(exc).__name__ == "MissingAPIKeyError" else "verifier-error"
        code = EXIT_CREDENTIALS if kind == "credentials" else EXIT_VERIFIER
        fail(kind, f"llm_verifier.select failed: {type(exc).__name__}: {exc}", code)

    n = len(req["candidates"])
    expected = expected_comparisons(n, req["pivots"])
    if result.n_comparisons != expected:
        fail(
            "comparison-count",
            f"select ran {result.n_comparisons} comparisons, expected {expected} "
            f"(N={n} + k(N-k) + C(k,2), pivots={req['pivots']}); halting without a winner",
            EXIT_HALT,
            nComparisons=result.n_comparisons,
            expectedComparisons=expected,
        )

    cache_report = None
    if req["cache_path"]:
        ok_cache, detail = inspect_cache(req["cache_path"])
        if not ok_cache:
            fail(
                "cache",
                f"score cache {req['cache_path']} is {detail} after selection; a silent cache-write "
                "failure dilutes the ring pass (upstream issue #14); halting without a winner",
                EXIT_HALT,
                cachePath=req["cache_path"],
            )
        cache_report = {"path": req["cache_path"], "bytes": os.path.getsize(req["cache_path"])}

    # Degenerate-score halt (ticket 06): a flat distribution means the
    # backend cannot discriminate between candidates (the silent 0.5
    # fallback of a logprob-less backend is the canonical shape). Picking
    # any winner from it would be fabrication, so halt with no winner.
    spread = max(result.scores) - min(result.scores)
    if spread <= DEGENERATE_SPREAD_EPSILON:
        fail(
            "degenerate-scores",
            f"verifier returned a flat score distribution "
            f"(spread {spread:.2e}, scores {[round(s, 6) for s in result.scores]}); "
            "the backend cannot discriminate between candidates, so no winner is "
            "selected. Traces and candidate snapshots are preserved for a "
            "verification retry.",
            EXIT_HALT,
            scores=result.scores,
        )

    emit({
        "ok": True,
        "kind": "select",
        "model": req["model"],
        "thinking": req["thinking"],
        "winnerIndex": result.index,
        "ranking": result.ranking,
        "scores": result.scores,
        "criteria": result.criteria,
        "nComparisons": result.n_comparisons,
        "expectedComparisons": expected,
        "usage": llm_verifier.token_usage(),
        "cache": cache_report,
        "elapsedMs": round((time.monotonic() - started) * 1000),
    })


def main() -> int:
    req = parse_request()
    kind = req.get("kind", "select")
    if kind == "preview":
        run_preview(req)
        return EXIT_OK
    if kind == "probe":
        run_probe(validate_probe_request(req))
        return EXIT_OK
    if kind != "select":
        fail("malformed-request", f'field "kind" must be "select", "preview", or "probe" (got {kind!r})', EXIT_MALFORMED)
    validated = validate_select_request(req)
    run_select(validated)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
