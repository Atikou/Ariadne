import { z } from "zod";

export const locateBudgetSchema = z.object({
  maxLocateSteps: z.number().int().positive(),
  maxSearchCalls: z.number().int().positive(),
  maxListCalls: z.number().int().positive(),
  maxReadForLocationCalls: z.number().int().min(0),
  maxCandidateFiles: z.number().int().positive(),
  maxPrimaryFiles: z.number().int().positive(),
});

export const projectScanInputSchema = z.object({
  root: z.string().default("."),
  maxDepth: z.number().int().min(1).max(8).default(3),
  includePackageJson: z.boolean().default(true),
  includeTsConfig: z.boolean().default(true),
  exclude: z.array(z.string()).default([]),
});

export const projectIndexUpdateInputSchema = z.object({
  projectId: z.string().default("default"),
  root: z.string().default("."),
  paths: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(1).max(10).default(8),
  limit: z.number().int().positive().max(5000).default(2000),
  exclude: z.array(z.string()).default([]),
  forceResync: z.boolean().default(false),
  extractSymbols: z.boolean().default(true),
  extractDependencies: z.boolean().default(true),
});

export const locateResumeContextSchema = z.object({
  visitedFiles: z.array(z.string()).default([]),
  visitedDirs: z.array(z.string()).default([]),
  candidateFiles: z.array(z.string()).default([]),
  primaryFiles: z.array(z.string()).default([]),
  searchPlan: z
    .object({
      goal: z.string(),
      keywords: z.array(z.string()).optional(),
      possibleSymbols: z.array(z.string()).optional(),
      possiblePaths: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      taskType: z.string().optional(),
    })
    .partial()
    .optional(),
});

export const locateRelevantFilesInputSchema = z.object({
  projectId: z.string().default("default"),
  goal: z.string().min(1),
  mode: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  possibleSymbols: z.array(z.string()).optional(),
  possiblePaths: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).default(20),
  locateBudget: locateBudgetSchema.partial().optional(),
  resumeContext: locateResumeContextSchema.optional(),
});

export const contextPackInputSchema = z.object({
  files: z.array(z.string()).min(1),
  maxFiles: z.number().int().positive().max(20).default(8),
  maxTokens: z.number().int().positive().max(50_000).default(12_000),
  includeSummaries: z.boolean().default(true),
  includeImportantSections: z.boolean().default(true),
});

export const symbolKindSchema = z.enum(["class", "function", "interface", "type", "const", "enum"]);

export const symbolSearchInputSchema = z
  .object({
    projectId: z.string().default("default"),
    query: z.string().optional(),
    symbols: z.array(z.string()).optional(),
    match: z.enum(["exact", "prefix", "contains"]).default("exact"),
    kinds: z.array(symbolKindSchema).optional(),
    root: z.string().default("."),
    pathPrefix: z.string().optional(),
    maxDepth: z.number().int().min(1).max(10).default(6),
    scanLimit: z.number().int().positive().max(2000).default(500),
    limit: z.number().int().positive().max(100).default(30),
  })
  .superRefine((value, ctx) => {
    const hasQuery = Boolean(value.query?.trim());
    const hasSymbols = Boolean(value.symbols?.length);
    if (!hasQuery && !hasSymbols) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query 或 symbols 至少提供一个",
      });
    }
  });