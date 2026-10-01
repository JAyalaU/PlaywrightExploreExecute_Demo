import {selectors} from '@playwright/test';
import {z} from 'zod';
// Fixed runtime engine runs in Playwright's isolated utility world. Page JavaScript cannot supply
// the option collection or override its native getters. No selector text crosses the request contract.
export const nativeOptionEngine = selectors.register('wp2b_native_options', () => ({
  query(root: Node) { return root instanceof HTMLSelectElement ? root.options.item(0) : null; },
  queryAll(root: Node) {
    if (!(root instanceof HTMLSelectElement)) return [];
    // 81 is an overflow sentinel, never a complete usable list.
    return Array.from({ length: Math.min(root.options.length, 81) }, (_, index) => root.options.item(index)!);
  },
}), { contentScript: true });
export const nativeOptionFactsEngine = selectors.register('wp2b_native_option_facts', () => {
  // The detached element transports bounded JSON only. It is never inserted into the page.
  const facts = (root: Node) => {
    if (!(root instanceof HTMLSelectElement)) return null;
    const carrier = root.ownerDocument.createElement('span');
    const fail = () => { carrier.textContent = JSON.stringify({ status: 'limit' }); return carrier; };
    if (root.options.length > 80) return fail();
    const options = Array.from(root.options, (o) => ({ displayedLabel: o.label, text: o.text,
      value: o.value, disabled: o.disabled || o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled,
      selected: o.selected, owned: o.closest('select') === root }));
    if (options.some((o) => [o.displayedLabel, o.text, o.value].some((s) => s.length > 1024))) return fail();
    const payload = JSON.stringify({ status: 'complete', count: options.length, multiple: root.multiple, options });
    if (payload.length > 262_144) return fail();
    carrier.textContent = payload; return carrier;
  };
  return { query(root: Node) { return facts(root); }, queryAll(root: Node) { const node = facts(root); return node ? [node] : []; } };
}, { contentScript: true });
export const nativeFactsSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('limit') }),
  z.strictObject({ status: z.literal('complete'), count: z.number().int().min(0).max(80), multiple: z.boolean(),
    options: z.array(z.strictObject({ displayedLabel: z.string().max(1024), text: z.string().max(1024),
      value: z.string().max(1024), disabled: z.boolean(), selected: z.boolean(), owned: z.literal(true) })).max(80) }),
]);
