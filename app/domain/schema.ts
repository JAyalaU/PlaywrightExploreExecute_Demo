import { z } from 'zod';
import { VerificationGoalSchema } from './verification-goal.js';
import { ActionTargetIntentV1Schema } from './action-target-intent.js';

// Version 2 is the first published production contract. A new shape needs an
// explicit versioned schema rather than silently widening this one.
export const SCHEMA_VERSION = '2' as const;
export const LINK_ASSERTION_SCHEMA_VERSION = '3' as const;
export const VERIFICATION_GOAL_SCHEMA_VERSION = '4' as const;
export const STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION = '5' as const;
export const SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION = '4' as const;
export const SEMANTIC_ROLE_NAME_SCHEMA_VERSION = '5' as const;

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

/** Reused by separately versioned source contracts; grants no navigation approval. */
export const ApprovedAbsoluteUrlSchema = httpUrl;

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
  z.strictObject({ ...authoredBase, type: z.literal('click'), target: TargetSchema,
    actionTargetIntent: ActionTargetIntentV1Schema.optional() }),
  z.strictObject({ ...authoredBase, type: z.literal('fill'), target: TargetSchema, value: dataValue,
    actionTargetIntent: ActionTargetIntentV1Schema.optional() }),
  z.strictObject({ ...authoredBase, type: z.literal('select_option'), target: TargetSchema, value: dataValue,
    actionTargetIntent: ActionTargetIntentV1Schema.optional() }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_visible'), target: TargetSchema }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_text'), target: TargetSchema, expectedText: z.string(), match: z.enum(['exact', 'contains']) }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_value'), target: TargetSchema, expectedValue: dataValue }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_url'), expectedUrl: z.string().min(1), match: z.enum(['exact', 'pattern']) }).superRefine((step, context) => {
    if (!(step.match === 'exact' ? httpUrl : urlPattern).safeParse(step.expectedUrl).success) {
      context.addIssue({ code: 'custom', path: ['expectedUrl'], message: 'Invalid URL for match mode' });
    }
  }),
  z.strictObject({ ...authoredBase, type: z.literal('assert_link_collection'), linkName: prose, expectedCount: z.literal(2), expectedHref: httpUrl }),
  z.strictObject({ ...authoredBase, type: z.literal('wait_for'), condition: WaitConditionSchema, timeoutPolicyRef: identifier }),
  VerificationGoalSchema,
]);

export const TestSpecSchema = z.strictObject({
  schemaVersion: z.enum([SCHEMA_VERSION, LINK_ASSERTION_SCHEMA_VERSION, VERIFICATION_GOAL_SCHEMA_VERSION,
    STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION]),
  testSpecId: identifier,
  sourceInstruction: prose,
  executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([httpUrl, z.literal('about:blank')]) }),
  steps: z.array(AuthoredStepSchema).min(1),
}).superRefine((spec, context) => {
  if (spec.schemaVersion === SCHEMA_VERSION && spec.steps.some((step) => step.type === 'assert_link_collection')) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'Link collection assertions require TestSpec version 3' });
  }
  if (spec.schemaVersion !== VERIFICATION_GOAL_SCHEMA_VERSION &&
      spec.schemaVersion !== STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION &&
      spec.steps.some((step) => step.type === 'verification_goal')) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'Verification goals require TestSpec version 4 or 5' });
  }
  if (spec.schemaVersion === VERIFICATION_GOAL_SCHEMA_VERSION && !spec.steps.some((step) => step.type === 'verification_goal')) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'TestSpec version 4 requires a verification goal' });
  }
  if (spec.schemaVersion === STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION &&
      spec.steps.some((step) => !['navigate', 'click', 'fill', 'select_option', 'verification_goal'].includes(step.type))) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'TestSpec version 5 permits actions and verification goals only' });
  }
  for (const [index, step] of spec.steps.entries()) {
    if (step.type !== 'click' && step.type !== 'fill' && step.type !== 'select_option') continue;
    if (spec.schemaVersion === STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION && !step.actionTargetIntent ||
        spec.schemaVersion !== STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION && step.actionTargetIntent) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'actionTargetIntent'],
        message: 'Action target identity is required only in TestSpec version 5' });
    }
  }
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
export type PageLocator = OrdinaryLocator | { type: 'rowWithCell'; cellName: string } |
  { type: 'within'; scope: PageLocator; target: PageLocator };
