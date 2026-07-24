import type { Tool } from "./types.js";

/**
 * 可信进程内工具扩展边界。Provider 只负责声明工具；执行仍统一经过
 * PathPolicy -> PermissionGuard -> Budget -> ToolRegistry -> ToolLedger。
 */
export interface ToolProvider {
  readonly id: string;
  listTools(): readonly Tool[];
  dispose?(): void;
}

export class StaticToolProvider implements ToolProvider {
  constructor(
    readonly id: string,
    private readonly tools: readonly Tool[],
  ) {}

  listTools(): readonly Tool[] {
    return this.tools;
  }
}
