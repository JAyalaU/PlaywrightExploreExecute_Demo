import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionProfileRefSchema } from '../domain/schema.js';
import { ProfileCatalog, profilePresentationMode, type PresentationMode } from '../profile/index.js';
import {
  LocalWorkflowRequestSchema, parseTrustedLocalConfiguration,
  type LocalWorkflowOutcome,
} from './contracts.js';
import { LocalWorkflowError, runLocalWorkflow } from './workflow.js';

const MAX_CONFIG_BYTES = 1_048_576;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,99}$/;

export const LOCAL_COMMAND_USAGE = [
  'Usage: npm run local -- --config <trusted.json> --profile <id@version> --url <http(s) URL> --task <text> [--mode headed|headless]',
  'The selected trusted profile owns presentation mode and network policy. OPENAI_API_KEY is read from the environment.',
].join('\n');

export const LOCAL_COMMAND_EXIT = {
  success: 0,
  qaFailure: 1,
  automationStop: 2,
  misuse: 64,
  cancelled: 130,
} as const;

type Workflow = typeof runLocalWorkflow;

export interface LocalCommandOptions {
  workflow?: Workflow;
  apiKey?: () => string | undefined;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  signal?: AbortSignal;
}

class CommandMisuse extends Error {}

type ParsedArgs = {
  config: string;
  profile: string;
  url: string;
  task: string;
  mode?: PresentationMode;
};

function parseArgs(args: readonly string[]): ParsedArgs | 'help' {
  if (args.length === 1 && args[0] === '--help') return 'help';
  const values = new Map<string, string>();
  const allowed = new Set(['--config', '--profile', '--url', '--task', '--mode']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith('--')) {
      throw new CommandMisuse();
    }
    values.set(flag, value);
  }
  for (const flag of ['--config', '--profile', '--url', '--task']) {
    if (!values.has(flag)) throw new CommandMisuse();
  }
  const mode = values.get('--mode');
  if (mode !== undefined && mode !== 'headed' && mode !== 'headless') throw new CommandMisuse();
  return {
    config: values.get('--config')!, profile: values.get('--profile')!,
    url: values.get('--url')!, task: values.get('--task')!,
    ...(mode ? { mode } : {}),
  };
}

function profileRef(value: string) {
  const separator = value.lastIndexOf('@');
  if (separator < 1) throw new CommandMisuse();
  const result = ExecutionProfileRefSchema.safeParse({
    id: value.slice(0, separator), version: value.slice(separator + 1),
  });
  if (!result.success) throw new CommandMisuse();
  return result.data;
}

async function readTrustedConfig(file: string) {
  try {
    const details = await stat(file);
    if (!details.isFile() || details.size > MAX_CONFIG_BYTES) throw new Error('Invalid configuration file');
    const content = await readFile(file);
    if (content.byteLength > MAX_CONFIG_BYTES) throw new Error('Configuration too large');
    return parseTrustedLocalConfiguration(JSON.parse(content.toString('utf8')) as unknown);
  } catch {
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  }
}

function safeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return SAFE_REASON.test(reason) ? reason : 'REDACTED_REASON';
}

