import { z } from 'zod';
import { DecisionSchema } from './node.js';

/**
 * Request bodies for `POST /api/v1/prompts/:id/respond`.
 *
 * The client does **not** restate the prompt kind — the server reads it from
 * the stored row and validates against the matching schema. That keeps a
 * mismatched body (a clarify answer sent to an approval prompt) a 400 rather
 * than a silently-accepted wrong-shaped resume value.
 */

export const ApprovalRespondBodySchema = z.object({
  decision: DecisionSchema,
  /**
   * Args to run *instead of* the ones the model proposed — edit-then-approve.
   * Ignored when `decision` is 'deny'.
   *
   * These are not trusted: `executeTool` validates at execution time, so the
   * `write_file` sandbox check applies to edited args exactly as it does to
   * model-proposed ones. Editing cannot widen what a tool is allowed to touch.
   */
  edited_args: z.record(z.string(), z.unknown()).optional(),
});
export type ApprovalRespondBody = z.infer<typeof ApprovalRespondBodySchema>;

export const ClarifyRespondBodySchema = z.object({
  selected_chip_ids: z.array(z.string()).default([]),
  text: z.string().default(''),
});
export type ClarifyRespondBody = z.infer<typeof ClarifyRespondBodySchema>;
