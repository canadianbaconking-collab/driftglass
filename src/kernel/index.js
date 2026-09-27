/** Pure v0.1 authority-policy evaluator. No imports, ambient state, or I/O. */

const EFFECTS = new Set(['READ', 'WRITE', 'EXECUTE', 'DELETE', 'SEND']);
const OUTCOMES = ['allow', 'deny', 'require_approval'];
const FIELDS = ['effect', 'actor', 'resource', 'destination'];
const COMPILED = Symbol('validated policy');
const has = (object, key) => Object.hasOwn(object, key);
const alphabetic = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(path, message) {
  throw new ValidationError(`${path}: ${message}`);
}

function record(value, path, allowed, required) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of required) if (!has(value, key)) fail(`${path}.${key}`, 'required field');
}

function nonempty(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected non-empty string');
}

function pattern(value, path) {
  nonempty(value, path);
  if (value.includes('*') && !/^[^/*]+(?:\/[^/*]+)*\/\*$/.test(value)) {
    fail(path, 'only a terminal whole-segment wildcard is supported');
  }
}

function isWildcard(value) {
  return value?.endsWith('/*') === true;
}

function matchesPattern(patternValue, actual) {
  if (actual === undefined) return false;
  if (!isWildcard(patternValue)) return patternValue === actual;
  const prefix = patternValue.slice(0, -1);
  return actual.startsWith(prefix) && actual.length > prefix.length && !actual.slice(prefix.length).includes('/');
}

function intersects(a, b) {
  if (a === undefined || b === undefined) return true;
  if (!isWildcard(a) && !isWildcard(b)) return a === b;
  if (isWildcard(a) && isWildcard(b)) return a === b;
  return isWildcard(a) ? matchesPattern(a, b) : matchesPattern(b, a);
}

function vector(constraints) {
  return [Number(has(constraints, 'effect')), Number(has(constraints, 'actor')),
    has(constraints, 'resource') ? (isWildcard(constraints.resource) ? 1 : 2) : 0,
    has(constraints, 'destination') ? (isWildcard(constraints.destination) ? 1 : 2) : 0];
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function normalizeConstraints(value, path) {
  record(value, path, ['tool', ...FIELDS], ['tool']);
  nonempty(value.tool, `${path}.tool`);
  if (value.tool.includes('*')) fail(`${path}.tool`, 'wildcards are not supported');
  const result = { tool: value.tool };
  for (const field of FIELDS) {
    if (!has(value, field)) continue;
    if (field === 'effect') {
      if (!EFFECTS.has(value[field])) fail(`${path}.effect`, 'unknown effect');
    } else if (field === 'resource' || field === 'destination') {
      pattern(value[field], `${path}.${field}`);
    } else {
      nonempty(value[field], `${path}.${field}`);
      if (value[field].includes('*')) fail(`${path}.${field}`, 'wildcards are not supported');
    }
    result[field] = value[field];
  }
  return result;
}

/** Validate and snapshot a policy. A malformed or ambiguous policy never loads. */
export function loadPolicy(value) {
  record(value, 'policy', ['schema_version', 'default', 'rules'], ['schema_version', 'default', 'rules']);
  if (value.schema_version !== 1) fail('policy.schema_version', 'expected 1');
  if (value.default !== 'allow' && value.default !== 'deny') fail('policy.default', 'expected allow or deny');
  if (!Array.isArray(value.rules)) fail('policy.rules', 'expected array');
  const ids = new Set();
  const bodies = new Set();
  const rules = value.rules.map((input, i) => {
    const path = `policy.rules[${i}]`;
    record(input, path, ['id', ...OUTCOMES], ['id']);
    if (typeof input.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(input.id)) fail(`${path}.id`, 'invalid stable ID');
    if (ids.has(input.id)) fail(`${path}.id`, 'duplicate ID');
    ids.add(input.id);
    const outcomes = OUTCOMES.filter((outcome) => has(input, outcome));
    if (outcomes.length !== 1) fail(path, 'expected exactly one outcome');
    const outcome = outcomes[0];
    const constraints = normalizeConstraints(input[outcome], `${path}.${outcome}`);
    const body = JSON.stringify([outcome, Object.entries(constraints).sort(([a], [b]) => alphabetic(a, b))]);
    if (bodies.has(body)) fail(path, 'duplicate outcome and constraints');
    bodies.add(body);
    return { id: input.id, outcome, constraints, specificity: vector(constraints) };
  });
  for (let i = 0; i < rules.length; i++) {
    const a = rules[i];
    if (a.outcome === 'deny') continue;
    for (let j = i + 1; j < rules.length; j++) {
      const b = rules[j];
      if (b.outcome === 'deny' || b.outcome === a.outcome || compare(a.specificity, b.specificity)) continue;
      if (a.constraints.tool !== b.constraints.tool) continue;
      if (FIELDS.every((field) => intersects(a.constraints[field], b.constraints[field]))) {
        fail('policy.rules', `ambiguous overlap between ${a.id} and ${b.id}`);
      }
    }
  }
  return Object.freeze({ schema_version: 1, default: value.default, [COMPILED]: true,
    rules: Object.freeze(rules.map((r) => Object.freeze({ ...r,
      specificity: Object.freeze(r.specificity), constraints: Object.freeze(r.constraints) }))) });
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min, s] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(h, min, s, 0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    && date.getUTCHours() === h && date.getUTCMinutes() === min && date.getUTCSeconds() === s;
}

/** Validate and snapshot a normalized event. */
export function loadEvent(value) {
  record(value, 'event', ['schema_version', 'tool', ...FIELDS, 'timestamp'], ['schema_version', 'tool', 'effect']);
  if (value.schema_version !== 1) fail('event.schema_version', 'expected 1');
  for (const field of ['tool', ...FIELDS]) {
    if (!has(value, field)) continue;
    nonempty(value[field], `event.${field}`);
  }
  if (!EFFECTS.has(value.effect)) fail('event.effect', 'unknown effect');
  if (has(value, 'timestamp') && !validTimestamp(value.timestamp)) fail('event.timestamp', 'expected a valid UTC RFC 3339 instant');
  return Object.freeze({ ...value });
}

function differences(constraints, event) {
  const reasons = [];
  if (constraints.tool !== event.tool) reasons.push('tool mismatch');
  for (const field of FIELDS) {
    if (!has(constraints, field)) continue;
    if (!has(event, field)) reasons.push(`${field} missing`);
    else if (field === 'resource' || field === 'destination' ? !matchesPattern(constraints[field], event[field])
      : constraints[field] !== event[field]) reasons.push(`${field} mismatch`);
  }
  return reasons;
}

/** Evaluate one event with no I/O or ambient state. Input is validated on each call. */
export function evaluate(policyInput, eventInput) {
  const policy = policyInput?.[COMPILED] === true ? policyInput : loadPolicy(policyInput);
  const event = loadEvent(eventInput);
  const inspected = policy.rules.map((rule) => ({ rule, reasons: differences(rule.constraints, event) }));
  const matched = inspected.filter(({ reasons }) => reasons.length === 0).map(({ rule }) => rule);
  const matching_rule_ids = matched.map((r) => r.id).sort(alphabetic);
  if (matched.length === 0) {
    const result = { match_state: 'UNMATCHED', decision: policy.default.toUpperCase(),
      source: 'default', matching_rule_ids, winning_rule_ids: [], specificity: null };
    if (policy.default === 'deny') result.non_matching_higher_priority = inspected
      .map(({ rule, reasons }) => ({ id: rule.id, specificity: [...rule.specificity], reasons }))
      .sort((a, b) => alphabetic(a.id, b.id));
    return result;
  }
  const denied = matched.filter((r) => r.outcome === 'deny');
  const winners = denied.length ? denied : matched.filter((r) => !matched.some((other) =>
    compare(other.specificity, r.specificity) > 0));
  const decision = denied.length ? 'DENY' : winners[0].outcome.toUpperCase();
  const result = { match_state: 'MATCHED', decision, source: 'rule', matching_rule_ids,
    winning_rule_ids: winners.map((r) => r.id).sort(alphabetic), specificity: denied.length ? null : [...winners[0].specificity] };
  if (!denied.length && matched.some((r) => compare(r.specificity, winners[0].specificity) !== 0)) {
    result.matching_specificity = matched.map((r) => ({ id: r.id, vector: [...r.specificity] }))
      .sort((a, b) => alphabetic(a.id, b.id));
  }
  if (decision !== 'ALLOW') {
    result.non_matching_higher_priority = inspected.filter(({ rule, reasons }) => reasons.length &&
      (rule.outcome === 'deny' || (decision !== 'DENY' && compare(rule.specificity, winners[0].specificity) >= 0)))
      .map(({ rule, reasons }) => ({ id: rule.id, specificity: [...rule.specificity], reasons }))
      .sort((a, b) => alphabetic(a.id, b.id));
  }
  return result;
}

/** Automated checks must treat approval as non-passing until approval evidence exists. */
export function passesAutomation(result) {
  return result.decision === 'ALLOW';
}
