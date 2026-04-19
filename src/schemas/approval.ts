import { z } from 'zod';
import { DecisionSchema } from './node.js';

export const ApprovalDecisionRequestSchema = z.object({
  decision: DecisionSchema,
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;
