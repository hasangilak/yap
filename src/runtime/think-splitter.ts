/**
 * Streaming <think>…</think> splitter.
 *
 * Thinking-model output interleaves an internal reasoning trace inside
 * `<think>` tags with the user-visible response outside them:
 *
 *     <think>Let me decompose this…</think>
 *     The answer is 42.
 *
 * This splitter feeds on raw content deltas (which may chop tags in
 * half across chunk boundaries) and emits segments already classified
 * as reasoning vs content, plus a step_end marker each time a
 * reasoning block closes. A flush() at the end of the stream drains
 * any unclosed buffer.
 *
 * For non-thinking models (qwen2.5:14b, llama3.1), tags never appear
 * and every delta becomes a single content segment — the overhead is
 * one indexOf + one slice per chunk.
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
const MAX_TAG_LEN = Math.max(OPEN_TAG.length, CLOSE_TAG.length);

export type Segment =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string; step_index: number }
  | { type: 'reasoning_end'; step_index: number };

export class ThinkSplitter {
  private buffer = '';
  private inside = false;
  private stepIndex = 0;

  /** Feed one content delta and get back any segments the splitter can
   *  commit to. Chars at the very end that could be the start of a
   *  tag are held in the buffer until the next feed() / flush(). */
  feed(delta: string): Segment[] {
    this.buffer += delta;
    const out: Segment[] = [];

    while (this.buffer.length > 0) {
      if (!this.inside) {
        const i = this.buffer.indexOf(OPEN_TAG);
        if (i >= 0) {
          if (i > 0) {
            out.push({ type: 'content', text: this.buffer.slice(0, i) });
          }
          this.buffer = this.buffer.slice(i + OPEN_TAG.length);
          this.inside = true;
          continue;
        }
        const safeLen = Math.max(0, this.buffer.length - (MAX_TAG_LEN - 1));
        if (safeLen > 0) {
          out.push({ type: 'content', text: this.buffer.slice(0, safeLen) });
          this.buffer = this.buffer.slice(safeLen);
        }
        return out;
      }
      const j = this.buffer.indexOf(CLOSE_TAG);
      if (j >= 0) {
        if (j > 0) {
          out.push({
            type: 'reasoning',
            text: this.buffer.slice(0, j),
            step_index: this.stepIndex,
          });
        }
        out.push({ type: 'reasoning_end', step_index: this.stepIndex });
        this.buffer = this.buffer.slice(j + CLOSE_TAG.length);
        this.inside = false;
        this.stepIndex++;
        continue;
      }
      const safeLen = Math.max(0, this.buffer.length - (MAX_TAG_LEN - 1));
      if (safeLen > 0) {
        out.push({
          type: 'reasoning',
          text: this.buffer.slice(0, safeLen),
          step_index: this.stepIndex,
        });
        this.buffer = this.buffer.slice(safeLen);
      }
      return out;
    }
    return out;
  }

  /** Flush any remaining buffered characters at end-of-stream. An
   *  unclosed <think> block is emitted as reasoning + a synthetic
   *  reasoning_end so persistence stays consistent. */
  flush(): Segment[] {
    const out: Segment[] = [];
    if (this.buffer.length > 0) {
      if (this.inside) {
        out.push({
          type: 'reasoning',
          text: this.buffer,
          step_index: this.stepIndex,
        });
        out.push({ type: 'reasoning_end', step_index: this.stepIndex });
      } else {
        out.push({ type: 'content', text: this.buffer });
      }
      this.buffer = '';
    }
    if (this.inside) {
      // Stream ended mid-block without text after the opener. Still
      // emit a terminator so downstream tallies stay sane.
      out.push({ type: 'reasoning_end', step_index: this.stepIndex });
      this.inside = false;
      this.stepIndex++;
    }
    return out;
  }

  /** True iff the splitter saw at least one reasoning segment. */
  sawReasoning(): boolean {
    return this.stepIndex > 0 || this.inside;
  }
}
