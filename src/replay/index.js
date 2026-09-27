import { evaluate, loadEvent, loadPolicy, passesAutomation, ValidationError } from '../kernel/index.js';

const decisions = () => ({ ALLOW: 0, DENY: 0, REQUIRE_APPROVAL: 0 });
const changes = () => ({ newly_allowed: 0, newly_denied: 0, newly_approved: 0, unchanged: 0 });

function normalizeTraces(input) {
  if (!Array.isArray(input) || input.length === 0) throw new ValidationError('traces: expected non-empty array');
  const ids = new Set();
  let total = 0;
  const traces = input.map((trace, i) => {
    const path = `traces[${i}]`;
    if (trace === null || typeof trace !== 'object' || Array.isArray(trace)) throw new ValidationError(`${path}: expected object`);
    for (const key of Object.keys(trace)) {
      if (!['id', 'schema_version', 'events'].includes(key)) throw new ValidationError(`${path}.${key}: unknown field`);
    }
    if (typeof trace.id !== 'string' || trace.id.length === 0) throw new ValidationError(`${path}.id: expected non-empty string`);
    if (ids.has(trace.id)) throw new ValidationError(`${path}.id: duplicate trace ID ${trace.id}`);
    ids.add(trace.id);
    if (trace.schema_version !== 1) throw new ValidationError(`${path}.schema_version: expected 1`);
    if (!Array.isArray(trace.events)) throw new ValidationError(`${path}.events: expected array`);
    const events = trace.events.map((event, j) => {
      try { return loadEvent(event); }
      catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(`${path}.events[${j}]: ${error.message}`);
        throw error;
      }
    });
    total += events.length;
    return { id: trace.id, events };
  });
  if (total === 0) throw new ValidationError('traces: corpus has no events');
  return { traces, total };
}

/** Evaluate a validated synthetic corpus under one policy, without I/O. */
export function replayTraces(policyInput, traceInput) {
  const policy = loadPolicy(policyInput);
  const { traces, total } = normalizeTraces(traceInput);
  const counts = decisions();
  const results = traces.map(({ id, events }) => ({ id, decisions: events.map((event, index) => {
    const result = evaluate(policy, event);
    counts[result.decision]++;
    return { index, result };
  }) }));
  return { schema_version: 1, summary: { traces: traces.length, events: total, decisions: counts }, traces: results };
}

function changeType(before, after) {
  if (before.decision === after.decision) return 'unchanged';
  return ({ ALLOW: 'newly_allowed', DENY: 'newly_denied', REQUIRE_APPROVAL: 'newly_approved' })[after.decision];
}

/** Historical impact of a candidate policy against the exact same events. */
export function comparePolicies(baselineInput, candidateInput, traceInput) {
  const baseline = loadPolicy(baselineInput);
  const candidate = loadPolicy(candidateInput);
  const { traces, total } = normalizeTraces(traceInput);
  const summary = {
    traces: traces.length, events: total, baseline: decisions(), candidate: decisions(), changes: changes(),
    regressions: 0, restored: 0, rule_reassignments: 0,
    coverage: { newly_explicit: 0, newly_defaulted: 0 }
  };
  const results = traces.map(({ id, events }) => {
    const traceSummary = { events: events.length, changes: changes(), regressions: 0, restored: 0, rule_reassignments: 0 };
    const differences = [];
    events.forEach((event, index) => {
      const before = evaluate(baseline, event);
      const after = evaluate(candidate, event);
      summary.baseline[before.decision]++;
      summary.candidate[after.decision]++;
      const type = changeType(before, after);
      summary.changes[type]++;
      traceSummary.changes[type]++;
      const regression = passesAutomation(before) && !passesAutomation(after);
      const restored = !passesAutomation(before) && passesAutomation(after);
      if (regression) { summary.regressions++; traceSummary.regressions++; }
      if (restored) { summary.restored++; traceSummary.restored++; }
      let coverage_change = null;
      if (before.source === 'default' && after.source === 'rule') {
        coverage_change = 'newly_explicit'; summary.coverage.newly_explicit++;
      } else if (before.source === 'rule' && after.source === 'default') {
        coverage_change = 'newly_defaulted'; summary.coverage.newly_defaulted++;
      }
      const rule_change = before.source === 'rule' && after.source === 'rule' &&
        before.winning_rule_ids.join('\0') !== after.winning_rule_ids.join('\0');
      if (rule_change) { summary.rule_reassignments++; traceSummary.rule_reassignments++; }
      if (type !== 'unchanged' || coverage_change || rule_change) differences.push({ index, event, change: type,
        regression, restored, coverage_change, rule_change, baseline: before, candidate: after });
    });
    return { id, summary: traceSummary, differences };
  });
  return { schema_version: 1, summary, traces: results };
}
