import { selectors, type Frame, type ElementHandle, type Locator } from '@playwright/test';
import { z } from 'zod';

// Fixed utility-world engines expose only native label/IDREF ownership, never a page/model locator.
// Browser exact getByLabel supplies text correspondence separately from native/IDREF ownership.
const engines = selectors.register('wp2c_label_sources', () => {
  const sources = (root: Node): Element[] => {
    if (!(root instanceof HTMLElement) || !(root.getRootNode() instanceof Document)) throw new Error('unsupported');
    const refs = root.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
    if (refs.length > 16) throw new Error('limit');
    const referenced = [...new Set(refs.map((id) => root.ownerDocument.getElementById(id)).filter((e): e is HTMLElement => !!e))];
    if (referenced.length) return referenced;
    if (root.getAttribute('aria-label')?.trim()) return [];
    if (!(root instanceof HTMLInputElement || root instanceof HTMLSelectElement || root instanceof HTMLTextAreaElement ||
      root instanceof HTMLButtonElement || root instanceof HTMLOutputElement || root instanceof HTMLMeterElement || root instanceof HTMLProgressElement)) return [];
    const labels = root.labels;
    if (labels && labels.length > 16) throw new Error('limit');
    return Array.from(labels ?? []).filter((label) => label.control === root);
  };
  return { query(root: Node) { return sources(root)[0] ?? null; }, queryAll(root: Node) { return sources(root); } };
}, { contentScript: true });
const factsEngine = selectors.register('wp2c_label_facts', () => {
  const facts = (root: Node) => {
    if (!(root instanceof HTMLElement)) return null;
    const carrier = root.ownerDocument.createElement('span');
    const fail = (status: 'limit' | 'unsupported') => { carrier.textContent = JSON.stringify({ status }); return carrier; };
    if (!(root.getRootNode() instanceof Document)) return fail('unsupported');
    const refs = root.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
    if (refs.length > 16) return fail('limit');
    const nodes = [...new Set(refs.map((id) => root.ownerDocument.getElementById(id)).filter((e) => !!e))];
    let kinds: string[], active: Element[];
    if (nodes.length) {
      if (nodes.includes(root)) return fail('unsupported');
      active = nodes as Element[];
      kinds = nodes.map(() => 'aria_labelledby');
    } else if (root.getAttribute('aria-label')?.trim()) { kinds = []; active = []; }
    else if (root instanceof HTMLInputElement || root instanceof HTMLSelectElement || root instanceof HTMLTextAreaElement ||
      root instanceof HTMLButtonElement || root instanceof HTMLOutputElement || root instanceof HTMLMeterElement || root instanceof HTMLProgressElement) {
      if (root.labels && root.labels.length > 16) return fail('limit');
      const labels = Array.from(root.labels ?? []);
      if (labels.some((label) => label.control !== root)) return fail('unsupported');
      active = labels;
      kinds = labels.map(() => 'native_label');
    } else { kinds = []; active = []; }
    // Playwright's exact label predicate is text based. More complex text alternatives need
    // separately reviewed AX contribution evidence, never a false complete-zero association.
    if (active.some((node) => node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby') ||
      node.querySelector('img[alt], [aria-hidden], [aria-label], [aria-labelledby]'))) return fail('unsupported');
    carrier.textContent = JSON.stringify({ status: 'complete', kinds }); return carrier;
  };
  return { query(root: Node) { return facts(root); }, queryAll(root: Node) { const node = facts(root); return node ? [node] : []; } };
}, { contentScript: true });
const schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('limit') }), z.strictObject({ status: z.literal('unsupported') }),
  z.strictObject({ status: z.literal('complete'), kinds: z.array(z.enum(['native_label', 'aria_labelledby'])).max(16) }),
]);
export async function readOwnedLabelSources(frame: Frame, ref: string, authoredText: string,
  role: Parameters<Frame['getByRole']>[0], checkBound: () => void) {
  return readOwnedLabelSourcesFromLocator(frame, frame.locator(`aria-ref=${ref}`), authoredText, role, checkBound);
}
export async function readOwnedLabelSourcesFromLocator(frame: Frame, control: Locator, authoredText: string,
  role: Parameters<Frame['getByRole']>[0], checkBound: () => void) {
  const bounded = async <T>(read: () => Promise<T>) => { checkBound(); const result = await read(); checkBound(); return result; };
  checkBound();
  await Promise.all([engines, factsEngine]);
  checkBound();
  const payload = await bounded(() => control.locator('wp2c_label_facts=').textContent({ timeout: 3000 }));
  if (!payload || payload.length > 4096) throw new Error('LABEL_RESULT_LIMIT');
  const facts = schema.parse(JSON.parse(payload));
  if (facts.status === 'limit') throw new Error('LABEL_RESULT_LIMIT');
  if (facts.status === 'unsupported') throw new Error('LABEL_UNSUPPORTED_CONTROL');
  const labels = control.locator('wp2c_label_sources=');
  if (await bounded(() => labels.count()) !== facts.kinds.length) throw new Error('LABEL_STALE_STATE');
  const sources: { handle: ElementHandle; kind: 'native_label' | 'aria_labelledby' }[] = [];
  try {
    const matched = await bounded(() => control.and(frame.getByLabel(authoredText, { exact: true })).count()) === 1;
    // Name equality is not label contribution proof. An unsupported text-alternative edge cannot
    // disappear from the domain or be promoted into association using the role/name predicate.
    if (!matched && facts.kinds.length &&
      await bounded(() => control.and(frame.getByRole(role, { name: authoredText, exact: true, includeHidden: true })).count()) === 1)
      throw new Error('LABEL_UNSUPPORTED_CONTROL');
    if (matched && !facts.kinds.length) throw new Error('LABEL_UNSUPPORTED_CONTROL');
    for (let index = 0; index < facts.kinds.length; index++) {
      checkBound();
      const label = labels.nth(index), handle = await bounded(() => label.elementHandle());
      if (!handle || await bounded(() => handle.ownerFrame()) !== frame) { await handle?.dispose(); throw new Error('LABEL_STALE_STATE'); }
      // Retain the complete active source group, not an arbitrary text node chosen by DOM order.
      if (matched)
        sources.push({ handle, kind: facts.kinds[index]! });
      else await handle.dispose();
    }
    if (await bounded(() => labels.count()) !== facts.kinds.length) throw new Error('LABEL_STALE_STATE');
    return sources;
  } catch (error) { await Promise.all(sources.map((s) => s.handle.dispose())); throw error; }
}

