import {
  ResolvedTestSpecSchema,
  SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION,
  SEMANTIC_ROLE_NAME_SCHEMA_VERSION,
  STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION,
  ResultRecordSchema,
  TestSpecSchema,
  type AuthoredStep,
  type ExecutionStep,
  type ResolvedTestSpec,
  type ResultRecord,
  type TestSpec,
} from './schema.js';
import { reviewAuthoredRoleNameIdentity } from '../locator/quality.js';
import { verificationGoalFidelity } from './verification-goal.js';
import { actionTargetIntentFidelity } from './action-target-intent.js';

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

function ensureUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ContractValidationError(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function parseTestSpec(input: unknown): TestSpec {
  const spec = TestSpecSchema.parse(input);
  ensureUnique(spec.steps.map((step) => step.id), 'authored step ID');
  for (const [index, step] of spec.steps.entries()) {
    if (step.type === 'verification_goal') {
      const problem = verificationGoalFidelity(step, spec.sourceInstruction,
        spec.steps.slice(0, index).map((prior) => prior.id));
      if (problem) throw new ContractValidationError(`Verification goal ${step.id}: ${problem}`);
    } else if (spec.schemaVersion === STRUCTURED_ACTION_IDENTITY_SCHEMA_VERSION &&
        (step.type === 'click' || step.type === 'fill' || step.type === 'select_option')) {
      const problem = actionTargetIntentFidelity(step, spec.sourceInstruction);
      if (problem) throw new ContractValidationError(`Action target ${step.id}: ${problem}`);
    }
  }
  return spec;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describesLink(description: string, accessibleName: string): boolean {
  const authored = description.trim().toLocaleLowerCase('en-US');
  const name = accessibleName.trim().toLocaleLowerCase('en-US');
  return authored === name || authored === `${name} link`;
}

function scopeIdentifiesCell(description: string, cellName: string): boolean {
  const escaped = cellName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(description);
}

/** A revision may keep its ID only when its validated content is unchanged. */
export function assertImmutableTestSpec(previousInput: unknown, candidateInput: unknown): void {
  const previous = parseTestSpec(previousInput);
  const candidate = parseTestSpec(candidateInput);
  if (previous.testSpecId === candidate.testSpecId && !sameJson(previous, candidate)) {
    throw new ContractValidationError('A changed TestSpec requires a new testSpecId');
  }
}

function assertAuthoredOperationMatches(authored: AuthoredStep, execution: ExecutionStep): void {
  if (authored.type !== execution.type) {
    throw new ContractValidationError(`Authored step ${authored.id} changed operation type`);
  }
  switch (authored.type) {
    case 'navigate':
      if (execution.type !== 'navigate' || execution.url !== authored.url) throw new ContractValidationError(`Authored step ${authored.id} changed URL`);
      break;
    case 'fill':
    case 'select_option':
      if (execution.type !== authored.type || !sameJson(execution.value, authored.value)) throw new ContractValidationError(`Authored step ${authored.id} changed input value`);
      break;
    case 'assert_text':
      if (execution.type !== 'assert_text' || execution.expectedText !== authored.expectedText || execution.match !== authored.match) throw new ContractValidationError(`Authored step ${authored.id} changed text assertion`);
      break;
    case 'assert_value':
      if (execution.type !== 'assert_value' || !sameJson(execution.expectedValue, authored.expectedValue)) throw new ContractValidationError(`Authored step ${authored.id} changed value assertion`);
      break;
    case 'assert_url':
      if (execution.type !== 'assert_url' || execution.expectedUrl !== authored.expectedUrl || execution.match !== authored.match) throw new ContractValidationError(`Authored step ${authored.id} changed URL assertion`);
      break;
    case 'assert_link_collection':
      if (execution.type !== 'assert_link_collection' || execution.linkName !== authored.linkName ||
          execution.expectedCount !== authored.expectedCount || execution.expectedHref !== authored.expectedHref ||
          execution.locator.validatedForm.name !== authored.linkName ||
          execution.locator.observed.accessibleName !== authored.linkName) {
        throw new ContractValidationError(`Authored step ${authored.id} changed link collection assertion`);
      }
      break;
    case 'wait_for':
      if (execution.type !== 'wait_for' || execution.timeoutPolicyRef !== authored.timeoutPolicyRef || !sameJson(execution.condition, authored.condition)) throw new ContractValidationError(`Authored step ${authored.id} changed wait condition`);
      break;
    case 'click':
    case 'assert_visible':
      break;
  }
}

/**
 * Validate the accepted artifact together with its source TestSpec. The source
 * is required because origin references and authored intent cannot be checked
 * from a resolved artifact alone.
 */
export function parseResolvedTestSpec(input: unknown, sourceInput: unknown): ResolvedTestSpec {
  const source = parseTestSpec(sourceInput);
  const resolved = ResolvedTestSpecSchema.parse(input);
  if (resolved.testSpecId !== source.testSpecId) {
    throw new ContractValidationError('Resolved spec references a different TestSpec');
  }
  if (!sameJson(resolved.executionProfileRef, source.executionProfileRef)) {
    throw new ContractValidationError('Resolved spec changed the execution profile reference');
  }
  if (resolved.schemaVersion === SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION ||
      resolved.schemaVersion === SEMANTIC_ROLE_NAME_SCHEMA_VERSION
    ? resolved.sourceSchemaVersion !== source.schemaVersion
    : resolved.schemaVersion !== source.schemaVersion) {
    throw new ContractValidationError('Resolved spec changed the TestSpec schema version');
  }
  ensureUnique(resolved.executionSteps.map((step) => step.id), 'execution step ID');
  ensureUnique(resolved.executionSteps.flatMap((step) => 'locatorId' in step ? [step.locatorId] : []), 'locator ID');

  let authoredIndex = 0;
  for (const execution of resolved.executionSteps) {
    const authored = source.steps[authoredIndex];
    if (!authored || execution.originStepId !== authored.id) {
      throw new ContractValidationError(`Execution step ${execution.id} has an absent or out-of-order origin`);
    }
    if ('locator' in execution && 'origin' in execution.locator && execution.locator.origin === 'semanticRowScope') {
      const form = execution.locator.validatedForm;
      if (execution.source !== 'authored' || execution.type !== 'click' || authored.type !== 'click' ||
          authored.target.scope?.length !== 1 || authored.target.scope[0]?.kind !== 'row' ||
          !scopeIdentifiesCell(authored.target.scope[0].description, form.scope.cellName) ||
          !describesLink(authored.target.description, form.target.name)) {
        throw new ContractValidationError('Semantic row locator does not match the authored row and link intent');
      }
    }
    if ('locator' in execution && 'origin' in execution.locator &&
        execution.locator.origin === 'verifiedRoleNameProjection') {
      const target = authored.type === 'wait_for' && 'target' in authored.condition
        ? authored.condition.target : 'target' in authored ? authored.target : undefined;
      if (execution.source !== 'authored' || !target ||
          !reviewAuthoredRoleNameIdentity(target, execution.locator.validatedForm,
            execution.locator.observed)) {
        throw new ContractValidationError('Verified role/name projection does not match authored target intent');
      }
    }
    if (execution.source === 'authored') {
      assertAuthoredOperationMatches(authored, execution);
      authoredIndex += 1;
    }
  }
  if (authoredIndex !== source.steps.length) {
    throw new ContractValidationError('Each authored step requires one final execution step');
  }
  return resolved;
}

/** Re-resolution requires both a new attempt and a new resolved artifact ID. */
export function assertImmutableResolvedTestSpec(previous: ResolvedTestSpec, candidate: ResolvedTestSpec): void {
  if (previous.resolvedSpecId === candidate.resolvedSpecId && !sameJson(previous, candidate)) {
    throw new ContractValidationError('A changed ResolvedTestSpec requires a new resolvedSpecId');
  }
  if (previous.resolvedSpecId !== candidate.resolvedSpecId && previous.explorationAttemptId === candidate.explorationAttemptId) {
    throw new ContractValidationError('A new resolved artifact requires a new explorationAttemptId');
  }
  if (previous.resolvedSpecId === candidate.resolvedSpecId && previous.explorationAttemptId !== candidate.explorationAttemptId) {
    throw new ContractValidationError('An exploration attempt cannot reuse a resolvedSpecId');
  }
}

export function parseResultRecord(input: unknown): ResultRecord {
  return ResultRecordSchema.parse(input);
}
