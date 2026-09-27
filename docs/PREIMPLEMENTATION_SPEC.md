# PolicyReplay — Pre-Implementation Spec

Status: draft, pre-v0.1
Purpose: resolve the design questions that the roadmap left implicit, before any evaluator code is written. Everything here is a constraint on v0.1, not a future milestone — the roadmap's later gates (v0.5 diff, v0.6 CI, v0.8 provenance) all assume these decisions were made correctly at the start.

---

## 0. v0.1 Schema Grammar

The first evaluator needs a small, validated input language. These are the v0.1 wire shapes; adapters normalize external data before it crosses the evaluator boundary. Missing optional fields mean "no constraint" on a rule and "unknown/not supplied" on an event. `null` is never a substitute for omission. All strings are non-empty and case-sensitive; the evaluator does not trim, coerce, or case-fold them. Unknown fields and unknown enum values fail validation rather than being ignored.

### 0.1 `Policy` and `Rule`

```text
Policy = {
  schema_version: 1,                 // required integer, exactly 1
  default: "allow" | "deny",         // required
  rules: Rule[]                      // required; may be empty
}

Rule = {
  id: string,                       // required, unique within the policy
  exactly one of:
    allow: Constraints
    deny: Constraints
    require_approval: Constraints
}

Constraints = {
  tool: string,                     // required exact match
  effect?: "READ" | "WRITE" | "EXECUTE" | "DELETE" | "SEND",
  actor?: string,                   // exact match
  resource?: string,                // exact or v0.1 segment wildcard (§1.1.1)
  destination?: string              // exact or v0.1 segment wildcard (§1.1.1)
}
```

`id` must match `[A-Za-z][A-Za-z0-9._-]*` and must remain stable when a rule moves in the file. A missing or duplicate ID fails policy loading; file positions and generated IDs are not identifiers. A rule with more than one outcome key, an unknown key at any level, an empty value, a `null` value, an invalid pattern, or a duplicate outcome-plus-constraint body also fails loading. Constraint fields are scalar strings, never arrays or objects. An empty `rules` array is valid because the required default still decides every event.

### 0.2 `AuthorityEvent`

```text
AuthorityEvent = {
  schema_version: 1,                 // required integer, exactly 1
  tool: string,                     // required exact tool name
  effect: "READ" | "WRITE" | "EXECUTE" | "DELETE" | "SEND", // required
  actor?: string,
  resource?: string,
  destination?: string,
  timestamp?: string                // RFC 3339 instant, normalized to UTC
}
```

The optional `timestamp` exists from v0.1. Its canonical form is `YYYY-MM-DDTHH:mm:ss[.fraction]Z`; invalid dates, offsets left unnormalized, and local times fail validation. The evaluator never reads the clock or uses `timestamp` to break a rule tie. A missing event field does not match a rule that constrains that field; an absent rule constraint matches either a present or missing event field. Event fields are literal values, so wildcard syntax has meaning only in rule `resource` and `destination` constraints. Events with unknown keys, `null`, empty strings, malformed timestamps, or an unrecognized effect fail validation before evaluation. An adapter may reject or explicitly map an external effect into one of the five v0.1 classes, but the evaluator does not guess.

---

## 1. Rule Precedence and Conflict Resolution

This is the part of any policy engine most likely to be both buggy and security-relevant. It has to be nailed down before "explain which rule matched and why" (the v0.1 deliverable) can mean anything.

### 1.1 Resolution order

When multiple rules match a single normalized `AuthorityEvent`:

1. **Explicit DENY always wins**, regardless of specificity. If any matching rule is `deny`, the decision is `DENY`. No allow or require_approval rule can override a deny, no matter how specific.
2. **Among the remaining matches** (no deny present), the **most specific rule wins**. Compare each matching rule's vector `[effect, actor, resource, destination]` lexicographically, from left to right. `effect` and `actor` score `1` when constrained and `0` when absent. `resource` and `destination` score `2` for an exact constraint, `1` for a segment wildcard, and `0` when absent. `tool` is required on every rule and is not a differentiator. At the first unequal vector component, the larger value wins; do not sum the components. Thus a constrained `effect` outranks any combination of later dimensions, and an exact `resource` outranks a wildcard `resource` only when earlier components tie. Report the vector, not an ambiguous scalar "score."
3. **A tie in specificity between two non-deny rules producing different outcomes is a policy authoring error.** Any two `allow`/`require_approval` rules whose constraints can match the same event and whose vectors are equal make the policy fail to load, even if that event is absent from the current trace. This overlap check is decidable under the v0.1 grammar below. Equal-vector matches with the same outcome are allowed and report all winning rule IDs. Declaration order, file order, and "last wins" never resolve a conflict.

