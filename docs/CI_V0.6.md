# v0.6 CI policy gate

The CI gate evaluates the **same normalized corpus** under baseline and candidate policies, then compares the policies over every valid event in the restricted schema 1 grammar. It blocks when either check finds:

- a recorded `ALLOW` event becoming `DENY` or `REQUIRE_APPROVAL`; or
- any newly allowed authority, including cases absent from the corpus.

`DENY` to `REQUIRE_APPROVAL` remains nonpassing. A policy may narrow other authority without blocking if the recorded corpus has no passing-to-nonpassing regressions. Coverage and rule reassignment changes are reported but do not block. The exact diff's representative-cell count is a partition count, not an estimate of how many actions will occur. If the diff exceeds its analysis budget or any input fails validation, CI exits `1` without a passing report. A completed blocked check exits `2`; a passing check exits `0`.

## GitHub Actions

Check out the repository containing your policies and normalized traces, then call the published Driftglass action at a pinned tag or commit:

```yaml
name: Authority policy
on: [pull_request]
jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: canadianbaconking-collab/driftglass@<pinned-commit-or-release-tag>
        with:
          baseline: policies/baseline.json
          candidate: policies/candidate.json
          traces: traces/synthetic
```

Replace the placeholder ref after a release tag is created, or pin a reviewed commit. Both policy paths and the trace directory are relative to the caller's checked-out workspace. The composite action installs Node 22 and appends a **counts-only** result to the GitHub step summary. Its log and summary omit event values and witness examples. It does not upload the trace corpus or a report.

**Hosted runners: use only synthetic or redacted traces.** Do not commit unredacted resource IDs, account identifiers, or other sensitive trace values into a repository used by hosted CI. **Self-hosted runners are the supported path for real, unredacted traces.** Keep the runner, checkout, logs, and report destination under your own controls. Driftglass does not automatically redact events and cannot verify that supplied traces are complete or authentic.

To retain full event-level evidence, set `report-path` to a new file path you control and handle its retention explicitly. The report contains source event fields and concrete policy-diff witnesses. No report is created by default; a pre-existing report path causes an error rather than an overwrite.

## Local check

```powershell
cd c:/dev/playground/driftglass
node bin/driftglass.js ci fixtures/bookshop/baseline.json fixtures/bookshop/baseline.json fixtures/bookshop/traces
node bin/driftglass.js ci fixtures/bookshop/baseline.json fixtures/bookshop/candidate.json fixtures/bookshop/traces --json
```

The second command exits `2`: its historical corpus has three regressions, and the policy change is evaluated for any newly allowed authority too. `--json` prints the **full** report to stdout; avoid it in hosted CI logs. `--summary <path>` appends a counts-only Markdown summary, and `--report <new-path>` writes full JSON. No options means the CLI prints the counts-only summary. You can call `assessPolicyChange(baseline, candidate, traces)` directly from `driftglass/ci` or the package root; it returns `gate`, `comparison`, and `policy_diff` together.

The checked-in CI workflow exercises the composite action with a synthetic, unchanged policy pair after running boundary and compatibility tests. The local tests cover historical approval regressions, unexercised widening, invalid input, output privacy, and exit codes. The hosted [v0.6 workflow run](https://github.com/canadianbaconking-collab/driftglass/actions/runs/36366866855) passed the composite action smoke check.
