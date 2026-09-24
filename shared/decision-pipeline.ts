export const PIPELINE_VERSION = '1' as const;
export const DECISION_STAGES = ['planning', 'market_regime', 'candidate_filter', 'setup_quality', 'risk_gate'] as const;
export type DecisionStage = typeof DECISION_STAGES[number];

export interface ChoiceDecision {
  choice: string;
  probabilities: Record<string, number>;
}
export interface DecisionRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
}
export interface StageDecision {
  id: string;
  stage: DecisionStage;
  version: typeof PIPELINE_VERSION;
  /** Exact, bounded provider input, without credentials; permits isolated replay. */
  request: DecisionRequest;
  answers: Record<string, ChoiceDecision>;
  model: string;
  completedAt: number;
  latencyMs: number;
  cost: number | null;
}
export interface ResearchAction {
  choice: 'research' | 'watch' | 'wait';
  symbol: string;
  reasons: string[];
  hardBlocks: string[];
}
export interface DecisionPipeline {
  version: typeof PIPELINE_VERSION;
  decisions: StageDecision[];
  action: ResearchAction;
}

/** Binary ties abstain. This policy never places orders or sizes positions. */
export function resolveResearchAction(symbol: string, filterChoice: string, setup: ChoiceDecision, risk: ChoiceDecision, hardBlocks: string[]): ResearchAction {
  const reasons = [...hardBlocks];
  if (filterChoice !== symbol) reasons.push('filter_abstained');
  if (risk.choice !== 'allow' || risk.probabilities.allow <= 0.5) reasons.push('risk_not_cleared');
  if (reasons.length) return { choice: 'wait', symbol, reasons, hardBlocks };
  if (setup.choice !== 'supported' || setup.probabilities.supported <= 0.5) return { choice: 'watch', symbol, reasons: ['weak_setup'], hardBlocks };
  return { choice: 'research', symbol, reasons: ['gates_passed'], hardBlocks };
}
