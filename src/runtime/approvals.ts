import type { Decision } from '../schemas/index.js';

interface Pending {
  resolve: (decision: Decision) => void;
  reject: (err: Error) => void;
}

/**
 * Process-local registry of paused runtime generators waiting on a
 * user decision. Works because the generator, the HTTP handler that
 * receives POST /approvals/:id/decide, and the SSE subscriber are all
 * in the same Node process.
 *
 * Limitation: if the process restarts while an approval is pending,
 * the generator's promise dies and the turn becomes stuck. The DB row
 * still exists and a new decision can be persisted, but the runtime
 * that would act on it is gone. A later phase can lift the pause
 * state to a persistent queue (Postgres NOTIFY, Redis, etc.).
 */
const pending = new Map<string, Pending>();

/**
 * Block until a decision for `approvalId` arrives. Resolves with the
 * decision the user chose, rejects if rejectAllPending() is called
 * (shutdown/cleanup).
 */
export function awaitDecision(approvalId: string): Promise<Decision> {
  return new Promise<Decision>((resolve, reject) => {
    pending.set(approvalId, { resolve, reject });
  });
}

/**
 * Deliver a decision to a waiting generator. Returns false if no
 * runtime was waiting (the approval was still recorded in the DB by
 * the caller, but nobody noticed).
 */
export function resolveApproval(approvalId: string, decision: Decision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision);
  return true;
}

/**
 * Reject every pending approval with the given error. Call on
 * graceful shutdown so dangling generators terminate instead of
 * leaking forever.
 */
export function rejectAllPending(err: Error): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(err);
  }
}

export function pendingCount(): number {
  return pending.size;
}
