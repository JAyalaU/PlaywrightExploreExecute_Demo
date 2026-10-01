/**
 * P2-3D test-only child. It deliberately shares the production stdin/stdout
 * adapter, but replaces only the trusted model composition with deterministic
 * responses. It is not reachable from the production CLI or request envelope.
 */
import type { AuthoredStep } from '../domain/index.js';
import type { InterpretationModel, StepDecisionModel } from '../interpretation/index.js';
import type { LocalWorkflowOptions } from '../local/workflow.js';
import { runLocalWorkflow } from '../local/workflow.js';
import {
  readSubprocessTrustedConfiguration, runSubprocessAdapter, serializeSubprocessResponse,
} from './entry.js';
import { SUBPROCESS_PROTOCOL_VERSION } from './protocol.js';
import { connectEventChannel } from '../observability/event-channel.js';
import { connectImageChannel } from '../observability/image-channel.js';
import { ViewerLifecycle } from '../observability/viewer-channel.js';
import { editRefInIuvaretRow } from './test-harness-support.js';
import { installSubprocessCancellation } from './cancellation.js';

const rawStdout = process.stdout.write.bind(process.stdout);

function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}

// The same stdout-purity protection as the production child. Test models do
// not write diagnostics, and this entry is compiled but never a package script.
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;

function stepsFor(instruction: string): AuthoredStep[] | undefined {
  if (instruction === 'Ambiguous task.') return undefined;
  if (instruction === 'Wait forever.') return [];
  const target = /^Select (Save|Missing)\.$/m.exec(instruction)?.[1];
  const expectedUrl = /^Assert URL is (https?:\/\/\S+)$/m.exec(instruction)?.[1];
  if (!target || !expectedUrl) return undefined;
  return [
    { id: 's1', type: 'click', sourceText: `Select ${target}.`, target: { description: target } },
    { id: 's2', type: 'assert_url', sourceText: `Assert URL is ${expectedUrl}`,
      expectedUrl, match: 'exact' },
  ];
}

