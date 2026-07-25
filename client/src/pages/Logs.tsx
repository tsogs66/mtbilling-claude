import { useEffect, useState } from 'react';
import { Code2, Globe, Mail, Monitor, Router } from 'lucide-react';
import Layout from '../components/Layout';
import { DataTable, LogPanel, PageHeader, StatusBadge, TabBar, TabPills, logBoxClass } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';

const TABS = [
  { key: 'router', label: 'Router Logs', icon: Router },
  { key: 'panel', label: 'Panel Logs', icon: Monitor },
  { key: 'nginx', label: 'Nginx Logs', icon: Globe },
  { key: 'email', label: 'Email Logs', icon: Mail },
] as const;

const PANEL_SUBTABS = [
  { key: 'ui', label: 'Panel UI' },
  { key: 'api', label: 'Panel API' },
];

const EMAIL_SUBTABS = [
  { key: 'payment', label: 'Payment' },
  { key: 'reminder', label: 'Reminder' },
  { key: 'announcement', label: 'Announcements' },
];

export default function Logs() {
  const [tab, setTab] = useState('router');
  return (
    <Layout title="Log Viewer">
      <div className="max-w-5xl mx-auto">
        <PageHeader
          title="Log Viewer"
          description="Browse router, panel, web server, and email delivery logs."
          icon={Code2}
        />

        <TabBar tabs={[...TABS]} active={tab} onChange={setTab} className="mb-5" />

        {tab === 'router' && <RouterLogs />}
        {tab === 'panel' && <PanelLogs />}
        {tab === 'nginx' && <NginxLogs />}
        {tab === 'email' && <EmailLogs />}
      </div>
    </Layout>
  );
}

function RouterLogs() {
  const { current } = useRouterDevice();
  const [data, setData] = useState<{ router: string; entries: any[] }>({ router: '', entries: [] });
  const load = () => {
    if (current) api.get(`/logs/router?routerId=${current.id}`).then((r) => setData(r.data));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const rows = data.entries.map((e, i) => ({
    key: i,
    cells: [
      <span key="time" className="whitespace-nowrap text-slate-500">
        {new Date(e.time).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' })}
        <br />
        {new Date(e.time).toLocaleTimeString('en-GB')}
      </span>,
      <span key="topic" className="text-sky-600 whitespace-nowrap">{e.topic}</span>,
      <span key="message" className="text-slate-700">{e.message}</span>,
    ],
  }));

  return (
    <LogPanel title={`Router Logs (${data.router || current?.name || ''})`} onRefresh={load}>
      <DataTable
        columns={[
          { key: 'time', label: 'Time', className: 'w-28' },
          { key: 'topic', label: 'Topic' },
          { key: 'message', label: 'Message' },
        ]}
        rows={rows}
        emptyMessage="No router log entries found."
      />
    </LogPanel>
  );
}

function PanelLogs() {
  const [sub, setSub] = useState('ui');
  const [text, setText] = useState('');
  const load = () => api.get(`/logs/panel?process=${sub}`).then((r) => setText(r.data.text));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  const title = sub === 'ui' ? 'Panel UI (mikrotik-manager)' : 'Panel API (mikrotik-api-backend)';

  return (
    <div>
      <div className="mb-4">
        <TabPills tabs={PANEL_SUBTABS} active={sub} onChange={setSub} />
      </div>
      <LogPanel title={title} onRefresh={load}>
        <pre className={`${logBoxClass} whitespace-pre-wrap`}>{text}</pre>
      </LogPanel>
    </div>
  );
}

function NginxLogs() {
  const [text, setText] = useState('');
  const load = () => api.get('/logs/nginx').then((r) => setText(r.data.text));
  useEffect(() => {
    load();
  }, []);
  return (
    <LogPanel title="Nginx Access Logs" onRefresh={load}>
      <pre className={`${logBoxClass} whitespace-pre-wrap`}>{text}</pre>
    </LogPanel>
  );
}

function EmailLogs() {
  const [sub, setSub] = useState('payment');
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api.get(`/logs/email?category=${sub}`).then((r) => setRows(r.data));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  const title = sub === 'payment' ? 'Payment Emails' : sub === 'reminder' ? 'Reminder Emails' : 'Announcements';

  const tableRows = rows.map((r) => ({
    key: r.id,
    cells: [
      <span key="date" className="whitespace-nowrap text-slate-500">{new Date(r.date).toLocaleString()}</span>,
      <StatusBadge key="status" status={r.status} />,
      <div key="details" className="font-mono text-[12px] space-y-1">
        <div className="text-slate-600">To: {r.recipient || '—'} ({r.customer})</div>
        <div className="text-slate-800 font-semibold">{r.subject}</div>
        <div className="text-slate-600 whitespace-pre-wrap">{r.message}</div>
        {r.detail && <div className="text-slate-400">{r.detail}</div>}
      </div>,
    ],
  }));

  return (
    <div>
      <div className="mb-4">
        <TabPills tabs={EMAIL_SUBTABS} active={sub} onChange={setSub} />
      </div>
      <LogPanel title={title} onRefresh={load}>
        <DataTable
          columns={[
            { key: 'date', label: 'Date', className: 'w-36' },
            { key: 'status', label: 'Status' },
            { key: 'details', label: 'Details' },
          ]}
          rows={tableRows}
          emptyMessage="No email log entries found."
        />
      </LogPanel>
    </div>
  );
}
