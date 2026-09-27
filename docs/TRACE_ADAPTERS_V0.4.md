# v0.4 saved trace adapters

Driftglass accepts three local JSON formats. Each import creates schema 1 authority events for replay. The adapter reads saved data only; it does not observe, authorize, or execute live tool calls. Trace data is unauthenticated and may omit actions. Review the resulting JSON before sharing it: tool names, resource labels, and trace IDs can be sensitive.

| `adapt` format | Accepted saved input | Selected action records |
| --- | --- | --- |
| `coldgate` | Coldgate `coldgate trace --format json` report with `schemaVersion: "0.1"`, `kind: "coldgate-trace"`, no errors | `tool` events with observed operation; `resource` and `network` events use `resource:<operation>` and `network:<operation>` identities. Approval events are skipped; approval evidence is v0.8 work. |
| `otlp` | OTLP JSON `resourceSpans[].scopeSpans[].spans[]` | `gen_ai.operation.name=execute_tool` or `mcp.method.name=tools/call` with `gen_ai.tool.name`; `mcp.method.name=resources/read`; HTTP client (`kind: 3`) with `http.request.method`. The last two use `resource:resources/read` and `network:<method>`. |
| `openai` | Locally exported OpenAI Agents Python SDK `Span.export()` objects in an array or `{ "spans": [...] }` | `object: "trace.span"` with `span_data.type: "function"` and `span_data.name`. Known agent/generation/guardrail/handoff/task/turn/response spans and `coldgate.approval` custom spans are skipped. Other span types fail. This does not accept Responses API output objects or dashboard downloads. |

Configure every tool/effect explicitly. The map is a local JSON file:

```json
{
  "schema_version": 1,
  "effects": { "files.write": "WRITE", "resource:resources/read": "READ" },
  "scopes": { "repo/app/docs": "tenants/acme/projects/app/docs" }
}
```

`effects` uses exact tool names and one of `READ`, `WRITE`, `EXECUTE`, `DELETE`, or `SEND`. An unmapped action fails the entire import; inferred Coldgate effect claims and operation names never fill in a mapping. The same tool has one mapped effect in this version. Review mixed-effect tools or split their identities before importing. `scopes` maps exact **observed resource labels** to a reviewed, literal hierarchy path. Coldgate report `resource` claims require `OBSERVED`; OTLP requires `coldgate.resource`. Function spans have no supported resource field. Missing evidence or an unmapped label yields `{ "schema_version": 1, "state": "unknown" }`, even if a legacy resource label exists. Scope paths follow the [v0.3 scope contract](SCOPE_V0.3.md); no path is inferred from an argument, URI, filename, tool name, or host. The original resource label, when present, remains the v0.1 `resource` field and must be reviewed for confidentiality.

For a single-trace export:

```bash
node bin/driftglass.js adapt coldgate saved-report.json mapping.json > normalized-traces/run.json
node bin/driftglass.js replay policy.json normalized-traces
node bin/driftglass.js compare baseline.json candidate.json normalized-traces
```

The `adapt` command emits the trace-file envelope `{ "schema_version": 1, "events": [...] }` on stdout. Use a directory containing only normalized trace JSON for replay. The JavaScript `adaptSourceTrace(format, source, mapping)` API returns one `{ id, schema_version, events }` per trace, ordered by timestamp then source order; a CLI import with multiple trace IDs fails rather than combining them. Split such exports locally before using the CLI. Invalid input and missing mappings exit 1 with no partial JSON output.

Only tool identity, a mapped effect, optional observed resource label, supported timestamp, and resolved or unknown scope are output. Model text, arguments, outputs, arbitrary attributes, and error content are omitted. The normalized event represents a **recorded attempt**, not proof of a completed side effect or authorization. No actor or destination is inferred. A policy constraining those fields will not match an event lacking them. Synthetic shape fixtures run in hosted CI; real traces should be sanitized, reviewed, and tested locally, then kept off hosted CI.
