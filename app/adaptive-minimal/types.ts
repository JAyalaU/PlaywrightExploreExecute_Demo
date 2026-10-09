import { z } from 'zod';
import type { ObservationV1 } from '../adaptive/contracts.js';

const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element_ref'), ref: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('role_name'), role: z.string().min(1).max(100),
    name: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('visual_coordinate'), x: z.number().finite(),
    y: z.number().finite(), description: z.string().min(1).max(300) }),
]);
const observed = { observationId: z.string().min(1).max(128) };
const act = { kind: z.literal('act'), ...observed, target };
const option = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('label'), label: z.string().min(1).max(1_024) }),
  z.strictObject({ kind: z.literal('value'), value: z.string().max(1_024) }),
]);
const expectedDialog = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('alert'), response: z.literal('accept') }),
  z.strictObject({ kind: z.literal('confirm'), response: z.enum(['accept', 'dismiss']) }),
  z.strictObject({ kind: z.literal('prompt'), response: z.enum(['accept', 'dismiss']),
    text: z.string().max(1_024).optional() }),
]);
export type ExpectedDialog = z.infer<typeof expectedDialog>;
export interface DialogEvidence {
  kind: ExpectedDialog['kind'];
  response: 'accept' | 'dismiss';
}
export const ChoiceSchema = z.union([
  z.strictObject({ kind: z.literal('observe'), modality: z.enum(['accessibility', 'dom', 'screenshot']) }),
  z.discriminatedUnion('operation', [
    z.strictObject({ ...act, operation: z.literal('click'), dialog: expectedDialog.optional(),
      popup: z.literal('expect').optional() }),
    z.strictObject({ ...act, operation: z.literal('check') }),
    z.strictObject({ ...act, operation: z.literal('uncheck') }),
    z.strictObject({ ...act, operation: z.literal('hover') }),
    z.strictObject({ ...act, operation: z.literal('fill'), value: z.string().max(1_024) }),
    z.strictObject({ ...act, operation: z.literal('select_option'), option }),
    z.strictObject({ ...act, operation: z.literal('set_range'), value: z.number().finite() }),
  ]),
  z.strictObject({ kind: z.literal('press'), ...observed,
    key: z.enum(['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp',
      'ArrowLeft', 'ArrowRight', 'Space']),
    target: target.optional() }),
  z.strictObject({ kind: z.literal('navigate'), ...observed,
    url: z.url().max(4096) }),
  z.strictObject({ kind: z.literal('select_page'), ...observed,
    pageId: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('done'), reason: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('stuck'), reason: z.string().min(1).max(500) }),
]);
export type Choice = z.infer<typeof ChoiceSchema>;
export type BrowserAction = Extract<Choice, { kind: 'act' | 'navigate' | 'press' | 'select_page' }>;
type FillAction = Extract<BrowserAction, { kind: 'act'; operation: 'fill' }>;
export type RecordedAction = Exclude<BrowserAction, FillAction> |
  (Omit<FillAction, 'value'> & { valueRedacted: true });

export interface MinimalTask {
  instruction: string;
  startUrl: string;
  allowedOrigins: readonly string[];
  resetRef: string;
  maxModelTurns: number;
  maxActions: number;
  maxScreenshots: number;
  maxElapsedMs: number;
}
export interface ResetProof {
  freshBrowserContext: boolean;
  applicationStateVerified: boolean;
  /** Public pages can only prove a fresh context and navigation, not server-side reset. */
  kind?: 'application_reset' | 'fresh_navigation';
  initialNavigationVerified?: boolean;
  resetRef?: string;
  evidenceRef?: string;
}
export interface Receipt {
  id: string;
  action: RecordedAction;
  targetDescription: string;
  beforeId: string;
  afterId?: string;
  delivery: 'returned' | 'failed';
  observedChange?: string;
  dialog?: DialogEvidence;
  popup?: { pageId: string; url: string };
  error?: string;
  /** Optional browser diagnostic; the OpenAI adapter excludes it from model payloads. */
  diagnostic?: {
    capturedAt: string;
    currentUrl: string;
    mainFrameNavigations: number;
    documentLoads: number;
    bodyAttached?: boolean;
    documentReadyState?: string;
    ariaSnapshotTimedOut: boolean;
  };
}
export interface Attempt {
  resetProof: ResetProof;
  observations: ObservationV1[];
  receipts: Receipt[];
  stopReason: 'done' | 'stuck' | 'budget' | 'no_progress' | 'error';
  stopDetail?: string;
}
export interface ModelTurn {
  instruction: string;
  phase: 'discovery' | 'clean';
  workflow?: string;
  observation: ObservationV1;
  pages: readonly { pageId: string; url: string; selected: boolean }[];
  screenshotDataUrl?: string;
  recentReceipts: readonly Receipt[];
  remaining: { modelTurns: number; actions: number; screenshots: number; elapsedMs: number };
  signal?: AbortSignal;
}
export const VerdictSchema = z.strictObject({
  outcome: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  explanation: z.string().min(1).max(1200),
  evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(20),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export interface EvaluationInput {
  instruction: string;
  observations: readonly ObservationV1[];
  receipts: readonly Receipt[];
  finalObservation: ObservationV1;
  /** Private in-memory clean screenshots; omitted from the returned report. */
  screenshots?: readonly { observationId: string; dataUrl: string }[];
  signal?: AbortSignal;
}
export interface MinimalModel {
  choose(input: ModelTurn): Promise<Choice>;
  evaluate(input: EvaluationInput): Promise<Verdict>;
}
export interface MinimalResult {
  outcome: Verdict['outcome'];
  explanation: string;
  evidenceIds: string[];
  workflow: string;
  discovery: Attempt;
  clean?: Attempt;
}
