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

export async function disconnectDb(): Promise<void> {
  await closeDb();
}

export { getPrisma };
