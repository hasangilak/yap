import { Hono } from 'hono';
import { createPatch, structuredPatch } from 'diff';
import {
  getArtifact,
  getArtifactVersion,
  listArtifactVersions,
  listArtifactsByConversation,
} from '../db/queries.js';
import { getPrisma } from '../db/index.js';

export const artifactsRouter = new Hono();

/**
 * GET /api/v1/artifacts/:id
 *
 * Returns the artifact + its current version (content included) so a
 * single request populates the Canvas preview tab.
 */
artifactsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const artifact = await getArtifact(id);
  if (!artifact) return c.json({ error: 'not found' }, 404);
  const current = artifact.current_version_id
    ? await getPrisma().artifactVersion.findUnique({
        where: { id: artifact.current_version_id },
      })
    : null;
  return c.json({
    artifact,
    current_version: current
      ? {
          id: current.id,
          artifact_id: current.artifactId,
          version: current.version,
          content: current.content,
          diff_from: current.diffFrom,
          message: current.message,
          author: current.author,
          produced_by_node_id: current.producedByNodeId,
          created_at: current.createdAt.toISOString(),
        }
      : null,
  });
});

artifactsRouter.get('/:id/versions', async (c) => {
  const id = c.req.param('id');
  const artifact = await getArtifact(id);
  if (!artifact) return c.json({ error: 'not found' }, 404);
  const versions = await listArtifactVersions(id);
  return c.json(versions);
});

artifactsRouter.get('/:id/versions/:v', async (c) => {
  const id = c.req.param('id');
  const v = Number(c.req.param('v'));
  if (!Number.isInteger(v) || v < 1) {
    return c.json({ error: 'version must be a positive integer' }, 400);
  }
  const row = await getArtifactVersion(id, v);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

/**
 * GET /api/v1/artifacts/:id/diff?from=<n>&to=<m>
 *
 * Returns both snapshots + a unified patch computed server-side
 * (jsdiff's Myers-based createPatch). The client's Diff tab just
 * renders the patch.
 */
artifactsRouter.get('/:id/diff', async (c) => {
  const id = c.req.param('id');
  const fromN = Number(c.req.query('from'));
  const toN = Number(c.req.query('to'));
  if (!Number.isInteger(fromN) || !Number.isInteger(toN)) {
    return c.json({ error: 'from and to must be integers' }, 400);
  }
  const [a, b] = await Promise.all([
    getArtifactVersion(id, fromN),
    getArtifactVersion(id, toN),
  ]);
  if (!a || !b) return c.json({ error: 'version(s) not found' }, 404);

  const artifact = await getArtifact(id);
  const label = artifact?.title ?? id;
  const patch = createPatch(label, a.content, b.content, `v${fromN}`, `v${toN}`);
  const structured = structuredPatch(label, label, a.content, b.content, `v${fromN}`, `v${toN}`);

  return c.json({
    from: { version: a.version, id: a.id, created_at: a.created_at },
    to: { version: b.version, id: b.id, created_at: b.created_at },
    unified: patch,
    hunks: structured.hunks,
  });
});
