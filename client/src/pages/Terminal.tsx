import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TerminalSquare, Plug, PlugZap, Router as RouterIcon, ExternalLink, Loader2 } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Layout from '../components/Layout';
import { Card, StatusBadge, FormField, PageHeader } from '../components/ui';
import { api } from '../api';
import { getWsUrl } from '../config';
import { useRouterDevice } from '../context/RouterContext';

type ConnInfo = {
  id: number;
  name: string;
  host: string;
  api_port: number;
  ssh_port: number;
  user: string;
  has_credentials: boolean;
  board: string;
  type: string;
  status: string;
  ssh_uri: string | null;
};

type TermMode = 'disconnected' | 'connecting' | 'ssh' | 'api' | 'demo' | 'error';

export default function TerminalPage() {
  const { routers, current, setCurrent } = useRouterDevice();
  const [routerId, setRouterId] = useState<number | ''>('');
  const [info, setInfo] = useState<ConnInfo | null>(null);
  const [mode, setMode] = useState<TermMode>('disconnected');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (current?.id) setRouterId(current.id);
  }, [current?.id]);

  useEffect(() => {
    if (!routerId) {
      setInfo(null);
      return;
    }
    api.get(`/terminal/routers/${routerId}`).then((r) => setInfo(r.data));
  }, [routerId]);

  const writeTerm = useCallback((text: string) => {
    xtermRef.current?.write(text);
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'disconnect' }));
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    setMode('disconnected');
  }, []);

  const connect = useCallback(() => {
    if (!routerId || !info?.has_credentials) return;
    disconnect();

    const token = localStorage.getItem('mt_token');
    if (!token) return;

    xtermRef.current?.clear();
    writeTerm(`\r\n\x1b[1;36mConnecting to ${info.name} (${info.host}:${info.ssh_port})…\x1b[0m\r\n`);

    const ws = new WebSocket(getWsUrl(`/api/terminal/ws?token=${encodeURIComponent(token)}`));
    wsRef.current = ws;
    setMode('connecting');

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'connect', routerId }));
      setConnected(true);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') writeTerm(msg.data);
        if (msg.type === 'status') {
          if (msg.mode) setMode(msg.mode as TermMode);
          if (msg.message) setMessage(msg.message);
          if (msg.mode === 'ssh') {
            writeTerm(`\x1b[32m✓ SSH session to ${msg.host}:${msg.port ?? info.ssh_port}\x1b[0m\r\n`);
          }
          if (msg.mode === 'demo' || msg.mode === 'api') {
            writeTerm(`\x1b[33m${msg.message || 'Using API/demo mode'}\x1b[0m\r\n`);
          }
          if (msg.mode === 'error') {
            writeTerm(`\x1b[31m${msg.message}\x1b[0m\r\n`);
            setConnected(false);
          }
          if (msg.mode === 'disconnected') setConnected(false);
        }
      } catch {
        writeTerm(ev.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setMode('disconnected');
      writeTerm('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    };

    ws.onerror = () => {
      writeTerm('\r\n\x1b[31mWebSocket error — is the API server running?\x1b[0m\r\n');
      setMode('error');
    };
  }, [routerId, info, disconnect, writeTerm]);

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#f97316',
        selectionBackground: '#334155',
      },
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();
    term.writeln('\x1b[1;36mMikroTik Terminal · ts0gs v1.0.0\x1b[0m');
    term.writeln('Select a router and click Connect. Uses SSH (port 22) with API/demo fallback.\r\n');

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    xtermRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, [disconnect]);

  useEffect(() => {
    fitRef.current?.fit();
  }, [info, connected]);

  const modeLabel: Record<TermMode, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    ssh: 'SSH',
    api: 'API',
    demo: 'Demo',
    error: 'Error',
  };

  return (
    <Layout title="Terminal">
      <PageHeader
        title="MikroTik Terminal"
        description="SSH session to the selected router with API and demo fallback."
        icon={TerminalSquare}
      />
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-5">
        <div className="xl:col-span-1 space-y-4">
          <Card title="Router connection" icon={RouterIcon} interactive>
            <div className="space-y-4">
              <FormField label="Linked router" hint="Synced with the global router selector in the top bar.">
                <select
                  className="input"
                  value={routerId}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : '';
                    setRouterId(id);
                    if (id) {
                      const r = routers.find((x) => x.id === id);
                      if (r) setCurrent(r);
                    }
                  }}
                >
                  <option value="">— Select router —</option>
                  {routers.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </FormField>

              {info && (
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-sm space-y-2">
                  <div className="flex items-center gap-2">
                    <RouterIcon size={15} className="text-slate-400" />
                    <span className="font-medium text-slate-800">{info.name}</span>
                    <StatusBadge status={info.status} />
                  </div>
                  <div className="text-xs text-slate-500 grid grid-cols-2 gap-1">
                    <span>Host</span><span className="font-mono text-slate-700">{info.host || '—'}</span>
                    <span>SSH</span><span className="font-mono text-slate-700">:{info.ssh_port}</span>
                    <span>API</span><span className="font-mono text-slate-700">:{info.api_port}</span>
                    <span>User</span><span className="font-mono text-slate-700">{info.user}</span>
                  </div>
                  {info.ssh_uri && (
                    <a
                      href={info.ssh_uri}
                      className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1"
                      title="Open in external SSH client"
                    >
                      {info.ssh_uri} <ExternalLink size={11} />
                    </a>
                  )}
                </div>
              )}

              {!info?.has_credentials && info && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  Configure host and API credentials in{' '}
                  <Link to="/settings" className="font-medium underline">System Settings → Router Management</Link>.
                </div>
              )}

              <div className="flex gap-2">
                <button
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                  onClick={connect}
                  disabled={!info?.has_credentials || connected}
                >
                  {mode === 'connecting' ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                  Connect
                </button>
                <button
                  type="button"
                  className="btn-secondary flex-1"
                  onClick={disconnect}
                  disabled={!connected}
                >
                  <PlugZap size={16} /> Disconnect
                </button>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Session</span>
                <StatusBadge status={mode === 'ssh' || mode === 'api' ? 'running' : mode === 'demo' ? 'offline' : 'inactive'} />
                <span className="text-slate-600 font-medium">{modeLabel[mode]}</span>
              </div>
              {message && <p className="text-xs text-slate-400">{message}</p>}
            </div>
          </Card>

          <Card className="text-xs text-slate-500" interactive>
            <div className="font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
              <TerminalSquare size={14} /> Connection order
            </div>
            <ol className="list-decimal list-inside space-y-1">
              <li>SSH to router (port 22)</li>
              <li>RouterOS API command mode</li>
              <li>Demo terminal (offline dev)</li>
            </ol>
          </Card>
        </div>

        <div className="xl:col-span-3">
          <div className="card overflow-hidden p-0 shadow-card-hover">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50 bg-gradient-to-r from-slate-900 to-slate-800 text-slate-400 text-xs">
              <span className="font-mono flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse-soft' : 'bg-slate-500'}`} />
                {info ? `${info.user}@${info.host}` : 'no router selected'}
              </span>
              <span className="uppercase tracking-wider font-semibold">{connected ? 'live' : 'idle'}</span>
            </div>
            <div ref={termRef} className="h-[min(52dvh,420px)] sm:h-[min(70vh,520px)] p-1 bg-slate-950" />
          </div>
        </div>
      </div>
    </Layout>
  );
}
