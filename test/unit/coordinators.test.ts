import { describe, expect, it } from 'vitest';
import {
  awaitDecision,
  resolveApproval,
  rejectAllPending as rejectAllApprovals,
  pendingCount as pendingApprovalCount,
} from '../../src/runtime/approvals.js';
import {
  awaitAnswer,
  resolveClarify,
  rejectAllPending as rejectAllClarifies,
  pendingCount as pendingClarifyCount,
} from '../../src/runtime/clarifications.js';

describe('approval coordinator', () => {
  it('resolves a pending promise when the user decides', async () => {
    const p = awaitDecision('ap-x');
    expect(pendingApprovalCount()).toBeGreaterThanOrEqual(1);
    expect(resolveApproval('ap-x', 'allow')).toBe(true);
    await expect(p).resolves.toBe('allow');
    expect(resolveApproval('ap-x', 'deny')).toBe(false);
  });

  it('returns false when no waiter is registered', () => {
    expect(resolveApproval('ap-ghost', 'allow')).toBe(false);
  });

  it('rejectAllPending fails every outstanding promise', async () => {
    const a = awaitDecision('ap-a1');
    const b = awaitDecision('ap-b1');
    rejectAllApprovals(new Error('shutdown'));
    await expect(a).rejects.toThrow('shutdown');
    await expect(b).rejects.toThrow('shutdown');
    expect(pendingApprovalCount()).toBe(0);
  });
});

describe('clarification coordinator', () => {
  it('resolves with the structured answer', async () => {
    const p = awaitAnswer('cl-x');
    expect(pendingClarifyCount()).toBeGreaterThanOrEqual(1);
    expect(
      resolveClarify('cl-x', { selected_chip_ids: ['c-0'], text: 'go' }),
    ).toBe(true);
    await expect(p).resolves.toEqual({ selected_chip_ids: ['c-0'], text: 'go' });
  });

  it('rejectAllPending fails every outstanding clarify', async () => {
    const a = awaitAnswer('cl-a');
    const b = awaitAnswer('cl-b');
    rejectAllClarifies(new Error('stop'));
    await expect(a).rejects.toThrow('stop');
    await expect(b).rejects.toThrow('stop');
    expect(pendingClarifyCount()).toBe(0);
  });
});
