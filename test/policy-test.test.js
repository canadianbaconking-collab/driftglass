import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testPolicy } from '../src/policy-test/index.js';
import { ValidationError } from '../src/kernel/index.js';

const fixture = (path) => new URL(`../fixtures/bookshop/${path}`, import.meta.url);
const policy = JSON.parse(await readFile(fixture('baseline.json'), 'utf8'));
const suite = JSON.parse(await readFile(fixture('baseline.tests.json'), 'utf8'));
const one = (event, expect = { decision: 'ALLOW' }) => ({ schema_version: 1, cases: [{ id: 'case-one', event, expect }] });

test('authored cases pin precedence, rule identity, and default coverage', () => {
  const report = testPolicy(policy, suite);
  assert.deepEqual(report.summary, { cases: 5, passed: 5, failed: 0 });
  assert.ok(report.cases.every(item => item.passed && item.mismatches.length === 0));
  const changed = { ...policy, rules: policy.rules.filter(rule => rule.id !== 'vip-deny') };
  const failures = testPolicy(changed, suite);
  assert.equal(failures.summary.failed, 1);
  assert.deepEqual(failures.cases[2].mismatches.map(item => item.field),
    ['decision', 'winning_rule_ids', 'matching_rule_ids']);
  assert.equal(failures.cases[2].mismatches[0].actual, 'ALLOW');
});

test('expected approval counts as assertion success without granting automated authority', () => {
  const event = { schema_version: 1, tool: 't', effect: 'SEND' };
  const approval = { schema_version: 1, default: 'deny', rules: [{ id: 'review', require_approval: { tool: 't' } }] };
  const report = testPolicy(approval, one(event, { decision: 'REQUIRE_APPROVAL', source: 'rule', winning_rule_ids: ['review'] }));
  assert.equal(report.summary.failed, 0);
});

test('scope expectation identifies a known child and rejects unknown scope', () => {
  const scoped = { schema_version: 1, default: 'deny', rules: [{ id: 'child', allow: { tool: 't', resource_scope: {
    schema_version: 1, state: 'known', anchor: 'tenant/a', relation: 'child' } } }] };
  const event = { schema_version: 1, tool: 't', effect: 'READ', resource_scope: { schema_version: 1, state: 'known', path: 'tenant/a/doc' } };
  assert.equal(testPolicy(scoped, one(event)).summary.failed, 0);
  assert.equal(testPolicy(scoped, one({ ...event, resource_scope: { schema_version: 1, state: 'unknown' } })).summary.failed, 1);
});

test('suite and policy validation fail closed before returning any case results', () => {
  const invalid = [
    { ...suite, schema_version: 2 }, { ...suite, cases: [] }, { ...suite, extra: true },
    { ...suite, cases: [suite.cases[0], suite.cases[0]] },
    one({ schema_version: 1, tool: 't', effect: 'BAD' }),
    one({ schema_version: 1, tool: 't', effect: 'READ' }, { decision: 'MAYBE' }),
    one({ schema_version: 1, tool: 't', effect: 'READ' }, { decision: 'ALLOW', winning_rule_ids: ['x', 'x'] }),
    one({ schema_version: 1, tool: 't', effect: 'READ' }, { decision: 'ALLOW', ignored: true })
  ];
  for (const item of invalid) assert.throws(() => testPolicy(policy, item), ValidationError);
  assert.throws(() => testPolicy({ ...policy, default: 'unknown' }, suite), ValidationError);
  assert.throws(() => testPolicy(policy, { ...suite, cases: [...suite.cases, { ...suite.cases[0], id: 'late', event: null }] }),
    /suite\.cases\[5\]\.event/);
});

test('CLI reports mismatches as 2, malformed input as 1, and keeps CI summary counts-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftglass-policy-test-'));
  const cli = new URL('../bin/driftglass.js', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, 'policy', 'test', ...args], { encoding: 'utf8' });
  try {
    const suitePath = join(dir, 'suite.json'), policyPath = join(dir, 'policy.json'), summaryPath = join(dir, 'summary.md');
    await writeFile(policyPath, JSON.stringify(policy));
    await writeFile(suitePath, JSON.stringify(suite));
    const passed = run(policyPath, suitePath, '--json');
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).summary.passed, 5);
    await writeFile(policyPath, JSON.stringify({ ...policy, rules: policy.rules.filter(rule => rule.id !== 'vip-deny') }));
    const failed = run(policyPath, suitePath);
    assert.equal(failed.status, 2);
    assert.match(failed.stdout, /vip-deny-overrides-refund: decision expected "DENY", got "ALLOW"/);
    const quiet = run(policyPath, suitePath, '--summary', summaryPath);
    assert.equal(quiet.status, 2);
    assert.doesNotMatch(quiet.stdout, /vip-deny-overrides-refund|orders\/vip/);
    assert.doesNotMatch(await readFile(summaryPath, 'utf8'), /vip-deny-overrides-refund|orders\/vip/);
    await writeFile(suitePath, '{');
    assert.equal(run(policyPath, suitePath).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
