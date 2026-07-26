/**
 * Process-local steering state for in-flight model calls.
 *
 * This is the one piece of turn state that is deliberately **not** durable,
 * and the distinction matters. The pause state we moved into LangGraph's
 * checkpointer had to survive a restart because a human might take minutes to
 * answer. An in-flight HTTP stream to Ollama cannot survive a restart at all —
 * the socket dies with the process — so an `AbortController` for it has no
 * meaning outside this process and nothing is lost by keeping it in memory.
 *
 * Queued interjections are held here too: they are only consumed at the next
 * round boundary, and if the process dies before that the turn is recovered
 * from its checkpoint and the user can simply say it again.
 */

const controllers = new Map<string, AbortController>();
const queued = new Map<string, string[]>();

/**
 * Fresh controller for a model round, replacing any stale one for this thread.
 * Never derive this from an HTTP request signal — a client disconnect would
 * then abort a turn that is meant to outlive the request.
 */
export function takeAbortController(threadId: string): AbortController {
  const ac = new AbortController();
  controllers.set(threadId, ac);
  return ac;
}

/** Abort the in-flight model round, if this process owns one. */
export function abortActiveRound(threadId: string): boolean {
  const ac = controllers.get(threadId);
  if (!ac || ac.signal.aborted) return false;
  ac.abort();
  return true;
}

export function clearAbortController(threadId: string): void {
  controllers.delete(threadId);
}

/** Queue user text to be injected before the next model round. */
export function queueInterjection(threadId: string, text: string): void {
  const list = queued.get(threadId) ?? [];
  list.push(text);
  queued.set(threadId, list);
}

/** Drain queued interjections for a thread. */
export function getInterjections(threadId: string): string[] {
  const list = queued.get(threadId) ?? [];
  queued.delete(threadId);
  return list;
}

/** Release both maps for a finished turn. */
export function clearSteering(threadId: string): void {
  controllers.delete(threadId);
  queued.delete(threadId);
}
