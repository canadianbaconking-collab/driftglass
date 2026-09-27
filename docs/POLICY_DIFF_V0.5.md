# v0.5 exact policy diff

`diff` compares the decisions of two policies over **all valid schema 1 authority events**, including events absent from a trace corpus. It uses the same evaluator, deny precedence, specificity ordering, defaults, and scope rules as replay. It does not inspect past traces or predict which actions an agent will actually attempt.

```powershell
cd c:/dev/playground/driftglass
node bin/driftglass.js diff fixtures/scope/baseline.json fixtures/scope/candidate.json
node bin/driftglass.js diff fixtures/scope/baseline.json fixtures/scope/candidate.json --json
```

Exit `2` means at least one event newly receives `ALLOW`; `0` means no newly allowed event; `1` means invalid input, ambiguous policy, or an unfinished analysis. A narrowing or an approval-only change exits `0`, and its details appear in the output. `diffPolicies(baseline, candidate, { max_cells })` is also exported from `src/diff/index.js` and the package root. The default analysis budget is 250,000 representative cells. If the budget is exceeded, the operation throws without returning a partial answer; callers must not treat that failure as an equivalence result.

## Exactness argument

The shipped policy grammar deliberately has finite discriminators. Rules require an exact tool; effects are one of five values; actors use exact equality; legacy `resource` and `destination` use exact values or a **terminal one-segment** `/*`; `resource_scope` is explicitly unknown or a literal anchor with `self`, `child`, `descendant`, or `self_or_descendant`. There are no regexes, partial segment wildcards, or arbitrary-depth path wildcards in legacy fields. Timestamps have no rule semantics in schema 1.

For each named tool, the diff forms a finite partition independently for each field:

- All five effects; every named actor plus an omitted actor and one fresh value.
- Every exact resource/destination, one fresh child for each terminal wildcard base, one fresh value outside all patterns, and omission.
- Unknown scope plus each anchor prefix, a fresh child, a fresh grandchild, and a fresh unrelated root. This covers exact anchor depth, one-level children, deeper descendants, and branches outside nested anchors.
- A fresh tool represents every tool unmentioned by either policy. Such tools use the defaults, so they need only one event.

The fresh values are chosen outside all literal path segments. Within a partition cell, the truth of every rule constraint and its specificity vector are fixed. Both policies therefore select the same outcomes for every event in that cell. Enumerating the cross-product and calling the shipping evaluator establishes exact allowance containment for this grammar; no sampling inference is used. An emitted witness is a valid concrete event in the changed cell and can be evaluated directly. The finite-cell analysis is exact **when it completes**, subject to the same policy input assumptions as the evaluator. If a future grammar adds regexes or broader wildcards, it requires a new proof and implementation rather than silently reusing this method.

`authority` compares automated pass sets only: `widened`, `narrowed`, `mixed`, or `equivalent`. `REQUIRE_APPROVAL` is nonpassing until approval evidence is defined. `decisions_equal` separately checks all three final decisions, so a `DENY` to `REQUIRE_APPROVAL` change has equivalent automated authority but different decisions. The `categories` values count **representative cells**, not real events, probabilities, or authority volume. `witnesses` retain a concrete event and each policy's decision, source, and winning rule IDs for the first cell in each category. `coverage_changed` and `rule_reassigned` expose provenance changes even when the decision stays the same. These categories can overlap.

## Example: what the scope fixture reveals

```powershell
node bin/driftglass.js compare fixtures/scope/baseline.json fixtures/scope/candidate.json fixtures/scope/traces
node bin/driftglass.js diff fixtures/scope/baseline.json fixtures/scope/candidate.json
```

The recorded traces show four regressions. The exact diff additionally finds a **widening**: `allow-project-child` in the candidate matches a project child with a known scope even if the legacy `resource` field is omitted; the baseline `write-repo` allowance required `resource: "repo/*"`. The policy pair is therefore `mixed`. This is a difference in policy authority, not proof that an agent exercised the path.
