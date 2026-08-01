import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TerminalSquare, Plug, PlugZap, Router as RouterIcon, ExternalLink, Loader2, Server } from 'lucide-react';
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
  source?: 'router' | 'noc';
};

type TermMode = 'disconnected' | 'connecting' | 'ssh' | 'api' | 'demo' | 'error';

type NetTarget =
  | { kind: 'router'; id: number; label: string }
  | { kind: 'noc'; id: number; label: string; host: string; sshCapable: boolean };

export default function TerminalPage() {
  const { routers, current, setCurrent } = useRouterDevice();
  const [targetKey, setTargetKey] = useState('');
  const [nocDevices, setNocDevices] = useState<any[]>([]);
  const [info, setInfo] = useState<ConnInfo | null>(null);
  const [mode, setMode] = useState<TermMode>('disconnected');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const targets: NetTarget[] = [
    ...routers.map((r) => ({
      kind: 'router' as const,
      id: r.id,
      label: `${r.name} (router)`,
    })),
    ...nocDevices
      .filter((d) => d.source === 'custom' && (d.sshCapable || d.ssh_user || d.ssh_pass_set))
      .map((d) => ({
        kind: 'noc' as const,
        id: d.id,
        label: `${d.name} · ${d.host} (NOC)`,
        host: d.host,
        sshCapable: !!(d.sshCapable || d.ssh_user),
      })),
  ];

  useEffect(() => {
    api
      .get('/noc')
      .then((r) => setNocDevices(r.data.devices || []))
      .catch(() => setNocDevices([]));
  }, []);

  useEffect(() => {
    if (current?.id && !targetKey) setTargetKey(`router:${current.id}`);
  }, [current?.id, targetKey]);

  useEffect(() => {
    if (!targetKey) {
      setInfo(null);
      return;
    }
    const [kind, idStr] = targetKey.split(':');
    const id = Number(idStr);
    if (kind === 'router') {
      api.get(`/terminal/routers/${id}`).then((r) => setInfo({ ...r.data, source: 'router' }));
    } else if (kind === 'noc') {
      api
        .get(`/noc/devices/${id}/info`)
        .then((r) => {
          const d = r.data.device || {};
          setInfo({
            id: d.id,
            name: d.name,
            host: d.host,
            api_port: 0,
            ssh_port: d.ssh_port || 22,
            user: d.ssh_user || 'admin',
            has_credentials: !!(d.ssh_user && d.host),
            board: d.model || d.sys_name || '',
            type: d.kind || 'noc',
            status: d.status || 'unknown',
            ssh_uri: d.host ? `ssh://${d.ssh_user || 'admin'}@${d.host}:${d.ssh_port || 22}` : null,
            source: 'noc',
          });
        })
        .catch(() => setInfo(null));
    }
  }, [targetKey]);

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
    if (!info?.has_credentials) return;
    disconnect();

    const token = localStorage.getItem('mt_token');
    if (!token) return;

    xtermRef.current?.clear();
    writeTerm(`\r\n\x1b[1;36mConnecting to ${info.name} (${info.host}:${info.ssh_port})…\x1b[0m\r\n`);

    const ws = new WebSocket(getWsUrl(`/api/terminal/ws?token=${encodeURIComponent(token)}`));
    wsRef.current = ws;
    setMode('connecting');

    ws.onopen = () => {
      if (info.source === 'noc') {
        ws.send(JSON.stringify({ type: 'connect', nocDeviceId: info.id }));
      } else {
        ws.send(JSON.stringify({ type: 'connect', routerId: info.id }));
      }
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
  }, [info, disconnect, writeTerm]);

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
    term.writeln('\x1b[1;36mNetwork Terminal · ts0gs v1.0.0\x1b[0m');
    term.writeln('Select a network device (router or NOC SSH) and click Connect.\r\n');

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
    <Layout title="Network Terminal">
      <PageHeader
        title="Network Terminal"
        description="SSH session to routers or NOC devices with SSH credentials. MikroTik routers also support API/demo fallback."
        icon={TerminalSquare}
      />
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-5">
        <div className="xl:col-span-1 space-y-4">
          <Card title="Network connection" icon={RouterIcon} interactive>
            <div className="space-y-4">
              <FormField
                label="Device"
                hint="Routers from Router Management and NOC custom devices with SSH."
              >
                <select
                  className="input"
                  value={targetKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setTargetKey(key);
                    if (key.startsWith('router:')) {
                      const id = Number(key.split(':')[1]);
                      const r = routers.find((x) => x.id === id);
                      if (r) setCurrent(r);
                    }
                  }}
                >
                  <option value="">— Select device —</option>
                  {targets.map((t) => (
                    <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FormField>

              {info && (
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-sm space-y-2">
                  <div className="flex items-center gap-2">
                    {info.source === 'noc' ? (
                      <Server size={15} className="text-slate-400" />
                    ) : (
                      <RouterIcon size={15} className="text-slate-400" />
                    )}
                    <span className="font-medium text-slate-800">{info.name}</span>
                    <StatusBadge status={info.status} />
                  </div>
                  <div className="text-xs text-slate-500 grid grid-cols-2 gap-1">
                    <span>Host</span>
                    <span className="font-mono text-slate-700">{info.host || '—'}</span>
                    <span>SSH</span>
                    <span className="font-mono text-slate-700">:{info.ssh_port}</span>
                    {info.source === 'router' && (
                      <>
                        <span>API</span>
                        <span className="font-mono text-slate-700">:{info.api_port}</span>
                      </>
                    )}
                    <span>User</span>
                    <span className="font-mono text-slate-700">{info.user}</span>
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
                  {info.source === 'noc' ? (
                    <>
                      Set SSH user/password on the device under{' '}
                      <Link to="/noc" className="font-medium underline">
                        NOC Suite
                      </Link>
                      .
                    </>
                  ) : (
                    <>
                      Configure host and API credentials in{' '}
                      <Link to="/settings" className="font-medium underline">
                        System Settings → Router Management
                      </Link>
                      .
                    </>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {!connected ? (
                  <button
                    type="button"
                    className="btn-primary flex-1"
                    disabled={!info?.has_credentials || mode === 'connecting'}
                    onClick={connect}
                  >
                    {mode === 'connecting' ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Plug size={16} />
                    )}
                    Connect
                  </button>
                ) : (
                  <button type="button" className="btn-secondary flex-1" onClick={disconnect}>
                    <PlugZap size={16} /> Disconnect
                  </button>
                )}
              </div>
              <div className="text-xs text-slate-400">
                Mode: <span className="font-medium text-slate-600">{modeLabel[mode]}</span>
                {message ? ` · ${message}` : ''}
              </div>
            </div>
          </Card>
        </div>

        <div className="xl:col-span-3">
          <Card className="overflow-hidden p-0">
            <div ref={termRef} className="min-h-[420px] bg-slate-900 p-2" />
          </Card>
        </div>
      </div>
    </Layout>
  );
}
