# Driftglass project state

## Review hardening — 2026-09-28

- Scope relationships must be primitive strings from the supported enum. Arrays and objects fail policy loading instead of coercing into valid property keys and later matching a broader scope. The matcher explicitly rejects unknown relationships.
- Added malformed-relation regression cases for every outcome while retaining the existing scope matrix and golden decisions.
- Directory tests retain all sorting assertions and isolate symlink validation in a subtest. Windows hosts lacking symlink permission report that subtest as skipped; Linux and capable Windows hosts still exercise rejection.

## v0.6 — implementation complete

- Added `assessPolicyChange` and `driftglass ci`: the gate blocks on either historical pass-to-nonpass regression or exact newly allowed authority. Approval is nonpassing; invalid data and an unfinished diff fail without a pass.
- Added composite `action.yml` with counts-only GitHub step summary and optional full JSON report. Hosted runners are documented for synthetic/redacted traces only; real unredacted traces require self-hosted runners. No report is uploaded by default.
- The checked-in workflow invokes the action with an unchanged synthetic fixture pair. Local `npm run check` passes 178 tests, including CI gating, output privacy, CLI exit codes, and the 50 original v0.1 golden decisions. Hosted CI [run #36366866855](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36366866855) passed, including the composite action smoke check and benchmark artifact upload.

## v0.5 — implementation complete

- Exact semantic policy diff over the shipped restricted schema 1 rule grammar. Finite representative partitions cover exact tool/actor/effect values, terminal one-segment legacy patterns, v0.3 known/unknown scope relationships, and defaults. The comparator calls the existing evaluator and supplies real witness events for newly allowed/nonpassing/approved/denied decisions, coverage changes, and rule reassignments.
- The scope fixture reveals `mixed` authority: a candidate scoped child rule grants WRITE when the old required `repo/*` legacy resource is missing. This widening did not occur in the fixture trace corpus; historical compare remains accurate for those recorded events.
- `driftglass diff` and `diffPolicies` expose the result. A finite analysis budget fails without an exactness claim or partial output. See [the proof and limits](docs/POLICY_DIFF_V0.5.md).

Hosted CI for v0.5 passed all 174 tests and uploaded the replay benchmark artifact ([run #36352858789](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36352858789)). The local 200-rule exact-diff smoke comparison completed in 9,600 representative cells; performance is not a release gate for policy diff.

## v0.4 — implementation complete

- Added saved Coldgate native report, OTLP JSON, and OpenAI Agents Python span adapters outside the evaluator boundary. Effect maps are mandatory for each recognized capability action; observed resource labels become known hierarchy scopes only through a reviewed exact mapping. Missing evidence remains explicitly unknown.
- Added `adapt` CLI and public adapter API, local JSON adapter contract, synthetic source-shape tests, and compatibility checks against v0.1 golden and v0.3 scope decisions. No prompts or tool arguments enter normalized output.
- No real private trace was supplied for local comparison. Production-export compatibility remains unverified; hosted CI runs synthetic fixtures only.

Hosted CI for v0.4 passed all 164 tests and uploaded the benchmark artifact ([run #36349338478](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36349338478)). Coldgate's public synthetic exports also imported locally through both source and native report paths. No private production traces were supplied for verification.

## v0.3 — implementation complete

- Added an optional, separately versioned `resource_scope` object to policies and events. Known paths support `self`, `child`, `descendant`, and `self_or_descendant` relationships with literal segments; missing and explicitly unknown event scope can be handled by explicit deny or approval rules. Unknown scope cannot be granted by a scope-specific allow rule.
- Extended specificity ordering by anchor depth and relationship, and extended load-time overlap rejection to scoped rules. Explicit deny remains dominant. The v0.1 `resource` exact and terminal wildcard semantics are unchanged; no broader wildcard syntax was needed.
- Added synthetic scope policy and traces, CLI regression demonstration, strict schema and precedence tests, and a normative [scope contract](docs/SCOPE_V0.3.md). The 50 v0.1 golden decisions and outputs remain unchanged with optional scope input.
- 156 local tests pass. The 10,000-event / 200-rule benchmark remains below the one-second target (199.52 ms median in the latest local Node 24 Linux run); CI continues to record timing without gating on it.

Hosted CI for the v0.3 commit passed all 156 tests and uploaded the benchmark artifact ([run #36339264665](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36339264665)). Its Node 22 median was 56.99 ms, under the one-second target. Scope paths are trusted normalized inputs; real provider normalization remains v0.4 work.

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

## Subsequent milestones

| Version | Planned scope |
| --- | --- |
| v0.7 | Policy authoring tests. |
| v0.8 | Approval evidence and provenance. |
| v0.9 | Candidate policy generation with coverage and corpus-confidence signals (days, actors, tools, thin evidence). |
| v1.0 | Threat model and stable release. State that the evaluator trusts trace integrity and completeness; provenance verification is outside scope. |

## Design invariants

Additive fields preserve v0.1 behavior. New semantics require new fields or an explicit schema version and migration. Unknown schema versions and unresolved policy ambiguity fail closed. The evaluator remains deterministic and free of I/O, clock, and environment access. Golden decisions must remain unchanged unless a semantic change is deliberate and documented in the changelog.
