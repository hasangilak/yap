import { z } from 'zod';
import {
  ApprovalDataSchema,
  DecisionSchema,
  MessageNodeSchema,
  StatusStateSchema,
  ToolCallDataSchema,
  ToolStatusSchema,
} from './node.js';

const Base = z.object({
  id: z.string(),
  at: z.number().int(),
  conversation_id: z.string(),
});

export const NodeCreatedEventSchema = Base.extend({
  kind: z.literal('node.created'),
  node: MessageNodeSchema,
});

export const StatusUpdateEventSchema = Base.extend({
  kind: z.literal('status.update'),
  node_id: z.string(),
  state: StatusStateSchema,
  elapsed_ms: z.number().int().nonnegative(),
  tool: z.string().optional(),
});

export const ContentDeltaEventSchema = Base.extend({
  kind: z.literal('content.delta'),
  node_id: z.string(),
  delta: z.string(),
});

export const ReasoningDeltaEventSchema = Base.extend({
  kind: z.literal('reasoning.delta'),
  node_id: z.string(),
  step_index: z.number().int().nonnegative(),
  delta: z.string(),
});

export const ReasoningStepEndEventSchema = Base.extend({
  kind: z.literal('reasoning.step.end'),
  node_id: z.string(),
  step_index: z.number().int().nonnegative(),
  final_text: z.string(),
});

export const ToolCallProposedEventSchema = Base.extend({
  kind: z.literal('toolcall.proposed'),
  node_id: z.string(),
  tool_call: ToolCallDataSchema,
});

export const ToolCallStartedEventSchema = Base.extend({
  kind: z.literal('toolcall.started'),
  node_id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const ToolCallEndedEventSchema = Base.extend({
  kind: z.literal('toolcall.ended'),
  node_id: z.string(),
  status: ToolStatusSchema,
  elapsed_ms: z.number().int().nonnegative(),
  result: z.string().optional(),
  error: z.string().optional(),
});

export const NodeFinalizedEventSchema = Base.extend({
  kind: z.literal('node.finalized'),
  node_id: z.string(),
  node: MessageNodeSchema,
});

export const ActiveLeafChangedEventSchema = Base.extend({
  kind: z.literal('active_leaf.changed'),
  active_leaf_id: z.string(),
});

export const ApprovalRequestedEventSchema = Base.extend({
  kind: z.literal('approval.requested'),
  node_id: z.string(),
  approval_id: z.string(),
  approval: ApprovalDataSchema,
});

export const ApprovalDecidedEventSchema = Base.extend({
  kind: z.literal('approval.decided'),
  node_id: z.string(),
  approval_id: z.string(),
  decision: DecisionSchema,
});

export const ErrorEventSchema = Base.extend({
  kind: z.literal('error'),
  node_id: z.string().optional(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const BusEventSchema = z.discriminatedUnion('kind', [
  NodeCreatedEventSchema,
  StatusUpdateEventSchema,
  ContentDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningStepEndEventSchema,
  ToolCallProposedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallEndedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalDecidedEventSchema,
  NodeFinalizedEventSchema,
  ActiveLeafChangedEventSchema,
  ErrorEventSchema,
]);
export type BusEvent = z.infer<typeof BusEventSchema>;

export type BusEventKind = BusEvent['kind'];
