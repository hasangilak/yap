import type { ClarifyResponse } from '../schemas/index.js';

interface Pending {
  resolve: (response: ClarifyResponse) => void;
  reject: (err: Error) => void;
}

/**
 * Process-local registry of paused runtime generators waiting on a
 * user clarification answer. Same coordinator pattern as approvals —
 * the generator calls awaitAnswer, the HTTP handler for
 * POST /clarify/:id/answer calls resolveClarify, and the generator
 * resumes with the structured answer.
 *
 * Limitation: process-local, so a restart mid-clarify loses the
 * waiter. The DB row still records the eventual answer.
 */
const pending = new Map<string, Pending>();

export function awaitAnswer(clarifyId: string): Promise<ClarifyResponse> {
  return new Promise<ClarifyResponse>((resolve, reject) => {
    pending.set(clarifyId, { resolve, reject });
  });
}

export function resolveClarify(clarifyId: string, response: ClarifyResponse): boolean {
  const p = pending.get(clarifyId);
  if (!p) return false;
  pending.delete(clarifyId);
  p.resolve(response);
  return true;
}

export function rejectAllPending(err: Error): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(err);
  }
}

export function pendingCount(): number {
  return pending.size;
}
