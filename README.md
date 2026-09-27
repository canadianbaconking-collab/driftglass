# Driftglass

Driftglass evaluates a normalized authority event against a versioned policy and explains which rule determined the decision. It is the replay kernel for testing changes to an AI agent's authority before those changes reach a live workflow. Its design began as PolicyReplay; the original preimplementation spec is retained in `docs/`.

**Status:** v0.1 kernel. This release evaluates one event at a time. Bulk trace replay, policy regression reports, real trace adapters, and live enforcement are later milestones.

## Quick start

Requires Node.js 20 or newer. No runtime dependencies or install step are needed.

```bash
node bin/driftglass.js evaluate examples/policy.json examples/event.json
npm run check
```

The CLI prints JSON and exits `0` for `ALLOW`, `2` for `DENY` or `REQUIRE_APPROVAL`, and `1` for invalid input or usage. Until approval evidence is defined in v0.8, approval never counts as an automated pass.

For direct use:

```js
import { loadPolicy, evaluate, passesAutomation } from './src/kernel/index.js';
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

`loadPolicy` validates and snapshots a policy once for repeated calls. `evaluate` also accepts an uncompiled policy, validates it, and validates every event. The kernel reads no files, clock, environment, or network; the CLI owns file I/O. The CI boundary check forbids imports and ambient APIs in `src/kernel/`.

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
```

The 50 authored decisions in `fixtures/v0.1.json` are the compatibility gate for future versions. Validation and behavior tests extend that corpus. The boundary script enforces the current import and ambient-state rules; it is a lightweight static check, not a general proof of JavaScript purity.

The evaluator trusts the supplied event. It cannot detect omitted or altered actions in a self-reported trace. Driftglass evaluates historical authority decisions; it does not intercept or enforce live agent actions in v0.1.

See [PROJECT_STATE.md](PROJECT_STATE.md) for the roadmap and [docs/PREIMPLEMENTATION_SPEC.md](docs/PREIMPLEMENTATION_SPEC.md) for the design contract.
