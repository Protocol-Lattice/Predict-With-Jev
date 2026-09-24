import type { DecisionPipeline } from '../shared/decision-pipeline';
import './decision-summary.css';

const labels: Record<string, string> = {
  trending_up: 'Trending up', trending_down: 'Trending down', ranging: 'Ranging', volatile: 'Volatile', uncertain: 'Uncertain',
  supported: 'Supported', weak: 'Weak', allow: 'Clear for research', block: 'Blocked', NO_CANDIDATE: 'No candidate',
  research: 'Research candidate', watch: 'Watch for stronger evidence', wait: 'Wait',
  gates_passed: 'Setup and risk gates passed for further research.', weak_setup: 'The leading candidate needs stronger setup evidence.',
  filter_abstained: 'The candidate filter selected no candidate.', risk_not_cleared: 'The independent risk assessment did not clear the candidate.',
  non_live_evidence: 'Live evidence is unavailable.', expired_or_future_evidence: 'The evidence no longer meets the freshness checks.',
};

export default function DecisionSummary({ pipeline }: { pipeline: DecisionPipeline }) {
  const stages = [
    { title: 'Market regime', record: pipeline.decisions.find(item => item.stage === 'market_regime'), question: 'regime' },
    { title: 'Candidate filter', record: pipeline.decisions.findLast(item => item.stage === 'candidate_filter'), question: 'selection' },
    { title: 'Setup quality', record: pipeline.decisions.find(item => item.stage === 'setup_quality'), question: 'setup' },
    { title: 'Risk gate', record: pipeline.decisions.find(item => item.stage === 'risk_gate'), question: 'risk' },
  ];
  return <section className="decision-summary" aria-label="Decision stages">
    <h4>Decision path · {pipeline.action.symbol}</h4>
    <ol>{stages.map(({ title, record, question }) => {
      const answer = record?.answers[question];
      return <li key={title}><span>{title}</span><strong>{answer ? labels[answer.choice] ?? answer.choice : 'Unavailable'}</strong>{answer && <small>{(answer.probabilities[answer.choice] * 100).toFixed(1)}% weight</small>}</li>;
    })}<li><span>Action</span><strong>{labels[pipeline.action.choice]}</strong><small>Rule based</small></li></ol>
    <p>{pipeline.action.reasons.map(reason => labels[reason] ?? reason).join(' ')}</p>
    <p>Each weight belongs to its own decision. These weights are not probabilities of profit. Research only; no orders are placed.</p>
  </section>;
}