export type LocatorForm = PageLocator | {
  type: 'frame';
  frame: { type: 'title' | 'testId'; value: string };
  target: PageLocator;
};

const pageLocator: z.ZodType<PageLocator> = z.lazy(() => z.union([
  ordinaryLocator,
  z.strictObject({ type: z.literal('rowWithCell'), cellName: nonEmpty }),
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

function hasSemanticRowScope(form: LocatorForm): boolean {
  if (form.type === 'rowWithCell') return true;
  if (form.type === 'within') return hasSemanticRowScope(form.scope) || hasSemanticRowScope(form.target);
  if (form.type === 'frame') return hasSemanticRowScope(form.target);
  return false;
}

const mcpAcceptedLocator = z.strictObject({
  mcpGeneratedExpression: nonEmpty,
  validatedForm: LocatorFormSchema,
  observed: z.strictObject({
    role: nonEmpty.optional(),
    accessibleName: z.string().optional(),
    matchCount: z.literal(1),
  }),
  quality: z.strictObject({ status: z.literal('accepted'), identityBasis: nonEmpty }),
}).superRefine((locator, context) => {
  if (hasSemanticRowScope(locator.validatedForm)) {
    context.addIssue({ code: 'custom', path: ['validatedForm'], message: 'Authored semantic row scopes require their versioned origin' });
  }
});

/** Version 4 records an MCP rejection and a separately verified authored row scope. */
const semanticRowAcceptedLocator = z.strictObject({
  origin: z.literal('semanticRowScope'),
  mcpGeneratedExpression: nonEmpty,
  validatedForm: z.strictObject({
    type: z.literal('within'),
    scope: z.strictObject({ type: z.literal('rowWithCell'), cellName: nonEmpty }),
    target: z.strictObject({ type: z.literal('role'), role: z.literal('link'), name: nonEmpty, exact: z.literal(true) }),
  }),
  observed: z.strictObject({ role: z.literal('link'), accessibleName: nonEmpty, matchCount: z.literal(1) }),
  quality: z.strictObject({ status: z.literal('accepted'), identityBasis: z.literal('scoped-role-and-accessible-name') }),
});

/** Version 5 records a rejected MCP locator and a verified exact role/name replacement. */
const semanticRoleNameAcceptedLocator = z.strictObject({
  origin: z.literal('verifiedRoleNameProjection'),
  mcpGeneratedExpression: nonEmpty,
  rawRejection: z.strictObject({
    reasons: z.tuple([z.literal('WEAK_IDENTITY')]),
    matchCount: z.literal(1),
    observedTargetMatches: z.literal(true),
  }),
  validatedForm: z.strictObject({
    type: z.literal('role'), role: nonEmpty, name: nonEmpty, exact: z.literal(true),
  }),
  observed: z.strictObject({
    role: nonEmpty, accessibleName: nonEmpty, matchCount: z.literal(1),
    observedTargetMatches: z.literal(true),
  }),
  quality: z.strictObject({ status: z.literal('accepted'), identityBasis: z.literal('role-and-accessible-name') }),
}).superRefine((locator, context) => {
  if (locator.validatedForm.role !== locator.observed.role ||
      locator.validatedForm.name !== locator.observed.accessibleName) {
    context.addIssue({ code: 'custom', path: ['observed'], message: 'Projected identity must match the observed selected node' });
  }
});

export const AcceptedLocatorSchema = z.union([
  mcpAcceptedLocator, semanticRowAcceptedLocator, semanticRoleNameAcceptedLocator,
]);

const exactLinkCollectionForm = z.strictObject({ type: z.literal('role'), role: z.literal('link'), name: prose, exact: z.literal(true) });
const collectionQuality = { status: z.literal('accepted'), identityBasis: z.literal('role-and-accessible-name'),
  kind: z.literal('collection') };

/** A zero-match collection has no MCP exemplar; its identity comes only from the closed operation. */
export const AcceptedLinkCollectionLocatorSchema = z.discriminatedUnion('origin', [
  z.strictObject({
    origin: z.literal('mcp'), mcpGeneratedExpression: nonEmpty,
    validatedForm: exactLinkCollectionForm,
    observed: z.strictObject({ role: z.literal('link'), accessibleName: prose, matchCount: z.number().int().positive() }),
    quality: z.strictObject({ ...collectionQuality, projection: z.literal('exact-role-name-collection') }),
  }),
  z.strictObject({
    origin: z.literal('closedZeroMatch'), validatedForm: exactLinkCollectionForm,
    observed: z.strictObject({ role: z.literal('link'), accessibleName: prose, matchCount: z.literal(0) }),
    quality: z.strictObject({ ...collectionQuality, projection: z.literal('closed-assertion-zero-match') }),
  }),
]);

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
  z.strictObject({ ...executionBase, type: z.literal('assert_link_collection'), locatorId: identifier,
    targetDescription: prose, locator: AcceptedLinkCollectionLocatorSchema,
    linkName: prose, expectedCount: z.literal(2), expectedHref: httpUrl }),
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
  schemaVersion: z.enum([SCHEMA_VERSION, LINK_ASSERTION_SCHEMA_VERSION,
    SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION, SEMANTIC_ROLE_NAME_SCHEMA_VERSION]),
  sourceSchemaVersion: z.enum([SCHEMA_VERSION, LINK_ASSERTION_SCHEMA_VERSION]).optional(),
  resolvedSpecId: identifier,
  testSpecId: identifier,
  explorationAttemptId: identifier,
  executionProfileRef: ExecutionProfileRefSchema,
  runtimeVersions: z.strictObject({ playwright: nonEmpty, mcp: nonEmpty, runner: nonEmpty }),
  executionSteps: z.array(ExecutionStepSchema).min(1),
}).superRefine((spec, context) => {
  if (spec.schemaVersion === SCHEMA_VERSION && spec.executionSteps.some((step) => step.type === 'assert_link_collection')) {
    context.addIssue({ code: 'custom', path: ['executionSteps'], message: 'Link collection assertions require ResolvedTestSpec version 3' });
  }
  const hasSemanticRow = spec.executionSteps.some((step) => 'locator' in step &&
    'origin' in step.locator && step.locator.origin === 'semanticRowScope');
  const hasRoleNameProjection = spec.executionSteps.some((step) => 'locator' in step &&
    'origin' in step.locator && step.locator.origin === 'verifiedRoleNameProjection');
  if (spec.schemaVersion === SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION) {
    if (!spec.sourceSchemaVersion || !hasSemanticRow || hasRoleNameProjection) {
      context.addIssue({ code: 'custom', path: ['sourceSchemaVersion'], message: 'Version 4 requires its source version and a semantic row locator' });
    }
  } else if (spec.schemaVersion === SEMANTIC_ROLE_NAME_SCHEMA_VERSION) {
    if (!spec.sourceSchemaVersion || !hasRoleNameProjection) {
      context.addIssue({ code: 'custom', path: ['sourceSchemaVersion'], message: 'Version 5 requires its source version and a verified role/name projection' });
    }
  } else if (spec.sourceSchemaVersion || hasSemanticRow || hasRoleNameProjection) {
    context.addIssue({ code: 'custom', path: ['schemaVersion'], message: 'Projected locators require their resolved schema version' });
  }
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
