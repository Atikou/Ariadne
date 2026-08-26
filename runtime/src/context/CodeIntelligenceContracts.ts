import type {
  ExportRecord,
  ImportRecord
} from "./importExportParser.js";
import type {
  ProjectReferenceRecord,
  ProjectSymbolRecord
} from "./projectIndexTypes.js";

export interface CodeAnalysis {
  providerId: string;
  symbols: ProjectSymbolRecord[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  references: ProjectReferenceRecord[];
  parseDiagnostics: string[];
}

export interface CodeIntelligenceProvider {
  readonly id: string;
  supports(filePath: string): boolean;
  analyze(
    filePath: string,
    content: string,
    context?: { workspaceRoot?: string }
  ): Promise<CodeAnalysis>;
  dispose?(): Promise<void>;
}
