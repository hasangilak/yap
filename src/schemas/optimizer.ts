import { z } from 'zod';

/**
 * Phase 4: shape returned by POST /agents/:id/optimize. Today it's
 * canned; a later phase can wire a real prompt-improvement pass.
 */
export const OptimizerSuggestionSchema = z.object({
  suggestion_text: z.string(),
  rationale: z.string(),
  predicted_delta_pct: z.number(),
  applies_to: z.literal('system_prompt'),
  patch: z.object({
    before: z.string(),
    after: z.string(),
  }),
});
export type OptimizerSuggestion = z.infer<typeof OptimizerSuggestionSchema>;

/**
 * Phase 4: an eval run summary. Phase 4 stubs this — eval runs return
 * a synthetic pass/fail distribution immediately. A later phase can
 * replace the stub with a real async job backend.
 */
export const EvalResultSchema = z.object({
  job_id: z.string(),
  status: z.enum(['queued', 'running', 'done', 'error']),
  pass_rate: z.number().min(0).max(1).nullable(),
  cases: z.array(
    z.object({
      input: z.string(),
      expected_behavior: z.string(),
      passed: z.boolean(),
    }),
  ),
  delta_vs_previous_pct: z.number().nullable(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;
