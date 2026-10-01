import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const prose = z.string().trim().min(1).max(1024).refine((value) =>
  !/(?:\b(?:page|document|window)\.[\w$]+|\b(?:getBy\w+|locator|querySelector|evaluate|eval|fetch|Function)\s*\(|\b(?:javascript|css|xpath)\s*[:=]|<\s*script\b|=>|:nth-child\s*\()/i.test(value),
  'Executable code or selector syntax is not allowed');

export const VerificationGoalSubjectSchema = z.strictObject({
  role: z.enum(['button', 'link', 'dialog', 'row', 'textbox', 'checkbox', 'heading']).optional(),
  accessibleName: prose.optional(),
  scope: z.array(z.strictObject({
    kind: z.enum(['menu', 'dialog', 'region', 'row', 'frame']), description: prose,
  })).min(1).max(4).optional(),
}).refine((subject) => !!(subject.role || subject.accessibleName || subject.scope),
  'Empty subject hint is not useful');

export const VerificationGoalIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('presence'), expected: z.enum(['present', 'absent']) }),
  z.strictObject({ kind: z.literal('property'), property: z.enum(['visible', 'enabled', 'checked']), expected: z.boolean() }),
  z.strictObject({ kind: z.literal('cardinality'), comparison: z.enum(['equal', 'at_least', 'at_most']), count: z.number().int().nonnegative().max(1000) }),
  z.strictObject({ kind: z.literal('relationship'), relation: z.enum(['above', 'below', 'before', 'after']), other: prose }),
  z.strictObject({ kind: z.literal('temporal'), transition: z.enum(['appears', 'disappears']) }),
]);

