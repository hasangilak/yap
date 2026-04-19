import { Hono } from 'hono';
import { agentsRouter } from './agents.js';
import { conversationsRouter } from './conversations.js';
import { toolsRouter } from './tools.js';

export const apiV1 = new Hono();

apiV1.route('/conversations', conversationsRouter);
apiV1.route('/agents', agentsRouter);
apiV1.route('/tools', toolsRouter);