// Correspondence only: fixed native ownership fields, never a replay locator or candidate narrowing.
const ownershipEngine=selectors.register('native_verification_label_ownership',()=>({
 query(root:Node){if(!(root instanceof HTMLElement))return null;const carrier=root.ownerDocument.createElement('span');
 const refs=root.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean)??[];
 const nodes=[...new Set(refs.map(id=>root.ownerDocument.getElementById(id)).filter((e):e is HTMLElement=>!!e))];
 const labels=root instanceof HTMLSelectElement?Array.from(root.labels??[]):[];
 const sources=nodes.length?nodes:root.getAttribute('aria-label')?.trim()?[]:labels;
 carrier.textContent=JSON.stringify({controlId:root.id||null,sources:sources.map(source=>({sourceId:source.id||null,kind:nodes.length?'aria_labelledby':source instanceof HTMLLabelElement&&source.htmlFor?'native_for':'native_wrapped',forId:source instanceof HTMLLabelElement?source.htmlFor||null:null,idRefs:nodes.length?refs:[],owned:nodes.length?nodes.includes(source):source instanceof HTMLLabelElement&&source.control===root}))});return carrier;},
 queryAll(root:Node){const carrier=this.query(root);return carrier?[carrier]:[];}
}),{contentScript:true});
import {NativeLabelOwnershipSchema as ownershipSchema} from '../domain/native-option-verification.js';
export async function readNativeLabelOwnership(control:ElementHandle){await ownershipEngine;const carrier=await control.$('native_verification_label_ownership=');try{const payload=await carrier?.textContent();if(!payload||payload.length>16384)throw new Error('LABEL_RESULT_LIMIT');return ownershipSchema.parse(JSON.parse(payload));}finally{await carrier?.dispose();}}
