# Driftglass

Driftglass evaluates a normalized authority event against a versioned policy and explains which rule determined the decision. It is the replay kernel for testing changes to an AI agent's authority before those changes reach a live workflow. Its design began as PolicyReplay; the original preimplementation spec is retained in `docs/`.

**Status:** v0.7 policy authoring tests, a CI gate combining historical regressions and exact policy widening, and saved Coldgate, OTLP JSON, and OpenAI Agents Python trace adapters. Live enforcement is a later milestone.

## Quick start

Requires Node.js 20 or newer. No runtime dependencies or install step are needed.

```bash
node bin/driftglass.js evaluate examples/policy.json examples/event.json
node bin/driftglass.js replay fixtures/bookshop/candidate.json fixtures/bookshop/traces
node bin/driftglass.js compare fixtures/bookshop/baseline.json fixtures/bookshop/candidate.json fixtures/bookshop/traces
node bin/driftglass.js compare fixtures/scope/baseline.json fixtures/scope/candidate.json fixtures/scope/traces
node bin/driftglass.js diff fixtures/scope/baseline.json fixtures/scope/candidate.json
node bin/driftglass.js ci fixtures/bookshop/baseline.json fixtures/bookshop/baseline.json fixtures/bookshop/traces
node bin/driftglass.js policy test fixtures/bookshop/baseline.json fixtures/bookshop/baseline.tests.json
npm run check
```

Adapt a saved single-trace export using an explicit effect/scope mapping:

```bash
node bin/driftglass.js adapt coldgate saved-report.json mapping.json > normalized-traces/run.json
```

See [the v0.4 adapter contract](docs/TRACE_ADAPTERS_V0.4.md) for source formats, mapping rules, and the limits of historical telemetry.

The new [policy diff contract](docs/POLICY_DIFF_V0.5.md) compares authority for every valid event in the restricted grammar and gives concrete witnesses. It exits `2` when candidate policy authority widens, `0` otherwise, and `1` for invalid or incomplete analysis. The scope fixture reveals both narrowing and an unrecorded widening: the candidate allows a scoped child without the legacy `resource` that the baseline required.

The [v0.6 CI gate](docs/CI_V0.6.md) combines historical pass-to-block regressions with exact newly allowed authority. `driftglass ci` and the composite GitHub Action block on either result, fail closed on invalid or incomplete analysis, and print a counts-only summary. Hosted runners use only redacted or synthetic traces; unredacted real traces require a self-hosted runner. Full event reports are opt-in.

The [v0.7 policy test suite](docs/POLICY_TESTS_V0.7.md) lets authors pin expected decisions, matched/default status, and winning rules for chosen events. `driftglass policy test` exits `2` for a failed assertion and `1` for invalid input. The GitHub Action accepts an optional `test-suite` input, evaluated against the candidate policy before the other gates.

The bookshop `compare` example reports three regressions: a new shipping deny, a refund requiring approval, and an inventory action falling through to default deny. The scope example reports four regressions from narrowing authority under `tenants/acme` and denying unknown scope. Append `--json` to `replay` or `compare` for the complete machine-readable report.

Exit codes: `0` means no nonpassing event (`evaluate`/`replay`) or no regression (`compare`); `2` means at least one deny or approval (`evaluate`/`replay`) or at least one newly nonpassing event (`compare`); `1` means invalid input or usage. Until approval evidence is defined in v0.8, approval never counts as an automated pass. A `DENY` → `REQUIRE_APPROVAL` transition is newly approved but is **not** restored.

For direct use:

```js
import { loadPolicy, evaluate, comparePolicies, diffPolicies, passesAutomation } from './src/index.js';
import policy from './examples/policy.json' with { type: 'json' };

const compiled = loadPolicy(policy);
const result = evaluate(compiled, {
  schema_version: 1,
  tool: 'github.push_files',
  effect: 'WRITE',
  resource: 'canadianbaconking-collab/driftglass'
});
console.log(result.decision, result.winning_rule_ids, passesAutomation(result));
```

`loadPolicy` validates and snapshots a policy once for repeated calls. `evaluate` also accepts an uncompiled policy, validates it, and validates every event. The kernel and replay logic read no files, clock, environment, or network; the CLI and directory reader own file I/O. The CI boundary check allows the replay module to import only the kernel and forbids other imports and ambient APIs in both pure modules.

## Trace directories and impact reports

Each `.json` file in a trace directory (including nested directories) is one trace. Its relative path is the trace ID. The directory reader ignores other file types, refuses symlinks and malformed JSON, and rejects an empty corpus. Trace files contain only the following versioned envelope:

