import { getPrisma, closeDb } from '../../src/db/index.js';

/**
 * Truncate every mutable table in the test database. Called from
 * beforeEach() hooks in integration tests so each test starts from a
 * clean slate without the per-test-schema-setup overhead.
 */
export async function truncateAll(): Promise<void> {
  const prisma = getPrisma();
  // Order doesn't matter with CASCADE.
  await prisma.$executeRawUnsafe(
    `TRUNCATE
       conversations, nodes, agents, agent_versions,
       events, approvals, approval_grants,
       clarifications, artifacts, artifact_versions,
       tags, conversation_tags, thread_notes, pinned_snippets,
       idempotency_records
     CASCADE`,
  );
}

/**
 * Clear LangGraph's checkpoint tables.
 *
 * They live in their own schema (`config.langgraphSchema`) so `truncateAll`
 * above does not reach them — without this, checkpoints accumulate across test
 * files. Best-effort: the schema only exists once a checkpointer has run
 * `setup()`, so a fresh database legitimately has nothing to truncate.
 */
export async function truncateCheckpoints(): Promise<void> {
  const prisma = getPrisma();
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE langgraph.checkpoints, langgraph.checkpoint_blobs,
                langgraph.checkpoint_writes CASCADE`,
    );
  } catch {
    /* schema not created yet — nothing to clear */
  }
}

export async function disconnectDb(): Promise<void> {
  await closeDb();
}

export { getPrisma };
