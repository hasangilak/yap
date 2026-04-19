import { z } from 'zod';

export const RoleSchema = z.enum(['user', 'asst']);
export type Role = z.infer<typeof RoleSchema>;

export const ToolStatusSchema = z.enum(['ok', 'pending', 'err', 'done']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const StatusStateSchema = z.enum([
  'thinking',
  'pondering',
  'tool',
  'approval',
  'streaming',
]);
export type StatusState = z.infer<typeof StatusStateSchema>;

export const DecisionSchema = z.enum(['allow', 'always', 'deny']);
export type Decision = z.infer<typeof DecisionSchema>;

export const PermissionDefaultSchema = z.enum([
  'ask_every_time',
  'auto_allow_read',
  'auto_allow_all',
]);
export type PermissionDefault = z.infer<typeof PermissionDefaultSchema>;

export const ToolCallDataSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: ToolStatusSchema,
  elapsed: z.string().optional(),
  result: z.string().optional(),
});
export type ToolCallData = z.infer<typeof ToolCallDataSchema>;

export const ClarifyChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  selected: z.boolean().optional(),
});
export type ClarifyChip = z.infer<typeof ClarifyChipSchema>;

export const ClarifyDataSchema = z.object({
  question: z.string(),
  chips: z.array(ClarifyChipSchema),
  input: z.string(),
});
export type ClarifyData = z.infer<typeof ClarifyDataSchema>;

export const ApprovalDataSchema = z.object({
  tool: z.string(),
  title: z.string(),
  body: z.string(),
  preview: z.string().optional(),
});
export type ApprovalData = z.infer<typeof ApprovalDataSchema>;

export const MessageNodeSchema = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  role: RoleSchema,
  time: z.string(),
  branch: z.string(),
  content: z.string(),
  reasoning: z.array(z.string()).optional(),
  toolCall: ToolCallDataSchema.optional(),
  clarify: ClarifyDataSchema.optional(),
  approval: ApprovalDataSchema.optional(),
  streaming: z.boolean().optional(),
  status: StatusStateSchema.optional(),
  edited: z.boolean().optional(),
});
export type MessageNode = z.infer<typeof MessageNodeSchema>;

export const MessageTreeSchema = z.object({
  rootId: z.string(),
  activeLeaf: z.string(),
  nodes: z.record(z.string(), MessageNodeSchema),
});
export type MessageTree = z.infer<typeof MessageTreeSchema>;
