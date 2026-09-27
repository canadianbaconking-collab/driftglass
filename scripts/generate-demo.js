import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const destination = process.argv[2];
if (!destination || process.argv.length !== 3) {
  console.error('Usage: node scripts/generate-demo.js <new-directory>');
  process.exitCode = 1;
} else {
  // A new directory is required so existing traces are never overwritten.
  await mkdir(destination);
  const inputs = await Promise.all(['2026-09-01/packing.json', '2026-09-02/exceptions.json']
    .map(async (path) => JSON.parse(await readFile(new URL(`../fixtures/bookshop/traces/${path}`, import.meta.url), 'utf8'))));
  const events = inputs.flatMap((trace) => trace.events);
  for (let day = 0; day < 10; day++) {
    const directory = join(destination, `day-${String(day + 1).padStart(2, '0')}`);
    await mkdir(directory);
    for (let run = 0; run < 20; run++) {
      const id = day * 20 + run;
      const trace = { schema_version: 1, events: Array.from({ length: 5 }, (_, index) =>
        events[(id * 5 + index) % events.length]) };
      await writeFile(join(directory, `run-${String(id + 1).padStart(3, '0')}.json`), JSON.stringify(trace, null, 2) + '\n');
    }
  }
  console.log(`Generated 200 synthetic bookshop traces in ${destination}`);
}
