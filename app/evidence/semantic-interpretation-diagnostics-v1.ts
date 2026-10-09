import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SemanticNormalizationDiagnosticV3 } from '../interpretation/semantic-intent-v3.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const diagnostic = z.strictObject({
  phase: z.enum(['source', 'wire', 'spec_schema', 'spec_cross_step',
    'relation_canonicalization', 'admission']),
  predicate: z.enum(['SCHEMA_TYPE_MISMATCH', 'INVALID_STEP_SHAPE', 'UNSUPPORTED_ACTION_KIND',
    'UNSUPPORTED_VERIFICATION_KIND', 'MISSING_TARGET', 'INVALID_RELATION_COMBINATION',
    'INVALID_ORDINAL_RELATION_COMBINATION', 'INVALID_RELATION_REFERENCE',
    'CLAUSE_OWNERSHIP_UNRESOLVED', 'INVALID_CARDINALITY_VALUE', 'INVALID_STEP_DEPENDENCY',
    'MALFORMED_REPETITION_EXPANSION', 'CONTRADICTORY_TARGET_CONSTRAINTS',
    'DUPLICATE_STEP_ID', 'INVALID_TARGET_RELATION', 'CONFLICTING_TARGET_IDENTITY',
    'INVALID_ACTION_EFFECT_ARGUMENT', 'INVALID_VERIFICATION_PREDICATE',
    'TRUSTED_SOURCE_MISMATCH', 'OTHER_CLOSED_NORMALIZATION_VIOLATION']),
  stepIndex: z.number().int().min(0).max(99).nullable(),
  fieldFamily: z.enum(['source', 'wire', 'step_shape', 'step_identity', 'dependency', 'target',
    'relation', 'ordinal', 'action_argument', 'verification_value', 'admission']),
});
const data = z.strictObject({ recordVersion: z.literal('semantic_interpretation_diagnostic_v1'),
  workflowVersion: z.literal('semantic-general-v1'), testSpecId: id,
  publicCode: z.literal('INVALID_SOURCE_REPRESENTATION'),
  recordedAt: z.iso.datetime(), diagnostic });
const envelope = z.strictObject({ data, authentication: digest });
const namespace = 'semantic-interpretation-diagnostics-v1';
const maxRecords = 64;
export type SemanticInterpretationDiagnosticReadbackV1 = z.infer<typeof data>;

/** Private, bounded, authenticated interpretation rejection. No provider payload or QA authority. */
export class SemanticInterpretationDiagnosticsV1Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(create: boolean): Promise<string> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Diagnostic root symlink');
    const directory = path.join(this.#root, namespace);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of [this.#root, directory]) {
      const info = await lstat(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid diagnostic directory');
    }
    return directory;
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(true);
      const file = path.join(this.#root, '.semantic-interpretation-v1-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error('Invalid diagnostic authority');
      return readFile(file);
    })();
    return this.#key;
  }
  async write(testSpecId: string, value: SemanticNormalizationDiagnosticV3): Promise<void> {
    const record = data.parse({ recordVersion: 'semantic_interpretation_diagnostic_v1',
      workflowVersion: 'semantic-general-v1', testSpecId, publicCode: 'INVALID_SOURCE_REPRESENTATION',
      recordedAt: new Date().toISOString(), diagnostic: value });
    const directory = await this.#directory(true);
    const file = path.join(directory, `${record.testSpecId}.json`);
    const authentication = createHmac('sha256', await this.#authority())
      .update(JSON.stringify(record)).digest('hex');
    const temp = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ data: record, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, file); } finally { await unlink(temp); }
    await this.#prune(directory);
  }
  async #prune(directory: string): Promise<void> {
    const names = (await readdir(directory)).filter(name => /^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name));
    if (names.length <= maxRecords) return;
    const ordered = await Promise.all(names.map(async name => ({ name,
      modified: (await stat(path.join(directory, name))).mtimeMs })));
    ordered.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
    for (const item of ordered.slice(0, ordered.length - maxRecords)) {
      const file = path.join(directory, item.name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostic file');
      await unlink(file);
    }
  }
  async readByCorrelation(query: { testSpecId: string }): Promise<SemanticInterpretationDiagnosticReadbackV1[]> {
    const testSpecId = id.parse(query.testSpecId);
    const file = path.join(await this.#directory(false), `${testSpecId}.json`);
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error('Invalid interpretation diagnostic file');
    const parsed = envelope.parse(JSON.parse((await readFile(file)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(parsed.data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(parsed.authentication, 'hex')))
      throw new Error('INVALID_SEMANTIC_INTERPRETATION_DIAGNOSTIC_AUTHENTICATION');
    if (parsed.data.testSpecId !== testSpecId) throw new Error('Interpretation diagnostic correlation mismatch');
    return [parsed.data];
  }
}
