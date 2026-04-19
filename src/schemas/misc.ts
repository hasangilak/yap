import { z } from 'zod';

export const TagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});
export type Tag = z.infer<typeof TagSchema>;

export const CreateTagRequestSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

export const PatchTagRequestSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
});

export const AttachTagRequestSchema = z.object({
  tag_id: z.string().optional(),
  name: z.string().min(1).optional(),
}).refine((v) => v.tag_id || v.name, 'tag_id or name required');

export const ThreadNoteSchema = z.object({
  conversation_id: z.string(),
  body: z.string(),
  updated_at: z.string(),
});

export const PutNoteRequestSchema = z.object({
  body: z.string(),
});

export const PinnedSnippetSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  source_node_id: z.string(),
  label: z.string(),
  excerpt: z.string(),
  created_at: z.string(),
});

export const CreatePinnedSnippetRequestSchema = z.object({
  source_node_id: z.string(),
  label: z.string().min(1),
  excerpt: z.string().min(1),
});

export const TimelineEventKindSchema = z.enum([
  'user',
  'reason',
  'tool',
  'clar',
  'perm',
  'stream',
  'error',
]);
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

export const TimelineEventSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  node_id: z.string().nullable(),
  kind: TimelineEventKindSchema,
  label: z.string(),
  sub: z.string(),
  status: z.enum(['ok', 'pending', 'err']).nullable(),
  at: z.number().int(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const SearchHitSchema = z.object({
  scope: z.enum(['conversations', 'messages', 'agents']),
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  highlight: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
