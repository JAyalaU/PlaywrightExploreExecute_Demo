import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseResolvedTestSpec, parseTestSpec } from '../app/domain/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { resolveAndReplay } from '../app/exploration/index.js';
import { interpretTask } from '../app/interpretation/interpret.js';
import { normalizeInterpretationWire } from '../app/interpretation/openai-wire.js';
import { acceptAbsentLinkCollectionLocator, acceptGeneratedLinkCollectionLocator, assessGeneratedLinkCollectionLocator } from '../app/locator/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { executeResolvedTestSpec, replayTwice } from '../app/runner/index.js';

const linkName = 'Frank da Cruz';
const expression = "getByRole('link', { name: 'Frank da Cruz', exact: true })";

function assertion(url: string, schemaVersion = '3') {
  return {
    schemaVersion, testSpecId: 'test-links',
    sourceInstruction: `Confirm that two hyperlinks that say "${linkName}" take you to ${url}`,
    executionProfileRef: { id: 'links', version: '1' },
    startState: { url: `${url}sample.html` },
    steps: [{ id: 's1', type: 'assert_link_collection', sourceText: `Confirm that two hyperlinks that say "${linkName}" take you to ${url}`,
      linkName, expectedCount: 2, expectedHref: url }],
  };
}

function resolved(source: ReturnType<typeof parseTestSpec>) {
  const locator = acceptGeneratedLinkCollectionLocator(expression, linkName, {
    matchCount: 2, observedTargetMatches: true, role: 'link', accessibleName: linkName,
  });
  return parseResolvedTestSpec({
    schemaVersion: '3', resolvedSpecId: 'resolved-links', testSpecId: source.testSpecId,
    explorationAttemptId: 'explore-links', executionProfileRef: source.executionProfileRef,
    runtimeVersions: { playwright: '1.63.0', mcp: 'fixture', runner: '1' },
    executionSteps: [{ id: 'x1', originStepId: 's1', source: 'authored',
      derivationEvidenceRef: 'evidence/explore-links/x1.json',
      type: 'assert_link_collection', locatorId: 'loc-links', targetDescription: linkName,
      locator, linkName, expectedCount: 2, expectedHref: source.steps[0]!.type === 'assert_link_collection'
        ? source.steps[0]!.expectedHref : '' }],
  }, source);
}

test('C keeps the versioned collection contract closed and rejects weak identities', () => {
  const url = 'https://www.columbia.edu/~fdc/';
  const source = parseTestSpec(assertion(url));
  expect(source.schemaVersion).toBe('3');
  expect(() => parseTestSpec(assertion(url, '2'))).toThrow();
  expect(() => parseTestSpec({ ...assertion(url), steps: [{ ...assertion(url).steps[0], expectedCount: 3 }] })).toThrow();
  expect(() => parseTestSpec({ ...assertion(url), steps: [{ ...assertion(url).steps[0], selector: 'a' }] })).toThrow();
  const artifact = resolved(source);
  expect(() => parseResolvedTestSpec({ ...artifact, schemaVersion: '2' }, source)).toThrow();
  expect(() => parseResolvedTestSpec({ ...artifact, executionSteps: [{ ...artifact.executionSteps[0], expectedHref: `${url}elsewhere` }] }, source)).toThrow();
  expect(assessGeneratedLinkCollectionLocator(expression, linkName, {
    matchCount: 2, observedTargetMatches: true, role: 'link', accessibleName: linkName,
  })).toMatchObject({ status: 'accepted', checks: { uniqueness: 'not_checked', durableIdentity: 'passed' } });
  expect(assessGeneratedLinkCollectionLocator("getByRole('link', { name: 'Frank da Cruz' }).first()", linkName, {
    matchCount: 2, observedTargetMatches: true, role: 'link', accessibleName: linkName,
  })).toMatchObject({ status: 'accepted', validatedForm: { type: 'role', role: 'link', name: linkName, exact: true } });
  for (const weak of [
    "getByRole('link', { name: 'Other' }).first()",
    "getByText('Frank da Cruz')",
    "getByRole('link', { name: 'Frank da Cruz' }).filter({ visible: true })",
  ]) {
    expect(assessGeneratedLinkCollectionLocator(weak, linkName).status).toBe('rejected');
  }
});

test('C collection quality uses its authored exact link name without a letter test', () => {
  const numericName = '301';
  const candidate = "getByRole('link', { name: '301' }).first()";
  const observation = { matchCount: 2, observedTargetMatches: true,
    role: 'link', accessibleName: numericName } as const;
  expect(assessGeneratedLinkCollectionLocator(candidate, numericName, observation)).toMatchObject({
    status: 'accepted', validatedForm: { type: 'role', role: 'link', name: numericName, exact: true },
    checks: { durableIdentity: 'passed', uniqueness: 'not_checked', observedTarget: 'passed' },
  });
  expect(acceptGeneratedLinkCollectionLocator(candidate, numericName, observation).quality.projection)
    .toBe('exact-role-name-collection');
  expect(acceptAbsentLinkCollectionLocator(numericName).quality.projection)
    .toBe('closed-assertion-zero-match');
  expect(assessGeneratedLinkCollectionLocator("getByText('301')", numericName, observation).status)
    .toBe('rejected');
  expect(assessGeneratedLinkCollectionLocator(candidate, numericName,
    { ...observation, accessibleName: '302' }).status).toBe('rejected');
  expect(() => acceptAbsentLinkCollectionLocator('   ')).toThrow();
});

