# v0.7 policy authoring tests

A policy test suite pins intended decisions for authored authority events. It can also assert whether a rule or default decided the event, whether it matched any rule, and which rule IDs matched or won. This catches unintended changes to precedence or policy coverage before a historical corpus has exercised the path.

```powershell
cd c:/dev/playground/driftglass
node bin/driftglass.js policy test fixtures/bookshop/baseline.json fixtures/bookshop/baseline.tests.json
node bin/driftglass.js policy test fixtures/bookshop/baseline.json fixtures/bookshop/baseline.tests.json --json
```

The suite format is strict JSON:

```json
{
  "schema_version": 1,
  "cases": [
    {
      "id": "vip-deny-overrides-refund",
      "event": { "schema_version": 1, "tool": "payments.refund", "effect": "SEND", "resource": "orders/vip" },
      "expect": {
        "decision": "DENY",
        "source": "rule",
        "match_state": "MATCHED",
        "winning_rule_ids": ["vip-deny"],
        "matching_rule_ids": ["refund", "vip-deny"]
      }
    }
  ]
}
```

`decision` is required. `source`, `match_state`, `winning_rule_ids`, and `matching_rule_ids` are optional assertions. Supplying an ID list asserts the **complete** set; order in the suite does not matter. Case IDs are stable, unique identifiers matching the rule ID grammar. The suite must contain at least one case. Unknown fields, invalid events, unknown versions, duplicate IDs, invalid expectations, and invalid policies fail validation before any case results are returned. The evaluator's schema and precedence remain unchanged.

An expected `REQUIRE_APPROVAL` may **pass an authoring assertion**: it means the policy did what the author intended. Approval still does not grant an action or count as a pass in replay and CI regression gates before v0.8 evidence exists.

The command exits `0` if all assertions hold, `2` for one or more failed assertions, and `1` for invalid input or I/O. Default output includes failed case IDs and mismatched fields without printing event values. `--json` emits the case report. `--summary <path>` appends a counts-only Markdown summary and suppresses case details on stdout; use this mode in shared CI logs. The pure API `testPolicy(policy, suite)` is exported from `driftglass/policy-test` and the package root.

The composite GitHub Action accepts an optional `test-suite` path. When supplied, it runs the suite against the **candidate** before checking historical regressions and exact policy widening. A failed suite stops the job. A suite is a set of selected examples, not proof that every policy event has been tested; the exact diff and trace comparison remain separate checks. Hosted runners should use only synthetic or redacted events, as in [the CI data contract](CI_V0.6.md).
