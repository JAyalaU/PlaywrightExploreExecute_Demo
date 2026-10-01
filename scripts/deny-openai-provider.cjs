// Verification-only Node preload for offline test tiers. It fails closed if
// a test attempts the OpenAI Responses endpoint through the global fetch API.
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  } catch {
    return originalFetch.call(this, input, init);
  }
  if (url.hostname === 'api.openai.com') {
    throw new Error('Offline test tier attempted an OpenAI provider request.');
  }
  return originalFetch.call(this, input, init);
};
