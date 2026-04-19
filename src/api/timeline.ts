import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import type { BusEvent, TimelineEvent, TimelineEventKind } from '../schemas/index.js';

export const timelineRouter = new Hono();

/**
 * Transform one raw BusEvent into a TimelineEvent row, or return null
 * if the event isn't noteworthy enough for the Inspector Timeline
 * (content.delta / status.update / toolcall.proposed / etc. are
 * skipped — they'd drown the panel).
 */
function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

function mapEvent(ev: BusEvent): TimelineEvent | null {
  const common = {
    id: ev.id,
    conversation_id: ev.conversation_id,
    at: typeof ev.at === 'number' ? ev.at : 0,
  };

  switch (ev.kind) {
    case 'node.created': {
      if (ev.node.role !== 'user') return null;
      return {
        ...common,
        node_id: ev.node.id,
        kind: 'user' as TimelineEventKind,
        label: truncate(ev.node.content || '(empty user message)', 60),
        sub: 'Sent',
        status: null,
      };
    }
    case 'reasoning.step.end':
      return {
        ...common,
        node_id: ev.node_id,
        kind: 'reason',
        label: truncate(ev.final_text || `Step ${ev.step_index + 1}`, 60),
        sub: `Step ${ev.step_index + 1}`,
        status: null,
      };
    case 'toolcall.ended':
      return {
        ...common,
        node_id: ev.node_id,
        kind: 'tool',
        label: 'tool call',
        sub: `${(ev.elapsed_ms / 1000).toFixed(1)}s · ${ev.status}`,
        status: ev.status === 'ok' ? 'ok' : ev.status === 'err' ? 'err' : null,
      };
    case 'approval.decided':
      return {
        ...common,
        node_id: ev.node_id,
        kind: 'perm',
        label: `Approval: ${ev.decision}`,
        sub: ev.decision === 'deny' ? 'Denied' : 'Granted',
        status: ev.decision === 'deny' ? 'err' : 'ok',
      };
    case 'clarify.answered':
      return {
        ...common,
        node_id: ev.node_id,
        kind: 'clar',
        label: truncate(ev.response.text || 'clarified', 60),
        sub: `${ev.response.selected_chip_ids.length} chip(s)`,
        status: 'ok',
      };
    case 'node.finalized':
      return {
        ...common,
        node_id: ev.node_id,
        kind: 'stream',
        label: 'Assistant reply complete',
        sub: truncate(ev.node.content || '', 50),
        status: 'ok',
      };
    case 'error':
      return {
        ...common,
        node_id: ev.node_id ?? null,
        kind: 'error',
        label: truncate(ev.message, 60),
        sub: ev.recoverable ? 'Recoverable' : 'Fatal',
        status: 'err',
      };
    default:
      return null;
  }
}

timelineRouter.get('/conversations/:id/timeline', async (c) => {
  const convId = c.req.param('id');
  const since = Number(c.req.query('since') ?? 0);
  const rows = await getPrisma().event.findMany({
    where: {
      conversationId: convId,
      ...(since > 0 ? { at: { gt: new Date(since) } } : {}),
    },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  });
  const out: TimelineEvent[] = [];
  for (const r of rows) {
    const t = mapEvent(r.payload as unknown as BusEvent);
    if (t) out.push(t);
  }
  return c.json(out);
});
