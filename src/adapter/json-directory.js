import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Read only regular .json files. IDs are stable relative paths; symlinks are refused. */
export async function readTraceDirectory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Trace corpus contains symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
    }
  }
  await walk(root);
  files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (!files.length) throw new Error(`Trace corpus has no JSON files: ${root}`);
  return Promise.all(files.map(async (path) => {
    let input;
    try { input = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { throw new Error(`${path}: ${error.message}`); }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path}: expected trace object`);
    for (const key of Object.keys(input)) {
      if (!['schema_version', 'events'].includes(key)) throw new Error(`${path}: unknown trace field ${key}`);
    }
    return { id: relative(root, path).split(sep).join('/'), ...input };
  }));
}
