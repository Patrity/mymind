ALTER TABLE "documents" ADD COLUMN "embedded_hash" text;
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw ON documents USING hnsw (embedding halfvec_cosine_ops);