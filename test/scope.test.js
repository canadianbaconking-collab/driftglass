import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluate, loadEvent, loadPolicy, ValidationError } from '../src/kernel/index.js';
import { comparePolicies } from '../src/replay/index.js';
import { readTraceDirectory } from '../src/adapter/json-directory.js';

const corpus = JSON.parse(await readFile(new URL('../fixtures/v0.1.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('../fixtures/scope/baseline.json', import.meta.url), 'utf8'));
const candidate = JSON.parse(await readFile(new URL('../fixtures/scope/candidate.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../', import.meta.url));
const traces = await readTraceDirectory(fileURLToPath(new URL('../fixtures/scope/traces/', import.meta.url)));
const baseEvent = { schema_version: 1, tool: 'files.write', effect: 'WRITE', resource: 'repo/app' };
const known = (path) => ({ schema_version: 1, state: 'known', path });
const scoped = (anchor, relation) => ({ schema_version: 1, state: 'known', anchor, relation });
const policy = (rule) => ({ schema_version: 1, default: 'deny', rules: [rule] });

test('all 50 v0.1 decisions and outputs remain unchanged with optional scope input', () => {
  for (const fixture of corpus.cases) {
    const event = { schema_version: 1, ...fixture.event };
    const original = evaluate(corpus.policy, event);
    assert.equal(original.decision, fixture.decision);
    assert.deepEqual(evaluate(corpus.policy, { ...event, resource_scope: known('tenants/acme/app') }), original);
    assert.deepEqual(evaluate(corpus.policy, { ...event, resource_scope: { schema_version: 1, state: 'unknown' } }), original);
  }
});

test('scope relationships use exact path segments and never infer from legacy resource', () => {
  const anchor = 'tenant/acme/project';
  const matrix = [
    ['self', [anchor]],
    ['child', [`${anchor}/docs`]],
    ['descendant', [`${anchor}/docs`, `${anchor}/docs/spec`]],
    ['self_or_descendant', [anchor, `${anchor}/docs`, `${anchor}/docs/spec`]]
  ];
  for (const [relation, expected] of matrix) {
    const p = policy({ id: 'rule', allow: { tool: 'files.write', resource_scope: scoped(anchor, relation) } });
    for (const path of [anchor, `${anchor}/docs`, `${anchor}/docs/spec`, 'tenant/acme/projects/docs', 'tenant/acme']) {
      const result = evaluate(p, { ...baseEvent, resource_scope: known(path) });
      assert.equal(result.decision, expected.includes(path) ? 'ALLOW' : 'DENY', `${relation} at ${path}`);
    }
    assert.equal(evaluate(p, baseEvent).decision, 'DENY', `${relation} cannot infer from resource`);
    assert.equal(evaluate(p, { ...baseEvent, resource_scope: { schema_version: 1, state: 'unknown' } }).decision, 'DENY');
  }
});

test('deeper anchors and narrower relations win independent of declaration order', () => {
  const rules = candidate.rules.filter((rule) => ['write-repo', 'review-acme', 'allow-project-child'].includes(rule.id));
  for (const order of [rules, [...rules].reverse()]) {
    const p = { schema_version: 1, default: 'deny', rules: order };
    const child = evaluate(p, { ...baseEvent, resource_scope: known('tenants/acme/projects/app/docs') });
    assert.equal(child.decision, 'ALLOW');
    assert.deepEqual(child.winning_rule_ids, ['allow-project-child']);
    assert.deepEqual(child.specificity, [1, 0, 18, 0]);
    const grandchild = evaluate(p, { ...baseEvent, resource_scope: known('tenants/acme/projects/app/docs/spec') });
    assert.equal(grandchild.decision, 'REQUIRE_APPROVAL');
    assert.deepEqual(grandchild.specificity, [1, 0, 9, 0]);
  }
});

test('unknown guard denies missing and explicit unknown scope despite a legacy allow', () => {
  for (const event of [baseEvent, { ...baseEvent, resource_scope: { schema_version: 1, state: 'unknown' } }]) {
    const result = evaluate(candidate, event);
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(result.winning_rule_ids, ['deny-unresolved']);
    assert.deepEqual(result.matching_rule_ids, ['deny-unresolved', 'write-repo']);
  }
  const knownResult = evaluate(candidate, { ...baseEvent, resource_scope: known('tenants/other/app') });
  assert.equal(knownResult.decision, 'ALLOW');
});

test('scoped deny overrides more-specific scoped allow', () => {
  const result = evaluate(candidate, { ...baseEvent, resource_scope: known('tenants/acme/projects/app/secrets') });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(result.winning_rule_ids, ['deny-secrets']);
});

test('approval explains higher-priority scope rules that did not match', () => {
  const result = evaluate(candidate, { ...baseEvent, resource_scope: known('tenants/acme/projects/app/docs/spec') });
  assert.equal(result.decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(result.non_matching_higher_priority.find((r) => r.id === 'allow-project-child')?.reasons,
    ['resource_scope relation mismatch']);
  assert.deepEqual(result.non_matching_higher_priority.find((r) => r.id === 'deny-unresolved')?.reasons,
    ['resource_scope known']);
});

test('scope snapshot prevents later mutation', () => {
  const input = policy({ id: 'rule', allow: { tool: 'files.write', resource_scope: scoped('tenant/acme', 'child') } });
  const loaded = loadPolicy(input);
  input.rules[0].allow.resource_scope.anchor = 'tenant/other';
  assert.equal(evaluate(loaded, { ...baseEvent, resource_scope: known('tenant/acme/app') }).decision, 'ALLOW');
  assert.equal(Object.isFrozen(loaded.rules[0].constraints.resource_scope), true);
  const raw = { ...baseEvent, resource_scope: known('tenant/acme/app') };
  const event = loadEvent(raw);
  raw.resource_scope.path = 'tenant/other/app';
  assert.equal(event.resource_scope.path, 'tenant/acme/app');
});

test('overlapping equal-vector non-deny scope rules fail at load time', () => {
  const ruleScope = scoped('tenant/acme', 'descendant');
  const p = { schema_version: 1, default: 'deny', rules: [
    { id: 'a', allow: { tool: 't', resource_scope: ruleScope } },
    { id: 'b', require_approval: { tool: 't', resource_scope: { ...ruleScope } } }
  ] };
  assert.throws(() => loadPolicy(p), /ambiguous overlap between a and b/);
  p.rules[1].require_approval.resource_scope.anchor = 'tenant/other';
  assert.doesNotThrow(() => loadPolicy(p));
});

test('overlap detection still considers legacy resource when scope scores are equal', () => {
  const p = { schema_version: 1, default: 'deny', rules: [
    { id: 'a', allow: { tool: 't', resource: 'repo/*', resource_scope: scoped('tenant/acme', 'child') } },
    { id: 'b', require_approval: { tool: 't', resource: 'repo/app', resource_scope: scoped('tenant/acme', 'child') } }
  ] };
  assert.throws(() => loadPolicy(p), /ambiguous overlap/);
  p.rules[1].require_approval.resource = 'other/app';
  assert.doesNotThrow(() => loadPolicy(p));
});

test('different relations at the same anchor are ordered and not ambiguous', () => {
  const p = { schema_version: 1, default: 'deny', rules: [
    { id: 'broad', require_approval: { tool: 't', resource_scope: scoped('tenant/acme', 'descendant') } },
    { id: 'narrow', allow: { tool: 't', resource_scope: scoped('tenant/acme', 'child') } }
  ] };
  assert.equal(evaluate(p, { schema_version: 1, tool: 't', effect: 'READ', resource_scope: known('tenant/acme/app') }).decision, 'ALLOW');
});

const badRules = [
  ['null', null],
  ['future scope version', { schema_version: 2, state: 'unknown' }],
  ['unknown state', { schema_version: 1, state: 'unresolved' }],
  ['missing state', { schema_version: 1 }],
  ['unknown with anchor', { schema_version: 1, state: 'unknown', anchor: 'tenant' }],
  ['unknown with relation', { schema_version: 1, state: 'unknown', relation: 'child' }],
  ['missing anchor', { schema_version: 1, state: 'known', relation: 'child' }],
  ['missing relation', { schema_version: 1, state: 'known', anchor: 'tenant' }],
  ['broad wildcard', scoped('tenant/**', 'child')],
  ['embedded wildcard', scoped('ten*ant', 'child')],
  ['empty segment', scoped('tenant//app', 'child')],
  ['parent segment', scoped('tenant/../app', 'child')],
  ['unknown relationship', scoped('tenant', 'sibling')],
  ...[['self'], ['child'], ['descendant'], ['self_or_descendant'], [], {}, null, 0, true]
    .map(relation => [`non-string relationship ${JSON.stringify(relation)}`, scoped('tenant', relation)]),
  ['extra key', { ...scoped('tenant', 'child'), prefix: 'x' }]
];
for (const [name, resource_scope] of badRules) {
  test(`reject policy scope: ${name}`, () => {
    for (const outcome of ['allow', 'deny', 'require_approval']) {
      assert.throws(() => loadPolicy(policy({ id: 'x', [outcome]: { tool: 't', resource_scope } })), ValidationError);
    }
  });
}

test('unknown scope cannot grant authority', () => {
  assert.throws(() => loadPolicy(policy({ id: 'x', allow: { tool: 't', resource_scope: { schema_version: 1, state: 'unknown' } } })),
    /unknown scope cannot grant authority/);
  assert.doesNotThrow(() => loadPolicy(policy({ id: 'x', require_approval: { tool: 't', resource_scope: { schema_version: 1, state: 'unknown' } } })));
});

const badEvents = [
  ['null', null],
  ['future scope version', { schema_version: 2, state: 'unknown' }],
  ['unknown state', { schema_version: 1, state: 'maybe' }],
  ['missing path', { schema_version: 1, state: 'known' }],
  ['unknown with path', { schema_version: 1, state: 'unknown', path: 'tenant/acme' }],
  ['empty segment', known('tenant//acme')],
  ['trailing slash', known('tenant/acme/')],
  ['dot segment', known('tenant/./acme')],
  ['wildcard path', known('tenant/*')],
  ['extra key', { ...known('tenant/acme'), relation: 'child' }]
];
for (const [name, resource_scope] of badEvents) {
  test(`reject event scope: ${name}`, () => assert.throws(() => loadEvent({ ...baseEvent, resource_scope }), ValidationError));
}

test('v0.3 synthetic trace comparison captures scope regressions', () => {
  const report = comparePolicies(baseline, candidate, traces);
  assert.equal(report.summary.events, 8);
  assert.equal(report.summary.regressions, 4);
  assert.equal(report.summary.changes.newly_approved, 2);
  assert.equal(report.summary.changes.newly_denied, 3);
  assert.equal(report.summary.coverage.newly_explicit, 1);
  assert.equal(report.traces[0].differences.find((item) => item.index === 2).rule_change, true);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/driftglass.js', import.meta.url)), 'compare',
    fileURLToPath(new URL('../fixtures/scope/baseline.json', import.meta.url)),
    fileURLToPath(new URL('../fixtures/scope/candidate.json', import.meta.url)),
    fileURLToPath(new URL('../fixtures/scope/traces/', import.meta.url)), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.equal(JSON.parse(cli.stdout).summary.regressions, report.summary.regressions);
});
