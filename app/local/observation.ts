import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { LocalArtifactStore } from '../evidence/index.js';
import type { ProtectedBrowserSession, ProtectedSessionOptions } from '../profile/index.js';
import { profilePresentationMode } from '../profile/index.js';
import {
  ObservationJournal, type ObservationEvent, type ObservationCorrelation,
} from './contracts.js';

type Owner = NonNullable<ProtectedSessionOptions['observationOwner']>;
type Category = ObservationEvent['inputCategory'];
const categories = new Set<Category>(['pointer', 'keyboard', 'touch', 'wheel']);

/** Records only event categories and correlation; no page values or event payloads cross the binding. */
export class LocalObservationRecorder {
  readonly #events: ObservationEvent[] = [];
  readonly #writes: Promise<void>[] = [];
  readonly #errors: unknown[] = [];
  readonly #store: LocalArtifactStore;
  readonly #testSpecId: string;

  constructor(store: LocalArtifactStore, testSpecId: string) {
    this.#store = store;
    this.#testSpecId = testSpecId;
  }

  async attach(session: ProtectedBrowserSession, owner: Owner): Promise<void> {
    if (profilePresentationMode(session.effectiveProfile.profile) !== 'headed') return;
    const correlation: ObservationCorrelation = {
      testSpecId: this.#testSpecId, owner,
      executionProfileRef: { id: session.effectiveProfile.profile.id, version: session.effectiveProfile.profile.version },
      profileFingerprint: session.effectiveProfile.fingerprint,
    };
    const journal = new ObservationJournal(correlation, 'headed');
    const bindingName = `__qa_input_${randomUUID().replaceAll('-', '')}`;
    let observed = 0;
    const onInput = (category: string): void => {
      if (!categories.has(category as Category)) return;
      // Page scripts can invoke a binding. Limit their ability to create records.
      // Headed provenance remains unverified regardless of coverage.
      if (observed >= 512) return;
      observed += 1;
      const event = journal.append({
        ...correlation, eventId: `input-${randomUUID()}`, occurredAt: new Date().toISOString(),
        inputCategory: category as Category, attribution: 'uncertain',
        interventionReason: 'UNCERTAIN_ORIGIN',
      });
      this.#events.push(event);
      const write = this.#store.writeEvidence(this.#testSpecId, {
        evidenceId: event.eventId, owner, mediaType: 'application/json', content: event,
      }).then(() => undefined).catch((error: unknown) => { this.#errors.push(error); });
      this.#writes.push(write);
    };
    const context: BrowserContext = session.context;
    await context.exposeBinding(bindingName, (_source, category: unknown) => {
      if (typeof category === 'string') onInput(category);
    });
    await context.addInitScript(({ name }) => {
      const emit = (category: string): void => {
        const binding = (window as unknown as Record<string, (value: string) => Promise<unknown>>)[name];
        if (typeof binding === 'function') void binding(category).catch(() => undefined);
      };
      window.addEventListener('pointerdown', () => emit('pointer'), true);
      window.addEventListener('keydown', () => emit('keyboard'), true);
      window.addEventListener('touchstart', () => emit('touch'), true);
      window.addEventListener('wheel', () => emit('wheel'), true);
    }, { name: bindingName });
  }

  /** Wait for append-only evidence writes before returning a local outcome. */
  async flush(): Promise<void> {
    await Promise.all(this.#writes);
    if (this.#errors.length) throw new AggregateError(this.#errors, 'Input observation evidence failed');
  }

  eventIds(): string[] { return this.#events.map((event) => event.eventId); }
}
