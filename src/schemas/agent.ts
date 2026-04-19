import { z } from 'zod';

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

export const ToolDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  enabled: z.boolean(),
  auto: z.boolean(),
});
export type ToolDef = z.infer<typeof ToolDefSchema>;
