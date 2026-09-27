import { writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { replayTraces } from '../src/replay/index.js';

const policy = { schema_version: 1, default: 'deny', rules: [] };
for (let tool = 0; tool < 20; tool++) for (let resource = 0; resource < 10; resource++) {
  policy.rules.push({ id: `r-${tool}-${resource}`, allow: { tool: `tool.${tool}`, effect: 'READ', resource: `bucket${tool}/item${resource}` } });
}
const traces = Array.from({ length: 200 }, (_, trace) => ({
  id: `run-${String(trace).padStart(3, '0')}`,
  schema_version: 1,
  events: Array.from({ length: 50 }, (_, index) => {
    const tool = (trace + index) % 20;
    return { schema_version: 1, tool: `tool.${tool}`, effect: 'READ', resource: `bucket${tool}/item${(trace * 50 + index) % 10}` };
  })
}));

// One warmup and three measured runs. The synthetic corpus is fully deterministic.
replayTraces(policy, traces);
const samples_ms = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const result = replayTraces(policy, traces);
  samples_ms.push(Number((performance.now() - started).toFixed(2)));
  if (result.summary.events !== 10000 || result.summary.decisions.ALLOW !== 10000) {
    throw new Error('Benchmark corpus produced unexpected decisions');
  }
}
const median_ms = [...samples_ms].sort((a, b) => a - b)[1];
const report = {
  benchmark: 'synthetic-v0.2-200-traces-50-events',
  policy_rules: 200, traces: 200, events: 10000, target_ms: 1000,
  samples_ms, median_ms, meets_target: median_ms < 1000,
  runtime: { node: process.version, v8: process.versions.v8, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown', logical_cpus: cpus().length, memory_gib: Number((totalmem() / 2 ** 30).toFixed(2)) }
};
console.log(JSON.stringify(report, null, 2));
const output = process.argv[2];
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
// CI records the result. The target becomes a release gate after runner variance is assessed.
