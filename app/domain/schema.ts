import { z } from 'zod';

// Version 2 is the first published production contract. A new shape needs an
// explicit versioned schema rather than silently widening this one.
export const SCHEMA_VERSION = '2' as const;

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const nonEmpty = z.string().min(1).refine((value) => value.trim().length > 0, 'Expected non-empty text');
const evidenceRef = nonEmpty.refine(
  (value) => !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '.' || part === '..' || part === ''),
  'Expected a relative evidence reference without traversal',
);
const prose = nonEmpty.refine(
  (value) => !/(?:\b(?:page|document|window)\.[A-Za-z_$]|\b(?:getBy\w+|locator|querySelector|evaluate|eval|alert|fetch|Function)\s*\(|\b(?:javascript|css|xpath)\s*[:=]|<\s*script\b|\[[\w-]+\s*=|\b\w+\s*>\s*\w+|=>|:nth-child\s*\(|(?:^|\s)[#.][A-Za-z][\w-]*\b|(?:^|\s)\/\/[A-Za-z])/i.test(value),
  'Executable code or selector syntax is not allowed in semantic text',
);

const httpUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !value.includes('*');
}, 'Expected an absolute HTTP(S) URL without credentials');

const urlPattern = z.string().refine((value) => {
  if (!value.endsWith('/*') || value.slice(0, -2).includes('*') || /[?#]/.test(value)) return false;
  const prefix = value.slice(0, -1);
  try {
    const url = new URL(prefix);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      !!url.hostname && !url.username && !url.password && url.pathname.endsWith('/');
  } catch {
    return false;
  }
}, 'Expected an absolute HTTP(S) URL with one terminal /* pathname wildcard');

export const ExecutionProfileRefSchema = z.strictObject({
  id: identifier,
  version,
});

export const TargetSchema = z.strictObject({
  description: prose,
  scope: z.array(z.strictObject({
    kind: z.enum(['menu', 'dialog', 'region', 'row', 'frame']),
    description: prose,
  })).optional(),
});

const dataValue = z.union([
  z.string(),
  z.strictObject({ kind: z.literal('dataRef'), ref: identifier }),
]);

export const WaitConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('target_visible'), target: TargetSchema }),
  z.strictObject({ type: z.literal('url_exact'), url: httpUrl }),
  z.strictObject({ type: z.literal('url_pattern'), pattern: urlPattern }),
  z.strictObject({ type: z.literal('target_value'), target: TargetSchema, expectedValue: dataValue }),
]);

const authoredBase = { id: identifier, sourceText: prose };

export const AuthoredStepSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...authoredBase, type: z.literal('navigate'), url: httpUrl }),
  z.strictObject({ ...authoredBase, type: z.literal('click'), target: TargetSchema }),
  z.strictObject({ ...authoredBase, type: z.literal('fill'), target: TargetSchema, value: dataValue }),
  z.strictObject({ ...authoredBase, type: z.literal('select_option'), target: TargetSchema, value: dataValue }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_visible'), target: TargetSchema }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_text'), target: TargetSchema, expectedText: z.string(), match: z.enum(['exact', 'contains']) }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_value'), target: TargetSchema, expectedValue: dataValue }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_url'), expectedUrl: z.string().min(1), match: z.enum(['exact', 'pattern']) }).superRefine((step, context) => {
    if (!(step.match === 'exact' ? httpUrl : urlPattern).safeParse(step.expectedUrl).success) {
      context.addIssue({ code: 'custom', path: ['expectedUrl'], message: 'Invalid URL for match mode' });
    }
  }),
  z.strictObject({ ...authoredBase, type: z.literal('wait_for'), condition: WaitConditionSchema, timeoutPolicyRef: identifier }),
]);

export const TestSpecSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  testSpecId: identifier,
  sourceInstruction: prose,
  executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([httpUrl, z.literal('about:blank')]) }),
  steps: z.array(AuthoredStepSchema).min(1),
});

export type TestSpec = z.infer<typeof TestSpecSchema>;
export type AuthoredStep = z.infer<typeof AuthoredStepSchema>;

const ordinaryLocator = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('role'), role: nonEmpty, name: nonEmpty, exact: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('label'), value: nonEmpty, exact: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('placeholder'), value: nonEmpty, exact: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('text'), value: nonEmpty, exact: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('testId'), value: nonEmpty }),
]);

export type OrdinaryLocator = z.infer<typeof ordinaryLocator>;
export type PageLocator = OrdinaryLocator | { type: 'within'; scope: PageLocator; target: PageLocator };
export type LocatorForm = PageLocator | {
  type: 'frame';
  frame: { type: 'title' | 'testId'; value: string };
  target: PageLocator;
};

const pageLocator: z.ZodType<PageLocator> = z.lazy(() => z.union([
  ordinaryLocator,
  z.strictObject({ type: z.literal('within'), scope: pageLocator, target: pageLocator }),
]));

export const LocatorFormSchema: z.ZodType<LocatorForm> = z.union([
  pageLocator,
  z.strictObject({
    type: z.literal('frame'),
    frame: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('title'), value: nonEmpty }),
      z.strictObject({ type: z.literal('testId'), value: nonEmpty }),
    ]),
    target: pageLocator,
  }),
]);

