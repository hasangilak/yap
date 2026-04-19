import { z } from 'zod';
import { DecisionSchema } from './node.js';

export const ApprovalDecisionRequestSchema = z.object({
  decision: DecisionSchema,
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ClarifyAnswerRequestSchema = z.object({
  selected_chip_ids: z.array(z.string()).default([]),
  text: z.string().default(''),
});
export type ClarifyAnswerRequest = z.infer<typeof ClarifyAnswerRequestSchema>;
