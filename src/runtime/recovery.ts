import { listUnfinishedAssistantNodes, updateNode } from '../db/queries.js';
import { publish } from '../events/bus.js';
import { envelope } from './graph/emit.js';
import {
  getPendingInterrupts,
  hasUnfinishedWork,
} from './graph/index.js';
import { setupCheckpointer } from './graph/checkpointer.js';
import { continueTurn } from './run.js';

/**
 * Reconcile turns that were in flight when the process last stopped.
 *
 * This is the payoff of moving pause state into the checkpointer, and it runs
 * before the server accepts connections. Every assistant node still flagged
 * `streaming` falls into one of three cases:
 *
 *  1. **Waiting on a human.** The checkpoint has a pending interrupt, so the
 *     turn is already durable — leave it exactly as it is. The next
 *     `POST /approvals/:id/decide` will resume it. Previously this state was
 *     unrecoverable: the promise died with the process.
 *  2. **Crashed mid-execution.** A checkpoint exists with work still queued but
 *     no interrupt. Resume with `null` input, which replays from the last
 *     completed superstep.
 *  3. **Unrecoverable.** No checkpoint to resume from (e.g. the row predates
 *     the graph runtime, or the crash landed before the first checkpoint).
 *     Clear `streaming` and publish a terminal `error` so the node stops
 *     looking live in the UI forever.
 *
 * Failures here must never stop the server from booting — a single bad row
 * would otherwise make the process unstartable.
 */
export async function recoverInterruptedTurns(): Promise<{
  waiting: number;
  resumed: number;
  failed: number;
}> {
  const summary = { waiting: 0, resumed: 0, failed: 0 };

  let stranded: { id: string; conversationId: string }[];
  try {
    await setupCheckpointer();
    stranded = await listUnfinishedAssistantNodes();
  } catch (err) {
    console.error('[recovery] could not scan for interrupted turns:', err);
    return summary;
  }
  if (stranded.length === 0) return summary;

  for (const node of stranded) {
    try {
      const pending = await getPendingInterrupts(node.id);
      if (pending.length > 0) {
        summary.waiting++;
        continue;
      }

      if (await hasUnfinishedWork(node.id)) {
        // `continueTurn` (null input), not `resumeTurn` — there is no pending
        // interrupt to satisfy, just a superstep to replay. Drained here rather
        // than detached so boot reports a truthful summary.
        for await (const ev of continueTurn({
          conversationId: node.conversationId,
          asstNodeId: node.id,
        })) {
          await publish(ev);
        }
        summary.resumed++;
        continue;
      }

      await updateNode(node.id, { streaming: false, status: null });
      await publish({
        kind: 'error',
        ...envelope(node.conversationId),
        node_id: node.id,
        message: 'turn was interrupted by a server restart and cannot be resumed',
        recoverable: false,
      });
      summary.failed++;
    } catch (err) {
      console.error(`[recovery] node ${node.id}:`, err);
      summary.failed++;
    }
  }

  console.log(
    `[recovery] ${stranded.length} interrupted turn(s): ` +
      `${summary.waiting} waiting on input, ${summary.resumed} resumed, ${summary.failed} failed`,
  );
  return summary;
}