```json
{
  "schema_version": 1,
  "events": [
    { "schema_version": 1, "tool": "shipping.create", "effect": "WRITE", "resource": "orders/101" }
  ]
}
```

An individual trace may have no events, but the whole corpus must contain at least one. Unknown fields in traces, events, or policies fail the run. `comparePolicies(baseline, candidate, traces)` is a pure API that validates the entire corpus before comparison. The directory reader is a separate I/O adapter; the fixture corpus remains synthetic; v0.4 adapters accept saved traces with explicit mappings.

## v0.3 resource scope

Rules may add `resource_scope` with a literal anchor and a `self`, `child`, `descendant`, or `self_or_descendant` relationship. Events may supply a normalized scope path or mark it unknown. A missing scope also counts as unknown to **new scope rules**. An explicit `deny` or `require_approval` rule can match unknown scope; an unknown-scope `allow` fails policy loading. The separate v0.1 `resource` field keeps its original exact and one-segment wildcard behavior. See [the scope contract](docs/SCOPE_V0.3.md) for complete schemas, precedence, path validation, and the distinction between missing and normalized scope.

The comparison counts newly allowed, denied, approved, and unchanged **final decisions**. It separately records passing-to-nonpassing regressions, restored events, default-to-rule and rule-to-default coverage changes, and winning-rule reassignments. A decision can be unchanged while its coverage or winning rule changes; those events appear in the detailed output. Each change retains the event, both final decisions, `MATCHED`/`UNMATCHED`, source, and winning rule IDs. The corpus is evaluated against both policies without changing either policy or the events.

Generate a 200-trace demonstration in a fresh directory:

```bash
node scripts/generate-demo.js demo-traces-200
node bin/driftglass.js compare fixtures/bookshop/baseline.json fixtures/bookshop/candidate.json demo-traces-200
```

## v0.1 input contract

```json
{
  "schema_version": 1,
  "default": "deny",
  "rules": [
    { "id": "review-outbound", "require_approval": { "tool": "slack.send", "effect": "SEND", "destination": "team/*" } }
  ]
}
```

An event has required `schema_version: 1`, `tool`, and `effect`. It may include `actor`, `resource`, `destination`, and a UTC RFC 3339 `timestamp` such as `2026-09-26T12:00:00Z`. Allowed effects are `READ`, `WRITE`, `EXECUTE`, `DELETE`, and `SEND`. Rules must have a stable unique `id`, exactly one of `allow`, `deny`, or `require_approval`, and a required exact `tool`. Other constraints are optional. Unknown fields, unknown versions, `null`, empty strings, malformed dates, duplicate bodies, and unresolved non-deny ties fail validation.

`resource` and `destination` constraints can be exact strings or `literal/*`, which matches exactly one non-empty trailing path segment. A missing event field does not satisfy a constrained rule. The evaluator does not coerce strings, infer resource hierarchy, or map effects from external providers.

When rules match, any explicit deny wins. Otherwise the highest lexicographic specificity vector `[effect, actor, resource, destination]` wins, with exact paths scored `2`, terminal wildcards `1`, and absent constraints `0`. An equal-vector overlap between `allow` and `require_approval` fails policy loading. File order does not affect decisions.

Every result has `match_state` (`MATCHED` or `UNMATCHED`), final `decision`, `source` (`rule` or `default`), matching rule IDs, and winning rule IDs. A default decision preserves `UNMATCHED` as a coverage gap. Non-allow outcomes include reasons why rules of equal or higher priority did not match. Specificity vectors are returned where they decide among matches.

## Development and limitations

```bash
npm run check:boundary
npm test
npm run benchmark
```

The 50 authored decisions in `fixtures/v0.1.json` remain the compatibility gate. The deterministic benchmark replays 10,000 events across 200 traces against 200 rules, prints CPU/runtime details and timing, and uploads its JSON report in CI. Its target is under 1 second; CI currently **records** the result without using elapsed time as a release gate while runner variance is assessed. The boundary script enforces the current import and ambient-state rules; it is a lightweight static check, not a general proof of JavaScript purity.

The evaluator trusts the supplied event, including any normalized scope path. It cannot detect omitted or altered actions in a self-reported trace. Driftglass evaluates historical and hypothetical authority decisions; it does not intercept or enforce live agent actions in v0.5.

See [PROJECT_STATE.md](PROJECT_STATE.md) for the roadmap and [docs/PREIMPLEMENTATION_SPEC.md](docs/PREIMPLEMENTATION_SPEC.md) for the design contract.
