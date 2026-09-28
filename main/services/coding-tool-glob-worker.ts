/**
 * Traversal rules adapted from Node.js internal/fs/glob.js (MIT); see
 * THIRD_PARTY_NOTICES.md. Fixed worker code using Minimatch's parsed segments with Node fs.glob options.
 * Traversal tracks segment positions (including positions reached through links)
 * rather than matching a flattened pathname. Filesystem access stays on the host.
 */
export const CODING_GLOB_WORKER_SOURCE = `
const { join, isAbsolute, parse } = require('node:path');
const { Minimatch, GLOBSTAR } = require(workerData.minimatchPath);
const matcher = new Minimatch(workerData.pattern, {
  nocase: process.platform === 'win32' || process.platform === 'darwin',
  windowsPathsNoEscape: true, nonegate: true, nocomment: true,
  optimizationLevel: 2, platform: process.platform, nocaseMagicOnly: true,
});
if (matcher.set.length > 1000) throw new Error('Glob expands to too many alternatives.');
const seen = new Set();
const seeds = matcher.set.map((parts, pattern) => {
  // Brace expansion may mix roots; never infer an arm's root from the whole pattern.
  const expanded = matcher.globParts[pattern].join('/');
  const root = isAbsolute(expanded) ? parse(expanded).root : '';
  let current = root || '.';
  let index = root ? root.split('/').length - 1 : 0;
  // Resolve literal prefixes only. A globstar followed by .. is never collapsed.
  while (index < parts.length - 1 && typeof parts[index] === 'string') {
    current = join(current, parts[index++]);
  }
  if (index === 0 && parts[0] === '.') index++;
  return { path: current, pattern, indexes: [index], symlinks: [] };
});
function globStep({ task, entries, directory }) {
  const parts = matcher.set[task.pattern];
  const last = parts.length - 1;
  const indexes = task.indexes.filter(index => index <= last);
  const links = new Set(task.symlinks);
  const isDirectory = directory && indexes.some(index => !links.has(index));
  const isLast = indexes.includes(last) ||
    (parts[last] === '' && isDirectory && parts[last - 1] === GLOBSTAR && indexes.includes(last - 1));
  const matches = [];
  const tasks = [];
  const add = (path, positions, symlinks = []) => {
    if (positions.length) tasks.push({ path, pattern: task.pattern, indexes: positions, symlinks });
  };
  const test = (index, name) => {
    const token = parts[index];
    return token === GLOBSTAR || (typeof token === 'string' ? token === name : !!token?.test(name));
  };
  if (!entries) {
    const fresh = indexes.filter(index => !seen.has(JSON.stringify([task.pattern, task.path, index])));
    if (!fresh.length) return { matches, tasks, done: true };
    for (const index of fresh) seen.add(JSON.stringify([task.pattern, task.path, index]));
    if (isLast && typeof parts[last] === 'string') {
      if (parts[last] || isDirectory) matches.push(join(task.path, parts[last]));
      if (indexes.length === 1 && indexes[0] === last) return { matches, tasks, done: true };
    } else if (isLast && parts[last] === GLOBSTAR &&
      (task.path !== '.' || parts[0] === '.' || last === 0)) matches.push(task.path);
    if (!isDirectory) return { matches, tasks, done: true };
    const token = indexes.length === 1 ? parts[indexes[0]] : null;
    return { matches, tasks, literal: typeof token === 'string' ? token : undefined };
  }
  for (const entry of entries) {
    const child = join(task.path, entry.name);
    const positions = new Set();
    const symlinks = new Set();
    for (const index of indexes) {
      const token = parts[index];
      const next = index + 1;
      if (token === GLOBSTAR) {
        let afterStars = next;
        while (parts[afterStars] === GLOBSTAR) afterStars++;
        if (entry.name.startsWith('.') && !test(afterStars, entry.name)) continue;
        const viaLink = links.has(index);
        if (!viaLink && entry.directory) positions.add(index);
        else if (!viaLink && index === last) matches.push(child);
        const nextMatches = test(next, entry.name);
        if (nextMatches && next === last && !isLast) matches.push(child);
        else if (nextMatches && entry.directory) positions.add(index + 2);
        if ((nextMatches || parts[0] === '.') && (entry.directory || entry.link) && !viaLink) positions.add(next);
        if (entry.link) symlinks.add(index);
        if (parts[next] === '..' && entry.directory) {
          if (next === last) matches.push(task.path, join(task.path, '..'));
          else { add(task.path, [next + 1]); add(join(task.path, '..'), [next + 1]); }
        }
      } else if (typeof token === 'string') {
        if (test(index, entry.name) && index !== last) positions.add(next);
        else if (token === '.' && test(next, entry.name)) {
          if (next === last) matches.push(child); else positions.add(next + 1);
        }
      } else if (test(index, entry.name)) {
        if (index === last) matches.push(child);
        else if (entry.directory) positions.add(next);
      }
    }
    add(child, [...positions], [...symlinks]);
  }
  return { matches, tasks };
}
`;

export interface CodingGlobTask {
  path: string;
  pattern: number;
  indexes: number[];
  symlinks: number[];
}

export interface CodingGlobRequest {
  task: CodingGlobTask;
  directory: boolean;
  entries?: { name: string; directory: boolean; link: boolean }[];
}

export interface CodingGlobReply {
  matches: string[];
  tasks: CodingGlobTask[];
  done?: boolean;
  literal?: string;
}
