import type { TestSpecV6V2 } from '../../app/domain/index.js';
import { action, name } from './action-v2-fixtures.js';

/** Reviewed authored dropdown task used for exact source/live interpretation checks. */
export function deferredFiveStepSource(): TestSpecV6V2 {
  const clauses = [
    'Go to https://the-internet.herokuapp.com/',
    'Find and click the link with the text: "Dropdown"',
    'Confirm it takes you to https://the-internet.herokuapp.com/dropdown',
    'From the dropdown, select Option 1.',
    'Verify that Option 1 is selected.',
  ];
  const exactTask = clauses.map((clause, i) => `${i + 1}. ${clause}`).join('\n');
  const link = action([['Find and click', 'effect'], [' the ', 'neutral'], ['link', 'target'],
    [' with the text: "', 'neutral'], ['Dropdown', 'target'], ['"', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'link', sourceSegmentIds: ['p2'] }, name('n', ['p4'], 'Dropdown'),
  ]);
  const choose = action([['From the ', 'context'], ['dropdown', 'target'], [', ', 'neutral'],
    ['select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p3'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'dropdown', sourceSegmentIds: ['p1'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive',
      authoredText: 'From the dropdown', sourceSegmentIds: ['p0', 'p1'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p5'] },
  ]);
  const steps: TestSpecV6V2['steps'] = [
    { id: 's1', type: 'navigate', sourceText: clauses[0]!, sourceInstructionSpan: { start: 0, end: 1 },
      url: 'https://the-internet.herokuapp.com/' },
    { ...link, id: 's2', sourceStepId: 's2' },
    { id: 's3', type: 'verification_goal', sourceText: clauses[2]!, instruction: clauses[2]!,
      sourceInstructionSpan: { start: 0, end: 1 } },
    { ...choose, id: 's4', sourceStepId: 's4' },
    { id: 's5', type: 'verification_goal', verificationVersion: '2', sourceText: clauses[4]!,
      instruction: clauses[4]!, sourceInstructionSpan: { start: 0, end: 1 },
      claim: { kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true,
        optionSourceSpan: { start: 12, end: 20 }, controlConstraints: [] } },
  ];
  const instructionAccounting: TestSpecV6V2['instructionAccounting'] = [];
  let cursor = 0;
  for (const [i, clause] of clauses.entries()) {
    const prefix = `${i + 1}. `;
    instructionAccounting.push({ classification: 'neutral', authoredText: prefix,
      sourceSpan: { start: cursor, end: cursor + prefix.length } });
    cursor += prefix.length;
    const span = { start: cursor, end: cursor + clause.length };
    steps[i]!.sourceInstructionSpan = span;
    instructionAccounting.push({ classification: 'clause', stepId: steps[i]!.id, authoredText: clause, sourceSpan: span });
    cursor = span.end;
    if (i < clauses.length - 1) {
      instructionAccounting.push({ classification: 'neutral', authoredText: '\n', sourceSpan: { start: cursor, end: cursor + 1 } });
      cursor++;
    }
  }
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'live-exact-five-step',
    sourceInstruction: exactTask, executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url: 'about:blank' }, steps, instructionAccounting };
}