function accountMenuSteps(instruction: string): AuthoredStep[] | undefined {
  const expectedText = /^Assert the Selection status contains (Admin selected|Not selected)\.$/m.exec(instruction)?.[1];
  if (!/^Select Admin from the Account menu\.$/m.test(instruction) || !expectedText) return undefined;
  return [
    { id: 's1', type: 'click', sourceText: 'Select Admin from the Account menu.',
      target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Account menu' }] } },
    { id: 's2', type: 'assert_text', sourceText: `Assert the Selection status contains ${expectedText}.`,
      target: { description: 'Selection status' }, expectedText, match: 'contains' },
  ];
}

const REPLACEMENT_TASK = 'Go to https://the-internet.herokuapp.com/challenging_dom. In the table row containing Iuvaret1, select the edit link. Confirm that the URL is exactly https://the-internet.herokuapp.com/challenging_dom#edit.';

function replacementSteps(instruction: string): AuthoredStep[] | undefined {
  if (instruction !== REPLACEMENT_TASK) return undefined;
  return [
    { id: 's1', type: 'click', sourceText: 'In the table row containing Iuvaret1, select the edit link.',
      target: { description: 'edit', scope: [{ kind: 'row', description: 'Iuvaret1' }] } },
    { id: 's2', type: 'assert_url',
      sourceText: 'Confirm that the URL is exactly https://the-internet.herokuapp.com/challenging_dom#edit.',
      expectedUrl: 'https://the-internet.herokuapp.com/challenging_dom#edit', match: 'exact' },
  ];
}

function deterministicModels(): NonNullable<LocalWorkflowOptions['modelAdapters']> {
  const interpretationModel: InterpretationModel = {
    complete: async ({ userInstruction, signal }) => {
      if (userInstruction === 'Wait forever.') {
        return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      const steps = replacementSteps(userInstruction) ?? accountMenuSteps(userInstruction) ?? stepsFor(userInstruction);
      return JSON.stringify(steps
        ? { kind: 'test_spec', steps }
        : { kind: 'ambiguous', reason: 'Controlled test task is ambiguous.' });
    },
  };
  const stepDecisionModel: StepDecisionModel = {
    complete: async ({ context }) => {
      const target = 'target' in context.authoredStep ? context.authoredStep.target.description : undefined;
      if (!target) return JSON.stringify({ kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
      if (context.authoredStep.id === 's1' && target === 'Admin') {
        const admin = /menuitem "Admin" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
        if (admin) return JSON.stringify({ kind: 'target', ref: admin, element: 'Admin menuitem' });
        const menu = /button "Account menu" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
        return JSON.stringify(menu
          ? { kind: 'prerequisite', ref: menu, element: 'Account menu button',
            reason: 'Open Account menu', action: 'click' }
          : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
      }
      if (context.authoredStep.id === 's2' && target === 'Selection status') {
        const status = /status "Selection status" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
        return JSON.stringify(status
          ? { kind: 'target', ref: status, element: 'Selection status' }
          : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
      }
      if (context.authoredStep.id === 's1' && target === 'edit' &&
          context.authoredStep.type === 'click' &&
          context.authoredStep.target.scope?.some((scope) => scope.kind === 'row' && scope.description === 'Iuvaret1')) {
        const edit = editRefInIuvaretRow(context.snapshot);
        return JSON.stringify(edit
          ? { kind: 'target', ref: edit, element: 'edit link in the Iuvaret1 row' }
          : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
      }
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ref = new RegExp(`button "${escaped}" \\[ref=(e\\d+)\\]`).exec(context.snapshot)?.[1];
      return JSON.stringify(ref
        ? { kind: 'target', ref, element: `${target} button` }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
    },
  };
  return { interpretationModel, stepDecisionModel };
}

const testWorkflow: typeof runLocalWorkflow = async (request, configuration, dependencies, options = {}) =>
  runLocalWorkflow(request, configuration, dependencies, {
    ...options,
    modelAdapters: deterministicModels(),
  });

const controller = new AbortController();
const removeCancellationHandlers = installSubprocessCancellation(controller);
let closeEventChannel: (() => void) | undefined;
let closeImageChannel: (() => void) | undefined;
let closeViewerChannel: (() => void) | undefined;

try {
  let eventChannel;
  try { eventChannel = await connectEventChannel(); } catch {
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    eventChannel = null;
  }
  closeEventChannel = eventChannel?.close;
  if (eventChannel !== null) {
  let imageChannel;
  try { imageChannel = await connectImageChannel(eventChannel?.producer.streamId); } catch {
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    imageChannel = null;
  }
  closeImageChannel = imageChannel?.close;
  if (imageChannel !== null) {
  let viewerChannel;
  try { viewerChannel = await ViewerLifecycle.connect(eventChannel?.producer); } catch {
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    viewerChannel = null;
  }
  closeViewerChannel = viewerChannel?.close.bind(viewerChannel);
  if (viewerChannel !== null) {
  const args = process.argv.slice(2);
  const configPath = args.length === 2 && args[0] === '--config' && args[1] ? args[1] : undefined;
  const response = configPath
    ? await runSubprocessAdapter(process.stdin, () => readSubprocessTrustedConfiguration(configPath),
      { provider: { apiKey: () => undefined } }, { signal: controller.signal, workflow: testWorkflow,
        ...(eventChannel ? { events: eventChannel.producer } : {}),
        ...(imageChannel ? { images: imageChannel } : {}),
        ...(viewerChannel ? { viewer: viewerChannel } : {}) })
    : { protocolVersion: SUBPROCESS_PROTOCOL_VERSION, kind: 'bridge_error' as const,
      code: 'INVALID_TRUSTED_CONFIGURATION' as const, cleanup: 'not_started' as const };
  const wire = serializeSubprocessResponse(response);
  await eventChannel?.flush();
  await new Promise<void>((resolve, reject) => rawStdout(wire.body, (error) => error ? reject(error) : resolve()));
  process.exitCode = wire.exitCode;
  eventChannel?.close();
  imageChannel?.close();
  viewerChannel?.close();
  }
  }
  }
} catch {
  process.exitCode = 64;
} finally {
  closeEventChannel?.();
  closeImageChannel?.();
  closeViewerChannel?.();
  removeCancellationHandlers();
}
