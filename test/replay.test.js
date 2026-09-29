import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { comparePolicies, replayTraces } from '../src/replay/index.js';
import { readTraceDirectory } from '../src/adapter/json-directory.js';
import { loadPolicy, ValidationError } from '../src/kernel/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bookshop = (name) => join(root, 'fixtures/bookshop', name);
const baseline = JSON.parse(await readFile(bookshop('baseline.json'), 'utf8'));
const candidate = JSON.parse(await readFile(bookshop('candidate.json'), 'utf8'));
const traces = await readTraceDirectory(bookshop('traces'));
const event = { schema_version: 1, tool: 't', effect: 'READ' };
const trace = { id: 'one', schema_version: 1, events: [event] };

test('bookshop corpus reports each transition and coverage change', () => {
  const report = comparePolicies(baseline, candidate, traces);
  assert.deepEqual(report.summary, {
    traces: 3, events: 8,
    baseline: { ALLOW: 5, DENY: 3, REQUIRE_APPROVAL: 0 },
    candidate: { ALLOW: 3, DENY: 4, REQUIRE_APPROVAL: 1 },
    changes: { newly_allowed: 1, newly_denied: 2, newly_approved: 1, unchanged: 4 },
    regressions: 3, restored: 1, rule_reassignments: 2,
    coverage: { newly_explicit: 2, newly_defaulted: 1 }
  });
  assert.deepEqual(report.traces.map(({ id }) => id), [
    '2026-09-01/packing.json', '2026-09-02/exceptions.json', '2026-09-03/quiet.json'
  ]);
  assert.equal(report.traces[0].differences[0].candidate.decision, 'REQUIRE_APPROVAL');
  assert.equal(report.traces[0].differences[0].regression, true);
  assert.equal(report.traces[1].differences[1].coverage_change, 'newly_defaulted');
  assert.equal(report.traces[1].differences[2].change, 'unchanged');
  assert.equal(report.traces[1].differences[2].coverage_change, 'newly_explicit');
  assert.deepEqual(report.traces[2].differences, []);
});

test('single-policy replay keeps default source and approval decision distinct', () => {
  const report = replayTraces(loadPolicy(candidate), traces);
  assert.deepEqual(report.summary.decisions, { ALLOW: 3, DENY: 4, REQUIRE_APPROVAL: 1 });
  assert.equal(report.traces[1].decisions[2].result.source, 'default');
  assert.equal(report.traces[0].decisions[2].result.decision, 'REQUIRE_APPROVAL');
});

test('comparison accepts compiled policies without changing results', () => {
  assert.deepEqual(comparePolicies(loadPolicy(baseline), loadPolicy(candidate), traces),
    comparePolicies(baseline, candidate, traces));
});

test('unchanged decision may still be an explicit-coverage change', () => {
  const denied = { schema_version: 1, default: 'deny', rules: [] };
  const explicit = { schema_version: 1, default: 'deny', rules: [{ id: 'x', deny: { tool: 't' } }] };
  const report = comparePolicies(denied, explicit, [trace]);
  assert.equal(report.summary.changes.unchanged, 1);
  assert.equal(report.summary.coverage.newly_explicit, 1);
  assert.equal(report.summary.regressions, 0);
  assert.equal(report.traces[0].differences[0].candidate.source, 'rule');
});

test('same decision with a different winning rule is still reported', () => {
  const original = { schema_version: 1, default: 'deny', rules: [{ id: 'old', allow: { tool: 't' } }] };
  const renamed = { schema_version: 1, default: 'deny', rules: [{ id: 'new', allow: { tool: 't' } }] };
  const report = comparePolicies(original, renamed, [trace]);
  assert.equal(report.summary.changes.unchanged, 1);
  assert.equal(report.summary.rule_reassignments, 1);
  assert.equal(report.traces[0].differences[0].rule_change, true);
  assert.equal(report.summary.regressions, 0);
});

