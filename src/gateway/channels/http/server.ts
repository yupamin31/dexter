import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentEvent } from '../../../agent/types.js';
import type { HttpChannelConfig } from '../../config.js';

export type HttpInboundMessage = {
  accountId: string;
  channel: 'http';
  from: string;
  body: string;
  timestamp: number;
  /** Called for each AgentEvent during the run; 'done' event signals completion. */
  onEvent: (event: AgentEvent) => void;
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function startHttpChannel(
  cfg: HttpChannelConfig,
  onMessage: (msg: HttpInboundMessage) => Promise<void>,
): () => void {
  const uiPath = join(__dirname, 'ui.html');
  const uiHtml = readFileSync(uiPath, 'utf8');

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // Password check for plain HTTP requests
    if (cfg.password) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${cfg.password}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(uiHtml);
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1] ?? '');
    const sessionId = urlParams.get('sessionId') ?? crypto.randomUUID();

    ws.on('message', async (raw: Buffer | string) => {
      let parsed: { type: string; text?: string; password?: string };
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (cfg.password && parsed.password !== cfg.password) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        return;
      }

      if (parsed.type !== 'query' || !parsed.text?.trim()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Expected {type:"query", text:"..."}' }));
        return;
      }

      const query = parsed.text.trim();

      const onEvent = (event: AgentEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };

      await onMessage({
        accountId: 'http-default',
        channel: 'http',
        from: sessionId,
        body: query,
        timestamp: Date.now(),
        onEvent,
      });
    });
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    const displayHost = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
    console.log(`[http] Browser UI available at http://${displayHost}:${cfg.port}`);
  });

  return () => {
    wss.close();
    httpServer.close();
  };
}