### 1.1.1 v0.1 matching grammar

`tool`, `effect`, and `actor` constraints use exact, case-sensitive equality only. `resource` and `destination` accept either an exact string or one terminal, whole-segment wildcard: `literal/*` (where `literal` is one or more non-empty slash-separated segments). `*` matches exactly one non-empty segment; `repo/*` matches `repo/app` but not `repo`, `repo/app/secrets`, or `repo/app/`. It does not mean an arbitrary prefix. Embedded stars, multiple stars, `**`, regex, glob escapes, and wildcards in any other field are invalid in v0.1. Exact strings cannot contain `*`. Normalized event values are compared literally, without hierarchy inference or resource lookup.

v0.3 adds richer scope semantics: resource narrowing and relationships, explicit unknown-resource handling, and any broader wildcard grammar justified by that work. It must not silently reinterpret a v0.1 pattern; new syntax or fields require explicit versioned semantics and compatibility fixtures (§3.1–3.3).

### 1.2 Fail-closed applies to policy authoring, not just evaluation

This is the one addition worth calling out explicitly: the roadmap's "unknown must never silently collapse into allow" principle governs runtime evaluation. The same posture must govern **policy loading**. A policy with an unresolved tie, a malformed constraint, a missing or duplicate rule ID, or an unrecognized rule type must fail to load — not fall back to a default, not warn-and-continue. `coldgate policy test` (v0.7) and CI (v0.6) both depend on this: a policy that loads "successfully" but has silent ambiguity defeats the purpose of testing it.

### 1.3 Worked example

Two rules within `policy.rules`:

```yaml
- id: allow-repo-push
  allow:
    tool: github.push_files
    resource: "canadianbaconking-collab/*"

- id: deny-secrets-push
  deny:
    tool: github.push_files
    resource: "canadianbaconking-collab/coldgate-secrets"
```

Event: `push_files` to `canadianbaconking-collab/coldgate-secrets`.
Both rules match. Rule `deny-secrets-push` wins outright — specificity comparison never happens, because rule 1.1 short-circuits before rule 1.2 is evaluated.

Event: `push_files` to `canadianbaconking-collab/coldgate`.
Only the allow rule matches. Result: `ALLOW`, explained as "matched rule `allow-repo-push` (resource wildcard `canadianbaconking-collab/*`)."

### 1.4 Explainability requirement

Every decision must report:
- the stable ID of every matching rule, and which ID(s) produced the winning decision (or `source: default` when none matched)
- why non-matching rules of equal or higher priority didn't apply (only for DENY/REQUIRE_APPROVAL outcomes, to keep ALLOW output terse)
- the specificity vectors that broke the tie, when relevant

---

## 2. Decision State Model

### 2.1 Three final decisions and one pre-default match state

| State | Meaning |
|---|---|
| `ALLOW` | Final decision: a rule or the default permitted the event. |
| `DENY` | Final decision: a rule or the default forbade the event. |
| `REQUIRE_APPROVAL` | Final decision: a rule explicitly requires human sign-off. |
| `UNMATCHED` | Pre-default match status: no rule matched. This is a **coverage gap**, not a final decision. |

Every successful evaluation reports `match_state: MATCHED | UNMATCHED`, `decision: ALLOW | DENY | REQUIRE_APPROVAL`, and `source: rule | default`. `UNMATCHED` is assigned after rule resolution and before the required default is applied; it is never an externally enforceable fourth decision. `source: default` if and only if `match_state: UNMATCHED`. `REQUIRE_APPROVAL` always has `source: rule`. Reports retain the match state so v0.2's regression analysis and v0.5's policy diff can distinguish "we found a gap in your policy" from "your policy is working as designed and asking for a human."

### 2.2 Default policy behavior

