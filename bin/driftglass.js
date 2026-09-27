#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluate, passesAutomation } from '../src/kernel/index.js';
import { replayTraces, comparePolicies } from '../src/replay/index.js';
import { readTraceDirectory } from '../src/adapter/json-directory.js';
import { adaptSourceTrace } from '../src/adapter/source-traces.js';

const usage = 'Usage:\n  driftglass evaluate <policy.json> <event.json>\n  driftglass replay <policy.json> <traces-dir> [--json]\n  driftglass compare <baseline.json> <candidate.json> <traces-dir> [--json]\n  driftglass adapt <coldgate|otlp|openai> <source.json> <mapping.json> > trace.json';
const [command, ...input] = process.argv.slice(2);
const json = input.at(-1) === '--json';
if (json) input.pop();

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
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
