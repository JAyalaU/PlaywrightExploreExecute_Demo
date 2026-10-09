/** Paths and authenticated-artifact input checks for opt-in experiments only. */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function importProduct(relativeModule) {
  if (!/^[a-z0-9/-]+\.js$/.test(relativeModule) || relativeModule.includes('..')) {
    throw new Error('INVALID_EXPERIMENT_PRODUCT_IMPORT');
  }
  return import(pathToFileURL(path.join(repoRoot, 'dist', relativeModule)).href);
}

/** An experiment must name an existing complete store artifact, never a report projection. */
export async function requiredStoreArtifact(variable, namespace) {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable}_REQUIRED`);
  const file = path.resolve(value);
  if (path.extname(file) !== '.json' || path.basename(path.dirname(path.dirname(file))) !== namespace) {
    throw new Error(`${variable}_INVALID_STORE_PATH`);
  }
  await access(file);
  return {
    file,
    root: path.dirname(path.dirname(path.dirname(file))),
    testSpecId: path.basename(path.dirname(file)),
    attemptId: path.basename(file, '.json'),
  };
}
