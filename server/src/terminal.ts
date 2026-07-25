import type { Server } from 'http';
import { parse as parseUrl } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client as SshClient } from 'ssh2';
import express from 'express';
import { db } from './db.js';
import { verifyToken } from './auth.js';
import { withRouter } from './mikrotik.js';

export const terminalRouter = express.Router();

type RouterRow = {
  id: number;
  name: string;
  host: string | null;
  port: number;
  ssh_port: number;
  api_user: string | null;
  api_pass: string | null;
  board: string | null;
  type: string;
  status: string;
};

function getRouter(id: number): RouterRow | undefined {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as RouterRow | undefined;
}

terminalRouter.get('/terminal/routers/:id', (req, res) => {
  const r = getRouter(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Router not found' });
  res.json({
    id: r.id,
    name: r.name,
    host: r.host,
    api_port: r.port || 8728,
    ssh_port: r.ssh_port || 22,
    user: r.api_user || 'admin',
    has_credentials: !!(r.host && r.api_user),
    board: r.board,
    type: r.type,
    status: r.status,
    ssh_uri: r.host ? `ssh://${r.api_user || 'admin'}@${r.host}:${r.ssh_port || 22}` : null,
  });
});

const DEMO_RESPONSES: Record<string, string> = {
  '/system resource print': [
    'uptime: 5d12h30m',
    'version: 7.14.2 (stable)',
    'cpu: MIPS 100MHz',
    'cpu-count: 4',
    'cpu-load: 12%',
    'free-memory: 512MiB',
    'total-memory: 1024MiB',
  ].join('\r\n'),
  '/ip address print': [
    'Flags: D - DYNAMIC',
    ' #   ADDRESS            NETWORK         INTERFACE',
    ' 0   192.168.88.1/24    192.168.88.0    bridge',
    ' 1   10.0.0.1/24        10.0.0.0        ether1',
  ].join('\r\n'),
  '/interface print': [
    'Flags: R - RUNNING; S - SLAVE',
    ' #   NAME      TYPE       ACTUAL-MTU',
    ' 0 R ether1  ether      1500',
    ' 1 R bridge  bridge     1500',
  ].join('\r\n'),
  help: [
    'MikroTik RouterOS terminal (demo mode — router unreachable)',
    '',
    'Try: /system resource print',
    '     /ip address print',
    '     /interface print',
    '',
    'Configure router API/SSH credentials under System Settings → Router Management.',
  ].join('\r\n'),
};

function demoReply(line: string): string {
  const cmd = line.trim().toLowerCase();
  if (!cmd) return '';
  if (DEMO_RESPONSES[cmd]) return DEMO_RESPONSES[cmd] + '\r\n';
  if (cmd === 'clear' || cmd === 'cls') return '\x1b[2J\x1b[H';
  return `[demo] unknown command: ${line}\r\nType "help" for sample commands.\r\n`;
}

async function tryApiCommand(router: RouterRow, line: string): Promise<string | null> {
  const cmd = line.trim();
  if (!cmd.startsWith('/')) return null;
  const path = cmd.split(/\s+/)[0];
  if (!path.includes('/')) return null;
  try {
    const rows = await withRouter(
      { host: router.host!, port: router.port, api_user: router.api_user!, api_pass: router.api_pass || '' },
      (api) => api.write(path)
    );
    const text = Array.isArray(rows)
      ? rows.map((row) => Object.entries(row as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(' ')).join('\r\n')
      : JSON.stringify(rows, null, 2);
    return (text || '(no output)') + '\r\n';
  } catch {
    return null;
  }
}

function attachSsh(ws: WebSocket, router: RouterRow, onFallback: () => void) {
  const conn = new SshClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stream: any = null;

  conn
    .on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, s) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'status', mode: 'fallback', message: 'SSH shell failed, trying API…' }));
          conn.end();
          onFallback();
          return;
        }
        stream = s;
        ws.send(JSON.stringify({ type: 'status', mode: 'ssh', host: router.host, port: router.ssh_port || 22 }));
        s.on('data', (data: Buffer) => ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') })));
        s.stderr.on('data', (data: Buffer) => ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') })));
        s.on('close', () => {
          ws.send(JSON.stringify({ type: 'status', mode: 'disconnected' }));
          conn.end();
        });
      });
    })
    .on('error', () => {
      ws.send(JSON.stringify({ type: 'status', mode: 'fallback', message: 'SSH unreachable, using API/demo…' }));
      onFallback();
    })
    .connect({
      host: router.host!,
      port: router.ssh_port || 22,
      username: router.api_user || 'admin',
      password: router.api_pass || '',
      readyTimeout: 5000,
    });

  return {
    write: (data: string) => stream?.write(data),
    close: () => {
      try {
        stream?.close();
        conn.end();
      } catch {
        /* ignore */
      }
    },
  };
}

