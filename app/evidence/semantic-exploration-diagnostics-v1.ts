import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SemanticExplorationDiagnosticV1Schema,
  type SemanticExplorationDiagnosticV1 } from '../domain/semantic-exploration-diagnostics-v1.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const namespace = 'semantic-exploration-diagnostics-v1';
const envelope = z.strictObject({ data: SemanticExplorationDiagnosticV1Schema,
  authentication: z.string().regex(/^[a-f0-9]{64}$/) });
const maxAttempts = 64;

/** Restricted, authenticated attempt snapshots. Readback has no artifact or QA authority. */
export class SemanticExplorationDiagnosticsV1Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(create: boolean): Promise<string> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Diagnostic root symlink');
    const directory = path.join(this.#root, namespace);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const item of [this.#root, directory]) {
      const info = await lstat(item);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid diagnostic directory');
    }
    return directory;
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(true);
      const file = path.join(this.#root, '.semantic-exploration-v1-authority');
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error('Invalid diagnostic authority');
      return readFile(file);
    })();
    return this.#key;
  }
  async write(record: SemanticExplorationDiagnosticV1): Promise<void> {
    const data = SemanticExplorationDiagnosticV1Schema.parse(record);
    const directory = await this.#directory(true);
    const file = path.join(directory, `${id.parse(data.explorationAttemptId)}.json`);
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const pending = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(pending, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(pending, file); } finally { await unlink(pending).catch(() => {}); }
    await this.#prune(directory);
  }
  async #prune(directory: string): Promise<void> {
    const names = (await readdir(directory)).filter(name => /^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name));
    if (names.length <= maxAttempts) return;
    const ordered = await Promise.all(names.map(async name => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
    ordered.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
    for (const item of ordered.slice(0, ordered.length - maxAttempts)) {
      const file = path.join(directory, item.name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostic file');
      await unlink(file);
    }
  }
  async #read(file: string): Promise<SemanticExplorationDiagnosticV1> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Invalid diagnostic file');
    const parsed = envelope.parse(JSON.parse((await readFile(file)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(parsed.data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(parsed.authentication, 'hex')))
      throw new Error('INVALID_SEMANTIC_EXPLORATION_DIAGNOSTIC_AUTHENTICATION');
    return parsed.data;
  }
  async readByCorrelation(query: { explorationAttemptId?: string; testSpecId?: string }):
    Promise<SemanticExplorationDiagnosticV1[]> {
    if (!query.explorationAttemptId && !query.testSpecId) throw new Error('Diagnostic correlation required');
    if (query.explorationAttemptId) id.parse(query.explorationAttemptId);
    if (query.testSpecId) id.parse(query.testSpecId);
    const directory = await this.#directory(false);
    const names = query.explorationAttemptId ? [`${query.explorationAttemptId}.json`] :
      (await readdir(directory)).filter(name => /^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name));
    const records: SemanticExplorationDiagnosticV1[] = [];
    for (const name of names) {
      const record = await this.#read(path.join(directory, name));
      if (query.explorationAttemptId && record.explorationAttemptId !== query.explorationAttemptId ||
          query.testSpecId && record.testSpecId !== query.testSpecId) continue;
      records.push(record);
    }
    return records;
  }
}
