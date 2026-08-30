-- DD15: pgvector for approximate incident matching (context/schema.md §7).
-- drizzle-kit never emits CREATE EXTENSION on its own; this must be the
-- first migration in the journal, or the incidents table's `vector` column
-- fails to create.
CREATE EXTENSION IF NOT EXISTS vector;
