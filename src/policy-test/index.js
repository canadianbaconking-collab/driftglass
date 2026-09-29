import { evaluate, loadEvent, loadPolicy, ValidationError } from '../kernel/index.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;

function object(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${path}: expected object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ValidationError(`${path}.${key}: unknown field`);
}

function ruleIds(value, path) {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: expected array`);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new ValidationError(`${path}: invalid rule ID`);
    if (seen.has(id)) throw new ValidationError(`${path}: duplicate rule ID ${id}`);
    seen.add(id);
  }
  return [...value].sort();
}

function loadSuite(input) {
  object(input, 'suite', ['schema_version', 'cases']);
  if (input.schema_version !== 1) throw new ValidationError('suite.schema_version: expected 1');
  if (!Array.isArray(input.cases) || input.cases.length === 0) throw new ValidationError('suite.cases: expected non-empty array');
  const ids = new Set();
  return input.cases.map((item, i) => {
    const path = `suite.cases[${i}]`;
    object(item, path, ['id', 'event', 'expect']);
    if (typeof item.id !== 'string' || !idPattern.test(item.id)) throw new ValidationError(`${path}.id: invalid case ID`);
    if (ids.has(item.id)) throw new ValidationError(`${path}.id: duplicate case ID ${item.id}`);
    ids.add(item.id);
    let event;
    try { event = loadEvent(item.event); }
    catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(`${path}.event: ${error.message}`);
      throw error;
    }
    const expectation = `${path}.expect`;
    object(item.expect, expectation, ['decision', 'source', 'match_state', 'winning_rule_ids', 'matching_rule_ids']);
    if (!['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(item.expect.decision))
      throw new ValidationError(`${expectation}.decision: invalid or missing decision`);
    if (own(item.expect, 'source') && !['rule', 'default'].includes(item.expect.source))
      throw new ValidationError(`${expectation}.source: expected rule or default`);
    if (own(item.expect, 'match_state') && !['MATCHED', 'UNMATCHED'].includes(item.expect.match_state))
      throw new ValidationError(`${expectation}.match_state: expected MATCHED or UNMATCHED`);
    const expected = { decision: item.expect.decision };
    for (const field of ['source', 'match_state']) if (own(item.expect, field)) expected[field] = item.expect[field];
    for (const field of ['winning_rule_ids', 'matching_rule_ids']) if (own(item.expect, field))
      expected[field] = ruleIds(item.expect[field], `${expectation}.${field}`);
    return { id: item.id, event, expected };
  });
}

/** Assert authored examples against one policy. An expected approval is a test pass, not an automated grant. */
export function testPolicy(policyInput, suiteInput) {
  const policy = loadPolicy(policyInput);
  const cases = loadSuite(suiteInput); // validate the entire suite before evaluating any case
  let passed = 0;
  const results = cases.map(({ id, event, expected }) => {
    const actual = evaluate(policy, event);
    const mismatches = Object.entries(expected).flatMap(([field, value]) => {
      const observed = actual[field];
      return JSON.stringify(value) === JSON.stringify(observed) ? [] : [{ field, expected: value, actual: observed }];
    });
    if (mismatches.length === 0) passed++;
    return { id, passed: mismatches.length === 0, mismatches };
  });
  return { schema_version: 1, summary: { cases: results.length, passed, failed: results.length - passed }, cases: results };
}

export function formatPolicyTestSummary(report) {
  return `## Driftglass policy tests\n\n**${report.summary.failed ? 'FAIL' : 'PASS'}** — ${report.summary.passed}/${report.summary.cases} cases passed\n\n`;
}
