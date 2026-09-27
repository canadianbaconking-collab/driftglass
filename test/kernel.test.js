import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, loadPolicy, loadEvent, passesAutomation, ValidationError } from '../src/kernel/index.js';

const corpus = JSON.parse(await readFile(new URL('../fixtures/v0.1.json', import.meta.url), 'utf8'));
const event = (value) => ({ schema_version: 1, ...value });
const policy = (rules, fallback = 'deny') => ({ schema_version: 1, default: fallback, rules });

for (const fixture of corpus.cases) {
  test(`golden v0.1: ${fixture.name}`, () => {
    const result = evaluate(corpus.policy, event(fixture.event));
    assert.equal(result.decision, fixture.decision);
    assert.deepEqual(result.winning_rule_ids, fixture.winners);
    assert.equal(result.match_state, fixture.winners.length ? 'MATCHED' : 'UNMATCHED');
    assert.equal(result.source, fixture.winners.length ? 'rule' : 'default');
    assert.equal(passesAutomation(result), fixture.decision === 'ALLOW');
  });
}

test('default allow preserves coverage gap and is passing', () => {
  const result = evaluate(policy([], 'allow'), event({ tool: 'missing', effect: 'READ' }));
  assert.deepEqual(result, { match_state: 'UNMATCHED', decision: 'ALLOW', source: 'default',
    matching_rule_ids: [], winning_rule_ids: [], specificity: null });
  assert.equal(passesAutomation(result), true);
});

test('deny overrides more-specific approval, and explains other deny mismatches', () => {
  const result = evaluate(corpus.policy, event({ tool: 'github.push_files', effect: 'WRITE', actor: 'contractor', resource: 'repo/secrets' }));
  assert.deepEqual(result.matching_rule_ids, ['contractor-approval', 'repo-allow', 'repo-secret-deny']);
  assert.deepEqual(result.winning_rule_ids, ['repo-secret-deny']);
  assert.equal(result.specificity, null);
});

