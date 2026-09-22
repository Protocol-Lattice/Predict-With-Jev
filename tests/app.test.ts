import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { MarketService } from '../server/market';

// Dispatch through the complete Express middleware stack without opening a network port.
async function getJournal(app: ReturnType<typeof createApp>, url = '/api/forecasts') {
  const output: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  });
  const request = new IncomingMessage(socket as Socket);
  request.method = 'GET';
  request.url = url;
  request.headers = { host: 'localhost' };
  const response = new ServerResponse(request);
  response.assignSocket(socket as Socket);
  try {
    await new Promise<void>((resolve, reject) => {
      response.once('finish', resolve);
      response.once('error', reject);
      app(request, response);
    });
    const body = Buffer.concat(output).toString('utf8').split('\r\n\r\n')[1];
    return { status: response.statusCode, body: JSON.parse(body) };
  } finally { socket.destroy(); }
}

describe('forecast journal API errors', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'jev-api-test-'));
    file = path.join(directory, 'forecasts.json');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('returns an empty journal when no file has been created', async () => {
    const app = createApp({ apiKey: '', demo: true, dataFile: file });
    expect(await getJournal(app)).toEqual({ status: 200, body: [] });
  });

  it.each(['{"unfinished":', JSON.stringify([{ id: 'incomplete', referencePrice: 100, targetTime: 1 }])])('reports corrupt storage as a server error and keeps the file intact', async original => {
    await writeFile(file, original);
    const app = createApp({ apiKey: '', demo: true, dataFile: file });
    const result = await getJournal(app);
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/forecast journal is invalid/);
    expect(result.body.error).toContain('Restore a valid backup');
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});

describe('history API', () => {
  it('exposes idle chat progress without requesting inference or touching the journal', async () => {
    const app = createApp({ apiKey: '', demo: true, dataFile: 'unused-progress-test.json' });
    expect(await getJournal(app, '/api/chat/progress')).toEqual({ status: 200, body: null });
  });
  it.each(['1y', '5y'] as const)('routes %s to the history service without changing the forecast data route', async range => {
    const marketService = new MarketService(true);
    const history = vi.spyOn(marketService, 'history').mockResolvedValue({ symbol: 'BTC', range, intervalMinutes: range === '1y' ? 1440 : 10080, candles: [], requestedFrom: 1, limited: false, fetchedAt: 2, source: 'kraken', stale: false });
    const hourly = vi.spyOn(marketService, 'get');
    const app = createApp({ apiKey: '', demo: true, dataFile: 'unused-history-test.json', marketService });
    const result = await getJournal(app, `/api/markets/BTC/history?range=${range}`);
    expect(result.status).toBe(200);
    expect(result.body.range).toBe(range);
    expect(history).toHaveBeenCalledWith('BTC', range);
    expect(hourly).not.toHaveBeenCalled();
  });

  it.each(['', '?range=10y', '?range=1y&range=5y'])('rejects missing or unsupported ranges before requesting market data: %s', async query => {
    const marketService = new MarketService(true);
    const history = vi.spyOn(marketService, 'history');
    const app = createApp({ apiKey: '', demo: true, dataFile: 'unused-history-test.json', marketService });
    const result = await getJournal(app, `/api/markets/BTC/history${query}`);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/1y or 5y/);
    expect(history).not.toHaveBeenCalled();
  });
});
