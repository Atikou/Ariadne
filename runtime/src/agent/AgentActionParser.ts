/**
 * Agent 层兼容出口。协议 schema 归属 core，模型准入和 AgentLoop 共用同一解析器，
 * 避免“路由探针通过、执行解析失败”的双实现漂移。
 */
export {
  parseAgentAction as parseAction,
  parseAgentModelAction,
  sanitizeAgentAction,
  stripModelNoise,
  type AgentAction,
  type FinalAction,
  type ParallelToolAction,
  type ParallelToolCall,
  type ToolAction,
} from "../core/AgentActionProtocol.js";
