import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import { CreateTagRequestSchema, PatchTagRequestSchema } from '../schemas/index.js';

export const tagsRouter = new Hono();

function newTagId(): string {
  return `tg-${randomUUID().slice(0, 8)}`;
}

tagsRouter.get('/', async (c) => {
  const rows = await getPrisma().tag.findMany({ orderBy: { name: 'asc' } });
  return c.json(
    rows.map((r) => ({ id: r.id, name: r.name, color: r.color ?? null })),
  );
});

tagsRouter.post('/', async (c) => {
  const body = CreateTagRequestSchema.parse(await c.req.json());
  try {
    const row = await getPrisma().tag.create({
      data: {
        id: newTagId(),
        name: body.name,
        color: body.color ?? null,
      },
    });
    return c.json({ id: row.id, name: row.name, color: row.color ?? null }, 201);
  } catch (err) {
    if (String(err).includes('Unique')) {
      return c.json({ error: `tag '${body.name}' already exists` }, 409);
    }
    throw err;
  }
});

tagsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = PatchTagRequestSchema.parse(await c.req.json());
  try {
    const row = await getPrisma().tag.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
      },
    });
    return c.json({ id: row.id, name: row.name, color: row.color ?? null });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

tagsRouter.delete('/:id', async (c) => {
  try {
    await getPrisma().tag.delete({ where: { id: c.req.param('id') } });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});
