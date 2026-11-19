// Drizzle Kit configuration (IADP Phase 7, WP7-8). Tooling only: it holds no credential and reads
// no environment. Generating and running application migrations needs separate authorization.
export default {
  dialect: 'postgresql',
  schema: './src/infrastructure/adapters/database/schema/*.ts',
  out: './src/infrastructure/adapters/database/migrations',
};
