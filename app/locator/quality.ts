import { AcceptedLocatorSchema, type LocatorForm, type OrdinaryLocator, type PageLocator } from '../domain/index.js';
import type { z } from 'zod';
import { parseGeneratedLocator, LocatorSyntaxError } from './parse.js';

export type QualityCheck = 'passed' | 'failed' | 'not_checked';
export type IdentityBasis =
  | 'role-and-accessible-name' | 'label' | 'placeholder'
  | 'scoped-visible-text' | 'application-test-id' | 'frame-scoped-semantic';

/** M6 must supply these observations from a trusted, same-profile browser check. */
export interface LocatorObservation {
  matchCount: number;
  observedTargetMatches?: boolean;
  role?: string;
  accessibleName?: string;
  testIdProvenance?: 'mcp-discovered-stable';
}

export interface QualityAssessment {
  status: 'accepted' | 'rejected' | 'pending_live_checks';
  expression: string;
  validatedForm?: LocatorForm;
  checks: {
    grammar: QualityCheck;
    identityBasis: IdentityBasis | null;
    durableIdentity: QualityCheck;
    uniqueness: QualityCheck;
    observedTarget: QualityCheck;
  };
  reasons: readonly string[];
}

export type AcceptedLocator = z.infer<typeof AcceptedLocatorSchema>;

export class LocatorQualityError extends Error {
  constructor(readonly assessment: QualityAssessment) {
    super(`Locator quality gate rejected: ${assessment.reasons.join(', ') || assessment.status}`);
    this.name = 'LocatorQualityError';
  }
}

function meaningful(value: string): boolean {
  // Glyph-only and numeric labels are too weak to identify persisted UI intent.
  return /\p{L}/u.test(value);
}

function containsTestId(form: LocatorForm): boolean {
  if (form.type === 'frame') return form.frame.type === 'testId' || containsTestId(form.target);
  if (form.type === 'within') return containsTestId(form.scope) || containsTestId(form.target);
  return form.type === 'testId';
}

function ordinaryBasis(form: OrdinaryLocator, scoped: boolean): IdentityBasis | null {
  switch (form.type) {
    case 'role': return meaningful(form.name) ? 'role-and-accessible-name' : null;
    case 'label': return meaningful(form.value) ? 'label' : null;
    case 'placeholder': return meaningful(form.value) ? 'placeholder' : null;
    case 'text': return scoped && meaningful(form.value) ? 'scoped-visible-text' : null;
    case 'testId': return 'application-test-id';
  }
}

function pageBasis(form: PageLocator, scoped = false): IdentityBasis | null {
  if (form.type === 'within') {
    const parent = pageBasis(form.scope, scoped);
    const child = pageBasis(form.target, true);
    return parent && child ? child : null;
  }
  return ordinaryBasis(form, scoped);
}

function identityBasis(form: LocatorForm): IdentityBasis | null {
  if (form.type !== 'frame') return pageBasis(form);
  return pageBasis(form.target) ? 'frame-scoped-semantic' : null;
}

/** A static decision stays pending until M6 supplies browser observations. */
export function assessGeneratedLocator(expression: string, observation?: LocatorObservation): QualityAssessment {
  let form: LocatorForm;
  try {
    form = parseGeneratedLocator(expression);
  } catch (error) {
    if (!(error instanceof LocatorSyntaxError)) throw error;
    return {
      status: 'rejected', expression,
      checks: { grammar: 'failed', identityBasis: null, durableIdentity: 'failed', uniqueness: 'not_checked', observedTarget: 'not_checked' },
      reasons: ['UNSUPPORTED_GRAMMAR'],
    };
  }
  const basis = identityBasis(form);
  if (observation) {
    if (!Number.isSafeInteger(observation.matchCount) || observation.matchCount < 0) {
      throw new RangeError('matchCount must be a nonnegative safe integer');
    }
    if (observation.matchCount === 1 && observation.observedTargetMatches === undefined) {
      throw new TypeError('A unique match requires a target comparison');
    }
    if (observation.matchCount !== 1 && observation.observedTargetMatches !== undefined) {
      throw new TypeError('Only a unique match can have a target comparison');
    }
  }
  const reasons: string[] = [];
  if (!basis) reasons.push('WEAK_IDENTITY');
  if (containsTestId(form) && observation?.testIdProvenance !== 'mcp-discovered-stable') reasons.push('TEST_ID_PROVENANCE_UNVERIFIED');
  const durableIdentity = reasons.length === 0 ? 'passed' : 'failed';
  const uniqueness = observation === undefined ? 'not_checked' : observation.matchCount === 1 ? 'passed' : 'failed';
  const observedTarget = observation?.matchCount !== 1 ? 'not_checked' : observation.observedTargetMatches ? 'passed' : 'failed';
  if (uniqueness === 'failed') reasons.push('NON_UNIQUE_MATCH');
  if (observedTarget === 'failed') reasons.push('TARGET_MISMATCH');
  const status = reasons.length > 0 ? 'rejected' : observation === undefined ? 'pending_live_checks' : 'accepted';
  return {
    status, expression, validatedForm: form,
    checks: { grammar: 'passed', identityBasis: basis, durableIdentity, uniqueness, observedTarget },
    reasons,
  };
}

/** Only a full observation can produce the M1 accepted-locator record. */
export function acceptGeneratedLocator(expression: string, observation: LocatorObservation): AcceptedLocator {
  const assessment = assessGeneratedLocator(expression, observation);
  if (assessment.status !== 'accepted' || !assessment.validatedForm || !assessment.checks.identityBasis) {
    throw new LocatorQualityError(assessment);
  }
  return AcceptedLocatorSchema.parse({
    mcpGeneratedExpression: expression,
    validatedForm: assessment.validatedForm,
    observed: {
      matchCount: 1,
      ...(observation.role === undefined ? {} : { role: observation.role }),
      ...(observation.accessibleName === undefined ? {} : { accessibleName: observation.accessibleName }),
    },
    quality: { status: 'accepted', identityBasis: assessment.checks.identityBasis },
  });
}