An explicit `default: deny` or `default: allow` at the policy root determines what happens when no rule matches. If no default is declared, the policy fails to load (fail-closed — see 1.2). When a default resolves an otherwise-unmatched event, the final decision is `DENY` or `ALLOW` with `match_state: UNMATCHED` and `source: default`; human-facing output renders this as `DENY (default)` or `ALLOW (default)`. The distinction between "a rule said so" and "the default said so" matters for auditing and for v0.9's candidate-generation coverage math.

### 2.3 REQUIRE_APPROVAL is semantically empty until v0.8 — treat it as DENY-equivalent until then

`REQUIRE_APPROVAL` is emitted starting in v0.1, but nothing before v0.8 defines what "approval" means, who grants it, or how it's recorded. Leaving it as a soft, unenforced third category for seven versions is a real gap: a CI check or regression report that treats `REQUIRE_APPROVAL` as "passing" is silently weaker than it looks.

**Rule:** for every automated pass/fail purpose (v0.2 regression summaries, v0.6 CI exit codes) prior to v0.8, `REQUIRE_APPROVAL` is treated identically to `DENY`. It is still labeled distinctly in human-facing output (so a reviewer can tell the two apart), but it never counts as a passing/safe outcome until v0.8 ships real approval evidence and the policy can distinguish `REQUIRE_APPROVAL + approval granted` from `REQUIRE_APPROVAL + approval status unknown`.

---

## 3. Schema Versioning and Evolution Policy

### 3.1 Rule: additive-only through 1.0

- Every new field introduced after v0.1 is **optional**, with a defined default that preserves old behavior.
- **No field's meaning is ever changed** once shipped. If a field needs different semantics, it gets a new name.
- A genuinely breaking change (rare, and should be resisted) bumps `schema_version` and ships with a migration path — not a silent reinterpretation.

### 3.2 Where `schema_version` lives

Both schemas carry it from v0.1, not added later:

```yaml
# policy.yaml
schema_version: 1
default: deny
rules: []
```

```json
// normalized AuthorityEvent
{
  "schema_version": 1,
  "tool": "github.push_files",
  "actor": "release-agent",
  "resource": "canadianbaconking-collab/coldgate",
  "effect": "WRITE",
  "timestamp": "2026-09-26T12:00:00Z"
}
```

An engine that sees a `schema_version` it doesn't recognize fails closed (refuses to evaluate) rather than guessing. The field-level validation contract is in §0; the example event includes the optional v0.1 timestamp.

### 3.3 Enforcement mechanism: the golden fixture corpus

The ~50 hand-built fixtures from v0.1 aren't just a testing convenience — they become the enforcement mechanism for 3.1. Every later version's gate includes: **all v0.1 fixtures still evaluate to their original decisions**, unless a change is explicitly logged in a changelog as an intentional semantic change (which should be rare and deliberate, not a byproduct of adding a feature). This turns "backwards compatibility rules exist" from a 1.0 checkbox into something continuously verified starting at v0.2.

---

## 4. Evaluator Purity Constraint

### 4.1 The constraint

The core evaluator (the code path from `AuthorityEvent[] + policy → decision`) must be a pure function: no network calls, no filesystem I/O, no clock reads, no environment access. This is what makes the Action Firewall reuse (proven evaluator → live enforcement) actually clean rather than aspirational.

### 4.2 Enforcement, not documentation

A written rule that isn't checked will quietly stop being true — most likely around v0.3–v0.4, the first time someone needs to resolve a resource identifier against a live API and reaches for the nearest convenient function. So:

- The evaluator lives in its own package/module with an enforced import boundary (e.g., an architecture-test or lint rule that fails CI if the evaluator package imports anything performing I/O).
- This check ships **in v0.1**, not retrofitted later — it's cheap now and expensive to add after the boundary has already been violated a few times.
- Adapters (v0.3) and any resource-resolution logic live strictly on the caller's side of that boundary and hand the evaluator already-normalized data.

---

## 5. Performance Benchmark

### 5.1 Concrete target (replacing "large trace sets perform reasonably")

**10,000 events replayed against a 200-rule policy in under 1 second, on ordinary developer hardware (no GPU, no special tuning).**

This is a placeholder-but-real number: cheap enough to be a non-goal-distorting constraint at current scope, but concrete enough to catch an accidentally-quadratic rule-matching implementation before it's load-bearing.

