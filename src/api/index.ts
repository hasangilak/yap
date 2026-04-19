import { Hono } from 'hono';
import { agentsRouter } from './agents.js';
import { templatesRouter } from './agent-templates.js';
import { approvalsRouter } from './approvals.js';
import { conversationsRouter } from './conversations.js';
import { devRouter } from './dev.js';
import { messagesRouter } from './messages.js';
import { nodesRouter } from './nodes.js';
import { streamRouter } from './stream.js';
import { toolsRouter } from './tools.js';

export const apiV1 = new Hono();

// Write/stream routes reference :id under /conversations and so mount at
// the v1 root; Hono's route matcher handles the overlap.
apiV1.route('/', messagesRouter);
apiV1.route('/', streamRouter);

apiV1.route('/conversations', conversationsRouter);
apiV1.route('/agents', agentsRouter);
apiV1.route('/agent-templates', templatesRouter);
apiV1.route('/tools', toolsRouter);
apiV1.route('/approvals', approvalsRouter);
apiV1.route('/nodes', nodesRouter);
apiV1.route('/dev', devRouter);
