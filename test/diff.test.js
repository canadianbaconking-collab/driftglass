import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { diffPolicies } from '../src/diff/index.js';
import { evaluate, ValidationError } from '../src/kernel/index.js';

const policy = (rules = [], fallback = 'deny') => ({ schema_version: 1, default: fallback, rules });
const allow = (id, body) => ({ id, allow: { tool: 't', ...body } });
const deny = (id, body) => ({ id, deny: { tool: 't', ...body } });
const scope = (anchor, relation) => ({ schema_version: 1, state: 'known', anchor, relation });
const known = (path) => ({ schema_version: 1, state: 'known', path });
const unknown = { schema_version: 1, state: 'unknown' };

test('terminal one-segment wildcard containment is exact and supplies a real witness', () => {
  const before = policy([allow('old', { resource: 'repo/*' })]);
  const after = policy([allow('old', { resource: 'repo/*' }), allow('new', { resource: 'archive/*' })]);
  const result = diffPolicies(before, after);
  assert.equal(result.method, 'exact'); assert.equal(result.authority, 'widened');
  const w = result.witnesses.newly_allowed;
  assert.equal(w.event.resource.startsWith('archive/'), true);
  assert.equal(evaluate(before, w.event).decision, 'DENY');
  assert.equal(evaluate(after, w.event).decision, 'ALLOW');
  assert.equal(diffPolicies(after, before).authority, 'narrowed');
});

test('deeper v0.3 anchor, child/descendant boundary, and unknown scope all count', () => {
  const before = policy([allow('broad', { resource_scope: scope('tenants/a', 'self_or_descendant') })]);
  const after = policy([allow('narrow', { resource_scope: scope('tenants/a', 'child') }),
    deny('unknown', { resource_scope: unknown })]);
  const result = diffPolicies(before, after);
  assert.equal(result.authority, 'narrowed');
  assert.equal(result.witnesses.newly_nonpassing.event.resource_scope.state, 'known');
  assert.equal(diffPolicies(after, before).authority, 'widened');
  const first = policy([allow('deep', { resource_scope: scope('tenants/a/projects/app', 'child') })]);
  const second = policy([allow('shallow', { resource_scope: scope('tenants/a', 'descendant') })]);
  assert.equal(diffPolicies(first, second).authority, 'widened');
});

test('mixed authority and the independent legacy resource/scope cross-product', () => {
  const before = policy([allow('a', { resource: 'repo/*', resource_scope: scope('tenant/a', 'child') })]);
  const after = policy([allow('b', { resource: 'archive/*', resource_scope: scope('tenant/a', 'child') })]);
  const result = diffPolicies(before, after);
  assert.equal(result.authority, 'mixed');
  assert.equal(result.witnesses.newly_allowed.event.resource.startsWith('archive/'), true);
  assert.equal(result.witnesses.newly_nonpassing.event.resource.startsWith('repo/'), true);
});

test('approval and deny transitions are reported without equating them to automated authority', () => {
  const before = policy([deny('before', { effect: 'WRITE' })]);
  const after = policy([{ id: 'review', require_approval: { tool: 't', effect: 'WRITE' } }]);
  const result = diffPolicies(before, after);
  assert.equal(result.authority, 'equivalent');
  assert.equal(result.decisions_equal, false);
  assert.ok(result.categories.newly_approved > 0);
  assert.equal(result.categories.newly_allowed, 0);
  assert.equal(diffPolicies(after, before).categories.newly_denied > 0, true);
});

test('changed defaults affect unnamed tools, while rule IDs and coverage are reported separately', () => {
  const defaults = diffPolicies(policy([], 'deny'), policy([], 'allow'));
  assert.equal(defaults.authority, 'widened');
  assert.ok(defaults.witnesses.newly_allowed.event.tool);
  const renamed = diffPolicies(policy([allow('old', {})]), policy([allow('new', {})]));
  assert.equal(renamed.authority, 'equivalent');
  assert.equal(renamed.decisions_equal, true);
  assert.ok(renamed.categories.rule_reassigned > 0);
  const explicit = diffPolicies(policy(), policy([deny('explicit', {})]));
  assert.equal(explicit.authority, 'equivalent');
  assert.ok(explicit.categories.coverage_changed > 0);
});

