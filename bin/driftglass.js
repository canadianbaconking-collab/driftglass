#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluate, passesAutomation } from '../src/kernel/index.js';

if (process.argv.length !== 5 || process.argv[2] !== 'evaluate') {
  console.error('Usage: driftglass evaluate <policy.json> <event.json>');
  process.exitCode = 1;
} else {
  try {
    const [policy, event] = await Promise.all(process.argv.slice(3).map(async (path) =>
      JSON.parse(await readFile(path, 'utf8'))));
    const result = evaluate(policy, event);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = passesAutomation(result) ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
