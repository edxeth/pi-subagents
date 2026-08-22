# Generic task — Verifier criteria

## Ground Truth Note

Do NOT trust the agent's self-assessment or claims of success.

## Criteria

### Answer–Task Alignment {#alignment}

Compare the agent's final deliverable against the task as written, not against
a reworded version of it. Score HIGH when everything the task asked for is
present in the form it asked for and nothing asked-for is quietly dropped or
substituted. Score LOW when the answer solves an adjacent problem, honors only
the parts that were easy, or replaces the requested artifact with a
description of it. Ignore effort, style, and how confident the narration
sounds.

### Evidence Grounding {#evidence}

Check whether the load-bearing claims in the final report are supported by
observable output in the trace: command output, file contents read back,
fetched material, or explicit tool results. Score HIGH when conclusions cite
what was actually observed; score LOW when results are asserted, when the
trace contradicts the report, or when a check that would have been cheap to
run was skipped and its outcome invented. For tasks with nothing runnable to
check, grounding means the report marks inference as inference. Ignore
formatting and prose polish.

### Completeness and Honesty {#completeness}

Score HIGH when the report states what was done, what was not done, and any
failure or partial result encountered along the way. Score LOW when failures
are omitted, when caveats are dropped to make the result look cleaner, or when
constraints the task stated (scope, format, environment) are silently
violated. Ignore length beyond what the task asked for.
