import { AcceptedLinkCollectionLocatorSchema, AcceptedLocatorSchema, LocatorFormSchema, TargetSchema, type LocatorForm, type OrdinaryLocator, type PageLocator } from '../domain/schema.js';
import type { z } from 'zod';
import { parseGeneratedLocator, LocatorSyntaxError } from './parse.js';

export type QualityCheck = 'passed' | 'failed' | 'not_checked';
export type IdentityBasis =
  | 'role-and-accessible-name' | 'label' | 'placeholder'
  | 'scoped-visible-text' | 'scoped-role-and-accessible-name' | 'application-test-id' | 'frame-scoped-semantic';
export type LocatorQualityReason =
  | 'UNSUPPORTED_GRAMMAR'
  | 'WEAK_IDENTITY'
  | 'TEST_ID_PROVENANCE_UNVERIFIED'
  | 'NON_UNIQUE_MATCH'
  | 'TARGET_MISMATCH';

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
  reasons: readonly LocatorQualityReason[];
}

export type AcceptedLocator = z.infer<typeof AcceptedLocatorSchema>;
export type AcceptedLinkCollectionLocator = z.infer<typeof AcceptedLinkCollectionLocatorSchema>;

export class LocatorQualityError extends Error {
  constructor(readonly assessment: QualityAssessment) {
    super(`Locator quality gate rejected: ${assessment.reasons.join(', ') || assessment.status}`);
    this.name = 'LocatorQualityError';
  }
}

function meaningful(value: string): boolean {
  // Keep the existing conservative rule for labels, placeholders and scoped text.
  // Reviewed authored role/name identity is evaluated separately below.
  return /\p{L}/u.test(value);
}

/** A reviewed role/name identity is an ephemeral quality witness, not a persisted locator. */
export interface AuthoredRoleNameWitness {
  identityBasis: 'role-and-accessible-name';
  validatedForm: { type: 'role'; role: string; name: string; exact: true };
  observed: { role: string; accessibleName: string; matchCount: 1; observedTargetMatches: true };
}
export type AuthoredRoleNameTarget = z.infer<typeof TargetSchema>;

/** Read only closed, explicit role/name phrases for WP1, M7, and WP3. */
export function parseAuthoredRoleNameIdentity(description: string): { role: string; name: string } | null {
  const text = description.trim();
  if (text.length > 1024 || /[\r\n]/.test(text)) return null;
  const roles = '(link|button|checkbox|radio|textbox|combobox|option|menuitem|tab|heading)';
  const introduction = '(?:(?:that\\s+)?(?:says|reads)|with\\s+(?:the\\s+)?(?:text|name|label):?|named|called)';
  const quoted = new RegExp(`^${roles}\\s+${introduction}\\s+(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)')(?:\\s+and\\s+that\\s+takes\\s+you\\s+to\\s+(?:the\\s+)?url:?\\s+https?:\\/\\/\\S+)?$`, 'i').exec(text);
  if (quoted) {
    const name = quoted[2] ?? quoted[3];
    return name && name.length <= 512 && name.trim() === name
      ? { role: quoted[1]!.toLowerCase(), name } : null;
  }
  // Unquoted names have a deliberately smaller alphabet and no conjunctions.
  // A different selected-node name cannot be rescued by fresh uniqueness.
  const namePattern = '([\\p{L}\\p{N}][\\p{L}\\p{N} _-]*)';
  const roleFirst = new RegExp(`^${roles}\\s+${introduction}\\s+${namePattern}$`, 'iu').exec(text);
  const roleLast = new RegExp(`^${namePattern}\\s+${roles}(?:\\s+in\\s+(?:the\\s+)?sentence\\s+ending\\s+with\\s+go\\s+${namePattern})?$`, 'iu').exec(text);
  const role = roleFirst?.[1] ?? roleLast?.[2];
  const name = roleFirst?.[2] ?? roleLast?.[1];
  const repeated = roleLast?.[3];
  if (!role || !name || name.length > 512 || name.trim() !== name || /\s{2,}/.test(name) ||
      /\b(?:or|either|another|one of|and)\b/i.test(name) ||
      (repeated !== undefined && repeated !== name)) return null;
  return { role: role.toLowerCase(), name };
}

/**
 * Review an exact role/name candidate against authored target intent and the
 * already-selected snapshot node. M6 must separately measure match count and
 * selected-reference equality for this exact form in the protected page.
 */
export function reviewAuthoredRoleNameIdentity(target: AuthoredRoleNameTarget, form: LocatorForm,
  observation: LocatorObservation): AuthoredRoleNameWitness | null {
  const parsedTarget = TargetSchema.safeParse(target);
  if (!parsedTarget.success || parsedTarget.data.scope?.length) return null;
  const authored = parseAuthoredRoleNameIdentity(parsedTarget.data.description);
  const parsed = LocatorFormSchema.safeParse(form);
  if (!authored || !parsed.success || parsed.data.type !== 'role' || parsed.data.exact !== true ||
      parsed.data.role !== authored.role || parsed.data.name !== authored.name ||
      observation.role !== authored.role || observation.accessibleName !== authored.name ||
      observation.matchCount !== 1 || observation.observedTargetMatches !== true) return null;
  return {
    identityBasis: 'role-and-accessible-name',
    validatedForm: { type: 'role', role: authored.role, name: authored.name, exact: true },
    observed: { role: authored.role, accessibleName: authored.name,
      matchCount: 1, observedTargetMatches: true },
  };
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
  if (form.type === 'rowWithCell') return meaningful(form.cellName) ? 'scoped-role-and-accessible-name' : null;
  if (form.type === 'within') {
    const parent = pageBasis(form.scope, scoped);
    const child = pageBasis(form.target, true);
    return parent && child ? child : null;
  }
  return ordinaryBasis(form, scoped);
}

