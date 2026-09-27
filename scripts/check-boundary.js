import { readFile, readdir } from 'node:fs/promises';

const files = await readdir(new URL('../src/kernel/', import.meta.url));
const forbidden = [
  /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]/, // no module dependencies
  /\bimport\s*\(/, /\brequire\s*\(/,
  /\b(?:process|globalThis|fetch|XMLHttpRequest|WebSocket|navigator|window|document)\b/,
  /\b(?:setTimeout|setInterval|queueMicrotask|performance|crypto)\b/,
  /\bDate\s*\.\s*now\s*\(/, /\bnew\s+Date\s*\(\s*\)/,
  /\bMath\s*\.\s*random\s*\(/
];
for (const file of files) {
  if (!file.endsWith('.js')) continue;
  const source = await readFile(new URL(`../src/kernel/${file}`, import.meta.url), 'utf8');
  // Ignore comments to keep the check focused on executable code.
  const executable = source.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm, '');
  for (const expression of forbidden) {
    if (expression.test(executable)) throw new Error(`${file}: forbidden kernel dependency or ambient API: ${expression}`);
  }
}
console.log('Kernel import and ambient-state boundary: OK');
