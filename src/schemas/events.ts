import { z } from 'zod';
import {
  ApprovalDataSchema,
  ClarifyDataSchema,
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

// -- prompts (the unified human-in-the-loop pause) ----------------------------

/**
 * `approval.requested`/`approval.decided`/`clarify.requested`/`clarify.answered`
 * collapsed into `prompt.requested`/`prompt.responded`.
 *
 * The kind-specific data sits under a nested `request`/`response` object rather
 * than as sibling optional fields, because that is what narrows in TypeScript:
 * `ev.request.prompt_kind === 'approval'` proves `ev.request.approval` exists.
 * A flat shape with two optionals would compile but let a malformed event —
 * `prompt_kind: 'approval'` with no approval data — pass validation.
 *
 * `kind` remains the single top-level discriminator of `BusEvent`, so
 * `prompt_kind` discriminates only within the nested object.
 */
export const PromptKindSchema = z.enum(['approval', 'clarify']);
export type PromptKind = z.infer<typeof PromptKindSchema>;

export const PromptRequestSchema = z.discriminatedUnion('prompt_kind', [
  z.object({
    prompt_kind: z.literal('approval'),
    approval: ApprovalDataSchema,
  }),
  z.object({
    prompt_kind: z.literal('clarify'),
    clarify: ClarifyDataSchema,
  }),
]);
export type PromptRequest = z.infer<typeof PromptRequestSchema>;

/** The free-form part of a clarify answer, shared by the event and the row. */
export const ClarifyAnswerSchema = z.object({
  selected_chip_ids: z.array(z.string()),
  text: z.string(),
});
export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>;

export const PromptResponseSchema = z.discriminatedUnion('prompt_kind', [
  z.object({
    prompt_kind: z.literal('approval'),
    decision: DecisionSchema,
    /**
     * Present only when the human changed the args before approving. The tool
     * ran with these, not with what the model proposed — so a client rendering
     * history must show these to be accurate about what happened.
     */
    edited_args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    prompt_kind: z.literal('clarify'),
    answer: ClarifyAnswerSchema,
  }),
]);
export type PromptResponse = z.infer<typeof PromptResponseSchema>;

export const PromptRequestedEventSchema = Base.extend({
  kind: z.literal('prompt.requested'),
  node_id: z.string(),
  prompt_id: z.string(),
  /** The tool that triggered the pause; `ask_clarification` for clarify. */
  tool: z.string(),
  request: PromptRequestSchema,
});

export const PromptRespondedEventSchema = Base.extend({
  kind: z.literal('prompt.responded'),
  node_id: z.string(),
  prompt_id: z.string(),
  tool: z.string(),
  response: PromptResponseSchema,
});

export const ArtifactUpdatedEventSchema = Base.extend({
  kind: z.literal('artifact.updated'),
  artifact_id: z.string(),
  version_id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
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
  PromptRequestedEventSchema,
  PromptRespondedEventSchema,
  ArtifactUpdatedEventSchema,
  NodeFinalizedEventSchema,
  ActiveLeafChangedEventSchema,
  ErrorEventSchema,
]);
export type BusEvent = z.infer<typeof BusEventSchema>;

export type BusEventKind = BusEvent['kind'];
