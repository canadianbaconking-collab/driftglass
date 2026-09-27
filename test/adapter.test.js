import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { adaptSourceTrace } from '../src/adapter/source-traces.js';
import { replayTraces, comparePolicies } from '../src/replay/index.js';
import { ValidationError } from '../src/kernel/index.js';

const map = { schema_version: 1, effects: { 'files.write': 'WRITE', 'send_email': 'SEND', 'resource:resources/read': 'READ' },
  scopes: { 'repo/app/docs': 'tenants/acme/projects/app/docs' } };
const coldgate = { schemaVersion: '0.1', kind: 'coldgate-trace', errors: [], events: [
  { traceId: 'one', kind: 'tool', operation: { status: 'OBSERVED', value: 'files.write' },
    effects: { status: 'INFERRED', value: ['READ'] }, resource: { status: 'OBSERVED', value: 'repo/app/docs' },
    startedAt: '2026-09-26T12:00:01Z', source: 'sample' },
  { traceId: 'one', kind: 'approval', operation: { status: 'OBSERVED', value: 'files.write' } }
] };
const openai = { spans: [
  { object: 'trace.span', trace_id: 'one', id: 'agent', span_data: { type: 'agent', name: 'demo' } },
  { object: 'trace.span', trace_id: 'one', id: 'call', started_at: '2026-09-26T12:00:01Z',
    span_data: { type: 'function', name: 'send_email', input: '{"password":"PRIVATE"}', output: 'PRIVATE' } }
] };
const otlp = { resourceSpans: [{ scopeSpans: [{ spans: [
  { traceId: '11111111111111111111111111111111', spanId: '0000000000000001',
    startTimeUnixNano: '1790424001000000000', attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
      { key: 'gen_ai.tool.name', value: { stringValue: 'files.write' } },
      { key: 'coldgate.resource', value: { stringValue: 'repo/app/docs' } },
      { key: 'gen_ai.input.messages', value: { stringValue: 'PRIVATE' } }
    ] }
] }] }] };

test('Coldgate native observed identity and explicit path mapping replay through scope rules', () => {
  const [trace] = adaptSourceTrace('coldgate', coldgate, map);
  assert.deepEqual(trace.events, [{ schema_version: 1, tool: 'files.write', effect: 'WRITE',
    resource_scope: { schema_version: 1, state: 'known', path: 'tenants/acme/projects/app/docs' },
    resource: 'repo/app/docs', timestamp: '2026-09-26T12:00:01.000Z' }]);
  const policy = { schema_version: 1, default: 'deny', rules: [{ id: 'docs', allow: { tool: 'files.write', effect: 'WRITE', resource_scope: {
    schema_version: 1, state: 'known', anchor: 'tenants/acme/projects/app', relation: 'child' } } }] };
  assert.equal(replayTraces(policy, [trace]).summary.decisions.ALLOW, 1);
  assert.equal(comparePolicies({ schema_version: 1, default: 'deny', rules: [] }, policy, [trace]).summary.restored, 1);
});

test('OpenAI function spans omit arguments and report unresolved scope', () => {
  const [trace] = adaptSourceTrace('openai', openai, map);
  assert.equal(trace.events[0].effect, 'SEND');
  assert.deepEqual(trace.events[0].resource_scope, { schema_version: 1, state: 'unknown' });
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|password/);
  assert.equal(replayTraces({ schema_version: 1, default: 'deny', rules: [{ id: 'x', deny: {
    tool: 'send_email', resource_scope: { schema_version: 1, state: 'unknown' } } }] }, [trace]).summary.decisions.DENY, 1);
});

test('OTLP tool attribute and Coldgate resource require a reviewed scope mapping', () => {
  const [trace] = adaptSourceTrace('otlp', otlp, map);
  assert.equal(trace.events[0].resource_scope.state, 'known');
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/);
  const [unresolved] = adaptSourceTrace('otlp', otlp, { ...map, scopes: {} });
  assert.equal(unresolved.events[0].resource_scope.state, 'unknown');
});