function attachLineMode(ws: WebSocket, router: RouterRow) {
  let buffer = '';
  let mode: 'api' | 'demo' = 'api';

  const prompt = () => {
    const label = router.name || router.host || 'router';
    ws.send(JSON.stringify({ type: 'data', data: `\r\n[${label}]> ` }));
  };

  ws.send(
    JSON.stringify({
      type: 'status',
      mode: 'api',
      message: 'SSH unavailable — enter RouterOS API paths (e.g. /system/resource/print). Empty line retries SSH on reconnect.',
    })
  );
  prompt();

  const handleLine = async (line: string) => {
    if (mode === 'demo' || !router.host || !router.api_user) {
      ws.send(JSON.stringify({ type: 'data', data: demoReply(line) }));
      prompt();
      return;
    }
    const out = await tryApiCommand(router, line);
    if (out) {
      ws.send(JSON.stringify({ type: 'data', data: out }));
      mode = 'api';
    } else {
      mode = 'demo';
      ws.send(JSON.stringify({ type: 'status', mode: 'demo', message: 'Switched to demo terminal.' }));
      ws.send(JSON.stringify({ type: 'data', data: demoReply(line) }));
    }
    prompt();
  };

  return {
    write: (data: string) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const line = buffer;
          buffer = '';
          void handleLine(line);
        } else if (ch === '\x7f' || ch === '\b') {
          if (buffer.length) {
            buffer = buffer.slice(0, -1);
            ws.send(JSON.stringify({ type: 'data', data: '\b \b' }));
          }
        } else if (ch >= ' ') {
          buffer += ch;
          ws.send(JSON.stringify({ type: 'data', data: ch }));
        }
      }
    },
    close: () => {},
  };
}

export function initTerminalWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parseUrl(req.url || '', true);
    if (pathname !== '/api/terminal/ws') {
      socket.destroy();
      return;
    }
    const token = typeof query.token === 'string' ? query.token : '';
    try {
      verifyToken(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let session: { write: (d: string) => void; close: () => void } | null = null;
    let router: RouterRow | null = null;
    let lineFallback: ReturnType<typeof attachLineMode> | null = null;

    const startLineMode = () => {
      if (!router) return;
      session?.close();
      lineFallback = attachLineMode(ws, router);
      session = lineFallback;
    };

    ws.on('message', (raw) => {
      let msg: { type?: string; routerId?: number; data?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'connect') {
        session?.close();
        session = null;
        lineFallback = null;
        router = getRouter(Number(msg.routerId)) || null;
        if (!router?.host) {
          ws.send(JSON.stringify({ type: 'status', mode: 'error', message: 'Router host not configured.' }));
          return;
        }
        if (!router.api_user) {
          ws.send(JSON.stringify({ type: 'status', mode: 'error', message: 'Set API user/password in Router Management.' }));
          startLineMode();
          return;
        }
        ws.send(JSON.stringify({ type: 'status', mode: 'connecting', host: router.host }));
        session = attachSsh(ws, router, startLineMode);
        return;
      }

      if (msg.type === 'input' && msg.data != null) {
        session?.write(msg.data);
      }

      if (msg.type === 'disconnect') {
        session?.close();
        session = null;
        ws.send(JSON.stringify({ type: 'status', mode: 'disconnected' }));
      }
    });

    ws.on('close', () => session?.close());
  });
}
