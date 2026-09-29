#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { evaluate, passesAutomation } from '../src/kernel/index.js';
import { replayTraces, comparePolicies } from '../src/replay/index.js';
import { readTraceDirectory } from '../src/adapter/json-directory.js';
import { adaptSourceTrace } from '../src/adapter/source-traces.js';
import { diffPolicies } from '../src/diff/index.js';
import { assessPolicyChange, formatCISummary } from '../src/ci/index.js';
import { testPolicy, formatPolicyTestSummary } from '../src/policy-test/index.js';

const usage = 'Usage:\n  driftglass evaluate <policy.json> <event.json>\n  driftglass replay <policy.json> <traces-dir> [--json]\n  driftglass compare <baseline.json> <candidate.json> <traces-dir> [--json]\n  driftglass diff <baseline.json> <candidate.json> [--json]\n  driftglass ci <baseline.json> <candidate.json> <traces-dir> [--json] [--report <path>] [--summary <path>]\n  driftglass policy test <policy.json> <suite.json> [--json] [--summary <path>]\n  driftglass adapt <coldgate|otlp|openai> <source.json> <mapping.json> > trace.json';
const [command, ...input] = process.argv.slice(2);
const json = input.includes('--json');
if (json) input.splice(input.indexOf('--json'), 1);

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

function label(result) {
  return `${result.decision} (${result.source}${result.winning_rule_ids.length ? `: ${result.winning_rule_ids.join(', ')}` : ''})`;
}

function printComparison(result) {
  const { summary } = result;
  console.log(`Traces: ${summary.traces}  Events: ${summary.events}`);
  console.log(`Changes: ${summary.changes.newly_denied} newly denied, ${summary.changes.newly_approved} newly approved, ${summary.changes.newly_allowed} newly allowed, ${summary.changes.unchanged} unchanged`);
  console.log(`Regressions: ${summary.regressions}  Restored: ${summary.restored}`);
  console.log(`Coverage: ${summary.coverage.newly_explicit} newly explicit, ${summary.coverage.newly_defaulted} newly defaulted`);
  console.log(`Rule reassignments: ${summary.rule_reassignments}`);
  for (const trace of result.traces) for (const change of trace.differences) {
    const suffix = change.coverage_change ? ` [${change.coverage_change}]` : '';
    console.log(`${trace.id} #${change.index + 1}: ${label(change.baseline)} -> ${label(change.candidate)}${suffix}${change.rule_change ? ' [rule reassignment]' : ''}${change.regression ? ' [regression]' : ''}`);
  }
}

try {
  if (command === 'adapt' && input.length === 3 && !json) {
    const [source, mapping] = await Promise.all([readJSON(input[1]), readJSON(input[2])]);
    const traces = adaptSourceTrace(input[0], source, mapping);
    if (traces.length !== 1) throw new Error(`Source contains ${traces.length} traces; split it into single-trace exports before adapting`);
    console.log(JSON.stringify({ schema_version: 1, events: traces[0].events }, null, 2));
  } else if (command === 'evaluate' && input.length === 2 && !json) {
    const [policy, event] = await Promise.all(input.map(readJSON));
    const result = evaluate(policy, event);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = passesAutomation(result) ? 0 : 2;
  } else if (command === 'replay' && input.length === 2) {
    const [policy, traces] = await Promise.all([readJSON(input[0]), readTraceDirectory(input[1])]);
    const result = replayTraces(policy, traces);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Traces: ${result.summary.traces}  Events: ${result.summary.events}`);
      for (const [decision, count] of Object.entries(result.summary.decisions)) console.log(`${decision}: ${count}`);
      for (const trace of result.traces) console.log(`${trace.id}: ${trace.decisions.map(({ result }) => result.decision).join(', ') || '(empty)'}`);
    }
    process.exitCode = result.summary.decisions.DENY + result.summary.decisions.REQUIRE_APPROVAL ? 2 : 0;
  } else if (command === 'compare' && input.length === 3) {
    const [baseline, candidate, traces] = await Promise.all([readJSON(input[0]), readJSON(input[1]), readTraceDirectory(input[2])]);
    const result = comparePolicies(baseline, candidate, traces);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printComparison(result);
    process.exitCode = result.summary.regressions ? 2 : 0;
  } else if (command === 'policy' && input[0] === 'test') {
    input.shift();
    const args = input.splice(0, 2);
    let summaryPath;
    if (input.length) {
      if (input.length !== 2 || input[0] !== '--summary' || input[1].startsWith('--')) throw new Error(usage);
      summaryPath = input[1];
    }
    if (args.length !== 2) throw new Error(usage);
    const [policy, suite] = await Promise.all(args.map(readJSON));
    const report = testPolicy(policy, suite);
    if (summaryPath) await appendFile(summaryPath, formatPolicyTestSummary(report));
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (summaryPath) console.log(formatPolicyTestSummary(report));
    else {
      console.log(formatPolicyTestSummary(report));
      for (const item of report.cases) if (!item.passed) for (const mismatch of item.mismatches)
        console.log(`${item.id}: ${mismatch.field} expected ${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.actual)}`);
    }
    process.exitCode = report.summary.failed ? 2 : 0;
  } else if (command === 'ci') {
    const args = input.splice(0, 3);
    let reportPath, summaryPath;
    while (input.length) {
      const flag = input.shift();
      if (!['--report', '--summary'].includes(flag) || !input.length || input[0].startsWith('--')) throw new Error(`Invalid ci option: ${flag}`);
      const path = input.shift();
      if (flag === '--report' && reportPath === undefined) reportPath = path;
      else if (flag === '--summary' && summaryPath === undefined) summaryPath = path;
      else throw new Error(`Duplicate ci option: ${flag}`);
    }
    if (args.length !== 3) throw new Error(usage);
    const [baseline, candidate, traces] = await Promise.all([readJSON(args[0]), readJSON(args[1]), readTraceDirectory(args[2])]);
    const report = assessPolicyChange(baseline, candidate, traces);
    if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (summaryPath) await appendFile(summaryPath, formatCISummary(report));
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatCISummary(report));
    process.exitCode = report.gate.passed ? 0 : 2;
  } else if (command === 'diff' && input.length === 2) {
    const [baseline, candidate] = await Promise.all(input.map(readJSON));
    const result = diffPolicies(baseline, candidate);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Authority: ${result.authority} (${result.method}; ${result.representative_cells} representative cells)`);
      console.log(`Decisions equal: ${result.decisions_equal}`);
      for (const [type, count] of Object.entries(result.categories)) if (count) {
        const witness = result.witnesses[type];
        console.log(`${type}: ${count} cells; example ${JSON.stringify(witness.event)} (${witness.baseline.decision} -> ${witness.candidate.decision})`);
      }
    }
    process.exitCode = result.categories.newly_allowed ? 2 : 0;
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
