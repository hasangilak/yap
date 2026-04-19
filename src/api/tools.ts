import { Hono } from 'hono';
import { TOOL_DEFS } from '../registry/tools.js';

export const toolsRouter = new Hono();

toolsRouter.get('/', (c) => c.json(TOOL_DEFS));