### 5.2 When it's measured

Tracked as an automated CI benchmark starting at **v0.2**, when bulk replay first exists as a feature (see §6). The benchmark harness records hardware and runtime details so runs are comparable. The target becomes release-blocking once that harness and its corpus are stable; thereafter a regression blocks a release the same way a failing fixture does. Not deferred to v1.0.

---

## 6. Revised Roadmap Ordering

### 6.1 The problem being fixed

The original ordering puts the strongest, most demonstrable value proposition (bulk replay + regression analysis, "what will this policy change break?") behind three versions of kernel work, scope semantics, and real trace adapters. The project's own stated "major validation gate" — an unrelated project keeping replay enabled in CI — doesn't arrive until v0.6. That's a lot of investment before any external signal.

### 6.2 The swap

| New version | Content | Was |
|---|---|---|
| v0.1 | Deterministic replay kernel (unchanged) | v0.1 |
| **v0.2** | **Bulk replay + regression diff, against synthetic fixture directories.** Full "200 traces → impact analysis" experience from the original v0.4, minus real adapters; automated performance tracking starts here. | *(new position — content pulled forward from old v0.4)* |
| v0.3 | Richer scope-aware policy (resource narrowing, scope relationships, unknown handling, and any broader wildcard grammar); v0.1 already has exact and terminal segment-wildcard matching | old v0.2 |
| v0.4 | Real trace adapters (Coldgate native, OpenTelemetry, OpenAI) | old v0.3 |
| v0.5 | Policy diff | v0.5 (unchanged) |
| v0.6 | CI-native integration | v0.6 (unchanged) |
| v0.7+ | Policy tests, provenance, candidate generation, 1.0 | unchanged |

### 6.3 Why this order and not some other

- Bulk replay only needs the v0.1 kernel plus a directory-walk and a diff-summary — it doesn't need richer scope semantics or real adapters to be demonstrable. Synthetic fixtures are enough to show the shape of the value proposition.
- This gets "run a policy change across many traces, see what breaks" demoable by the **second** release instead of the fifth, so real validation signal (does anyone actually want this workflow) arrives two versions earlier instead of six.
- Scope-aware policy and real adapters still need to land before v0.5's diff and v0.6's CI integration are meaningful for real-world policies — so they're not dropped, just resequenced behind the earlier demo.

---

## 7. Trace Trust Model (documented limitation, not new engineering)

**Stated limitation, to be published alongside 1.0's threat model:**

> PolicyReplay trusts the integrity and completeness of the traces it's given. It cannot detect that an agent selectively omitted an action from its own self-reported trace, or that a trace was altered after the fact. Tamper-evidence and trace provenance verification are out of scope for 1.0.

This is correctly a documentation fix, not an engineering one — no version of the roadmap through 1.0 can meaningfully solve "what if the trace itself lies," and pretending otherwise would be worse than stating the limitation plainly. If tamper-evidence becomes a requirement later, it belongs in a different layer (signed traces at the point of generation, e.g. in whatever produces the trace), not in PolicyReplay's evaluator.

---

## 8. Policy Diff Computability (spike scope, v0.5)

### 8.1 The open question

"Policy A permits a strict superset of policy B" (the semantic diff v0.5 wants — "authority widened") is a set-containment problem. For arbitrary rule grammars (unbounded wildcard depth, regex-like resource patterns), exact containment is not generally decidable in a useful way. Before committing v0.5's design, this needs a spike, not an assumption that "reuse AuthorityDiff's ordering" is sufficient.

### 8.2 Spike deliverable

Determine whether exact containment is decidable for a **restricted rule grammar**, beginning with v0.1's terminal, one-segment `*` and separately assessing any v0.3 additions:
- bounded wildcard depth (`*` only as a full path segment, not embedded in a string)
- no regex or arbitrary pattern matching in resource/destination fields
- a finite, enumerable set of effect classes

### 8.3 Two acceptable outcomes

- **If containment is decidable under the restricted grammar:** v0.5 ships exact semantic diff, and the policy schema (§3) formally restricts resource/destination matching to that grammar going forward — documented as a deliberate constraint, not an oversight.
- **If it isn't, even under the restricted grammar:** v0.5 ships a **heuristic diff** (e.g., sampling representative events, or comparing rule sets structurally rather than semantically) with the limitation stated plainly in output: "this comparison is heuristic and may not detect all cases of widened or narrowed authority." Do not present heuristic results with the confidence of a proof.

