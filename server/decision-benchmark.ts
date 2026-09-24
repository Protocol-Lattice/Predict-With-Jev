import { z } from 'zod';
import type { ChatRankingRecord } from '../shared/chat-journal.js';
import type { StageDecision } from '../shared/decision-pipeline.js';

const labelsSchema = z.array(z.object({ scanId: z.string().min(1), decisionId: z.string().min(1), question: z.string().min(1), expected: z.string().min(1) }).strict());
const key = (scanId: string, decisionId: string, question: string) => JSON.stringify([scanId, decisionId, question]);

export function decisionLabelTemplate(records: ChatRankingRecord[]) {
  return records.flatMap(record => record.scan.pipeline?.decisions.flatMap(decision => Object.keys(decision.answers).map(question => ({
    scanId: record.scan.id, decisionId: decision.id, question, expected: null,
  }))) ?? []);
}

/** Score explicit external labels only. Realized price returns are not setup/risk labels. */
export function benchmarkDecisions(records: ChatRankingRecord[], input: unknown) {
  const labels = labelsSchema.parse(input);
  const available = new Map<string, { scanId: string; decision: StageDecision; question: string }>();
  for (const record of records) for (const decision of record.scan.pipeline?.decisions ?? []) for (const question of Object.keys(decision.answers)) {
    const id = key(record.scan.id, decision.id, question);
    if (available.has(id)) throw new Error('Duplicate benchmark decision.');
    available.set(id, { scanId: record.scan.id, decision, question });
  }
  const seen = new Set<string>();
  const calls = new Map<string, StageDecision>();
  const groups = new Map<string, {
    contract: { stage: string; version: string; model: string; question: string; round: unknown; horizon: unknown; objective: unknown; scope: unknown; options: string[] };
    samples: { correct: number; confidence: number; brier: number; logLoss: number; latencyMs: number }[];
  }>();
  for (const label of labels) {
    const id = key(label.scanId, label.decisionId, label.question);
    if (seen.has(id)) throw new Error(`Duplicate label for ${id}.`);
    seen.add(id);
    const entry = available.get(id);
    if (!entry) throw new Error(`Unknown decision label ${id}.`);
    const { decision, question } = entry;
    const answer = decision.answers[question];
    const options = Object.keys(answer.probabilities).sort();
    if (!options.includes(label.expected)) throw new Error(`Expected label is outside the decision options for ${id}.`);
    const state = decision.request.state;
    const contract = { stage: decision.stage, version: decision.version, model: decision.model, question, round: state.stage ?? null, horizon: state.horizon_hours ?? null, objective: state.objective ?? null, scope: state.market_scope ?? null, options };
    const groupKey = JSON.stringify(contract);
    const group = groups.get(groupKey) ?? { contract, samples: [] };
    group.samples.push({
      correct: Number(answer.choice === label.expected), confidence: answer.probabilities[answer.choice],
      brier: options.reduce((sum, option) => sum + (answer.probabilities[option] - Number(option === label.expected)) ** 2, 0),
      logLoss: -Math.log(Math.max(1e-15, answer.probabilities[label.expected])), latencyMs: decision.latencyMs,
    });
    groups.set(groupKey, group);
    calls.set(JSON.stringify([label.scanId, decision.id]), decision);
  }
  const uniqueCalls = [...calls.values()];
  return {
    labeledQuestions: labels.length, availableQuestions: available.size, unlabeledQuestions: available.size - labels.length,
    legacyScans: records.filter(record => !record.scan.pipeline).length,
    scoredCalls: calls.size, cost: uniqueCalls.some(call => call.cost === null) ? null : uniqueCalls.reduce((sum, call) => sum + call.cost!, 0),
    groups: [...groups.values()].map(({ contract, samples }) => {
      const mean = (field: 'correct' | 'brier' | 'logLoss' | 'latencyMs') => samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
      const calibration = Array.from({ length: 10 }, (_, index) => {
        const bin = samples.filter(sample => Math.min(9, Math.floor(sample.confidence * 10)) === index);
        return { from: index / 10, to: (index + 1) / 10, count: bin.length,
          confidence: bin.length ? bin.reduce((sum, sample) => sum + sample.confidence, 0) / bin.length : null,
          accuracy: bin.length ? bin.reduce((sum, sample) => sum + sample.correct, 0) / bin.length : null };
      });
      return { ...contract, samples: samples.length, accuracy: mean('correct'), brier: mean('brier'), logLoss: mean('logLoss'), meanLatencyMs: mean('latencyMs'),
        calibrationError: calibration.reduce((sum, bin) => sum + (bin.count ? bin.count / samples.length * Math.abs(bin.accuracy! - bin.confidence!) : 0), 0), calibration };
    }),
  };
}
