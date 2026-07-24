import type { EmbeddingService } from "./EmbeddingService.js";
import type { SemanticItem } from "./types.js";
import type { VectorStore } from "./VectorStore.js";

export interface ProjectFileSemanticInput {
  projectId: string;
  workspaceRoot: string;
  path: string;
  summary?: string;
  symbols?: string[];
  tags?: string[];
}

export interface ProjectFileSemanticHit {
  path: string;
  score: number;
  summary?: string;
}

function normalizeRoot(workspaceRoot: string): string {
  return workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
}

function semanticItemId(projectId: string, workspaceRoot: string, filePath: string): string {
  return `project_file:${projectId}:${normalizeRoot(workspaceRoot)}:${filePath}`;
}

function buildSemanticContent(input: ProjectFileSemanticInput): string {
  const symbols = (input.symbols ?? []).slice(0, 12).join(" ");
  const summary = input.summary?.trim() ?? "";
  return [input.path, summary, symbols].filter(Boolean).join("\n");
}

/** 将项目文件摘要写入 LanceDB，供 locate 语义召回。 */
export class ProjectSemanticIndexer {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
  ) {}

  async indexFile(input: ProjectFileSemanticInput): Promise<void> {
    const content = buildSemanticContent(input);
    const vector = await this.embeddings.embedText(content);
    const now = new Date().toISOString();
    const item: SemanticItem = {
      id: semanticItemId(input.projectId, input.workspaceRoot, input.path),
      itemType: "code",
      scope: "project",
      scopeId: input.projectId,
      sourceType: "project_file",
      sourceId: input.path,
      content,
      summary: input.summary,
      vector,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
    };
    await this.vectors.updateItem(item);
  }

  async removeFile(projectId: string, workspaceRoot: string, filePath: string): Promise<void> {
    await this.vectors.deleteItem(semanticItemId(projectId, workspaceRoot, filePath));
  }

  async searchFiles(input: {
    projectId: string;
    query: string;
    limit?: number;
  }): Promise<ProjectFileSemanticHit[]> {
    const query = input.query.trim();
    if (!query) return [];
    const limit = Math.max(1, input.limit ?? 12);
    try {
      const vector = await this.embeddings.embedText(query);
      const items = await this.vectors.search(vector, {
        scope: "project",
        scopeId: input.projectId,
        itemType: "code",
      }, limit);
      return items
        .filter((item) => item.sourceType === "project_file" && item.sourceId)
        .map((item) => ({
          path: item.sourceId,
          score: 0.75,
          summary: item.summary,
        }));
    } catch {
      return [];
    }
  }
}