export const VerificationGoalSchema = z.strictObject({
  id: identifier, type: z.literal('verification_goal'), sourceText: prose,
  instruction: prose, subject: VerificationGoalSubjectSchema.optional(),
  intent: VerificationGoalIntentSchema.optional(),
  dependsOnStepId: identifier.optional(),
});
export type VerificationGoal = z.infer<typeof VerificationGoalSchema>;

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').toLocaleLowerCase('en-US');
const words = (value: string) => normalized(value).replace(/[“”"']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const containsPhrase = (source: string, phrase: string) => ` ${words(source)} `.includes(` ${words(phrase)} `);
const negative = /\b(?:does\s+not|do\s+not|is\s+not|are\s+not|isn't|aren't|doesn't|without|no|absent|missing|none|zero|disappear(?:s|ed)?|vanish(?:es|ed)?)\b/i;
const positivePresence = /\b(?:exist(?:s)?|present|appear(?:s)?|there\s+(?:is|are))\b/i;
const negativePresence = /\b(?:does\s+not\s+exist|do\s+not\s+exist|not\s+present|no\b|absent|missing|none|zero)\b/i;

/** Hints only narrow authored intent. Unsupported wording remains an unhinted goal. */
export function verificationGoalFidelity(goal: VerificationGoal, sourceInstruction: string,
  previousStepIds: readonly string[]): string | undefined {
  const clause = goal.sourceText;
  if (!normalized(sourceInstruction).includes(normalized(clause))) return 'SOURCE_CLAUSE_NOT_AUTHORED';
  if (normalized(goal.instruction) !== normalized(clause)) return 'TRANSFORMED_VERIFICATION_CLAUSE';
  if (goal.dependsOnStepId && !previousStepIds.includes(goal.dependsOnStepId)) return 'INVALID_STEP_DEPENDENCY';
  if (!/\b(?:confirm|verify|check|assert|make\s+sure|ensure|should|must)\b/i.test(clause))
    return 'AMBIGUOUS_VERIFICATION_INTENT';
  if (/^(?:confirm|verify|check|assert|ensure|make\s+sure)\s+(?:it|this|that|the\s+result)(?:\s+(?:is|are|exist(?:s)?|does|has|was|will|should|must)\b|$)/i.test(normalized(clause)))
    return 'AMBIGUOUS_VERIFICATION_INTENT';
  const subject = goal.subject;
  if (subject?.role && !containsPhrase(clause, subject.role) &&
      !(subject.role === 'dialog' && containsPhrase(clause, 'modal')))
    return 'ROLE_HINT_NOT_AUTHORED';
  if (subject?.accessibleName && !containsPhrase(clause, subject.accessibleName))
    return 'SUBJECT_HINT_NOT_AUTHORED';
  if (subject?.role && subject.accessibleName) {
    const clauseWords = words(clause);
    const roleAt = clauseWords.indexOf(words(subject.role));
    const nameAt = clauseWords.indexOf(words(subject.accessibleName));
    const between = clauseWords.slice(Math.min(roleAt, nameAt), Math.max(roleAt, nameAt));
    if (roleAt < 0 || nameAt < 0 || between.length > 48 ||
        /\b(?:button|link|dialog|row|textbox|checkbox|heading)\b/.test(
          between.replace(new RegExp(`\\b${subject.role}\\b`, 'g'), '')))
      return 'ROLE_NAME_HINT_AMBIGUOUS';
  }
  if (subject?.scope?.some((scope) => !containsPhrase(clause, scope.description) ||
    !containsPhrase(clause, scope.kind))) return 'SCOPE_HINT_NOT_AUTHORED';
  if (subject?.scope && /\b(?:or|either)\b/i.test(clause)) return 'AMBIGUOUS_SCOPE_HINT';
  const hint = goal.intent;
  if (!hint) return undefined;
  if (hint.kind === 'presence') {
    if (hint.expected === 'present' && (negative.test(clause) || !positivePresence.test(clause)))
      return 'POLARITY_CONTRADICTION';
    if (hint.expected === 'absent' && !negativePresence.test(clause)) return 'POLARITY_CONTRADICTION';
  }
  if (hint.kind === 'property') {
    if (hint.expected && negativePresence.test(clause)) return 'POLARITY_CONTRADICTION';
    const named = hint.property === 'visible' ? /\b(?:visible|hidden|invisible)\b/i :
      hint.property === 'enabled' ? /\b(?:enabled|disabled)\b/i : /\b(?:checked|unchecked)\b/i;
    if (!named.test(clause)) return 'PROPERTY_HINT_NOT_AUTHORED';
    const falseWord = hint.property === 'visible' ? /\b(?:hidden|invisible|not\s+visible)\b/i :
      hint.property === 'enabled' ? /\b(?:disabled|not\s+enabled)\b/i : /\b(?:unchecked|not\s+checked)\b/i;
    if (hint.expected === false && !falseWord.test(clause) || hint.expected === true && falseWord.test(clause))
      return 'POLARITY_CONTRADICTION';
  }
  if (hint.kind === 'cardinality') {
    const number = String(hint.count);
    const spelled: Record<number, string> = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
    if (!containsPhrase(clause, number) && (!spelled[hint.count] || !containsPhrase(clause, spelled[hint.count]!)))
      return 'COUNT_HINT_NOT_AUTHORED';
    if (hint.comparison === 'equal' && !/\b(?:exactly|equal\s+to)\b/i.test(clause) ||
        hint.comparison === 'at_least' && !/\b(?:at\s+least|or\s+more)\b/i.test(clause) ||
        hint.comparison === 'at_most' && !/\b(?:at\s+most|or\s+fewer)\b/i.test(clause))
      return 'COUNT_COMPARISON_NOT_AUTHORED';
  }
  if (hint.kind === 'relationship' && (!containsPhrase(clause, hint.relation) || !containsPhrase(clause, hint.other)))
    return 'RELATIONSHIP_HINT_NOT_AUTHORED';
  if (hint.kind === 'temporal' && !containsPhrase(clause, hint.transition))
    return 'TEMPORAL_HINT_NOT_AUTHORED';
  if (/\bdisappear(?:s|ed)?\b/i.test(clause) && hint.kind !== 'temporal')
    return 'TEMPORAL_INTENT_LOST';
  return undefined;
}