test('deny to approval does not count as restored', () => {
  const denied = { schema_version: 1, default: 'deny', rules: [] };
  const approved = { schema_version: 1, default: 'deny', rules: [{ id: 'x', require_approval: { tool: 't' } }] };
  const report = comparePolicies(denied, approved, [trace]);
  assert.equal(report.summary.changes.newly_approved, 1);
  assert.equal(report.summary.restored, 0);
});

test('unchanged results are omitted from event detail while counts remain', () => {
  const report = comparePolicies(baseline, baseline, traces);
  assert.equal(report.summary.changes.unchanged, 8);
  assert.deepEqual(report.summary.coverage, { newly_explicit: 0, newly_defaulted: 0 });
  assert.equal(report.summary.rule_reassignments, 0);
  assert.ok(report.traces.every(({ differences }) => differences.length === 0));
});

const invalid = [
  ['empty corpus', []],
  ['zero event corpus', [{ id: 'x', schema_version: 1, events: [] }]],
  ['duplicate IDs', [trace, trace]],
  ['unknown schema', [{ ...trace, schema_version: 2 }]],
  ['missing events', [{ id: 'x', schema_version: 1 }]],
  ['unknown trace key', [{ ...trace, metadata: {} }]],
  ['empty ID', [{ ...trace, id: '' }]],
  ['invalid event', [{ ...trace, events: [{ ...event, effect: 'UNKNOWN' }] }]]
];
for (const [name, input] of invalid) {
  test(`invalid corpus: ${name}`, () => assert.throws(() => comparePolicies(baseline, candidate, input), ValidationError));
}

test('invalid event names trace location and invalid candidate refuses all evaluation', () => {
  assert.throws(() => comparePolicies(baseline, candidate, [{ ...trace, events: [{ ...event, timestamp: null }] }]),
    /traces\[0\]\.events\[0\].*timestamp/);
  assert.throws(() => comparePolicies(baseline, { ...candidate, default: 'unknown' }, traces), ValidationError);
});

test('directory reader sorts nested paths and rejects symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'driftglass-directory-'));
  try {
    await mkdir(join(dir, 'b'));
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'b', 'z.json'), JSON.stringify({ schema_version: 1, events: [event] }));
    await writeFile(join(dir, 'a', 'a.json'), JSON.stringify({ schema_version: 1, events: [event] }));
    await writeFile(join(dir, 'ignore.txt'), 'ignored');
    assert.deepEqual((await readTraceDirectory(dir)).map((item) => item.id), ['a/a.json', 'b/z.json']);
    await t.test('rejects a symlink when the host permits creating one', async t => {
      try { await symlink(join(dir, 'a', 'a.json'), join(dir, 'link.json')); }
      catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink creation requires permission');
        throw error;
      }
      await assert.rejects(() => readTraceDirectory(dir), /symlink/);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('directory reader refuses malformed JSON and unexpected file fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftglass-invalid-'));
  try {
    await writeFile(join(dir, 'bad.json'), '{');
    await assert.rejects(() => readTraceDirectory(dir), /bad\.json/);
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ schema_version: 1, events: [], id: 'spoofed' }));
    await assert.rejects(() => readTraceDirectory(dir), /unknown trace field id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI produces machine report and blocking regression exit code', () => {
  const cli = join(root, 'bin/driftglass.js');
  const args = [cli, 'compare', bookshop('baseline.json'), bookshop('candidate.json'), bookshop('traces'), '--json'];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).summary.regressions, 3);
  const noChange = spawnSync(process.execPath,
    [cli, 'compare', bookshop('baseline.json'), bookshop('baseline.json'), bookshop('traces'), '--json'], { encoding: 'utf8' });
  assert.equal(noChange.status, 0);
});

test('200 generated trace files produce a complete impact report', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'driftglass-200-'));
  const target = join(tmp, 'generated');
  try {
    const generated = spawnSync(process.execPath, [join(root, 'scripts/generate-demo.js'), target], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const report = comparePolicies(baseline, candidate, await readTraceDirectory(target));
    assert.equal(report.summary.traces, 200);
    assert.equal(report.summary.events, 1000);
    assert.equal(report.traces.length, 200);
    assert.ok(report.summary.regressions > 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
