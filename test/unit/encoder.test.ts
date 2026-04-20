import { describe, expect, it } from 'vitest';
import {
  encodeSSE,
  SSE_CONTENT_TYPE,
  SSE_HEARTBEAT,
} from '../../src/events/encoder.js';
import type { BusEvent } from '../../src/events/types.js';

describe('SSE encoder', () => {
  it('emits event, id, data, blank line', () => {
    const ev: BusEvent = {
      kind: 'content.delta',
      id: 'ev-1',
      at: 123,
      conversation_id: 'c-1',
      node_id: 'n-1',
      delta: 'hi',
    };
    const out = encodeSSE(ev);
    expect(out).toMatch(/^event: content\.delta\n/);
    expect(out).toMatch(/^id: ev-1$/m);
    expect(out).toMatch(/^data: \{"kind":"content\.delta",/m);
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('data line is valid JSON that round-trips to the same BusEvent', () => {
    const ev: BusEvent = {
      kind: 'node.finalized',
      id: 'ev-2',
      at: 200,
      conversation_id: 'c-2',
      node_id: 'n-2',
      node: {
        id: 'n-2',
        parent: null,
        role: 'asst',
        time: '11:00',
        branch: 'main',
        content: 'done',
      },
    };
    const dataLine = encodeSSE(ev)
      .split('\n')
      .find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.kind).toBe('node.finalized');
    expect(parsed.node.content).toBe('done');
  });

  it('exports content-type and heartbeat constants', () => {
    expect(SSE_CONTENT_TYPE).toBe('text/event-stream');
    expect(SSE_HEARTBEAT).toMatch(/^: keep-alive/);
    expect(SSE_HEARTBEAT.endsWith('\n\n')).toBe(true);
  });
});
