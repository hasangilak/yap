// Global test setup: ensure DATABASE_URL points at the compose postgres
// and the schema is in place before any integration test runs.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://yap:yap@localhost:5432/yap';
}
// Quiet the Phase 8 middlewares for the test suite. Individual tests
// re-enable by instantiating the middleware directly.
process.env.YAP_API_TOKEN = process.env.YAP_API_TOKEN ?? '';
process.env.RATE_LIMIT_RPM = process.env.RATE_LIMIT_RPM ?? '100000';
