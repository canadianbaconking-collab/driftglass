import { readFile, readdir } from 'node:fs/promises';

const forbidden = [
  /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]/, // no module dependencies
  /\bimport\s*\(/, /\brequire\s*\(/,
  /\b(?:process|globalThis|fetch|XMLHttpRequest|WebSocket|navigator|window|document)\b/,
  /\b(?:setTimeout|setInterval|queueMicrotask|performance|crypto)\b/,
  /\bDate\s*\.\s*now\s*\(/, /\bnew\s+Date\s*\(\s*\)/,
  /\bMath\s*\.\s*random\s*\(/
];
for (const directory of ['kernel', 'replay']) {
  const files = await readdir(new URL(`../src/${directory}/`, import.meta.url));
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(new URL(`../src/${directory}/${file}`, import.meta.url), 'utf8');
    // The replay layer may depend on the kernel, but neither may import I/O.
    const withoutAllowedImport = directory === 'replay' ? source.replace(
      /^import\s+[^\n]+\s+from\s+['"]\.\.\/kernel\/index\.js['"];?\s*$/gm, '') : source;
    const executable = withoutAllowedImport.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm, '');
    for (const expression of forbidden) {
      if (expression.test(executable)) throw new Error(`${directory}/${file}: forbidden dependency or ambient API: ${expression}`);
    }
  }
}
console.log('Kernel and replay import/ambient-state boundaries: OK');
