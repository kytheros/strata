/**
 * Reasoning module barrel export.
 *
 * Re-exports the tool-calling provider interface, question-type procedures,
 * and the production agent loop engine.
 */

// -- Tool-calling provider interface --
export type {
  ToolDefinition,
  ToolCall,
  TokenUsage,
  AgentMessage,
  ToolCallingProvider,
} from "./tool-calling-provider.js";

// -- Procedures --
export type { QuestionType } from "./procedures.js";
export {
  classifyQuestion,
  getProcedure,
  getToolSubset,
  isComparisonQuestion,
} from "./procedures.js";

// -- Agent loop --
export type {
  AgentLoopDependencies,
  AgentLoopOptions,
  AgentLoopResult,
} from "./agent-loop.js";
export { runAgentLoop } from "./agent-loop.js";
