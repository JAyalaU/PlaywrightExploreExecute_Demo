import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
export const SourceSpanSchema = z.strictObject({
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).refine(({ start, end }) => start < end, 'Expected a nonempty source span');

const executable = /(?:\b(?:page|document|window)\.[\w$]+|\b(?:getBy\w+|locator|querySelector|evaluate|eval|alert|fetch|Function)\s*\(|\b(?:javascript|css|xpath)\s*[:=]|<\s*script\b|=>|:nth-child\s*\(|(?:^|\s)[#.][A-Za-z][\w-]*\b|\/\/|\[[\w-]+\s*=)/i;
const text = z.string().min(1).max(1024).refine((value) => value.trim() === value,
  'Expected exact bounded authored text');
const literalData = z.string().min(1).max(1024);
const semanticText = text.refine((value) => !executable.test(value), 'Code or selector syntax is not semantic intent');
const authoredPhrase = z.strictObject({ authoredText: semanticText, sourceSpan: SourceSpanSchema });

/** Source semantics only. Role/name words are authored phrases, never browser facts. */
export const ActionGoalV1Schema = z.strictObject({
  id: identifier, type: z.literal('action_goal'), goalVersion: z.literal('1'),
  sourceStepId: identifier, sourceText: text,
  sourceInstructionSpan: SourceSpanSchema,
  effect: z.enum(['activate', 'enter_text', 'choose']), effectSourceSpan: SourceSpanSchema,
  explicitOperation: z.strictObject({
    operation: z.enum(['click', 'fill', 'select_option']), sourceSpan: SourceSpanSchema,
  }).optional(),
  argument: z.strictObject({
    purpose: z.enum(['entered_text', 'choice']), authoredText: literalData,
    sourceSpan: SourceSpanSchema,
  }).optional(),
  targetConstraints: z.array(z.strictObject({
    kind: z.enum(['role', 'name', 'context', 'relationship', 'uniqueness']),
    authoredText: semanticText, sourceSpan: SourceSpanSchema, polarity: z.literal('positive'),
  })).max(24),
  prerequisiteContext: authoredPhrase.optional(),
});
export type ActionGoalV1 = z.infer<typeof ActionGoalV1Schema>;
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export function sourceSpanText(source: string, span: SourceSpan): string | undefined {
  return span.start < span.end && span.end <= source.length ? source.slice(span.start, span.end) : undefined;
}
const overlap = (a: SourceSpan, b: SourceSpan) => a.start < b.end && b.start < a.end;
const contains = (outer: SourceSpan, inner: SourceSpan) => outer.start <= inner.start && outer.end >= inner.end;
const roleWords = /\b(?:button|link|hyperlink|textbox|text field|text box|field|input|dropdown|combobox|listbox|checkbox|radio|menu item|menuitem|menu|dialog|region|row|frame)\b/gi;
const effects: Readonly<Record<ActionGoalV1['effect'], RegExp>> = {
  activate: /^(?:click|open|press|activate|follow)$/i,
  enter_text: /^(?:fill|enter|type|input)$/i,
  choose: /^(?:select|choose|pick|select_option)$/i,
};
const operations = { click: /^click$/i, fill: /^fill$/i, select_option: /^select_option$/i } as const;
const connective = /^(?:the|a|an|on|in|into|to|from|with|of|for|please|and|then)$/i;
const ambiguity = /\b(?:not|never|except|rather|instead|avoid|without|excluding|or|either)\b/i;
const multipleEffects = /\b(?:and|then)\s+(?:click|fill|open|enter|type|input|press|activate|follow|choose|select|pick)\b/i;
function quoted(source: string, span: SourceSpan): boolean {
  return /["'“]/.test(source[span.start - 1] ?? '') && /["'”]/.test(source[span.end] ?? '');
}
/** Find source grammar delimiters without interpreting quoted literal payload. */
function unquotedDelimiter(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const quotedSpans: SourceSpan[] = [];
  let opening: { start: number; closing: string } | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') { index += 1; continue; }
    if (opening) {
      if (character === opening.closing) {
        quotedSpans.push({ start: opening.start, end: index + 1 });
        opening = undefined;
      }
    } else if ((character === '"' || character === "'" || character === '“') &&
        (index === 0 || /[\s(]/.test(source[index - 1] ?? ''))) {
      opening = { start: index, closing: character === '“' ? '”' : character };
    }
  }
  if (opening) quotedSpans.push({ start: opening.start, end: source.length });
  const matches = new RegExp(pattern.source, 'gi');
  for (let match = matches.exec(source); match; match = matches.exec(source)) {
    if (!quotedSpans.some((span) => span.start <= match.index && match.index < span.end)) return match;
  }
  return undefined;
}

/** No browser information is needed or accepted. Unclear source semantics fail closed. */
export function actionGoalFidelity(goal: ActionGoalV1, sourceInstruction: string): string | undefined {
  const source = goal.sourceText;
  if (sourceSpanText(sourceInstruction, goal.sourceInstructionSpan) !== source) return 'SOURCE_CLAUSE_NOT_AUTHORED';
  if (goal.sourceStepId !== goal.id) return 'ACTION_LINKAGE_MISMATCH';
  const effectText = sourceSpanText(source, goal.effectSourceSpan);
  if (!effectText || !effects[goal.effect].test(effectText)) return 'EFFECT_NOT_AUTHORED';
  // One goal owns one effect. Ordered multi-effect clauses must be segmented.
  const covered: SourceSpan[] = [goal.effectSourceSpan];
  const argument = goal.argument;
  if (goal.effect === 'activate' ? !!argument : !argument) return 'ARGUMENT_EFFECT_MISMATCH';
  if (goal.effect !== 'choose' && goal.targetConstraints.length === 0) return 'MISSING_AUTHORED_TARGET_INTENT';
  if (argument) {
    if (argument.purpose !== (goal.effect === 'choose' ? 'choice' : 'entered_text') ||
        sourceSpanText(source, argument.sourceSpan) !== argument.authoredText ||
        overlap(argument.sourceSpan, goal.effectSourceSpan)) return 'ARGUMENT_NOT_AUTHORED';
    if (goal.effect === 'choose' && ambiguity.test(argument.authoredText) && !quoted(source, argument.sourceSpan))
      return 'AMBIGUOUS_CHOICE_ARGUMENT';
    if (multipleEffects.test(argument.authoredText) && !quoted(source, argument.sourceSpan))
      return 'MULTIPLE_ACTION_EFFECTS';
    // Literal payload is data, even when it resembles a selector or code.
    covered.push(argument.sourceSpan);
    const afterVerb = source.slice(goal.effectSourceSpan.end);
    const delimiter = goal.effect === 'choose' ? /\s+(?:from|in)\s+/i :
      /^fill$/i.test(effectText) ? /\s+with\s+/i : /\s+(?:in|into)\s+/i;
    const match = unquotedDelimiter(afterVerb, delimiter);
    const boundary = match ? goal.effectSourceSpan.end + match.index : undefined;
    const afterBoundary = match && boundary !== undefined ? boundary + match[0].length : undefined;
    if (/^fill$/i.test(effectText)) {
      if (afterBoundary === undefined || argument.sourceSpan.start < afterBoundary)
        return 'ARGUMENT_TARGET_CONFLATION';
    } else if (argument.sourceSpan.start <= goal.effectSourceSpan.end ||
        boundary !== undefined && argument.sourceSpan.end > boundary) return 'ARGUMENT_TARGET_CONFLATION';
    const regionStart = /^fill$/i.test(effectText) && afterBoundary !== undefined ? afterBoundary : goal.effectSourceSpan.end;
    const regionEnd = /^fill$/i.test(effectText) ? source.length : boundary ?? source.length;
    const unassigned = source.slice(regionStart, argument.sourceSpan.start) + source.slice(argument.sourceSpan.end, regionEnd);
    if (!/^[\s"'“”.,!?]*$/.test(unassigned)) return 'ARGUMENT_TARGET_CONFLATION';
    if (goal.targetConstraints.some((item) => /^fill$/i.test(effectText) ? boundary !== undefined && item.sourceSpan.end > boundary :
      boundary === undefined || item.sourceSpan.start < boundary)) return 'ARGUMENT_TARGET_CONFLATION';
  }
  if (goal.explicitOperation) {
    const operationText = sourceSpanText(source, goal.explicitOperation.sourceSpan);
    if (!operationText || !operations[goal.explicitOperation.operation].test(operationText) ||
        !contains(goal.effectSourceSpan, goal.explicitOperation.sourceSpan) ||
        goal.explicitOperation.operation !== (goal.effect === 'activate' ? 'click' :
          goal.effect === 'enter_text' ? 'fill' : 'select_option')) return 'OPERATION_CONTRADICTION';
  }
  const explicit = /^click$/i.test(effectText) ? 'click' : /^fill$/i.test(effectText) ? 'fill' :
    /^select_option$/i.test(effectText) ? 'select_option' : undefined;
  if (explicit && goal.explicitOperation?.operation !== explicit) return 'EXPLICIT_OPERATION_OMITTED';

  let previousStart = -1;
  const constraintSpans = new Set<string>();
  for (const constraint of goal.targetConstraints) {
    if (sourceSpanText(source, constraint.sourceSpan) !== constraint.authoredText)
      return 'CONSTRAINT_NOT_AUTHORED';
    if (constraint.sourceSpan.start < previousStart) return 'CONSTRAINT_ORDER_MISMATCH';
    previousStart = constraint.sourceSpan.start;
    const spanKey = `${constraint.sourceSpan.start}:${constraint.sourceSpan.end}`;
    if (constraintSpans.has(spanKey)) return 'DUPLICATE_CONSTRAINT';
    constraintSpans.add(spanKey);
    if (overlap(constraint.sourceSpan, goal.effectSourceSpan) ||
        argument && overlap(constraint.sourceSpan, argument.sourceSpan)) return 'ARGUMENT_TARGET_CONFLATION';
    if (constraint.kind === 'role' && !new RegExp(`^(?:${roleWords.source.slice(2, -2)})$`, 'i').test(constraint.authoredText))
      return 'ROLE_NOT_AUTHORED';
    if (constraint.kind === 'uniqueness' && !/\b(?:only|sole|single|unique)\b/i.test(constraint.authoredText))
      return 'UNIQUENESS_NOT_AUTHORED';
    if (constraint.kind === 'name' && ambiguity.test(constraint.authoredText) && !quoted(source, constraint.sourceSpan))
      return 'CONTRADICTORY_CONSTRAINTS';
    if (constraint.kind === 'name' && multipleEffects.test(constraint.authoredText) &&
        !quoted(source, constraint.sourceSpan)) return 'MULTIPLE_ACTION_EFFECTS';
    if (constraint.kind === 'context' && !/^(?:in|inside|within|from|under|on|at)\b/i.test(constraint.authoredText))
      return 'CONTEXT_NOT_AUTHORED';
    if (constraint.kind === 'relationship' && !/\b(?:next to|associated with|labelled|labeled|belongs to|belonging to|contained in|owned by)\b/i.test(constraint.authoredText))
      return 'RELATIONSHIP_NOT_AUTHORED';
    covered.push(constraint.sourceSpan);
  }
  if (goal.prerequisiteContext) {
    if (sourceSpanText(source, goal.prerequisiteContext.sourceSpan) !== goal.prerequisiteContext.authoredText ||
        overlap(goal.prerequisiteContext.sourceSpan, goal.effectSourceSpan) ||
        argument && overlap(goal.prerequisiteContext.sourceSpan, argument.sourceSpan) ||
        !/^(?:after|before|once|when|if)\b/i.test(goal.prerequisiteContext.authoredText)) return 'CONTEXT_NOT_AUTHORED';
    covered.push(goal.prerequisiteContext.sourceSpan);
  }
  for (const [index, left] of goal.targetConstraints.entries()) {
    for (const right of goal.targetConstraints.slice(index + 1)) {
      if (!overlap(left.sourceSpan, right.sourceSpan)) continue;
      const container = contains(left.sourceSpan, right.sourceSpan) ? left : contains(right.sourceSpan, left.sourceSpan) ? right : undefined;
      if (!container || !['context', 'relationship', 'uniqueness'].includes(container.kind))
        return 'CONTRADICTORY_CONSTRAINT_SPANS';
    }
  }
  const roles: string[] = [];
  for (const match of source.matchAll(roleWords)) {
    const at = { start: match.index, end: match.index + match[0].length };
    if (argument && contains(argument.sourceSpan, at)) continue;
    // Roles in named quoted literals are text, not invented browser-role facts.
    const quotedName = goal.targetConstraints.some((item) => item.kind === 'name' && contains(item.sourceSpan, at) &&
      quoted(source, item.sourceSpan));
    if (quotedName) continue;
    if (!goal.targetConstraints.some((item) => item.kind === 'role' && contains(item.sourceSpan, at)))
      return 'EXPLICIT_ROLE_OMITTED';
    if (!goal.targetConstraints.some((item) => (item.kind === 'context' || item.kind === 'relationship') && contains(item.sourceSpan, at)))
      roles.push(match[0].toLocaleLowerCase('en-US'));
  }
  if (new Set(roles).size > 1) return 'CONTRADICTORY_CONSTRAINTS';
  // Coverage prevents deleting explicit names, contexts or relationships. It does
  // not convert those phrases into accessible names, selectors or browser roles.
  for (const match of source.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const at = { start: match.index, end: match.index + match[0].length };
    const owning = goal.targetConstraints.filter((item) => contains(item.sourceSpan, at));
    if (argument && contains(argument.sourceSpan, at)) continue;
    if (ambiguity.test(match[0]) && !owning.some((item) => item.kind === 'name' &&
        quoted(source, item.sourceSpan)))
      return 'AMBIGUOUS_OR_NEGATED_ACTION';
    if (/^(?:in|inside|within|from|under)$/i.test(match[0]) &&
        !owning.some((item) => item.kind === 'context' || item.kind === 'relationship' ||
          item.kind === 'name' && quoted(source, item.sourceSpan)) &&
        !(goal.prerequisiteContext && contains(goal.prerequisiteContext.sourceSpan, at)))
      return 'EXPLICIT_CONTEXT_OMITTED';
    if (/^(?:only|sole|single|unique)$/i.test(match[0]) && !owning.some((item) => item.kind === 'uniqueness'))
      return 'EXPLICIT_UNIQUENESS_OMITTED';
    if (!covered.some((span) => contains(span, at)) && !connective.test(match[0])) return 'AUTHORED_CONSTRAINT_OMITTED';
  }
  const outsideArgument = argument ? source.slice(0, argument.sourceSpan.start) + ' '.repeat(argument.authoredText.length) + source.slice(argument.sourceSpan.end) : source;
  if (executable.test(outsideArgument)) return 'EXECUTABLE_SOURCE_INTENT';
  return undefined;
}
