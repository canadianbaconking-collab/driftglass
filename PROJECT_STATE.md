# Driftglass project state

## v0.2 — implementation complete

- Recursive, stable JSON trace-directory reader. Each file is one trace; nested relative paths identify runs. Symlinks and invalid corpora fail the run.
- Single-policy bulk replay and baseline-versus-candidate impact analysis, with decision transitions, regressions, restorations, source/coverage changes, and winning-rule reassignments. Approval remains nonpassing for automation.
- Human and JSON CLI reports. The separate synthetic bookshop corpus exercises denials, approval requirements, restored access, and coverage drift. A generator produces 200 trace files for an end-to-end demonstration.
- Pure replay module and extended import/ambient-state boundary. The v0.1 golden corpus remains in the test suite.
- 120 local tests pass. The deterministic benchmark replays 10,000 events from 200 traces against 200 rules; on a Linux Node 24 host (Xeon E5-2673 v4), the observed median was 130.22 ms. GitHub CI records and uploads timing plus hardware/runtime metadata. The under-1-second target is currently observational while runner variance is assessed.

Hosted CI for the v0.2 commit passed all 120 tests and uploaded the benchmark artifact ([run #36332260351](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36332260351)). Its Node 22 median was 50.54 ms, under the 1-second target. The timing remains observational until runner variance is assessed.

## v0.1 — published on `main`

- Strict schema version 1 loaders for policy, rule, constraints, and event, including UTC timestamp validation and stable IDs.
- Exact and one-segment terminal wildcard matching, deny precedence, lexicographic specificity, load-time ambiguity rejection, default coverage gaps, and decision explanations.
- Pure evaluator module with a CI-checked import/ambient-state boundary; file I/O resides in the CLI.
- 50 authored golden decisions plus invalid-input, ordering, explanation, and snapshot tests. Node 20+ dependency-free package and CI workflow.
- Automated pass semantics treat `REQUIRE_APPROVAL` as denied until approval evidence exists at v0.8.

Validation: `npm run check` passes 100 tests (including the 50 golden decisions), and the CLI example returns `ALLOW`. The GitHub `main` tree matches the tested source. The first hosted CI run ([Actions #36326317422](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36326317422)) completed successfully.

## Next checkpoint: v0.3

Add resource narrowing and relationships, explicit unknown-resource handling, and versioned richer scope syntax only where the v0.1 grammar cannot represent a needed relationship. Preserve the v0.1 fixture decisions and the evaluator's I/O boundary. Real trace adapters follow in v0.4.

## Subsequent milestones

| Version | Planned scope |
| --- | --- |
| v0.4 | Coldgate native, OpenTelemetry, and OpenAI trace adapters, outside the evaluator boundary. |
| v0.5 | Policy diff. First spike decidability for restricted grammar and v0.3 additions; label a heuristic result as heuristic if exact containment is not viable. |
| v0.6 | CI integration. Hosted runners use only redacted or synthetic traces; real unredacted traces require self-hosted runners. |
| v0.7 | Policy authoring tests. |
| v0.8 | Approval evidence and provenance. |
| v0.9 | Candidate policy generation with coverage and corpus-confidence signals (days, actors, tools, thin evidence). |
| v1.0 | Threat model and stable release. State that the evaluator trusts trace integrity and completeness; provenance verification is outside scope. |

## Design invariants

Additive fields preserve v0.1 behavior. New semantics require new fields or an explicit schema version and migration. Unknown schema versions and unresolved policy ambiguity fail closed. The evaluator remains deterministic and free of I/O, clock, and environment access. Golden decisions must remain unchanged unless a semantic change is deliberate and documented in the changelog.
