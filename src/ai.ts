/**
 * PrismBI AI: plain-language questions, explanations and automatic insights that run offline on the model, an
 * optional hook for any language model, and context plus tools for agent frameworks (Claude, OpenAI, MCP…).
 * Importing this module registers the `qna` and `insights` visuals and adds "Explain this" to context menus.
 */
export { ask, askSync, planQuestion, planToSpec, llmPrompt, suggestQuestions } from './ai/ask';
export type { AskOptions, AskResult, Interpretation, QueryPlan } from './ai/ask';
export { explain, previousPeriod, candidateDimensions } from './ai/explain';
export type { ExplainOptions, Explanation, Driver } from './ai/explain';
export { findInsights, timeColumn } from './ai/insights';
export type { Insight, InsightOptions } from './ai/insights';
export { getAIContext, contextToPrompt, createAgentTools, runTool, toAnthropicTools, toOpenAITools, toMcpTools } from './ai/agent';
export type { AIContext, AIColumn, ContextOptions, AgentTool, AgentToolOptions } from './ai/agent';
export { qnaVisual, insightsVisual, narrativeVisual, setNarrativeWriter, enableExplain, registerAI, showPanel, renderExplanation } from './ai/visuals';
export type { NarrativeWriter } from './ai/visuals';
export { writeNarrative, filterPhrase } from './ai/narrative';
export type { Narrative, NarrativeOptions, NarrativePart } from './ai/narrative';

export { runAgent, anthropicLLM, openAILLM, ruleBasedLLM, planPrompt, WRITE_TOOLS, AGENT_SYSTEM } from './ai/run';
export type { AgentLLM, AgentMessage, AgentReply, AgentRun, AgentStep, AgentToolCall, RunAgentOptions, HttpLLMOptions } from './ai/run';
export { agentPanel, describeCall } from './ai/panel';
export type { AgentPanel, AgentPanelOptions } from './ai/panel';

import { registerAI } from './ai/visuals';

registerAI();
