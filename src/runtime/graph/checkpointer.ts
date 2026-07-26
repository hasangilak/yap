import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { config } from '../../config.js';

/**
 * The LangGraph checkpointer — the reason this project has durable
 * human-in-the-loop at all. Every pause (`interrupt()` in the `wait` node)
 * writes graph state here, so a decision can arrive minutes later, from a
 * different request, or after a full process restart, and the turn resumes
 * from where it stopped.
 *
 * It lives in its own Postgres schema (`config.langgraphSchema`) rather than
 * `public`: the saver owns four tables (`checkpoints`, `checkpoint_blobs`,
 * `checkpoint_writes`, `checkpoint_migrations`) and manages their migrations
 * itself, which would otherwise read as drift to `prisma db push`.
 */
let saver: PostgresSaver | null = null;
let setupPromise: Promise<void> | null = null;

export function getCheckpointer(): PostgresSaver {
  saver ??= PostgresSaver.fromConnString(config.databaseUrl, {
    schema: config.langgraphSchema,
  });
  return saver;
}

/**
 * Create the schema and checkpoint tables. `setup()` is itself idempotent
 * (`CREATE ... IF NOT EXISTS` plus a migration table), but it must run before
 * the first graph invocation, so we memoize the promise: concurrent callers
 * share one round-trip instead of racing DDL. `server.ts` awaits this at boot;
 * the test helper awaits it before the first graph run.
 */
export async function setupCheckpointer(): Promise<void> {
  setupPromise ??= getCheckpointer().setup();
  await setupPromise;
}

/** Release the saver's pg pool — otherwise tests and SIGTERM hang. */
export async function closeCheckpointer(): Promise<void> {
  if (saver) await saver.end();
  saver = null;
  setupPromise = null;
}
