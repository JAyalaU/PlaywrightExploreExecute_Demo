import { importProduct } from '../../paths.mjs';
/** Deterministic TEST_FIXTURE_ONLY semantic source; never a production fidelity artifact. */
import { randomUUID } from 'node:crypto';

const [{ admitSemanticIntentV3 }, { normalizeSemanticIntentV3 }, relations] = await Promise.all([
  importProduct('domain/semantic-intent-v3.js'),
  importProduct('interpretation/semantic-intent-v3.js'),
  importProduct('interpretation/semantic-intent-v3-relations.js'),
]);

export const authored = `Go to https://the-internet.herokuapp.com/\nFind and activate the link named "Add/Remove Elements".\nVerify that the current URL is https://the-internet.herokuapp.com/add_remove_elements/\nActivate the "Add Element" button twice.\nVerify that exactly two "Delete" buttons exist.\nActivate the first "Delete" button.\nVerify that exactly one "Delete" button exists.`;
export const publicRoot = 'https://the-internet.herokuapp.com/';
export const destination = 'https://the-internet.herokuapp.com/add_remove_elements/';
export const expectedSemanticDigest = '154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d';

const target = (category, exactName = null, ordinal = null) => ({ category, exactName,
  context: null, ordinal, relation: 'unspecified', relatedStepId: null });
const nav = (id, url, authoredText, dependsOnStepId = null) =>
  ({ id, type: 'navigate', authoredText, url, dependsOnStepId });
const action = (id, authoredText, targetValue, dependsOnStepId) => ({ id, type: 'action_intent',
  authoredText, target: targetValue, desiredEffect: 'activate', value: null, checkedState: null,
  authoredMechanic: null, dependsOnStepId });
const verify = (id, authoredText, subject, observable, expected, dependsOnStepId) => ({ id,
  type: 'verification_intent', authoredText, subject, observable, comparator: 'equals', expected,
  dependsOnStepId });

export function createSemanticGroundingTestFixtureSourceV1(testSpecId =
  `semanticGroundingTestFixture${randomUUID().replaceAll('-', '')}`) {
  const source = { testSpecId, sourceInstruction: authored,
    executionProfileRef: { id: 'semantic-stability-experiment', version: '1' },
    startState: { url: 'about:blank' } };
  const steps = [
    nav('s1', publicRoot, 'Go to https://the-internet.herokuapp.com/'),
    action('s2', 'Find and activate the link named "Add/Remove Elements".',
      target('link', 'Add/Remove Elements'), 's1'),
    verify('s3', 'Verify that the current URL is https://the-internet.herokuapp.com/add_remove_elements/',
      null, 'url', destination, 's2'),
    action('s4', 'Activate the "Add Element" button twice.', target('button', 'Add Element'), 's3'),
    action('s5', 'Activate the "Add Element" button twice.', target('button', 'Add Element'), 's4'),
    verify('s6', 'Verify that exactly two "Delete" buttons exist.',
      target('button', 'Delete'), 'cardinality', 2, 's5'),
    action('s7', 'Activate the first "Delete" button.', target('button', 'Delete', 1), 's6'),
    verify('s8', 'Verify that exactly one "Delete" button exists.',
      target('button', 'Delete'), 'cardinality', 1, 's7'),
  ];
  const normalized = normalizeSemanticIntentV3(source, { response: { kind: 'extraction', steps } });
  const semanticDigest = relations.semanticIntentCanonicalDigestV3(normalized);
  if (normalized.steps.length !== 8 || semanticDigest !== expectedSemanticDigest)
    throw new Error('TEST_FIXTURE_ONLY_SEMANTIC_DIGEST_MISMATCH');
  return { source, normalized, semanticDigest,
    admissionForAttempt: () => admitSemanticIntentV3(source, normalized,
      { verdict: 'faithful', issues: [] }) };
}
