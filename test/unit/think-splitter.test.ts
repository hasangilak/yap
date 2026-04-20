import { describe, expect, it } from 'vitest';
import { ThinkSplitter, type Segment } from '../../src/runtime/think-splitter.js';

function feedAll(chunks: string[]): Segment[] {
  const s = new ThinkSplitter();
  const out: Segment[] = [];
  for (const c of chunks) out.push(...s.feed(c));
  out.push(...s.flush());
  return out;
}

describe('ThinkSplitter', () => {
  it('passes pure content through unchanged (chunks may merge on held-back buffer)', () => {
    const segs = feedAll(['Hello, ', 'world.']);
    expect(segs.every((s) => s.type === 'content')).toBe(true);
    const joined = segs.map((s) => (s.type === 'content' ? s.text : '')).join('');
    expect(joined).toBe('Hello, world.');
  });

  it('splits a single complete <think> block', () => {
    const segs = feedAll(['before <think>reasoning</think> after']);
    expect(segs).toEqual([
      { type: 'content', text: 'before ' },
      { type: 'reasoning', text: 'reasoning', step_index: 0 },
      { type: 'reasoning_end', step_index: 0 },
      { type: 'content', text: ' after' },
    ]);
  });

  it('handles <think> tag split across chunks', () => {
    const segs = feedAll(['prefix <thi', 'nk>step</think> tail']);
    const reasoning = segs.filter((s) => s.type === 'reasoning');
    const contents = segs.filter((s) => s.type === 'content').map((s) => s.text).join('');
    expect(reasoning).toEqual([{ type: 'reasoning', text: 'step', step_index: 0 }]);
    expect(contents).toBe('prefix  tail');
  });

  it('handles </think> tag split across chunks', () => {
    const segs = feedAll(['x<think>a</thi', 'nk>y']);
    expect(segs.filter((s) => s.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'a', step_index: 0 },
    ]);
    expect(segs.filter((s) => s.type === 'content').map((s) => s.text).join('')).toBe('xy');
  });

  it('increments step_index per closed block', () => {
    const segs = feedAll(['<think>a</think> mid <think>b</think>']);
    const steps = segs
      .filter((s): s is Extract<Segment, { type: 'reasoning' }> => s.type === 'reasoning')
      .map((s) => s.step_index);
    expect(steps).toEqual([0, 1]);
    const endIdx = segs
      .filter((s): s is Extract<Segment, { type: 'reasoning_end' }> => s.type === 'reasoning_end')
      .map((s) => s.step_index);
    expect(endIdx).toEqual([0, 1]);
  });

  it('flushes an unclosed <think> block with a synthetic step_end', () => {
    const segs = feedAll(['ok <think>still thinking']);
    const endSegs = segs.filter((s) => s.type === 'reasoning_end');
    expect(endSegs.length).toBeGreaterThan(0);
    const reasoning = segs
      .filter((s): s is Extract<Segment, { type: 'reasoning' }> => s.type === 'reasoning')
      .map((s) => s.text)
      .join('');
    expect(reasoning).toBe('still thinking');
  });

  it('handles empty feed', () => {
    const s = new ThinkSplitter();
    expect(s.feed('')).toEqual([]);
    expect(s.flush()).toEqual([]);
    expect(s.sawReasoning()).toBe(false);
  });

  it('sawReasoning() flips only after a think block opens', () => {
    const s = new ThinkSplitter();
    s.feed('plain content');
    expect(s.sawReasoning()).toBe(false);
    s.feed(' <think>r</think>');
    expect(s.sawReasoning()).toBe(true);
  });

  it('one character at a time still reconstructs tags correctly', () => {
    const input = 'a<think>b</think>c';
    const s = new ThinkSplitter();
    const segs: Segment[] = [];
    for (const ch of input) segs.push(...s.feed(ch));
    segs.push(...s.flush());
    const reasoning = segs.filter((x) => x.type === 'reasoning').map((x) => x.text).join('');
    const content = segs.filter((x) => x.type === 'content').map((x) => x.text).join('');
    expect(reasoning).toBe('b');
    expect(content).toBe('ac');
  });
});