The spike result determines which of these two v0.5 actually is — that decision should not be made by default under deadline pressure once v0.5 is already underway.

---

## 9. CI Data Handling Policy (v0.6)

### 9.1 The collision

1.0's quality bar states sensitive trace data stays local by default. v0.6 ships a GitHub Action that needs trace data present in the CI runner to replay against. On a hosted runner, "local by default" and "data must be present to run" are in direct tension the moment real traces contain resource names, account identifiers, or other sensitive values.

### 9.2 Resolution

Two supported paths, stated explicitly in the v0.6 documentation (not left for users to discover):

- **Hosted CI (GitHub-hosted runners):** supported only for redacted or synthetic trace corpora. The GitHub Action's documentation states this as a hard convention, not a suggestion — traces containing real resource identifiers should not be committed to a repo that hosted CI reads from.
- **Self-hosted runners:** the only supported path for replaying real, unredacted trace data, since the data never leaves infrastructure the user controls.

The Action itself should not attempt to solve this with automatic redaction — that invites false confidence (redaction is its own hard problem and a silent failure there is worse than no redaction at all). State the constraint; let the user choose the right runner for their data sensitivity.

---

## 10. Candidate Policy Confidence Signal (v0.9)

### 10.1 The gap in coverage percentage alone

"93% of exercised authority explicitly covered" measures breadth of the rule set relative to the corpus, but says nothing about whether the **corpus itself is representative**. A candidate policy generated from 147 runs that happen to never exercise a legitimate-but-rare path (a monthly batch job, an incident-response action used twice a year) will generate a policy too narrow to survive that path's first real occurrence after deployment — even at 93%+ coverage.

### 10.2 Addition: a confidence signal alongside coverage

Candidate generation output pairs coverage percentage with a distinctness signal:

```text
Generated candidate policy

Historical compatibility:
145 / 147 runs allowed

Coverage:
93% of exercised authority explicitly covered

Corpus confidence:
- 147 runs across 12 distinct days
- 4 distinct actors
- 9 distinct tools exercised
- ⚠ 3 tools appear in fewer than 3 runs each — candidate rules for
  these are generated from thin evidence and warrant manual review
```

This doesn't require new data collection for traces that already supply actor, tool, and the optional v0.1 `timestamp` in normalized `AuthorityEvent`s. If timestamps are missing, report the number of dated and undated runs and mark the distinct-days statistic unavailable rather than inventing dates. It's a reporting change to v0.9's existing output, flagging low-sample-size rules for the human reviewer rather than presenting all generated rules with equal apparent confidence.

---

## Summary: what changes before v0.1 is coded

- [ ] v0.1 `Policy`, `Rule`, and `AuthorityEvent` validation, including stable rule IDs, effect classes, and optional UTC timestamps (§0)
- [ ] Precedence, exact specificity vectors, and the small terminal segment-wildcard grammar (§1) implemented in the evaluator from the start
- [ ] Fail-closed policy loading (§1.2) — ambiguous or malformed policies refuse to load
- [ ] `UNMATCHED` preserved as pre-default match status beside the final decision and source (§2.1–2.2), and `REQUIRE_APPROVAL` treated as deny-equivalent for automation until v0.8 (§2.3)
- [ ] `schema_version` field present in both schemas from v0.1 (§3.2)
- [ ] Evaluator package has an enforced (CI-checked) import boundary preventing I/O (§4.2)
- [ ] Golden fixture corpus doubles as the backwards-compatibility gate from v0.2 onward (§3.3)
- [ ] Roadmap reordered: bulk replay + regression diff and performance tracking move to v0.2; richer scope semantics and real adapters move to v0.3/v0.4 (§5–6)
- [ ] Trace trust limitation drafted for the eventual threat-model doc (§7)
- [ ] Policy diff spike scheduled before v0.5 design is finalized (§8)
- [ ] CI data-handling convention (redacted traces on hosted runners; real traces only on self-hosted) documented ahead of v0.6 (§9)
- [ ] Candidate generation output design (v0.9) includes corpus-confidence reporting, not just coverage percentage (§10)
