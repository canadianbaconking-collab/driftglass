import { evaluate, loadPolicy, ValidationError } from '../kernel/index.js';

const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'DELETE', 'SEND'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fallback = (values) => {
  let candidate = '__driftglass_other__';
  const forbidden = new Set(values.flatMap(v => v.split('/')));
  while (forbidden.has(candidate)) candidate += '_';
  return candidate;
};
const sorted = (values) => [...new Set(values)].sort(compare);

function simpleDomain(values) {
  return [undefined, ...sorted(values), fallback(values)];
}

function pathDomain(patterns) {
  const wildcardBases = patterns.filter(p => p.endsWith('/*')).map(p => p.slice(0, -2));
  const fresh = fallback([...patterns, ...wildcardBases]);
  return [undefined, ...sorted([...patterns.filter(p => !p.endsWith('/*')),
    ...wildcardBases.map(base => `${base}/${fresh}`)]), fresh];
}

function scopeDomain(scopes) {
  const anchors = scopes.filter(s => s?.state === 'known').map(s => s.anchor);
  const fresh = fallback(anchors);
  const prefixes = anchors.flatMap(anchor => anchor.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')));
  const paths = sorted([fresh, ...prefixes.flatMap(p => [p, `${p}/${fresh}`, `${p}/${fresh}/${fresh}`])]);
  return [{ schema_version: 1, state: 'unknown' },
    ...paths.map(path => ({ schema_version: 1, state: 'known', path }))];
}

function domains(rules) {
  const constraints = rules.map(r => r.constraints);
  return [EFFECTS, simpleDomain(constraints.flatMap(c => c.actor === undefined ? [] : [c.actor])),
    pathDomain(constraints.flatMap(c => c.resource === undefined ? [] : [c.resource])),
    pathDomain(constraints.flatMap(c => c.destination === undefined ? [] : [c.destination])),
    scopeDomain(constraints.map(c => c.resource_scope))];
}

function representative(tool, [effect, actor, resource, destination, scope]) {
  return { schema_version: 1, tool, effect,
    ...(actor !== undefined && { actor }), ...(resource !== undefined && { resource }),
    ...(destination !== undefined && { destination }), resource_scope: scope };
}

const TYPES = ['newly_allowed', 'newly_nonpassing', 'newly_approved', 'newly_denied', 'coverage_changed', 'rule_reassigned'];
/** Exact decision-set comparison for the finite, literal/single-segment policy grammar. */
export function diffPolicies(baselineInput, candidateInput, options = {}) {
  const baseline = loadPolicy(baselineInput), candidate = loadPolicy(candidateInput);
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'max_cells')) throw new ValidationError('options: expected max_cells only');
  const max = options.max_cells ?? 250000;
  if (!Number.isSafeInteger(max) || max < 1) throw new ValidationError('options.max_cells: expected positive safe integer');
  const tools = sorted([...baseline.rules, ...candidate.rules].map(r => r.constraints.tool));
  const otherTool = fallback(tools);
  const witnesses = Object.fromEntries(TYPES.map(type => [type, null]));
  const counts = Object.fromEntries(TYPES.map(type => [type, 0]));
  let cells = 0;
  const visit = (event) => {
    const before = evaluate(baseline, event), after = evaluate(candidate, event);
    cells++;
    const types = [];
    if (before.decision !== 'ALLOW' && after.decision === 'ALLOW') types.push('newly_allowed');
    if (before.decision === 'ALLOW' && after.decision !== 'ALLOW') types.push('newly_nonpassing');
    if (before.decision !== after.decision && after.decision === 'REQUIRE_APPROVAL') types.push('newly_approved');
    if (before.decision !== after.decision && after.decision === 'DENY') types.push('newly_denied');
    if (before.source !== after.source) types.push('coverage_changed');
    if (before.source === 'rule' && after.source === 'rule' &&
        before.winning_rule_ids.join('\0') !== after.winning_rule_ids.join('\0')) types.push('rule_reassigned');
    for (const type of types) {
      counts[type]++;
      if (!witnesses[type]) witnesses[type] = { event, baseline: { decision: before.decision, source: before.source,
        winning_rule_ids: before.winning_rule_ids }, candidate: { decision: after.decision, source: after.source,
        winning_rule_ids: after.winning_rule_ids } };
    }
  };
  for (const tool of [...tools, otherTool]) {
    const rules = [...baseline.rules, ...candidate.rules].filter(r => r.constraints.tool === tool);
    // An unmentioned tool has no matching rule: only the defaults can matter.
    if (!rules.length) {
      if (cells + 1 > max) throw new ValidationError(`diff: analysis exceeds max_cells ${max}; no partial result`);
      visit(representative(tool, ['READ', undefined, undefined, undefined, { schema_version: 1, state: 'unknown' }]));
      continue;
    }
    const [effects, actors, resources, destinations, scopes] = domains(rules);
    const size = effects.length * actors.length * resources.length * destinations.length * scopes.length;
    if (!Number.isSafeInteger(size) || cells + size > max) {
      throw new ValidationError(`diff: analysis exceeds max_cells ${max}; no partial result`);
    }
    for (const effect of effects) for (const actor of actors) for (const resource of resources)
      for (const destination of destinations) for (const scope of scopes) {
        visit(representative(tool, [effect, actor, resource, destination, scope]));
      }
  }
  const widening = counts.newly_allowed > 0, narrowing = counts.newly_nonpassing > 0;
  return { schema_version: 1, method: 'exact', authority: widening && narrowing ? 'mixed'
    : widening ? 'widened' : narrowing ? 'narrowed' : 'equivalent',
    decisions_equal: !widening && !narrowing && !counts.newly_approved && !counts.newly_denied,
  // Counts are partition representatives, not event counts, probabilities, or volumes of authority.
    representative_cells: cells, categories: counts, witnesses };
}