test('specificity and deny precedence drive witnesses', () => {
  const before = policy([allow('broad', {})]);
  const after = policy([allow('broad', {}), deny('secret', { resource: 'repo/secrets' })]);
  const result = diffPolicies(before, after);
  assert.equal(result.authority, 'narrowed');
  assert.equal(result.witnesses.newly_nonpassing.event.resource, 'repo/secrets');
  const beforeApproval = policy([allow('generic', {}), { id: 'special', require_approval: { tool: 't', effect: 'WRITE' } }]);
  assert.equal(diffPolicies(before, beforeApproval).authority, 'narrowed');
});

test('invalid policies or exceeded analysis budget never return an exact partial result', () => {
  assert.throws(() => diffPolicies(policy(), policy([allow('bad', { resource_scope: unknown })])), ValidationError);
  assert.throws(() => diffPolicies(policy([allow('a', {})]), policy(), { max_cells: 1 }), /no partial result/);
  assert.throws(() => diffPolicies(policy(), policy(), { max_cells: 0 }), ValidationError);
  assert.throws(() => diffPolicies(policy(), policy(), { made_up: true }), ValidationError);
});

test('scope fixture exposes a widening missed by its historical trace corpus', async () => {
  const load = async name => JSON.parse(await readFile(new URL(`../fixtures/scope/${name}.json`, import.meta.url), 'utf8'));
  const result = diffPolicies(await load('baseline'), await load('candidate'));
  assert.equal(result.method, 'exact'); assert.equal(result.authority, 'mixed');
  assert.ok(result.categories.newly_nonpassing > 0);
  assert.equal(result.witnesses.newly_allowed.event.resource, undefined);
  assert.equal(result.witnesses.newly_allowed.event.resource_scope.state, 'known');
});

test('CLI prints exact result and uses exit 2 for newly allowed authority', () => {
  const run = (...args) => spawnSync(process.execPath, ['bin/driftglass.js', 'diff', ...args], { encoding: 'utf8' });
  const candidate = 'fixtures/scope/candidate.json', baseline = 'fixtures/scope/baseline.json';
  const unchanged = run(baseline, baseline, '--json');
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(JSON.parse(unchanged.stdout).authority, 'equivalent');
  const widened = run(candidate, baseline);
  assert.equal(widened.status, 2, widened.stderr);
  assert.match(widened.stdout, /Authority: mixed \(exact/);
});

// An independent finite brute force oracle catches a missed partition boundary.
test('small grammar pairs agree with exhaustive concrete event enumeration', () => {
  const variations = [
    {}, { effect: 'WRITE' }, { actor: 'ann' }, { resource: 'repo/*' }, { resource: 'repo/a' },
    { destination: 'team/*' }, { resource_scope: scope('a/b', 'child') },
    { resource_scope: scope('a', 'descendant') },
    { resource: 'repo/*', resource_scope: scope('a/b', 'self_or_descendant') }
  ];
  for (let i = 0; i < variations.length; i++) for (let j = 0; j < variations.length; j++) {
    const a = policy([allow('a', variations[i])]);
    const b = policy([allow('b', variations[j])]);
    const diff = diffPolicies(a, b);
    let wider = false, narrower = false;
    for (const effect of ['READ', 'WRITE', 'SEND'])
      for (const actor of [undefined, 'ann', 'someone'])
        for (const resource of [undefined, 'repo', 'repo/a', 'repo/z', 'repo/a/x', 'other'])
          for (const destination of [undefined, 'team/a', 'team/z', 'team/a/x', 'other'])
            for (const resource_scope of [unknown, known('a'), known('a/b'), known('a/b/c'), known('a/b/c/d'), known('a/z'), known('other')]) {
              const event = { schema_version: 1, tool: 't', effect,
                ...(actor && { actor }), ...(resource && { resource }), ...(destination && { destination }), resource_scope };
              const before = evaluate(a, event).decision === 'ALLOW';
              const after = evaluate(b, event).decision === 'ALLOW';
              wider ||= !before && after; narrower ||= before && !after;
            }
    assert.equal(diff.categories.newly_allowed > 0, wider, `widen ${i}/${j}`);
    assert.equal(diff.categories.newly_nonpassing > 0, narrower, `narrow ${i}/${j}`);
  }
});
