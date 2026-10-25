import type { DatabaseSync } from 'node:sqlite';

export const RUN_DOCUMENT_SCHEMA_NAME = 'public_projection_run_documents';

export function createRunDocumentSchemaObjects(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE projection_run_documents (
      run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
      run_version INTEGER NOT NULL CHECK(run_version > 0),
      document_digest TEXT NOT NULL CHECK(length(document_digest)=71),
      header_json TEXT NOT NULL CHECK(json_valid(header_json) AND json_type(header_json)='object' AND length(CAST(header_json AS BLOB))<=32768),
      preparation_state TEXT NOT NULL CHECK(preparation_state IN ('preparing','prepared')),
      published_cursor INTEGER UNIQUE,
      PRIMARY KEY(run_id,run_version),
      UNIQUE(run_id,run_version,document_digest),
      FOREIGN KEY(published_cursor) REFERENCES projection_commits(cursor) ON DELETE RESTRICT,
      CHECK(published_cursor IS NULL OR preparation_state='prepared')
    );
    CREATE TABLE projection_run_document_items (
      run_id TEXT NOT NULL,
      run_version INTEGER NOT NULL,
      collection TEXT NOT NULL CHECK(collection IN ('toolActivities','inbox','interactionMessages')),
      item_ordinal INTEGER NOT NULL CHECK(item_ordinal>=0),
      item_id TEXT NOT NULL CHECK(length(item_id) BETWEEN 1 AND 256),
      first_leaf INTEGER NOT NULL CHECK(first_leaf>=0),
      chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 32),
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object' AND length(CAST(metadata_json AS BLOB))<=262144),
      PRIMARY KEY(run_id,run_version,collection,item_ordinal),
      UNIQUE(run_id,run_version,collection,item_id),
      FOREIGN KEY(run_id,run_version) REFERENCES projection_run_documents(run_id,run_version) ON DELETE RESTRICT
    );
    CREATE TABLE projection_run_document_leaves (
      run_id TEXT NOT NULL,
      run_version INTEGER NOT NULL,
      collection TEXT NOT NULL,
      item_ordinal INTEGER NOT NULL,
      chunk_ordinal INTEGER NOT NULL CHECK(chunk_ordinal BETWEEN 0 AND 31),
      leaf_index INTEGER NOT NULL CHECK(leaf_index>=0),
      descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND json_type(descriptor_json)='object' AND length(CAST(descriptor_json AS BLOB))<=16384),
      siblings_json TEXT NOT NULL CHECK(json_valid(siblings_json) AND json_type(siblings_json)='array' AND json_array_length(siblings_json)<=53 AND length(CAST(siblings_json AS BLOB))<=4096),
      chunk_bytes BLOB NOT NULL CHECK(typeof(chunk_bytes)='blob' AND length(chunk_bytes) BETWEEN 1 AND 262144),
      PRIMARY KEY(run_id,run_version,collection,item_ordinal,chunk_ordinal),
      UNIQUE(run_id,run_version,collection,leaf_index),
      FOREIGN KEY(run_id,run_version,collection,item_ordinal)
        REFERENCES projection_run_document_items(run_id,run_version,collection,item_ordinal) ON DELETE RESTRICT
    );
  `);
}
