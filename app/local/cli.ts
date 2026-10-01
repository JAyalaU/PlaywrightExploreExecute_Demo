import { runLocalCommand } from './command.js';
import { loadProjectEnv } from './project-env.js';

loadProjectEnv();

const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.once('SIGINT', interrupt);
try {
  process.exitCode = await runLocalCommand(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener('SIGINT', interrupt);
}
