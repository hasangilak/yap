import { z } from 'zod';

export const ArtifactSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  title: z.string(),
  mime: z.string(),
  current_version_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactAuthorSchema = z.enum(['user', 'asst']);
export type ArtifactAuthor = z.infer<typeof ArtifactAuthorSchema>;

export const ArtifactVersionSchema = z.object({
  id: z.string(),
  artifact_id: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  diff_from: z.string().nullable(),
  message: z.string(),
  author: ArtifactAuthorSchema,
  produced_by_node_id: z.string().nullable(),
  created_at: z.string(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
