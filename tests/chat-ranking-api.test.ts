import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import type { MarketChatService } from '../server/chat';
import { MarketService } from '../server/market';
import { HOUR } from '../server/analysis';
import { observedMarket, rankingScan, SCAN_TIME } from './fixtures/chat-ranking';

async function dispatch(app: ReturnType<typeof createApp>, url: string, payload?: unknown) {
  const output: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  const request = new IncomingMessage(socket as Socket);
  request.method = payload === undefined ? 'GET' : 'POST';
  request.url = url;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  request.headers = { host: 'localhost', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }) };
  request.complete = true;
  if (body) request.push(body);
  request.push(null);
  const response = new ServerResponse(request);
  response.assignSocket(socket as Socket);
  try {
    await new Promise<void>((resolve, reject) => {
      response.once('finish', resolve); response.once('error', reject); app(request, response);
    });
    return { status: response.statusCode, body: JSON.parse(Buffer.concat(output).toString('utf8').split('\r\n\r\n')[1]) };
  } finally { socket.destroy(); }
}

describe('chat ranking persistence API', () => {
  let directory: string;
  let journalFile: string;
  let marketService: MarketService;
  let chatService: Pick<MarketChatService, 'scan' | 'status'>;
  const request = { message: 'Which coin will pump?', horizon: 4, history: ['Compare all assets'] };
  const app = () => createApp({ apiKey: 'test', demo: false, dataFile: path.join(directory, 'forecasts.json'), chatDataFile: journalFile, marketService, chatService });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SCAN_TIME + 1000);
    directory = await mkdtemp(path.join(tmpdir(), 'jev-ranking-api-test-'));
    journalFile = path.join(directory, 'chat-rankings.json');
    marketService = new MarketService(true);
    vi.spyOn(marketService, 'forSymbols').mockResolvedValue([]);
    chatService = { scan: vi.fn(async () => rankingScan()), status: () => null };
  });
  afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

  it('saves the complete ranking before returning it and exposes it after an app restart', async () => {
    const first = app();
    expect((await dispatch(first, '/api/chat', request)).status).toBe(200);
    const onDisk = JSON.parse(await readFile(journalFile, 'utf8'));
    expect(onDisk[0].scan).toEqual(rankingScan());
    expect(onDisk[0].history).toEqual(request.history);
    const restored = await dispatch(app(), '/api/chat/rankings');
    expect(restored.status).toBe(200);
    expect(restored.body.total).toBe(1);
    expect(restored.body.records[0]).toEqual(onDisk[0]);
    expect(marketService.forSymbols).not.toHaveBeenCalled();
    // A cached/retried chat result keeps the original saved record.
    await dispatch(first, '/api/chat', request);
    expect((await dispatch(first, '/api/chat/rankings')).body.total).toBe(1);
  });

  it('refuses inference when the journal is corrupt and preserves the original data', async () => {
    const original = '{"unfinished":';
    await writeFile(journalFile, original);
    const result = await dispatch(app(), '/api/chat', request);
    expect(result.status).toBe(500);
    expect(result.body.error).toContain('chat ranking journal is invalid');
    expect(chatService.scan).not.toHaveBeenCalled();
    expect(await readFile(journalFile, 'utf8')).toBe(original);
  });

  it('checks due hourly outcomes without making another JEV request', async () => {
    const server = app();
    await dispatch(server, '/api/chat', request);
    const ref = (await dispatch(server, '/api/chat/rankings')).body.records[0].referenceTime;
    vi.setSystemTime(ref + 4 * HOUR);
    vi.mocked(marketService.forSymbols).mockResolvedValue(['BTC', 'ETH'].map(symbol => observedMarket(symbol, [[ref, 100], [ref + 4 * HOUR, 110]])));
    expect((await dispatch(server, '/api/chat/rankings/evaluate', {})).status).toBe(200);
    const result = await dispatch(server, '/api/chat/rankings');
    expect(result.body.records[0].tracking[0].outcomes[0]).toMatchObject({ status: 'evaluated', returnPercent: expect.closeTo(10) });
    expect(result.body.summary.horizons[0].evaluated).toBe(1);
    expect(chatService.scan).toHaveBeenCalledTimes(1);
    expect(marketService.forSymbols).toHaveBeenCalledWith(['BTC', 'ETH']);
  });

  it('paginates saved scans while computing the summary from the whole journal', async () => {
    const server = app();
    for (let index = 0; index < 3; index++) {
      vi.mocked(chatService.scan).mockResolvedValueOnce(rankingScan(`scan-${index}`));
      await dispatch(server, '/api/chat', request);
    }
    const result = await dispatch(server, '/api/chat/rankings?offset=1&limit=1');
    expect(result.body.total).toBe(3);
    expect(result.body.summary.total).toBe(3);
    expect(result.body.records.map((record: { scan: { id: string } }) => record.scan.id)).toEqual(['scan-1']);
    expect((await dispatch(server, '/api/chat/rankings?offset=-1')).status).toBe(400);
    expect((await dispatch(server, '/api/chat/rankings?limit=5000')).status).toBe(400);
  });
});
