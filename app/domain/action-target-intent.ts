import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const literal = z.string().min(1).max(256).refine((value) => value.trim() === value &&
  !/(?:\b(?:page|document|window)\.|\b(?:getBy\w+|locator|querySelector|evaluate|eval|fetch|Function)\s*\(|\b(?:javascript|css|xpath)\s*[:=]|<\s*script\b|=>|:nth-child\s*\(|(?:^|\s)[#.][A-Za-z][\w-]*\b|\/\/|\[[\w-]+\s*=)/i.test(value),
  'Expected a bounded semantic literal');
const span = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() });
const scopeKind = z.enum(['menu', 'dialog', 'region', 'row', 'frame']);
const role = z.enum(['button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'menuitem', 'radio']);

export const ActionTargetIntentV1Schema = z.strictObject({
  intentVersion: z.literal('1'),
  sourceStepId: identifier,
  operation: z.enum(['click', 'fill', 'select_option']),
  role: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('explicit'), value: role, sourceSpan: span }),
    z.strictObject({ kind: z.literal('unspecified') }),
  ]),
  accessibleName: literal,
  exact: z.literal(true),
  nameSourceSpan: span,
  scope: z.array(z.strictObject({ kind: scopeKind, description: literal, sourceSpan: span })).min(1).max(4).optional(),
});
export type ActionTargetIntentV1 = z.infer<typeof ActionTargetIntentV1Schema>;

/** Frozen v1 eligibility shared by protected binding, trace validation, and fresh compilation. */
export type ActionIdentityRoleV1 = z.infer<typeof role>;
export const ACTION_IDENTITY_ELIGIBLE_ROLES_V1: Record<ActionTargetIntentV1['operation'],
  readonly ActionIdentityRoleV1[]> = {
  click: ['button', 'link', 'checkbox', 'menuitem', 'radio', 'option'],
  fill: ['textbox'], select_option: ['combobox'],
};

export interface ActionIntentStep {
  id: string;
  type: 'click' | 'fill' | 'select_option';
  sourceText: string;
  target: { description: string; scope?: readonly { kind: string; description: string }[] | undefined };
  actionTargetIntent?: ActionTargetIntentV1 | undefined;
}

const roleAliases: Readonly<Record<string, string>> = {
  link: 'link', hyperlink: 'link', button: 'button', textbox: 'textbox', 'text box': 'textbox',
  checkbox: 'checkbox', combobox: 'combobox', option: 'option', menuitem: 'menuitem', 'menu item': 'menuitem', radio: 'radio',
};
const explicitRole = /\b(?:link|hyperlink|button|textbox|text box|checkbox|combobox|option|menuitem|menu item|radio)\b/i;
const operationCues = {
  click: /\b(?:click|open|follow|press|activate|select)\b/i,
  fill: /\b(?:fill|enter|type|input)\b/i,
  select_option: /\b(?:select|choose)\b/i,
} as const;

function spanText(source: string, value: { start: number; end: number }): string | undefined {
  if (value.start >= value.end || value.end > source.length) return undefined;
  return source.slice(value.start, value.end);
}

/** Interpretation-boundary fidelity; no downstream compiler should parse sourceText. */
export function actionTargetIntentFidelity(step: ActionIntentStep, sourceInstruction: string): string | undefined {
  const intent = step.actionTargetIntent;
  if (!intent) return 'MISSING_ACTION_TARGET_INTENT';
  if (!sourceInstruction.replace(/\s+/g, ' ').includes(step.sourceText.replace(/\s+/g, ' ')))
    return 'ACTION_CLAUSE_NOT_AUTHORED';
  if (intent.sourceStepId !== step.id || intent.operation !== step.type) return 'ACTION_LINKAGE_MISMATCH';
  if (spanText(step.sourceText, intent.nameSourceSpan) !== intent.accessibleName ||
      step.sourceText.indexOf(intent.accessibleName) !== intent.nameSourceSpan.start ||
      step.sourceText.indexOf(intent.accessibleName, intent.nameSourceSpan.end) !== -1)
    return 'NAME_NOT_GROUNDED';
  if (step.target.description !== intent.accessibleName) return 'TARGET_DESCRIPTION_MISMATCH';
  // A literal name span proves where the proposed name came from, but not
  // whether the clause requested or excluded it. Defer contrast/negation to
  // interpretation instead of authorizing either alternative as a target.
  const outsideName = step.sourceText.slice(0, intent.nameSourceSpan.start) +
    ' '.repeat(intent.nameSourceSpan.end - intent.nameSourceSpan.start) +
    step.sourceText.slice(intent.nameSourceSpan.end);
  if (/\b(?:or|not|never|except|rather|instead|avoid|without|excluding)\b/i.test(outsideName))
    return 'AMBIGUOUS_ACTION_TARGET';
  const authoredRoles = [...step.sourceText.matchAll(new RegExp(explicitRole.source, 'gi'))]
    .filter((match) => match.index < intent.nameSourceSpan.start ||
      match.index >= intent.nameSourceSpan.end)
    .map((match) => roleAliases[match[0].toLocaleLowerCase('en-US')]);
  if (new Set(authoredRoles).size > 1)
    return 'AMBIGUOUS_ACTION_TARGET';
  const authoredRole = authoredRoles[0];
  if (intent.role.kind === 'explicit') {
    const roleSource = spanText(step.sourceText, intent.role.sourceSpan)?.toLocaleLowerCase('en-US');
    const before = step.sourceText[intent.role.sourceSpan.start - 1] ?? '';
    const after = step.sourceText[intent.role.sourceSpan.end] ?? '';
    if (!roleSource || roleAliases[roleSource] !== intent.role.value ||
        /[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after) ||
        (intent.role.sourceSpan.start < intent.nameSourceSpan.end &&
          intent.role.sourceSpan.end > intent.nameSourceSpan.start) ||
        (authoredRole && authoredRole !== intent.role.value)) return 'ROLE_NOT_GROUNDED';
  } else if (authoredRole) return 'EXPLICIT_ROLE_OMITTED';
  if (!operationCues[step.type].test(step.sourceText)) return 'OPERATION_NOT_GROUNDED';
  if (step.type === 'select_option' && /\b(?:link|hyperlink|button)\b/i.test(step.sourceText))
    return 'OPERATION_CONTRADICTION';
  if (step.type === 'click' && /\b(?:fill|enter|type|input|choose)\b/i.test(step.sourceText))
    return 'OPERATION_CONTRADICTION';
  const scope = intent.scope ?? [];
  if (JSON.stringify(step.target.scope ?? []) !== JSON.stringify(scope.map(({ kind, description }) => ({ kind, description }))))
    return 'SCOPE_MISMATCH';
  for (const item of scope) {
    if (spanText(step.sourceText, item.sourceSpan) !== item.description ||
        !step.sourceText.toLocaleLowerCase('en-US').includes(item.kind)) return 'SCOPE_NOT_GROUNDED';
  }
  if (scope.length === 0 && /\b(?:inside|within|in the|from the)\s+(?:[^.!?]{0,50})\b(?:menu|dialog|region|row|frame)\b/i.test(step.sourceText))
    return 'SCOPE_OMITTED';
  return undefined;
}