/** Accept only the reviewed exact-cell row plus exact-link projection after live ref equality. */
export function acceptSemanticRowLocator(rawExpression: string, cellName: string, linkName: string,
  observation: LocatorObservation): AcceptedLocator {
  const raw = assessGeneratedLocator(rawExpression);
  const positionalBase = rawExpression.replace(/\.nth\([0-9]+\)$/, '');
  const positionalForm = positionalBase === rawExpression ? undefined : assessGeneratedLocator(positionalBase).validatedForm;
  const supportedExemplar = (positionalForm?.type === 'role' && positionalForm.role === 'link' && positionalForm.name === linkName) ||
    /^getByRole\('row', \{ name: '[^']+' \}\)\.getByRole\('link'\)$/.test(rawExpression);
  if (raw.status !== 'rejected' || !raw.reasons.includes('UNSUPPORTED_GRAMMAR') ||
      !supportedExemplar ||
      !meaningful(cellName) || !meaningful(linkName) ||
      observation.matchCount !== 1 || observation.observedTargetMatches !== true ||
      observation.role !== 'link' || observation.accessibleName !== linkName) {
    throw new LocatorQualityError(raw);
  }
  return AcceptedLocatorSchema.parse({
    origin: 'semanticRowScope', mcpGeneratedExpression: rawExpression,
    validatedForm: { type: 'within', scope: { type: 'rowWithCell', cellName },
      target: { type: 'role', role: 'link', name: linkName, exact: true } },
    observed: { role: 'link', accessibleName: linkName, matchCount: 1 },
    quality: { status: 'accepted', identityBasis: 'scoped-role-and-accessible-name' },
  });
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
  const reasons: LocatorQualityReason[] = [];
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

/** The collection exception accepts one exact main-document link identity, not positional members. */
export function assessGeneratedLinkCollectionLocator(expression: string, linkName: string,
  observation?: LocatorObservation): QualityAssessment {
  // MCP generates a locator for one exemplar and may append a position for
  // duplicate names. The reviewed assertion persists only the common semantic
  // role/name identity. The suffix is retained as provenance, never replayed.
  const candidate = expression.replace(/\.(?:first|last)\(\)$|\.nth\([0-9]+\)$/, '');
  const base = assessGeneratedLocator(candidate);
  if (!base.validatedForm) return { ...base, expression };
  const parsed = base.validatedForm;
  const identity = parsed.type === 'role' && parsed.role === 'link' &&
    parsed.name === linkName && linkName.trim().length > 0;
  const form: LocatorForm = identity && parsed.type === 'role'
    ? { ...parsed, exact: true } : parsed;
  const reasons: LocatorQualityReason[] = identity ? [] : ['WEAK_IDENTITY'];
  if (observation) {
    if (!Number.isSafeInteger(observation.matchCount) || observation.matchCount < 0) {
      throw new RangeError('matchCount must be a nonnegative safe integer');
    }
    if (observation.matchCount < 1 || observation.observedTargetMatches !== true ||
        observation.role !== 'link' || observation.accessibleName !== linkName) reasons.push('TARGET_MISMATCH');
  }
  return {
    status: reasons.length ? 'rejected' : observation ? 'accepted' : 'pending_live_checks',
    expression, validatedForm: form, reasons,
    checks: {
      grammar: 'passed', identityBasis: identity ? 'role-and-accessible-name' : null,
      durableIdentity: identity ? 'passed' : 'failed', uniqueness: 'not_checked',
      observedTarget: observation ? reasons.includes('TARGET_MISMATCH') ? 'failed' : 'passed' : 'not_checked',
    },
  };
}

export function acceptGeneratedLinkCollectionLocator(expression: string, linkName: string,
  observation: LocatorObservation): AcceptedLinkCollectionLocator {
  const assessment = assessGeneratedLinkCollectionLocator(expression, linkName, observation);
  if (assessment.status !== 'accepted' || !assessment.validatedForm) throw new LocatorQualityError(assessment);
  return AcceptedLinkCollectionLocatorSchema.parse({
    origin: 'mcp', mcpGeneratedExpression: expression, validatedForm: assessment.validatedForm,
    observed: { role: 'link', accessibleName: linkName, matchCount: observation.matchCount },
    quality: { status: 'accepted', identityBasis: 'role-and-accessible-name',
      kind: 'collection', projection: 'exact-role-name-collection' },
  });
}

/** Only the closed collection assertion may compile an absent target for QA evaluation. */
export function acceptAbsentLinkCollectionLocator(linkName: string): AcceptedLinkCollectionLocator {
  if (!linkName.trim()) throw new TypeError('Link collection name has no durable semantic identity');
  return AcceptedLinkCollectionLocatorSchema.parse({
    origin: 'closedZeroMatch',
    validatedForm: { type: 'role', role: 'link', name: linkName, exact: true },
    observed: { role: 'link', accessibleName: linkName, matchCount: 0 },
    quality: { status: 'accepted', identityBasis: 'role-and-accessible-name',
      kind: 'collection', projection: 'closed-assertion-zero-match' },
  });
}