test('adapted Coldgate event preserves a v0.1 golden policy decision', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/v0.1.json', import.meta.url), 'utf8'));
  const sample = structuredClone(coldgate);
  sample.events[0].operation.value = 'github.push_files';
  sample.events[0].resource.value = 'repo/app';
  const [trace] = adaptSourceTrace('coldgate', sample, { schema_version: 1,
    effects: { 'github.push_files': 'WRITE' } });
  assert.equal(replayTraces(fixture.policy, [trace]).traces[0].decisions[0].result.decision, fixture.cases[0].decision);
});

test('no effect is inferred from names, claimed effects, or resource methods', () => {
  for (const [format, source] of [['coldgate', coldgate], ['openai', openai], ['otlp', otlp]]) {
    assert.throws(() => adaptSourceTrace(format, source, { schema_version: 1, effects: {} }), /unmapped effect/);
  }
  const resource = structuredClone(otlp);
  resource.resourceSpans[0].scopeSpans[0].spans[0].attributes = [
    { key: 'mcp.method.name', value: { stringValue: 'resources/read' } }];
  assert.throws(() => adaptSourceTrace('otlp', resource, { schema_version: 1, effects: {} }), /unmapped effect/);
});

test('malformed mapping or source fails without returning partial traces', () => {
  assert.throws(() => adaptSourceTrace('coldgate', coldgate, { ...map, scopes: { 'repo/app/docs': 'a/../b' } }), ValidationError);
  assert.throws(() => adaptSourceTrace('coldgate', { ...coldgate, errors: ['bad'] }, map), /report contains errors/);
  const missing = structuredClone(coldgate); missing.events[0].operation.status = 'INFERRED';
  assert.throws(() => adaptSourceTrace('coldgate', missing, map), /not observed/);
  const duplicate = structuredClone(otlp); duplicate.resourceSpans[0].scopeSpans[0].spans[0].attributes.push(
    { key: 'gen_ai.tool.name', value: { stringValue: 'send_email' } });
  assert.throws(() => adaptSourceTrace('otlp', duplicate, map), /duplicate attribute/);
  assert.throws(() => adaptSourceTrace('openai', { spans: [{ ...openai.spans[1], span_data: { type: 'mcp' } }] }, map), /unsupported span type/);
  assert.throws(() => adaptSourceTrace('openai', { spans: [{ ...openai.spans[1], span_data: { type: 'custom', name: 'unreviewed' } }] }, map), /unsupported span type/);
  assert.throws(() => adaptSourceTrace('otlp', { resourceSpans: [] }, map), /no supported capability events/);
  const invalidDate = structuredClone(openai); invalidDate.spans[1].started_at = '2026-02-30T12:00:01Z';
  assert.throws(() => adaptSourceTrace('openai', invalidDate, map), /invalid calendar date/);
});

test('multi-trace imports remain separate; CLI refuses to merge them', () => {
  const two = structuredClone(openai); two.spans.push({ ...openai.spans[1], trace_id: 'two' });
  assert.deepEqual(adaptSourceTrace('openai', two, map).map(x => x.id), ['one', 'two']);
});

test('CLI adapts a trace to a directory-compatible envelope', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'driftglass-adapt-'));
  try {
    const source = join(directory, 'source.json'), mapping = join(directory, 'mapping.json');
    await writeFile(source, JSON.stringify(coldgate)); await writeFile(mapping, JSON.stringify(map));
    const call = spawnSync(process.execPath, ['bin/driftglass.js', 'adapt', 'coldgate', source, mapping], { encoding: 'utf8' });
    assert.equal(call.status, 0, call.stderr);
    assert.deepEqual(JSON.parse(call.stdout).events, adaptSourceTrace('coldgate', coldgate, map)[0].events);
    const failed = spawnSync(process.execPath, ['bin/driftglass.js', 'adapt', 'coldgate', source, mapping, '--json'], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
