import { selectors, type ElementHandle } from '@playwright/test';
import { z } from 'zod';

// Execution receipt only. No caller query/locator or model semantic predicate is introduced.
// Fixed utility-world listeners cannot be forged by page-world Event/prototype overrides.
const engine = selectors.register('wp2db_native_activation_receipt', () => {
  type Receipt = { executionId: string; clicks: number; listener: (event: Event) => void };
  const receipts = new WeakMap<HTMLInputElement, Receipt>();
  const facts = (root: Node, token: string) => {
    if (!(root instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(root.type)) return null;
    const [phase, executionId] = token.split(':');
    if (!executionId || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(executionId)) return null;
    const carrier = root.ownerDocument.createElement('span');
    let receipt = receipts.get(root);
    if (phase === 'arm') {
      if (receipt) root.removeEventListener('click', receipt.listener, true);
      receipt = { executionId, clicks: 0, listener: (event) => {
        if (event.isTrusted && event.target === root && receipt!.executionId === executionId)
          receipt!.clicks = Math.min(2, receipt!.clicks + 1);
      } };
      receipts.set(root, receipt); root.addEventListener('click', receipt.listener, true);
    }
    const owned = receipt?.executionId === executionId;
    carrier.textContent = JSON.stringify({ executionId, nativeInputType: root.type, owned,
      clicks: owned ? receipt!.clicks : 0 });
    if (phase === 'clear' && owned) { root.removeEventListener('click', receipt!.listener, true); receipts.delete(root); }
    return carrier;
  };
  return { query(root: Node, token: string) { return facts(root, token); },
    queryAll(root: Node, token: string) { const node = facts(root, token); return node ? [node] : []; } };
}, { contentScript: true });
const schema = z.strictObject({ executionId: z.string().max(128), nativeInputType: z.enum(['checkbox', 'radio']),
  owned: z.boolean(), clicks: z.number().int().min(0).max(2) });
export async function nativeActivationReceipt(handle: ElementHandle, executionId: string, phase: 'arm' | 'read' | 'clear') {
  await engine;
  const carrier = await handle.$(`wp2db_native_activation_receipt=${phase}:${executionId}`);
  try {
    const payload = await carrier?.textContent();
    if (!payload || payload.length > 1024) throw new Error('ACTIVATION_RECEIPT_UNPROVEN');
    const record = schema.parse(JSON.parse(payload));
    if (!record.owned || record.executionId !== executionId) throw new Error('ACTIVATION_RECEIPT_UNPROVEN');
    return record;
  } finally { await carrier?.dispose().catch(() => {}); }
}