export const AcceptedLocatorSchema = z.strictObject({
  mcpGeneratedExpression: nonEmpty,
  validatedForm: LocatorFormSchema,
  observed: z.strictObject({
    role: nonEmpty.optional(),
    accessibleName: z.string().optional(),
    matchCount: z.literal(1),
  }),
  quality: z.strictObject({ status: z.literal('accepted'), identityBasis: nonEmpty }),
});

const executionBase = {
  id: identifier,
  originStepId: identifier,
  derivationEvidenceRef: evidenceRef,
  source: z.enum(['authored', 'discoveredPrerequisite']),
  reason: prose.optional(),
};
const targeted = {
  locatorId: identifier,
  targetDescription: prose,
  locator: AcceptedLocatorSchema,
};

const executionOperation = z.discriminatedUnion('type', [
  z.strictObject({ ...executionBase, type: z.literal('navigate'), url: httpUrl }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('click') }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('fill'), value: dataValue }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('select_option'), value: dataValue }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('assert_visible') }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('assert_text'), expectedText: z.string(), match: z.enum(['exact', 'contains']) }),
  z.strictObject({ ...executionBase, ...targeted, type: z.literal('assert_value'), expectedValue: dataValue }),
  z.strictObject({ ...executionBase, type: z.literal('assert_url'), expectedUrl: z.string().min(1), match: z.enum(['exact', 'pattern']) }).superRefine((step, context) => {
    if (!(step.match === 'exact' ? httpUrl : urlPattern).safeParse(step.expectedUrl).success) {
      context.addIssue({ code: 'custom', path: ['expectedUrl'], message: 'Invalid URL for match mode' });
    }
  }),
  z.strictObject({ ...executionBase, type: z.literal('wait_for'), condition: WaitConditionSchema, timeoutPolicyRef: identifier, ...targeted }).superRefine((step, context) => {
    if (step.condition.type === 'url_exact' || step.condition.type === 'url_pattern') {
      context.addIssue({ code: 'custom', path: ['condition'], message: 'URL waits do not have target locators' });
    }
  }),
]);

// URL waits are untargeted. Other wait variants carry a gated locator.
const resolvedOperation = z.union([
  executionOperation,
  z.strictObject({ ...executionBase, type: z.literal('wait_for'), condition: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('url_exact'), url: httpUrl }),
    z.strictObject({ type: z.literal('url_pattern'), pattern: urlPattern }),
  ]), timeoutPolicyRef: identifier }),
]);

export const ExecutionStepSchema = resolvedOperation.superRefine((step, context) => {
  if (step.source === 'authored' && step.reason !== undefined) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Authored steps cannot carry a prerequisite reason' });
  }
  if (step.source === 'discoveredPrerequisite') {
    if (!step.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Prerequisites require a reason' });
    }
    if (step.type.startsWith('assert_')) {
      context.addIssue({ code: 'custom', path: ['type'], message: 'Assertions cannot be prerequisites' });
    }
  }
});

export const ResolvedTestSpecSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  resolvedSpecId: identifier,
  testSpecId: identifier,
  explorationAttemptId: identifier,
  executionProfileRef: ExecutionProfileRefSchema,
  runtimeVersions: z.strictObject({ playwright: nonEmpty, mcp: nonEmpty, runner: nonEmpty }),
  executionSteps: z.array(ExecutionStepSchema).min(1),
});

export type ResolvedTestSpec = z.infer<typeof ResolvedTestSpecSchema>;
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

export const ResultStatusSchema = z.enum([
  'INTERPRETATION_FAILED', 'AMBIGUOUS_INSTRUCTION', 'MCP_EXPLORATION_FAILED',
  'TARGET_RESOLUTION_FAILED', 'LOCATOR_GENERATION_FAILED', 'LOCATOR_QUALITY_FAILED',
  'TEST_BUILD_FAILED', 'LOCATOR_BINDING_FAILED', 'BROWSER_EXECUTION_FAILED',
  'QA_ASSERTION_FAILED', 'QA_ASSERTION_PASSED', 'OPERATION_SUCCEEDED', 'NOT_RUN',
]);

export const ResultRecordSchema = z.strictObject({
  phase: z.enum(['interpretation', 'exploration', 'locator', 'execution']),
  status: ResultStatusSchema,
  testSpecId: identifier,
  resolvedSpecId: identifier.optional(),
  explorationAttemptId: identifier.optional(),
  executionRunId: identifier.optional(),
  executionProfileRef: ExecutionProfileRefSchema.optional(),
  originStepId: identifier.optional(),
  executionStepId: identifier.optional(),
  locatorId: identifier.optional(),
  reason: nonEmpty.optional(),
  expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
  actual: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
  retryable: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  evidenceRefs: z.array(evidenceRef),
}).superRefine((result, context) => {
  if (result.phase === 'execution') {
    for (const field of ['executionRunId', 'resolvedSpecId', 'executionProfileRef'] as const) {
      if (!result[field]) context.addIssue({ code: 'custom', path: [field], message: `Execution results require ${field}` });
    }
  }
  if ((result.phase === 'exploration' || result.phase === 'locator') && !result.explorationAttemptId) {
    context.addIssue({ code: 'custom', path: ['explorationAttemptId'], message: 'Exploration results require an attempt ID' });
  }
  if (result.locatorId && !result.executionStepId) {
    context.addIssue({ code: 'custom', path: ['executionStepId'], message: 'Locator results require an execution step ID' });
  }
});

export type ResultRecord = z.infer<typeof ResultRecordSchema>;
