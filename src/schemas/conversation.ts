import { z } from 'zod';

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  agent: z.string(),
  tag: z.string(),
  pinned: z.boolean().optional(),
  updated: z.string(),
  folder: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const CreateConversationRequestSchema = z.object({
  agent: z.string().optional(),
  title: z.string().optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const PostMessageRequestSchema = z.object({
  parent: z.string().nullable().optional(),
  content: z.string().min(1),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;
