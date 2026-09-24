import { readFile } from 'node:fs/promises';
import { chatRankingJournalSchema } from '../server/chat-journal-schema.js';
import { benchmarkDecisions, decisionLabelTemplate } from '../server/decision-benchmark.js';

try {
  const args = process.argv.slice(2);
  const template = args[0] === '--template';
  const file = args[template ? 1 : 0];
  if (args.length !== 2 || !file) throw new Error('Usage: npm run benchmark -- <journal-or-ranking.json> <labels.json>\n       npm run benchmark -- --template <journal-or-ranking.json>');
  const input = JSON.parse(await readFile(file, 'utf8'));
  const records = chatRankingJournalSchema.parse(Array.isArray(input) ? input : [input]);
  const output = template ? decisionLabelTemplate(records) : benchmarkDecisions(records, JSON.parse(await readFile(args[1], 'utf8')));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed.'}\n`);
  process.exitCode = 1;
}
