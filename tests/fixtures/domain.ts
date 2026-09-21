import { parseTestSpec, type AuthoredStep } from '../../app/domain/index.js';

export const authoredSteps: AuthoredStep[] = [
  { id: 's1', type: 'navigate', sourceText: 'Go to example.com', url: 'https://example.com' },
  { id: 's2', type: 'click', sourceText: 'Select Admin from the top-right menu', target: { description: 'Admin', scope: [{ kind: 'menu', description: 'top-right menu' }] } },
  { id: 's3', type: 'fill', sourceText: 'Enter Alice in Name', target: { description: 'Name' }, value: 'Alice' },
  { id: 's4', type: 'select_option', sourceText: 'Set Role to User', target: { description: 'Role' }, value: 'User' },
  { id: 's5', type: 'assert_visible', sourceText: 'Check Admin is visible', target: { description: 'Admin' } },
  { id: 's6', type: 'assert_text', sourceText: 'Check status contains saved', target: { description: 'status' }, expectedText: 'Saved', match: 'contains' },
  { id: 's7', type: 'assert_value', sourceText: 'Check Role value is User', target: { description: 'Role' }, expectedValue: 'User' },
  { id: 's8', type: 'assert_url', sourceText: 'Check URL', expectedUrl: 'https://example.com/orders/*', match: 'pattern' },
  { id: 's9', type: 'wait_for', sourceText: 'Wait for Continue', condition: { type: 'target_visible', target: { description: 'Continue button' } }, timeoutPolicyRef: 'default' },
  { id: 's10', type: 'wait_for', sourceText: 'Wait for Settings URL', condition: { type: 'url_exact', url: 'https://example.com/settings' }, timeoutPolicyRef: 'default' },
  { id: 's11', type: 'wait_for', sourceText: 'Wait for Orders URL', condition: { type: 'url_pattern', pattern: 'https://example.com/orders/*' }, timeoutPolicyRef: 'default' },
  { id: 's12', type: 'wait_for', sourceText: 'Wait for User value', condition: { type: 'target_value', target: { description: 'Role' }, expectedValue: 'User' }, timeoutPolicyRef: 'default' },
];

export function makeTestSpec() {
  return parseTestSpec({
    schemaVersion: '2',
    testSpecId: 'test-123',
    sourceInstruction: 'Go to example.com. Select Admin and check the form.',
    executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url: 'about:blank' },
    steps: authoredSteps,
  });
}

const locator = {
  mcpGeneratedExpression: "getByRole('button', { name: 'Admin' })",
  validatedForm: { type: 'role', role: 'button', name: 'Admin' },
  observed: { role: 'button', accessibleName: 'Admin', matchCount: 1 },
  quality: { status: 'accepted', identityBasis: 'role-and-accessible-name' },
};

export function makeResolvedSpec() {
  const spec = makeTestSpec();
  const executionSteps: object[] = [];
  for (const [index, step] of spec.steps.entries()) {
    const common = {
      id: `x${index + 1}`,
      originStepId: step.id,
      source: 'authored',
      derivationEvidenceRef: `evidence/explore-789/x${index + 1}.json`,
    };
    const target = 'target' in step ? { locatorId: `loc-${index + 1}`, targetDescription: step.target.description, locator } : {};
    switch (step.type) {
      case 'navigate': executionSteps.push({ ...common, type: step.type, url: step.url }); break;
      case 'click': executionSteps.push({ ...common, ...target, type: step.type }); break;
      case 'fill':
      case 'select_option': executionSteps.push({ ...common, ...target, type: step.type, value: step.value }); break;
      case 'assert_visible': executionSteps.push({ ...common, ...target, type: step.type }); break;
      case 'assert_text': executionSteps.push({ ...common, ...target, type: step.type, expectedText: step.expectedText, match: step.match }); break;
      case 'assert_value': executionSteps.push({ ...common, ...target, type: step.type, expectedValue: step.expectedValue }); break;
      case 'assert_url': executionSteps.push({ ...common, type: step.type, expectedUrl: step.expectedUrl, match: step.match }); break;
      case 'wait_for': {
        const waitTarget = step.condition.type === 'target_visible' || step.condition.type === 'target_value'
          ? { locatorId: `loc-${index + 1}`, targetDescription: step.condition.target.description, locator }
          : {};
        executionSteps.push({ ...common, ...waitTarget, type: step.type, condition: step.condition, timeoutPolicyRef: step.timeoutPolicyRef });
        break;
      }
    }
  }
  return {
    schemaVersion: '2', resolvedSpecId: 'resolved-456', testSpecId: spec.testSpecId,
    explorationAttemptId: 'explore-789', executionProfileRef: spec.executionProfileRef,
    runtimeVersions: { playwright: '1.63.0', mcp: 'pinned', runner: '1' },
    executionSteps,
  };
}
