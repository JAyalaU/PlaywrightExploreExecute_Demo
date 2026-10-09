import { z } from 'zod';
import type { ObservationV1 } from '../adaptive/contracts.js';

const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element_ref'), ref: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('role_name'), role: z.string().min(1).max(100),
    name: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('visual_coordinate'), x: z.number().finite(),
    y: z.number().finite(), description: z.string().min(1).max(300) }),
]);
export const ChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observe'), modality: z.enum(['accessibility', 'dom', 'screenshot']) }),
  z.strictObject({ kind: z.literal('act'), observationId: z.string().min(1).max(128),
    operation: z.enum(['click', 'check', 'uncheck']), target }),
  z.strictObject({ kind: z.literal('navigate'), observationId: z.string().min(1).max(128),
    url: z.url().max(4096) }),
  z.strictObject({ kind: z.literal('done'), reason: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('stuck'), reason: z.string().min(1).max(500) }),
]);
export type Choice = z.infer<typeof ChoiceSchema>;
export type BrowserAction = Extract<Choice, { kind: 'act' | 'navigate' }>;

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
  action: BrowserAction;
  targetDescription: string;
  beforeId: string;
  afterId?: string;
  delivery: 'returned' | 'failed';
  observedChange?: string;
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
