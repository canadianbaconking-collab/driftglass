# Driftglass project state

## v0.1 — published on `main`

- Strict schema version 1 loaders for policy, rule, constraints, and event, including UTC timestamp validation and stable IDs.
- Exact and one-segment terminal wildcard matching, deny precedence, lexicographic specificity, load-time ambiguity rejection, default coverage gaps, and decision explanations.
- Pure evaluator module with a CI-checked import/ambient-state boundary; file I/O resides in the CLI.
- 50 authored golden decisions plus invalid-input, ordering, explanation, and snapshot tests. Node 20+ dependency-free package and CI workflow.
- Automated pass semantics treat `REQUIRE_APPROVAL` as denied until approval evidence exists at v0.8.

Validation: `npm run check` passes 100 tests (including the 50 golden decisions), and the CLI example returns `ALLOW`. The GitHub `main` tree matches the tested source. The first hosted CI run ([Actions #36326317422](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36326317422)) completed successfully.

## Next checkpoint: v0.2

Replay directories of synthetic traces under both old and candidate policies. Summarize newly denied, newly approved, newly allowed, and unchanged events, preserving rule/default and match-state distinctions. Add the 10,000-event / 200-rule performance harness with hardware and runtime metadata; use the v0.1 corpus as a release compatibility gate. Validate the end-to-end regression report with an unrelated synthetic project before adding real adapters.

## Subsequent milestones

| Version | Planned scope |
| --- | --- |
| v0.3 | Resource narrowing and relationships, explicit unknown-resource handling, versioned richer pattern semantics if justified. |
| v0.4 | Coldgate native, OpenTelemetry, and OpenAI trace adapters, outside the evaluator boundary. |
| v0.5 | Policy diff. First spike decidability for restricted grammar and v0.3 additions; label a heuristic result as heuristic if exact containment is not viable. |
| v0.6 | CI integration. Hosted runners use only redacted or synthetic traces; real unredacted traces require self-hosted runners. |
| v0.7 | Policy authoring tests. |
| v0.8 | Approval evidence and provenance. |
| v0.9 | Candidate policy generation with coverage and corpus-confidence signals (days, actors, tools, thin evidence). |
| v1.0 | Threat model and stable release. State that the evaluator trusts trace integrity and completeness; provenance verification is outside scope. |

## Design invariants

Additive fields preserve v0.1 behavior. New semantics require new fields or an explicit schema version and migration. Unknown schema versions and unresolved policy ambiguity fail closed. The evaluator remains deterministic and free of I/O, clock, and environment access. Golden decisions must remain unchanged unless a semantic change is deliberate and documented in the changelog.
