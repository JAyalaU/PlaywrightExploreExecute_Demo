import type { ResolvedTestSpecV8 } from '../domain/index.js';
import { LocalArtifactStore } from './store.js';

const mintAuthority = Symbol('accepted-v8-immutable-store-readback');

/** Runtime-authenticated handoff after immutable v5/v4/v3/v8 readback. */
export class AcceptedResolvedTestSpecV8 {
  #payload: Readonly<{ testSpecId: string; startState: Readonly<{ url: string }>;
    resolved: ResolvedTestSpecV8 }>;

  private constructor(authority: symbol, testSpecId: string, startUrl: string,
    resolved: ResolvedTestSpecV8) {
    if (authority !== mintAuthority) throw new Error('Only immutable-store readback can mint v8 replay input');
    // A copy removes aliases to the store's parsed objects. The private field
    // is the runtime capability; an object with this prototype cannot forge it.
    const accepted = structuredClone(resolved);
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(accepted);
    this.#payload = Object.freeze({ testSpecId,
      startState: Object.freeze({ url: startUrl }), resolved: accepted });
    Object.freeze(this);
  }

  /** Only the existing immutable store can validate and mint this runner input. */
  static async fromStore(store: LocalArtifactStore, testSpecId: string,
    explorationAttemptId: string, compilerAttemptId: string): Promise<AcceptedResolvedTestSpecV8> {
    if (Object.getPrototypeOf(store) !== LocalArtifactStore.prototype)
      throw new Error('V8 replay requires the reviewed immutable artifact store');
    const { source, profile } = await store.readJob(testSpecId);
    if (source.schemaVersion !== '5') throw new Error('V8 replay requires accepted TestSpec v5');
    const { compiler, resolved } = await store.readCompiledExplorationV8(testSpecId,
      explorationAttemptId, compilerAttemptId);
    if (compiler.result.status !== 'accepted' ||
      resolved.testSpecId !== source.testSpecId ||
      resolved.explorationAttemptId !== explorationAttemptId ||
      resolved.compilerAttemptId !== compilerAttemptId ||
      resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Accepted v8 replay provenance mismatch');
    return new AcceptedResolvedTestSpecV8(mintAuthority, source.testSpecId,
      source.startState.url, resolved);
  }

  /** Throws for a forged prototype that lacks the private runtime field. */
  replayInput(): Readonly<{ testSpecId: string; startState: Readonly<{ url: string }>;
    resolved: ResolvedTestSpecV8 }> {
    return this.#payload;
  }
}