test('specificity is lexicographic and reports vectors', () => {
  const p = policy([
    { id: 'exact', allow: { tool: 't', resource: 'repo/app' } },
    { id: 'effect', require_approval: { tool: 't', effect: 'WRITE', resource: 'repo/*' } }
  ]);
  const result = evaluate(p, event({ tool: 't', effect: 'WRITE', resource: 'repo/app' }));
  assert.equal(result.decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(result.specificity, [1, 0, 1, 0]);
  assert.deepEqual(result.matching_specificity, [
    { id: 'effect', vector: [1, 0, 1, 0] }, { id: 'exact', vector: [0, 0, 2, 0] }
  ]);
  assert.deepEqual(result.non_matching_higher_priority, []);
});

test('explanation includes higher priority nonmatches for approval', () => {
  const result = evaluate(corpus.policy, event({ tool: 'slack.send', effect: 'SEND', destination: 'team/private' }));
  assert.deepEqual(result.non_matching_higher_priority.find((r) => r.id === 'public-deny')?.reasons, ['destination mismatch']);
});

test('default deny explains every nonmatching rule', () => {
  const result = evaluate(corpus.policy, event({ tool: 'other.tool', effect: 'READ' }));
  assert.equal(result.non_matching_higher_priority.length, corpus.policy.rules.length);
  assert.deepEqual(result.non_matching_higher_priority.find((r) => r.id === 'repo-allow').reasons,
    ['tool mismatch', 'resource missing']);
});

test('every matching deny wins irrespective of file order', () => {
  const rules = [
    { id: 'b', deny: { tool: 't' } },
    { id: 'a', deny: { tool: 't', effect: 'READ' } },
    { id: 'c', allow: { tool: 't', effect: 'READ', resource: 'r' } }
  ];
  for (const order of [rules, [...rules].reverse()]) {
    const result = evaluate(policy(order), event({ tool: 't', effect: 'READ', resource: 'r' }));
    assert.deepEqual(result.winning_rule_ids, ['a', 'b']);
    assert.deepEqual(result.matching_rule_ids, ['a', 'b', 'c']);
  }
});

test('independent equal-vector non-deny rules can coexist', () => {
  const p = policy([
    { id: 'a', allow: { tool: 't', resource: 'repo/*' } },
    { id: 'b', require_approval: { tool: 't', resource: 'other/*' } }
  ]);
  assert.equal(evaluate(p, event({ tool: 't', effect: 'READ', resource: 'other/x' })).decision, 'REQUIRE_APPROVAL');
});

test('snapshot is unaffected by mutations to source input', () => {
  const input = policy([{ id: 'a', allow: { tool: 't' } }]);
  const loaded = loadPolicy(input);
  input.rules[0].allow.tool = 'other';
  assert.equal(evaluate(loaded, event({ tool: 't', effect: 'READ' })).decision, 'ALLOW');
  assert.equal(Object.isFrozen(loaded.rules[0].constraints), true);
});

const badPolicies = [
  ['null policy', null], ['missing version', { default: 'deny', rules: [] }],
  ['future version', { schema_version: 2, default: 'deny', rules: [] }],
  ['missing default', { schema_version: 1, rules: [] }],
  ['bad default', policy([], 'approval')], ['missing rules', { schema_version: 1, default: 'deny' }],
  ['rules object', { schema_version: 1, default: 'deny', rules: {} }],
  ['unknown policy key', { ...policy([]), extra: 1 }],
  ['missing id', policy([{ allow: { tool: 't' } }])],
  ['invalid id', policy([{ id: '0x', allow: { tool: 't' } }])],
  ['duplicate id', policy([{ id: 'a', allow: { tool: 't' } }, { id: 'a', deny: { tool: 'x' } }])],
  ['no outcome', policy([{ id: 'a' }])],
  ['multiple outcomes', policy([{ id: 'a', allow: { tool: 't' }, deny: { tool: 'x' } }])],
  ['unknown outcome', policy([{ id: 'a', audit: { tool: 't' } }])],
  ['null constraints', policy([{ id: 'a', allow: null }])],
  ['missing tool', policy([{ id: 'a', allow: { actor: 'x' } }])],
  ['empty tool', policy([{ id: 'a', allow: { tool: '' } }])],
  ['tool wildcard', policy([{ id: 'a', allow: { tool: 't*' } }])],
  ['actor wildcard', policy([{ id: 'a', allow: { tool: 't', actor: '*' } }])],
  ['unknown constraint', policy([{ id: 'a', allow: { tool: 't', role: 'x' } }])],
  ['unknown effect', policy([{ id: 'a', allow: { tool: 't', effect: 'RUN' } }])],
  ['null effect', policy([{ id: 'a', allow: { tool: 't', effect: null } }])],
  ['array resource', policy([{ id: 'a', allow: { tool: 't', resource: ['repo/*'] } }])],
  ['embedded wildcard', policy([{ id: 'a', allow: { tool: 't', resource: 're*po' } }])],
  ['deep wildcard', policy([{ id: 'a', allow: { tool: 't', resource: 'repo/**' } }])],
  ['empty path segment', policy([{ id: 'a', allow: { tool: 't', resource: 'repo//x/*' } }])],
  ['duplicate body', policy([{ id: 'a', allow: { tool: 't', actor: 'x' } }, { id: 'b', allow: { actor: 'x', tool: 't' } }])],
  ['ambiguous overlap', policy([{ id: 'a', allow: { tool: 't', resource: 'repo/*' } }, { id: 'b', require_approval: { tool: 't', resource: 'repo/*' } }])],
  ['ambiguous exact', policy([{ id: 'a', allow: { tool: 't', effect: 'READ' } }, { id: 'b', require_approval: { tool: 't', effect: 'READ' } }])]
];
for (const [name, input] of badPolicies) test(`reject policy: ${name}`, () => assert.throws(() => loadPolicy(input), ValidationError));

const badEvents = [
  ['null event', null], ['missing version', { tool: 't', effect: 'READ' }],
  ['future version', { schema_version: 2, tool: 't', effect: 'READ' }],
  ['missing tool', { schema_version: 1, effect: 'READ' }],
  ['unknown effect', event({ tool: 't', effect: 'RUN' })],
  ['null actor', event({ tool: 't', effect: 'READ', actor: null })],
  ['empty destination', event({ tool: 't', effect: 'READ', destination: '' })],
  ['unknown field', event({ tool: 't', effect: 'READ', status: 'ok' })],
  ['date rollover', event({ tool: 't', effect: 'READ', timestamp: '2026-02-29T00:00:00Z' })],
  ['offset timestamp', event({ tool: 't', effect: 'READ', timestamp: '2026-09-26T05:00:00-07:00' })],
  ['local timestamp', event({ tool: 't', effect: 'READ', timestamp: '2026-09-26T05:00:00' })],
  ['invalid hour', event({ tool: 't', effect: 'READ', timestamp: '2026-09-26T24:00:00Z' })],
  ['null timestamp', event({ tool: 't', effect: 'READ', timestamp: null })]
];
for (const [name, input] of badEvents) test(`reject event: ${name}`, () => assert.throws(() => loadEvent(input), ValidationError));
