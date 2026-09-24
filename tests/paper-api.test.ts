import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';

async function dispatch(app: ReturnType<typeof createApp>, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const output: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  const request = new IncomingMessage(socket as Socket);
  request.method = payload === undefined ? 'GET' : 'POST'; request.url = url;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  request.headers = { host: 'localhost', ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }) };
  request.complete = true; if (body) request.push(body); request.push(null);
  const response = new ServerResponse(request); response.assignSocket(socket as Socket);
  try {
    await new Promise<void>((resolve, reject) => { response.once('finish', resolve); response.once('error', reject); app(request, response); });
    return { status: response.statusCode, body: JSON.parse(Buffer.concat(output).toString('utf8').split('\r\n\r\n')[1]) };
  } finally { socket.destroy(); }
}

describe('paper API boundary', () => {
  let directory: string, app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'jev-paper-api-'));
    app = createApp({ apiKey: '', demo: true, dataFile: path.join(directory, 'forecasts.json') });
  });
  afterEach(async () => { await app.stopPaperTrading(); await rm(directory, { recursive: true, force: true }); });

  it('loads an idle, virtual account without starting work or writing a journal', async () => {
    const result = await dispatch(app, '/api/paper');
    expect(result).toMatchObject({ status: 200, body: { running: false, mode: 'paper', source: 'demo', cashUsd: 10000, decisions: [] } });
    expect(await readdir(directory)).toEqual([]);
  });

  it('exposes configuration, start and stop and rejects live-mode inputs', async () => {
    const initial = (await dispatch(app, '/api/paper')).body;
    expect((await dispatch(app, '/api/paper/config', { ...initial.config, signal: 'live' })).status).toBe(400);
    expect((await dispatch(app, '/api/paper/start', { mode: 'live' })).status).toBe(400);
    expect((await dispatch(app, '/api/paper/config', { ...initial.config, orderUsd: 50 })).body.config.orderUsd).toBe(50);
    expect((await dispatch(app, '/api/paper/start', {})).body.running).toBe(true);
    expect((await dispatch(app, '/api/paper/config', initial.config)).status).toBe(409);
    expect((await dispatch(app, '/api/paper/stop', {})).body.running).toBe(false);
    expect((await dispatch(app, '/api/trades', {})).status).toBe(404);
  });

  it('rejects cross-origin and external-host mutation requests before changing the account', async () => {
    expect((await dispatch(app, '/api/paper/start', {}, { origin: 'https://example.com' })).status).toBe(403);
    expect((await dispatch(app, '/api/paper/start', {}, { host: 'example.com' })).status).toBe(403);
    expect((await dispatch(app, '/api/paper')).body.running).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});
