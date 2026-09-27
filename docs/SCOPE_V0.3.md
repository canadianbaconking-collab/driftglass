# v0.3 resource scope contract

This extension is additive to `schema_version: 1`. The v0.1 `resource` string retains its exact or terminal one-segment wildcard behavior. No hierarchy is inferred from that string. A new optional `resource_scope` carries normalized hierarchy supplied by a caller or adapter. Its own `schema_version: 1` fixes the semantics below; a future syntax needs a new field or explicit version and migration.

## Wire shapes

In a rule's `allow`, `deny`, or `require_approval` constraints:

```json
{ "tool": "files.write", "resource_scope": {
  "schema_version": 1, "state": "known",
  "anchor": "tenants/acme/projects/app", "relation": "child"
} }
```

Alternatively, only for a `deny` or `require_approval` rule:

```json
{ "tool": "files.write", "resource_scope": {
  "schema_version": 1, "state": "unknown"
} }
```

In a normalized event:

```json
{ "schema_version": 1, "tool": "files.write", "effect": "WRITE",
  "resource_scope": { "schema_version": 1, "state": "known",
    "path": "tenants/acme/projects/app/docs" } }
```

`{ "schema_version": 1, "state": "unknown" }` explicitly records an unresolved scope. Omission also counts as unknown **for new scope rules**, even if the event supplies a v0.1 `resource` string; this prevents an omitted normalization result from bypassing an unknown-scope deny rule. A v0.1 policy without scope rules evaluates either form exactly as before. An unconstrained v0.1 allow rule can still match unknown scope, preserving its shipped behavior; add an explicit unknown-scope deny when unknown scope must block that authority. A `default: allow` also remains an explicit author choice, so pair it with an unknown-scope deny where needed.

Paths and anchors are non-empty, case-sensitive, slash-separated literal segments. Empty segments, `.` and `..` segments, and `*` are invalid. The engine does no URL decoding, case folding, filesystem resolution, or provider lookup. It trusts that the caller supplied the normalized path; it does not claim the path is consistent with the separately supplied v0.1 resource identifier.

## Relationships

For anchor `tenants/acme/projects/app`:

| Relation | Matches | Does not match |
| --- | --- | --- |
| `self` | `tenants/acme/projects/app` | `.../app/docs` |
| `child` | `.../app/docs` | `.../app`, `.../app/docs/spec` |
| `descendant` | `.../app/docs`, `.../app/docs/spec` | `.../app` |
| `self_or_descendant` | `.../app`, `.../app/docs/spec` | `tenants/other/projects/app` |

The examples with `...` abbreviate the same exact anchor prefix; the wire format never accepts an ellipsis. A known rule matches only an event with a known scope. An unknown rule matches an omitted or explicitly unknown event scope; it cannot grant `ALLOW`. A rule that also specifies v0.1 `resource` requires **both** constraints to match. Explicit `DENY` still wins over all other matches.

## Specificity and ambiguity

The existing lexicographic vector remains `[effect, actor, resource, destination]`. The resource component is 0 when unconstrained, 1 for a legacy terminal wildcard, and 2 for a legacy exact string. A new unknown-scope constraint scores 3. A known-scope constraint scores `4 × anchor segment count + relation rank`, where `self_or_descendant = 0`, `descendant = 1`, `child = 2`, and `self = 3`. If a rule has both legacy `resource` and `resource_scope`, the scope score is used for this vector component, and both constraints still need to match.

Thus deeper anchors outrank shallower anchors at the same earlier vector components. At the same anchor, `child` outranks `descendant` when both match. A constrained effect or actor still outranks any later resource component. A deny bypasses specificity entirely. The exact vector is reported in decisions. As in v0.1, equal-vector overlapping `allow` and `require_approval` rules fail at policy loading, including overlap involving the new scope field. File order never resolves a conflict.

No new wildcard grammar is introduced: these four relationships cover the needed hierarchy while leaving v0.1 patterns unchanged. The restricted, literal-segment grammar also keeps the v0.5 policy-containment spike tractable. Real provider normalization belongs in v0.4 adapters, outside the pure evaluator.
