# Code change — Verifier criteria

## Ground Truth Note

Do NOT trust the agent's self-assessment or claims of success.

## Criteria

### Root Cause Fit {#root_cause}

Read the reported problem, then look at where the agent's diff lands. Score
HIGH when the changed lines are the ones whose behavior actually produces the
reported failure — the buggy branch, the wrong condition, the mishandled
case. Score LOW when the change only masks the symptom downstream, special
cases the literal example from the report, or edits a caller to dodge a
broken callee. Judge by where the change sits in the call path. Ignore patch
size; small precise fixes and larger correct ones both score well.

### Code Review Soundness {#code_review}

Review the final diff as a code reviewer would. Check syntactic validity,
semantic correctness (right APIs, types, control flow, no off-by-one or
swapped arguments), preservation of existing contracts (signatures, return
types, error messages, output formats), and consistency with surrounding
style. Look specifically for silent regressions in code paths the report did
not mention — that is the most common shape of a patch that looks fine and
breaks something else. Ignore style-only nits and preference calls the diff
could go either way on.

### Empirical Verification {#verification}

Look at the commands the agent actually ran and what they printed — not the
narration around them. Score HIGH when the agent reproduced the failure,
observed it fixed afterwards, and re-ran the affected tests or checks.
Score LOW when success is declared without a run, when output is misread, or
when the code was edited again after the last passing check so the shipped
state is untested. This rubric assumes the agent could run commands; it does
not apply to tasks that could not be executed.
