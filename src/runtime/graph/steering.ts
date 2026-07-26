/**
 * Process-local steering state for in-flight model calls.
 *
 * Exactly one thing lives here, and the boundary is deliberate: an
 * `AbortController` for an open HTTP stream to Ollama. That socket dies with
 * the process, so a controller for it has no meaning outside this process and
 * nothing is lost by keeping it in memory.
 *
 * The interjected **text** is not here — it is a row in the `interjections`
 * table. The endpoint returns 200 once that row exists, so the user has been
 * told we accepted their input; keeping it in a `Map` would let a restart
 * discard it silently, which is the same class of bug as the clarify answer
 * that used to be dropped when no runtime was listening. Durable user input,
 * ephemeral socket handle.
 */

const controllers = new Map<string, AbortController>();

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

/**
 * Abort the in-flight model round, if this process owns one.
 *
 * Returns false when there is nothing to abort — the turn is paused on a
 * prompt, between rounds, or running in another process. That is not a
 * failure: the interjection row is already persisted and the next round picks
 * it up. Callers surface this as `aborted`, not as an error.
 */
export function abortActiveRound(threadId: string): boolean {
  const ac = controllers.get(threadId);
  if (!ac || ac.signal.aborted) return false;
  ac.abort();
  return true;
}

export function clearAbortController(threadId: string): void {
  controllers.delete(threadId);
}
