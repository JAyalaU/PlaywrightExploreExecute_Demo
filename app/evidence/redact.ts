const sensitiveKey = /^(?:password|passwd|secret|token|accessToken|refreshToken|apiKey|authorization|cookie|setCookie|storageState)$/i;
const sensitiveQuery = /([?&](?:token|secret|password|api_key|apikey|session|code)=)[^&#\s]*/gi;

export class EvidenceRedactor {
  readonly #literals: readonly string[];

  constructor(secretLiterals: readonly string[] = []) {
    this.#literals = secretLiterals.filter((value) => value.length > 0);
  }

  text(input: string): string {
    let output = input.replace(sensitiveQuery, '$1[REDACTED]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
    for (const literal of this.#literals) output = output.replaceAll(literal, '[REDACTED]');
    return output;
  }

  value(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, value]) =>
        [key, sensitiveKey.test(key) ? '[REDACTED]' : this.value(value)]));
    }
    return input;
  }

  /** Executable contracts must be stored intact; reject a contract requiring redaction. */
  assertSafeContract(input: unknown): void {
    if (JSON.stringify(this.value(input)) !== JSON.stringify(input)) {
      throw new Error('Contract contains sensitive literal data; use protected data references');
    }
  }
}
