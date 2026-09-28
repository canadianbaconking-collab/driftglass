import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessPolicyChange, formatCISummary } from '../src/ci/index.js';

const policy = (rules = []) => ({ schema_version: 1, default: 'deny', rules });
const event = { schema_version: 1, tool: 't', effect: 'WRITE', resource: 'repo/a' };
const traces = [{ id: 'run.json', schema_version: 1, events: [event] }];
const allow = { id: 'allow-t', allow: { tool: 't', effect: 'WRITE' } };

test('CI blocks historical regressions, including approval requests', () => {
  const baseline = policy([allow]);
  const candidate = policy([{ id: 'review-t', require_approval: { tool: 't', effect: 'WRITE' } }]);
  const report = assessPolicyChange(baseline, candidate, traces);
  assert.equal(report.gate.passed, false);
  assert.equal(report.gate.historical_regressions, 1);
  assert.equal(report.gate.newly_allowed_cells, 0);
});

test('CI catches semantic widening outside historical traces', () => {
  const candidate = policy([allow, { id: 'allow-other', allow: { tool: 'other' } }]);
  const report = assessPolicyChange(policy([allow]), candidate, traces);
  assert.equal(report.gate.historical_regressions, 0);
  assert.ok(report.gate.newly_allowed_cells > 0);
  assert.equal(report.gate.passed, false);
  assert.doesNotMatch(formatCISummary(report), /repo\/a|run\.json|witness/);
});

test('CI accepts an unchanged policy and rejects invalid policies', () => {
  assert.equal(assessPolicyChange(policy([allow]), policy([allow]), traces).gate.passed, true);
  assert.throws(() => assessPolicyChange(policy([allow]), { ...policy(), schema_version: 2 }, traces), /schema_version/);
});

test('CLI CI codes and opt-in report writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftglass-ci-'));
  const baseline = join(dir, 'baseline.json'), candidate = join(dir, 'candidate.json');
  const corpus = join(dir, 'traces'), summary = join(dir, 'summary.md'), report = join(dir, 'report.json');
  const run = (...args) => spawnSync(process.execPath, ['bin/driftglass.js', 'ci', ...args], { encoding: 'utf8' });
  try {
    await mkdir(corpus);
    await writeFile(baseline, JSON.stringify(policy([allow])));
    await writeFile(candidate, JSON.stringify(policy([allow])));
    await writeFile(join(corpus, 'run.json'), JSON.stringify({ schema_version: 1, events: [event] }));
    const passed = run(baseline, candidate, corpus, '--summary', summary);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(await readFile(summary, 'utf8'), /PASS/);
    await writeFile(candidate, JSON.stringify(policy([allow, { id: 'wide', allow: { tool: 'other' } }])));
    const blocked = run(baseline, candidate, corpus, '--report', report, '--summary', summary);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).gate.passed, false);
    assert.doesNotMatch(blocked.stdout, /repo\/a/);
    await writeFile(candidate, '{');
    const invalid = run(baseline, candidate, corpus, '--report', join(dir, 'report-2.json'));
    assert.equal(invalid.status, 1);
    await assert.rejects(() => access(join(dir, 'report-2.json')));
    const badOptions = run(baseline, candidate, corpus, '--surprise');
    assert.equal(badOptions.status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
