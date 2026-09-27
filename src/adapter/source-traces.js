import { loadEvent, ValidationError } from '../kernel/index.js';

const own = (o, k) => Object.hasOwn(o, k);
const fail = (where, why) => { throw new ValidationError(`${where}: ${why}`); };
const object = (v, where) => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : fail(where, 'expected object');
const array = (v, where) => Array.isArray(v) && v.length <= 10000 ? v : fail(where, 'expected array of at most 10000 items');
const string = (v, where) => typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : fail(where, 'expected non-empty string of at most 512 characters');
const unknown = { schema_version: 1, state: 'unknown' };

function mapping(input) {
  const m = object(input, 'mapping');
  for (const key of Object.keys(m)) if (!['schema_version', 'effects', 'scopes'].includes(key)) fail(`mapping.${key}`, 'unknown field');
  if (m.schema_version !== 1) fail('mapping.schema_version', 'expected 1');
  const effects = object(m.effects, 'mapping.effects');
  const scopes = object(m.scopes ?? {}, 'mapping.scopes');
  for (const [key, effect] of Object.entries(effects)) {
    string(key, 'mapping.effects key');
    if (!['READ', 'WRITE', 'EXECUTE', 'DELETE', 'SEND'].includes(effect)) fail(`mapping.effects[${JSON.stringify(key)}]`, 'unmapped effect');
  }
  for (const [key, path] of Object.entries(scopes)) {
    string(key, 'mapping.scopes key');
    loadEvent({ schema_version: 1, tool: '_', effect: 'READ', resource_scope: { schema_version: 1, state: 'known', path } });
  }
  return { effects, scopes };
}
function nano(value, where) {
  if (value === undefined || value === null || value === '0' || value === 0) return undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || BigInt(value) > 18446744073709551615n) fail(where, 'invalid uint64 nanoseconds');
  const time = Number(BigInt(value) / 1000000n);
  if (!Number.isFinite(time) || time > 8640000000000000) fail(where, 'timestamp out of range');
  return new Date(time).toISOString();
}
function instant(value, where) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail(where, 'invalid ISO timestamp');
  const dateOnly = value.slice(0, 10);
  const [year, month, day] = dateOnly.split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.toISOString().slice(0, 10) !== dateOnly) fail(where, 'invalid calendar date');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(where, 'invalid ISO timestamp');
  return new Date(time).toISOString();
}
function attributes(input, where) {
  const values = Object.create(null);
  for (const [i, entry] of array(input ?? [], where).entries()) {
    const a = object(entry, `${where}[${i}]`);
    const key = string(a.key, `${where}[${i}].key`);
    if (own(values, key)) fail(`${where}[${i}]`, 'duplicate attribute');
    if (!['gen_ai.operation.name', 'gen_ai.tool.name', 'mcp.method.name', 'coldgate.resource', 'http.request.method'].includes(key)) continue;
    const val = object(a.value, `${where}[${i}].value`);
    if (Object.keys(val).length !== 1) fail(`${where}[${i}].value`, 'expected one stringValue');
    values[key] = string(val.stringValue, `${where}[${i}].value.stringValue`);
  }
  return values;
}
function claimValue(value, where) {
  if (value === undefined) return undefined;
  const claim = object(value, where);
  return claim.status === 'OBSERVED' ? string(claim.value, `${where}.value`) : undefined;
}
function entries(format, input) {
  if (format === 'coldgate') {
    const report = object(input, 'source');
    if (report.kind !== 'coldgate-trace' || report.schemaVersion !== '0.1') fail('source', 'expected Coldgate trace report 0.1');
    if (array(report.errors, 'source.errors').length) fail('source.errors', 'report contains errors');
    return array(report.events, 'source.events').flatMap((raw, i) => {
      const p = `source.events[${i}]`, e = object(raw, p);
      if (e.kind === 'approval') return [];
      if (!['tool', 'resource', 'network'].includes(e.kind)) fail(`${p}.kind`, 'unsupported capability');
      const name = claimValue(e.operation, `${p}.operation`);
      if (!name) fail(`${p}.operation`, 'operation is not observed');
      return [{ trace: string(e.traceId, `${p}.traceId`), tool: e.kind === 'tool' ? name : `${e.kind}:${name}`,
        resource: claimValue(e.resource, `${p}.resource`), time: instant(e.startedAt, `${p}.startedAt`), order: i }];
    });
  }
  if (format === 'openai') {
    const spans = Array.isArray(input) ? input : object(input, 'source').spans;
    return array(spans, 'source.spans').flatMap((raw, i) => {
      const p = `source.spans[${i}]`, span = object(raw, p);
      if (span.object !== 'trace.span') fail(`${p}.object`, 'expected trace.span');
      const trace = string(span.trace_id, `${p}.trace_id`);
      const data = object(span.span_data, `${p}.span_data`);
      if (data.type !== 'function') {
        if (data.type === 'custom' && data.name === 'coldgate.approval') return [];
        if (!['agent', 'generation', 'guardrail', 'handoff', 'task', 'turn', 'response'].includes(data.type)) fail(`${p}.span_data.type`, 'unsupported span type');
        return [];
      }
      return [{ trace, tool: string(data.name, `${p}.span_data.name`), time: instant(span.started_at, `${p}.started_at`), order: i }];
    });
  }
  if (format === 'otlp') {
    const root = object(input, 'source'), out = [];
    for (const [ri, raw] of array(root.resourceSpans, 'source.resourceSpans').entries()) {
      const resource = object(raw, `source.resourceSpans[${ri}]`);
      for (const [si, scoped] of array(resource.scopeSpans ?? [], `source.resourceSpans[${ri}].scopeSpans`).entries()) {
        const scope = object(scoped, `source.resourceSpans[${ri}].scopeSpans[${si}]`);
        for (const [i, rawSpan] of array(scope.spans ?? [], `source.resourceSpans[${ri}].scopeSpans[${si}].spans`).entries()) {
          const p = `source.resourceSpans[${ri}].scopeSpans[${si}].spans[${i}]`, span = object(rawSpan, p);
          const trace = string(span.traceId, `${p}.traceId`);
          if (!/^[a-f0-9]{32}$/i.test(trace) || /^0+$/.test(trace)) fail(`${p}.traceId`, 'invalid OTLP trace ID');
          const a = attributes(span.attributes, `${p}.attributes`);
          if (a['mcp.method.name']?.startsWith('resources/') && a['mcp.method.name'] !== 'resources/read') fail(`${p}.mcp.method.name`, 'unsupported resource operation');
          let tool;
          if (a['gen_ai.operation.name'] === 'execute_tool' || a['mcp.method.name'] === 'tools/call') tool = string(a['gen_ai.tool.name'], `${p}.gen_ai.tool.name`);
          else if (a['mcp.method.name'] === 'resources/read') tool = 'resource:resources/read';
          else if (span.kind === 3 && a['http.request.method']) tool = `network:${a['http.request.method']}`;
          if (tool) out.push({ trace: trace.toLowerCase(), tool, resource: a['coldgate.resource'], time: nano(span.startTimeUnixNano, `${p}.startTimeUnixNano`), order: out.length });
        }
      }
    }
    return out;
  }
  fail('format', 'expected coldgate, otlp, or openai');
}

/** Convert saved telemetry to complete Driftglass traces; no arguments or model content are copied. */
export function adaptSourceTrace(format, source, mapInput) {
  const map = mapping(mapInput), grouped = new Map();
  for (const item of entries(format, source)) {
    const effect = own(map.effects, item.tool) ? map.effects[item.tool] : fail(`mapping.effects[${JSON.stringify(item.tool)}]`, 'unmapped effect');
    const event = { schema_version: 1, tool: item.tool, effect,
      resource_scope: item.resource && own(map.scopes, item.resource)
        ? { schema_version: 1, state: 'known', path: map.scopes[item.resource] } : unknown };
    if (item.resource) event.resource = item.resource;
    if (item.time) event.timestamp = item.time;
    loadEvent(event);
    if (!grouped.has(item.trace)) grouped.set(item.trace, []);
    grouped.get(item.trace).push({ event, time: item.time, order: item.order });
  }
  if (!grouped.size) fail('source', 'no supported capability events');
  return [...grouped].map(([id, records]) => ({ id, schema_version: 1,
    events: records.sort((a, b) => a.time === b.time ? a.order - b.order : a.time === undefined ? 1 : b.time === undefined ? -1 : a.time < b.time ? -1 : 1).map(({ event }) => event) }));
}
