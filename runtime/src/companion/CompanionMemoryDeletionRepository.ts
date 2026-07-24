import type { DatabaseSync } from "node:sqlite";

import {
  CompanionMemoryDeletionPersistenceSchema,
  type CompanionMemoryDeletionPersistence,
} from "./CompanionMemoryContracts.js";

interface MemoryResourceRow {
  id: string;
  candidate_id: string | null;
  status: string;
}

interface CandidateResourceRow {
  id: string;
  status: string;
}

/** Owns the atomic candidate + confirmed-memory resource deletion transaction. */
export class CompanionMemoryDeletionRepository {
  constructor(private readonly db: DatabaseSync) {}

  delete(id: string): CompanionMemoryDeletionPersistence | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const memory = this.getMemory(id);
      if (memory && memory.status !== "deleted") {
        const candidate = memory.candidate_id
          ? this.getCandidate(memory.candidate_id)
          : null;
        if (candidate && candidate.status !== "deleted") {
          this.markCandidateDeleted(candidate.id);
        }
        this.markMemoryDeleted(memory.id);
        this.deleteMemoryVectorMetadata(memory.id);
        const result = CompanionMemoryDeletionPersistenceSchema.parse({
          outcome: "memory_deleted",
          memoryId: memory.id,
          candidateId: candidate?.id,
        });
        this.db.exec("COMMIT");
        return result;
      }

      const candidate = this.getCandidate(id);
      if (!candidate || candidate.status === "deleted") {
        this.db.exec("COMMIT");
        return null;
      }
      const linkedMemory = this.getMemoryByCandidateId(candidate.id);
      if (linkedMemory && linkedMemory.status !== "deleted") {
        this.markMemoryDeleted(linkedMemory.id);
        this.deleteMemoryVectorMetadata(linkedMemory.id);
      }
      this.markCandidateDeleted(candidate.id);
      const result = CompanionMemoryDeletionPersistenceSchema.parse({
        outcome: "candidate_deleted",
        candidateId: candidate.id,
        memoryId: linkedMemory?.id,
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getMemory(id: string): MemoryResourceRow | null {
    return (this.db
      .prepare("SELECT id, candidate_id, status FROM companion_memories WHERE id=?")
      .get(id) as MemoryResourceRow | undefined) ?? null;
  }

  private getMemoryByCandidateId(candidateId: string): MemoryResourceRow | null {
    return (this.db
      .prepare(
        "SELECT id, candidate_id, status FROM companion_memories WHERE candidate_id=? LIMIT 1",
      )
      .get(candidateId) as MemoryResourceRow | undefined) ?? null;
  }

  private getCandidate(id: string): CandidateResourceRow | null {
    return (this.db
      .prepare("SELECT id, status FROM companion_memory_candidates WHERE id=?")
      .get(id) as CandidateResourceRow | undefined) ?? null;
  }

  private markMemoryDeleted(id: string): void {
    const result = this.db
      .prepare(
        `UPDATE companion_memories
         SET status='deleted', updated_at=?
         WHERE id=? AND status<>'deleted'`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error("companion_memory_delete_lost_record");
  }

  private markCandidateDeleted(id: string): void {
    const result = this.db
      .prepare(
        `UPDATE companion_memory_candidates
         SET status='deleted', updated_at=?
         WHERE id=? AND status<>'deleted'`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new Error("companion_memory_candidate_delete_lost_record");
    }
  }

  private deleteMemoryVectorMetadata(memoryId: string): void {
    this.db
      .prepare(
        "DELETE FROM companion_vector_items WHERE source_type='memory' AND source_id=?",
      )
      .run(memoryId);
  }
}
