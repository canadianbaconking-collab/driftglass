import { comparePolicies } from '../replay/index.js';
import { diffPolicies } from '../diff/index.js';

/** A failed or incomplete exact diff must never yield a passing CI result. */
export function assessPolicyChange(baseline, candidate, traces) {
  const comparison = comparePolicies(baseline, candidate, traces);
  const policy_diff = diffPolicies(baseline, candidate);
  const gate = {
    passed: comparison.summary.regressions === 0 && policy_diff.categories.newly_allowed === 0,
    historical_regressions: comparison.summary.regressions,
    newly_allowed_cells: policy_diff.categories.newly_allowed
  };
  return { schema_version: 1, gate, comparison, policy_diff };
}

/** Deliberately omit event values and witness details from hosted CI summaries. */
export function formatCISummary(report) {
  const { gate, comparison, policy_diff } = report;
  return [
    '## Driftglass policy check',
    '',
    `**${gate.passed ? 'PASS' : 'BLOCK'}** — ${comparison.summary.traces} traces, ${comparison.summary.events} events`,
    '',
    '| Check | Result |',
    '| --- | ---: |',
    `| Historical pass-to-block regressions | ${gate.historical_regressions} |`,
    `| Newly allowed representative cells | ${gate.newly_allowed_cells} |`,
    `| Exact authority relationship | ${policy_diff.authority} |`,
    `| Restored historical events | ${comparison.summary.restored} |`,
    '',
    'Approval-required events are nonpassing until approval evidence is supported.',
    'Representative cells are policy partitions, not observed event counts.',
    ''
  ].join('\n');
}
