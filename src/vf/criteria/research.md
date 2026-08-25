# Research report — Verifier criteria

## Ground Truth Note

Do NOT trust the agent's self-assessment or claims of success.

## Criteria

### Source Grounding {#sources}

Check whether the report's load-bearing factual claims trace to evidence the
agent actually retrieved in the trace (fetched pages, documents, data read
from files), and whether that evidence says what the report says it does.
Score HIGH when claims are cited to retrieved material and inference is
labeled as inference. Score LOW when facts are asserted without a source,
sources are paraphrased beyond what they support, or numbers and dates are
misread. Ignore prose quality and citation formatting.

### Analytical Depth {#analysis}

Score HIGH when the report compares the realistic options and names the
trade-offs, costs, and failure modes of each, with a conclusion that follows
from the evidence presented. Score LOW when it lists facts without connecting
them, presents a single option as the only possibility, or hides uncertainty
behind confident phrasing. Ignore length; depth is about distinctions made,
not words spent.

### Actionable Output {#actionable}

Score HIGH when the report ends in something the requester can act on: a
concrete recommendation or a next step that names what to do and what it
depends on. Score LOW when it ends in a summary with no decision, hedges
every claim into unusability, or answers a different question than the one
asked. Ignore formatting and structure beyond what the task requested.