test('C provider wire normalizes into the closed version 3 interpretation contract', async () => {
  const sourceInstruction = 'Confirm that two hyperlinks that say "Frank da Cruz" take you to https://www.columbia.edu/~fdc/';
  const wire = { response: { kind: 'test_spec', steps: [{
    id: 's1', type: 'assert_link_collection', sourceText: sourceInstruction,
    linkName, expectedCount: 2, expectedHref: 'https://www.columbia.edu/~fdc/',
  }] } };
  const normalized = normalizeInterpretationWire(wire);
  const result = await interpretTask({ sourceInstruction, testSpecId: 'test-interpret-links',
    executionProfileRef: { id: 'links', version: '1' }, startState: { url: 'about:blank' } },
  { complete: async () => normalized });
  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') expect(result.testSpec.schemaVersion).toBe('3');
  expect(() => normalizeInterpretationWire({ response: { kind: 'test_spec', steps: [{
    ...wire.response.steps[0], expectedCount: 3,
  }] } })).toThrow();
});

test('C resolves an MCP-selected link collection through the accepted locator gate', async () => {
  let fixtureCount = 2;
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(Array.from({ length: fixtureCount }, () =>
      '<a href="/destination/">Frank da Cruz</a>').join('') || '<p>No matching links</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const base = `http://127.0.0.1:${address.port}/`;
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'links', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 1000 } },
    networkPolicyRef: { id: 'links-policy', version: '1' },
  }], [{ id: 'links-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-links-c-'));
  const store = new LocalArtifactStore(directory);
  const source = parseTestSpec(assertion(`${base}destination/`));
  try {
    await store.createJob(source, factory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(factory, store, source, ({ snapshot }) => {
      const ref = /link "Frank da Cruz" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      return ref ? { kind: 'target', ref, element: 'Frank da Cruz link' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' };
    });
    const attempt = await store.readAttempt(source.testSpecId, outcome.attemptId);
    const details = await Promise.all(attempt.evidenceRefs.map(async (reference) =>
      Buffer.from(await store.readEvidenceContent(source.testSpecId, reference)).toString('utf8')));
    expect(outcome.status, `${outcome.failureReason}\n${details.join('\n')}`).toBe('resolved');
    expect(outcome.resolved?.executionSteps[0]?.type).toBe('assert_link_collection');
    expect(outcome.replay?.map((run) => run.outcomes[0]?.status)).toEqual([
      'QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED',
    ]);
    fixtureCount = 0;
    const absent = await resolveAndReplay(factory, store, source, ({ snapshot }) => {
      const ref = /link "Frank da Cruz" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      return ref ? { kind: 'target', ref, element: 'Frank da Cruz link' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' };
    });
    expect(absent.status, absent.failureReason).toBe('resolved');
    const missingLocator = absent.resolved?.executionSteps[0];
    expect(missingLocator?.type).toBe('assert_link_collection');
    if (missingLocator?.type === 'assert_link_collection') {
      expect(missingLocator.locator.origin).toBe('closedZeroMatch');
      expect(missingLocator.locator).not.toHaveProperty('mcpGeneratedExpression');
    }
    expect(absent.replay?.map((run) => run.outcomes[0])).toEqual([
      expect.objectContaining({ status: 'QA_ASSERTION_FAILED', reason: 'LINK_COUNT_MISMATCH' }),
      expect.objectContaining({ status: 'QA_ASSERTION_FAILED', reason: 'LINK_COUNT_MISMATCH' }),
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('C evaluates exact main-document link count and browser-resolved href in fresh contexts', async () => {
  let count = 2;
  let wrongDestination = false;
  let base = '';
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<base href="${base}base/"><main>${Array.from({ length: count }, (_unused, index) =>
      `<a href="${wrongDestination && index === 1 ? '../elsewhere/' : '../~fdc/'}">Frank da Cruz</a>`).join('')}
      <a href="../elsewhere/">Frank da Cruz archive</a>
      <iframe srcdoc="<a href='../elsewhere/'>Frank da Cruz</a>"></iframe></main>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  base = `http://127.0.0.1:${address.port}/`;
  const profile = new ProfileCatalog([{
    id: 'links', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 500, navigationMs: 3000, waits: { default: 500 } },
    networkPolicyRef: { id: 'links-policy', version: '1' },
  }], [{ id: 'links-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]);
  const factory = new ProtectedContextFactory(profile);
  const source = parseTestSpec(assertion(`${base}~fdc/`));
  const artifact = resolved(source);
  try {
    const runs = await replayTwice(factory, source, artifact);
    expect(runs.map((run) => run.outcomes[0]?.status)).toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    expect(runs[0].executionRunId).not.toBe(runs[1].executionRunId);
    expect(JSON.parse(String(runs[0].outcomes[0]?.actual))).toEqual({
      count: 2, hrefs: [`${base}~fdc/`, `${base}~fdc/`],
    });
    for (const links of [0, 1, 3]) {
      count = links;
      const run = await executeResolvedTestSpec(factory, source, artifact);
      expect(run.outcomes[0]).toMatchObject({ status: 'QA_ASSERTION_FAILED', reason: 'LINK_COUNT_MISMATCH' });
      expect(JSON.parse(String(run.outcomes[0]?.actual)).count).toBe(links);
    }
    count = 2;
    wrongDestination = true;
    const run = await executeResolvedTestSpec(factory, source, artifact);
    expect(run.outcomes[0]).toMatchObject({ status: 'QA_ASSERTION_FAILED', reason: 'LINK_DESTINATION_MISMATCH' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
