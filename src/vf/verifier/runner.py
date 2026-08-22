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

No scoring math is reimplemented here; llm_verifier.select() is called verbatim.
"""

from __future__ import annotations

import json
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

N_EVALUATIONS_DEFAULT = 4
N_EVALUATIONS_BENCHMARK = 8
PIVOTS_DEFAULT = 2
SEED_DEFAULT = 0
ON_ERROR = "raise"

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


def build_mock_client(config: dict):
    good_marker = config.get("goodMarker", "")
    mid_marker = config.get("midMarker", "")
    fail_calls = bool(config.get("failCalls", False))
    sleep_seconds = float(config.get("sleepSeconds", 0) or 0)
    log_file = config.get("logFile")
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

        letter_a, letter_b = grade(trace_a), grade(trace_b)
        text = (
            "mock analysis\n"
            f"<score_A> {letter_a} </score_A>\n"
            f"<score_B> {letter_b} </score_B>"
        )
        positions = [
            SimpleNamespace(token="<score_A>", logprob=-0.1, top_logprobs=_letter_distribution(letter_a)),
            SimpleNamespace(token=f" {letter_a}", logprob=-0.05, top_logprobs=_letter_distribution(letter_a)),
            SimpleNamespace(token=" </score_A>", logprob=-0.1, top_logprobs=_letter_distribution(letter_a)),
            SimpleNamespace(token="\n", logprob=-0.1, top_logprobs=_letter_distribution(letter_a)),
            SimpleNamespace(token="<score_B>", logprob=-0.1, top_logprobs=_letter_distribution(letter_b)),
            SimpleNamespace(token=f" {letter_b}", logprob=-0.05, top_logprobs=_letter_distribution(letter_b)),
            SimpleNamespace(token=" </score_B>", logprob=-0.1, top_logprobs=_letter_distribution(letter_b)),
        ]
        choice = SimpleNamespace(
            message=SimpleNamespace(content=text),
            logprobs=SimpleNamespace(content=positions),
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
    # instead of trying the vLLM-only prefill trick.
    client._llm_verifier_deepseek = True
    return client


def check_credentials(req: dict) -> None:
    if req["mock"] is not None:
        return
    env = {**os.environ, **req["env"]}
    if env.get("OPENAI_BASE_URL") or env.get("DEEPSEEK_API_KEY") or env.get("VERTEX_API_KEY"):
        return
    fail(
        "credentials",
        "no verifier backend configured: set OPENAI_BASE_URL, DEEPSEEK_API_KEY, or VERTEX_API_KEY "
        "(via the verifier profile env block or the launching process)",
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
        client = build_mock_client(req["mock"])
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
    if kind != "select":
        fail("malformed-request", f'field "kind" must be "select" or "preview" (got {kind!r})', EXIT_MALFORMED)
    validated = validate_select_request(req)
    run_select(validated)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