/** Summarize typed results without printing task text, URLs, page text, or evidence bytes. */
export function summarizeLocalOutcome(outcome: LocalWorkflowOutcome): { lines: string[]; exitCode: number } {
  const lines = [
    `testSpecId=${outcome.testSpecId}`,
    `profile=${outcome.executionProfileRef.id}@${outcome.executionProfileRef.version}`,
    `presentationMode=${outcome.presentationMode}`,
    `provenance=${outcome.observation.state}${outcome.observation.state === 'observational' ? ':unverified' : ''}`,
    `autonomousEligible=${outcome.observation.autonomousEligible}`,
    `detectedInput=${outcome.observation.eventIds.length ? 'detected' : 'none_detected'}`,
  ];
  let exitCode: number;
  if (outcome.handoff.kind === 'stopped') {
    lines.push(`terminalPhase=${outcome.handoff.result.phase}`);
    lines.push(`terminalStatus=${outcome.handoff.result.status}`);
    const reason = safeReason(outcome.handoff.result.reason);
    if (reason) lines.push(`reason=${reason}`);
    if (outcome.handoff.attemptId) lines.push(`explorationAttemptId=${outcome.handoff.attemptId}`);
    exitCode = outcome.handoff.result.status === 'QA_ASSERTION_FAILED'
      ? LOCAL_COMMAND_EXIT.qaFailure : LOCAL_COMMAND_EXIT.automationStop;
  } else {
    lines.push(`explorationAttemptId=${outcome.handoff.attemptId}`);
    lines.push(`resolvedSpecId=${outcome.handoff.resolvedSpecId}`);
    const results = outcome.handoff.replay.map((run, index) => {
      const terminal = run.outcomes.find((result) =>
        result.status !== 'OPERATION_SUCCEEDED' && result.status !== 'QA_ASSERTION_PASSED')
        ?? run.outcomes.at(-1);
      lines.push(`run${index + 1}Id=${run.executionRunId}`);
      lines.push(`run${index + 1}Status=${terminal?.status ?? 'TEST_BUILD_FAILED'}`);
      return terminal;
    });
    const failure = results.find((result) => result?.status !== 'QA_ASSERTION_PASSED' &&
      result?.status !== 'OPERATION_SUCCEEDED' && result?.status !== 'QA_ASSERTION_FAILED');
    const qaFailure = results.find((result) => result?.status === 'QA_ASSERTION_FAILED');
    const terminal = failure ?? qaFailure ?? results.at(-1);
    lines.push('terminalPhase=execution');
    lines.push(`terminalStatus=${terminal?.status ?? 'TEST_BUILD_FAILED'}`);
    const reason = safeReason(terminal?.reason);
    if (reason) lines.push(`reason=${reason}`);
    exitCode = failure ? LOCAL_COMMAND_EXIT.automationStop
      : qaFailure ? LOCAL_COMMAND_EXIT.qaFailure
      : results.every((result) => result &&
        (result.status === 'OPERATION_SUCCEEDED' || result.status === 'QA_ASSERTION_PASSED'))
        ? LOCAL_COMMAND_EXIT.success : LOCAL_COMMAND_EXIT.automationStop;
  }
  lines.push(outcome.report.kind === 'available'
    ? `report=${JSON.stringify(path.join(outcome.report.artifactRoot, outcome.report.testSpecId))}`
    : 'report=unavailable');
  return { lines, exitCode };
}

/** Human-facing local entry point; the workflow retains all model and browser authority. */
export async function runLocalCommand(args: readonly string[], options: LocalCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseArgs(args);
    if (parsed === 'help') { stdout(LOCAL_COMMAND_USAGE); return LOCAL_COMMAND_EXIT.success; }
    const reference = profileRef(parsed.profile);
    const request = LocalWorkflowRequestSchema.safeParse({
      targetUrl: parsed.url, taskText: parsed.task, executionProfileRef: reference,
    });
    if (!request.success) throw new CommandMisuse();
    const config = await readTrustedConfig(parsed.config);
    let mode: PresentationMode;
    try {
      const profile = new ProfileCatalog(config.profiles, config.networkPolicies).resolve(reference);
      mode = profilePresentationMode(profile.profile);
    } catch { throw new LocalWorkflowError('PROFILE_UNAVAILABLE'); }
    if (parsed.mode && parsed.mode !== mode) throw new CommandMisuse();
    const workflow = options.workflow ?? runLocalWorkflow;
    const outcome = await workflow(request.data, config, {
      provider: { apiKey: options.apiKey ?? (() => process.env.OPENAI_API_KEY) },
    }, options.signal ? { signal: options.signal } : {});
    const summary = summarizeLocalOutcome(outcome);
    for (const line of summary.lines) stdout(line);
    return summary.exitCode;
  } catch (error) {
    if (error instanceof CommandMisuse) {
      stderr(LOCAL_COMMAND_USAGE);
      return LOCAL_COMMAND_EXIT.misuse;
    }
    const code = error instanceof LocalWorkflowError ? error.code : 'WORKFLOW_FAILED';
    stderr(`terminalPhase=local_command`);
    stderr(`terminalStatus=${code}`);
    return code === 'CANCELLED' ? LOCAL_COMMAND_EXIT.cancelled : LOCAL_COMMAND_EXIT.automationStop;
  }
}
