import OpenAI from 'openai';

// Authorization must come from the launch environment, never from .env itself.
if (process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS !== '1') {
  console.error('Provider contract spike requires PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1.');
  process.exit(2);
}

const { loadProjectEnv } = await import('../dist/local/project-env.js');
loadProjectEnv();
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey?.trim()) {
  console.error('Provider contract spike requires OPENAI_API_KEY.');
  process.exit(2);
}

const { POC_PRIMARY_RESPONSE_FORMAT, POC_FIDELITY_RESPONSE_FORMAT,
  PocPrimaryWireSchema, PocFidelityWireSchema } = await import('../dist/interpretation/deferred-action-poc-wire.js');
const { POC_PRIMARY_SYSTEM_INSTRUCTION, POC_FIDELITY_SYSTEM_INSTRUCTION } =
  await import('../dist/interpretation/deferred-action-poc-interpret.js');
const { normalizePocSemanticExtraction, pocReviewerProjection } =
  await import('../dist/interpretation/deferred-action-poc-normalize.js');

// This is the exact authored instruction in tests/helpers/deferred-five-step-source.ts.
const originalInstruction = [
  '1. Go to https://the-internet.herokuapp.com/',
  '2. Find and click the link with the text: "Dropdown"',
  '3. Confirm it takes you to https://the-internet.herokuapp.com/dropdown',
  '4. From the dropdown, select Option 1.',
  '5. Verify that Option 1 is selected.',
].join('\n');
const source = { testSpecId: 'provider-contract-spike', sourceInstruction: originalInstruction,
  executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };

// Locally validated representative projection for probe D. It is not model output.
const representativePrimary = PocPrimaryWireSchema.parse({ response: { kind: 'extraction', steps: [
  { id: 's1', type: 'navigate', url: 'https://the-internet.herokuapp.com/' },
  { id: 's2', type: 'action_goal', effect: 'activate', explicitOperation: 'click', argument: null,
    targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
      { kind: 'name', value: 'Dropdown', polarity: 'positive' }], dependsOnStepId: 's1' },
  { id: 's3', type: 'verification_goal', verificationVersion: null,
    instruction: 'The resulting URL is https://the-internet.herokuapp.com/dropdown',
    subject: null, intent: null, dependsOnStepId: 's2' },
  { id: 's4', type: 'action_goal', effect: 'choose', explicitOperation: 'select_option',
    argument: { purpose: 'choice', value: 'Option 1' },
    targetConstraints: [{ kind: 'role', value: 'dropdown', polarity: 'positive' }], dependsOnStepId: 's3' },
  { id: 's5', type: 'verification_goal', verificationVersion: '2', optionLabel: 'Option 1',
    expectedSelected: true, controlConstraints: [], dependsOnStepId: 's4' },
] } });
if (representativePrimary.response.kind !== 'extraction') throw new Error('Invalid local probe D fixture');
const representativeProjection = pocReviewerProjection(normalizePocSemanticExtraction(source, representativePrimary.response));

const model = 'gpt-5.6-terra'; // Production Responses client default.
const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 180_000 });
const short = (value: unknown, max = 180): string => {
  if (value === null || value === undefined) return '';
  let text = String(value).replaceAll(apiKey, '[REDACTED]');
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, '[REDACTED]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, max);
};

type Row = { probe: string; api: string; status: string; errorType: string; errorCode: string;
  errorParam: string; errorMessage: string; localSchema: string; elapsedMs: number };
const rows: Row[] = [];
const run = async (probe: string, request: Record<string, unknown>, validate?: (text: string) => void) => {
  const started = Date.now();
  try {
    const response = await client.responses.create(request as Parameters<typeof client.responses.create>[0]);
    const output = response.output_text ?? '';
    let localSchema = validate ? 'not run' : 'n/a';
    if (response.status === 'completed') {
      if (validate) {
        try { validate(output); localSchema = 'pass'; }
        catch { localSchema = 'fail'; }
      } else if (probe === 'A') localSchema = output.trim() ? 'text present' : 'no text';
    }
    rows.push({ probe, api: 'success', status: short(response.status), errorType: '', errorCode: '',
      errorParam: '', errorMessage: '', localSchema, elapsedMs: Date.now() - started });
  } catch (error) {
    const issue = error as { status?: unknown; type?: unknown; code?: unknown; param?: unknown;
      message?: unknown; error?: { type?: unknown; code?: unknown; param?: unknown; message?: unknown } };
    rows.push({ probe, api: 'failure', status: short(issue.status),
      errorType: short(issue.error?.type ?? issue.type, 80), errorCode: short(issue.error?.code ?? issue.code, 80),
      errorParam: short(issue.error?.param ?? issue.param, 80),
      errorMessage: short(issue.error?.message ?? issue.message), localSchema: 'not run',
      elapsedMs: Date.now() - started });
  }
};

await run('A', { model, input: 'Reply with OK.', store: false });
await run('B', { model, input: 'Return an object where ok is true.', store: false,
  text: { format: { type: 'json_schema', name: 'provider_spike_minimal_v1', strict: true,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } },
      required: ['ok'], additionalProperties: false } } } },
  (text) => { const parsed = JSON.parse(text) as { ok?: unknown }; if (parsed.ok !== true) throw new Error('ok must be true'); });
await run('C', { model, reasoning: { effort: 'medium' }, instructions: POC_PRIMARY_SYSTEM_INSTRUCTION,
  input: originalInstruction, text: { format: POC_PRIMARY_RESPONSE_FORMAT }, store: false,
  tools: [], tool_choice: 'none', max_output_tokens: 16_384, truncation: 'disabled' },
  (text) => { PocPrimaryWireSchema.parse(JSON.parse(text)); });
await run('D', { model, reasoning: { effort: 'medium' }, instructions: POC_FIDELITY_SYSTEM_INSTRUCTION,
  input: JSON.stringify({ originalInstruction, testSpec: representativeProjection }),
  text: { format: POC_FIDELITY_RESPONSE_FORMAT }, store: false,
  tools: [], tool_choice: 'none', max_output_tokens: 16_384, truncation: 'disabled' },
  (text) => { PocFidelityWireSchema.parse(JSON.parse(text)); });

console.table(rows);
