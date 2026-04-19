import { z } from 'zod';
import { PermissionDefaultSchema } from './node.js';

/**
 * Wire shape chat-box's Agent cards render. Exactly 7 fields; extra
 * fields are server-only.
 */
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  initial: z.string(),
  desc: z.string(),
  model: z.string(),
  tools: z.number().int().nonnegative(),
  temp: z.number().min(0).max(2),
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Client's tools registry row. Only the five fields that show up in
 * the UI; the server-side tool registry has richer metadata.
 */
export const ToolDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  enabled: z.boolean(),
  auto: z.boolean(),
});
export type ToolDef = z.infer<typeof ToolDefSchema>;

/**
 * Phase 4: AgentVariable — a named slot in the system prompt.
 */
export const AgentVariableSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  default: z.string().default(''),
  description: z.string().default(''),
});
export type AgentVariable = z.infer<typeof AgentVariableSchema>;

/**
 * Phase 4: the full editable shape AgentBuilder reads and PATCHes.
 * Returned from GET /agents/:id/full.
 */
export const AgentFullSchema = z.object({
  id: z.string(),
  name: z.string(),
  initial: z.string(),
  desc: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  max_tokens: z.number().int().min(1),
  system_prompt: z.string(),
  variables: z.array(AgentVariableSchema),
  tool_ids: z.array(z.string()),
  permission_default: PermissionDefaultSchema,
  current_version_id: z.string().nullable(),
});
export type AgentFull = z.infer<typeof AgentFullSchema>;

/**
 * Phase 4: POST /agents body. initial defaults to the first uppercased
 * letter of the name when omitted.
 */
export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1),
  initial: z.string().optional(),
  desc: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  system_prompt: z.string().optional(),
  variables: z.array(AgentVariableSchema).optional(),
  tool_ids: z.array(z.string()).optional(),
  permission_default: PermissionDefaultSchema.optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/**
 * Phase 4: PATCH /agents/:id body — any subset of the editable fields,
 * plus an optional commit-like message that ends up on the version.
 */
export const PatchAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  initial: z.string().optional(),
  desc: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  system_prompt: z.string().optional(),
  variables: z.array(AgentVariableSchema).optional(),
  tool_ids: z.array(z.string()).optional(),
  permission_default: PermissionDefaultSchema.optional(),
  message: z.string().optional(),
});
export type PatchAgentRequest = z.infer<typeof PatchAgentRequestSchema>;

/**
 * Phase 4: an AgentVersion snapshot — the full editable agent state
 * frozen at the point of save. Returned from GET /agents/:id/versions.
 */
export const AgentVersionSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  version: z.number().int().positive(),
  message: z.string(),
  snapshot: AgentFullSchema.omit({ id: true, current_version_id: true }),
  eval_score: z.number().nullable(),
  parent_version_id: z.string().nullable(),
  created_at: z.string(),
});
export type AgentVersion = z.infer<typeof AgentVersionSchema>;
