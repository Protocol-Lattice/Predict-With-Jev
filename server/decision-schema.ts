import { z } from 'zod';
import { DECISION_STAGES, PIPELINE_VERSION, resolveResearchAction, type DecisionPipeline, type StageDecision } from '../shared/decision-pipeline.js';

const text = z.string().min(1);
const nonnegative = z.number().finite().nonnegative();
const weight = nonnegative.max(1);
const choice = z.object({ choice: text, probabilities: z.record(text, weight) });
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every(key => b.includes(key));

export const stageDecisionSchema: z.ZodType<StageDecision> = z.object({
  id: text, stage: z.enum(DECISION_STAGES), version: z.literal(PIPELINE_VERSION),
  request: z.object({
    model: text,
    state: z.record(z.string(), z.json()),
    questions: z.record(text, z.object({ type: z.literal('choice'), instructions: text, criteria: z.record(text, text) })),
  }),
  answers: z.record(text, choice), model: text,
  completedAt: nonnegative.int().max(8_640_000_000_000_000), latencyMs: nonnegative, cost: nonnegative.nullable(),
}).superRefine((record, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const expected: Record<string, string[] | null> = record.stage === 'planning' ? { selection: ['all', 'only', 'exclude'], objective: ['best_fit', 'upside'] }
    : record.stage === 'market_regime' ? { regime: ['trending_up', 'trending_down', 'ranging', 'volatile', 'uncertain'] }
    : record.stage === 'setup_quality' ? { setup: ['supported', 'weak'] }
    : record.stage === 'risk_gate' ? { risk: ['allow', 'block'] } : { selection: null };
  if (!sameKeys(Object.keys(record.request.questions), Object.keys(expected)) || !sameKeys(Object.keys(record.answers), Object.keys(expected))) invalid('Unexpected stage questions.');
  if (record.request.state.decision_stage !== record.stage || record.request.state.prompt_version !== record.version) invalid('Request version or stage mismatch.');
  for (const [name, answer] of Object.entries(record.answers)) {
    const options = Object.keys(record.request.questions[name]?.criteria ?? {});
    const keys = Object.keys(answer.probabilities);
    const values = Object.values(answer.probabilities);
    if (!options.length || !sameKeys(keys, options) || expected[name] && !sameKeys(options, expected[name])
      || !keys.includes(answer.choice) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-8
      || answer.probabilities[answer.choice] + 0.001 < Math.max(...values)) invalid('Inconsistent stage probabilities or choice.');
  }
});

export const decisionPipelineSchema: z.ZodType<DecisionPipeline> = z.object({
  version: z.literal(PIPELINE_VERSION), decisions: z.array(stageDecisionSchema).min(6),
  action: z.object({ choice: z.enum(['research', 'watch', 'wait']), symbol: text, reasons: z.array(text).min(1), hardBlocks: z.array(z.enum(['non_live_evidence', 'expired_or_future_evidence'])) }),
}).superRefine((pipeline, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const records = pipeline.decisions;
  if (records.length < 6) return;
  const middle = records.slice(2, -2);
  if (records[0].stage !== 'planning' || records[1].stage !== 'market_regime'
    || records.at(-2)!.stage !== 'setup_quality' || records.at(-1)!.stage !== 'risk_gate'
    || middle.some(record => record.stage !== 'candidate_filter')
    || middle[0]?.request.state.stage !== 'analysis' || middle.at(-1)?.request.state.stage !== 'final'
    || middle.slice(0, -1).some(record => !['analysis', 'comparison'].includes(String(record.request.state.stage)))) invalid('Invalid pipeline order.');
  if (new Set(records.map(record => record.id)).size !== records.length) invalid('Duplicate decision IDs.');
  const final = middle.at(-1)?.answers.selection;
  const setup = records.at(-2)!.answers.setup;
  const risk = records.at(-1)!.answers.risk;
  if (!final || !setup || !risk) return;
  const symbol = pipeline.action.symbol;
  if (!Object.hasOwn(final.probabilities, symbol) || final.choice !== 'NO_CANDIDATE' && final.choice !== symbol
    || records.at(-2)!.request.state.subject !== symbol || records.at(-1)!.request.state.subject !== symbol) invalid('Gates must assess the comparison leader.');
  const expected = resolveResearchAction(symbol, final.choice, setup, risk, pipeline.action.hardBlocks);
  if (expected.choice !== pipeline.action.choice || !sameKeys(expected.reasons, pipeline.action.reasons)) invalid('Action contradicts its gates.');
});
