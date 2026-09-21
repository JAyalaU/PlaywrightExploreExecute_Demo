import { LocatorFormSchema, type LocatorForm, type OrdinaryLocator, type PageLocator } from '../domain/index.js';

/** The generated expression is untrusted text. This parser never evaluates it. */
export class LocatorSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorSyntaxError';
  }
}

class Reader {
  private offset = 0;

  constructor(private readonly input: string) {
    if (input.length === 0 || input.length > 2048) throw new LocatorSyntaxError('Locator expression length is invalid');
  }

  private space(): void {
    while (/\s/.test(this.input[this.offset] ?? '') && this.offset < this.input.length) this.offset++;
  }

  consume(token: string): boolean {
    this.space();
    if (!this.input.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }

  expect(token: string): void {
    if (!this.consume(token)) throw new LocatorSyntaxError(`Expected ${token} at offset ${this.offset}`);
  }

  identifier(): string {
    this.space();
    const match = /^[A-Za-z][A-Za-z0-9]*/.exec(this.input.slice(this.offset));
    if (!match) throw new LocatorSyntaxError(`Expected method at offset ${this.offset}`);
    this.offset += match[0].length;
    return match[0];
  }

  string(): string {
    this.space();
    const quote = this.input[this.offset];
    if (quote !== "'" && quote !== '"') throw new LocatorSyntaxError(`Expected string at offset ${this.offset}`);
    this.offset++;
    let result = '';
    while (this.offset < this.input.length) {
      const char = this.input[this.offset++]!;
      if (char === quote) return result;
      if (char === '\\') {
        const escaped = this.input[this.offset++];
        if (escaped === quote || escaped === '\\' || escaped === "'" || escaped === '"') result += escaped;
        else if (escaped === 'n') result += '\n';
        else if (escaped === 'r') result += '\r';
        else if (escaped === 't') result += '\t';
        else throw new LocatorSyntaxError('Unsupported string escape');
      } else {
        if (char === '\n' || char === '\r') throw new LocatorSyntaxError('Unescaped newline in string');
        result += char;
      }
    }
    throw new LocatorSyntaxError('Unterminated string');
  }

  done(): boolean {
    this.space();
    return this.offset === this.input.length;
  }
}

function ordinary(reader: Reader): OrdinaryLocator {
  const method = reader.identifier();
  reader.expect('(');
  if (method === 'getByRole') {
    const role = reader.string();
    reader.expect(',');
    reader.expect('{');
    reader.expect('name');
    reader.expect(':');
    const name = reader.string();
    const exact = optionalExact(reader);
    reader.expect('}');
    reader.expect(')');
    return { type: 'role', role, name, ...exact };
  }
  if (!['getByLabel', 'getByPlaceholder', 'getByText', 'getByTestId'].includes(method)) {
    throw new LocatorSyntaxError(`Unsupported locator method: ${method}`);
  }
  const value = reader.string();
  if (method === 'getByTestId') {
    reader.expect(')');
    return { type: 'testId', value };
  }
  const exact = reader.consume(',') ? optionsExact(reader) : {};
  reader.expect(')');
  switch (method) {
    case 'getByLabel': return { type: 'label', value, ...exact };
    case 'getByPlaceholder': return { type: 'placeholder', value, ...exact };
    default: return { type: 'text', value, ...exact };
  }
}

function optionalExact(reader: Reader): { exact?: true } {
  if (!reader.consume(',')) return {};
  reader.expect('exact');
  reader.expect(':');
  reader.expect('true');
  return { exact: true };
}

function optionsExact(reader: Reader): { exact: true } {
  reader.expect('{');
  reader.expect('exact');
  reader.expect(':');
  reader.expect('true');
  reader.expect('}');
  return { exact: true };
}

function frameTitle(value: string): string {
  const match = /^iframe\[title="([^"\]\\]+)"\]$/.exec(value);
  if (!match?.[1]) throw new LocatorSyntaxError('Only a literal iframe title is supported');
  return match[1];
}

/** Parse the allowlisted MCP expression grammar into the M1 locator form. */
export function parseGeneratedLocator(expression: string): LocatorForm {
  const reader = new Reader(expression);
  let frame: { type: 'title' | 'testId'; value: string } | undefined;
  let current: PageLocator;
  if (reader.consume('locator(')) {
    frame = { type: 'title', value: frameTitle(reader.string()) };
    reader.expect(')');
    reader.expect('.');
    reader.expect('contentFrame');
    reader.expect('(');
    reader.expect(')');
    reader.expect('.');
    current = ordinary(reader);
  } else {
    current = ordinary(reader);
    if (reader.consume('.contentFrame')) {
      if (current.type !== 'testId') throw new LocatorSyntaxError('Only a test ID can identify a frame this way');
      reader.expect('(');
      reader.expect(')');
      reader.expect('.');
      frame = { type: 'testId', value: current.value };
      current = ordinary(reader);
    }
  }
  let depth = 0;
  while (reader.consume('.')) {
    if (++depth > 8) throw new LocatorSyntaxError('Locator scope depth exceeds limit');
    current = { type: 'within', scope: current, target: ordinary(reader) };
  }
  if (!reader.done()) throw new LocatorSyntaxError('Unexpected trailing expression');
  const form: LocatorForm = frame ? { type: 'frame', frame, target: current } : current;
  const validated = LocatorFormSchema.safeParse(form);
  if (!validated.success) throw new LocatorSyntaxError('Locator arguments are invalid');
  return validated.data;
}
