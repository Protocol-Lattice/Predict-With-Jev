import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = process.env.DEMO_MODE === 'true';
const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const app = createApp({ apiKey: process.env.OPENROUTER_API_KEY ?? '', demo, dataFile: path.join(root, 'data', demo ? 'demo-forecasts.json' : 'forecasts.json') });

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

let stopRankingEvaluation = () => {};
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`JEV Terminal ready at http://localhost:${port}${demo ? ' · DEMO DATA' : ''}`);
  stopRankingEvaluation = app.startChatRankingEvaluation();
});
server.on('close', () => stopRankingEvaluation());
server.on('error', error => { console.error(`Server could not start: ${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
