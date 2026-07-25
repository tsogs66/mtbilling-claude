import { useEffect, useState } from 'react';
import { Mail, MessageSquare, Send, PlayCircle, Bell, Clock, PowerOff } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatusBadge, Toggle, TabBar, Flash, DataTable, FormField } from '../components/ui';
import { api } from '../api';

const TYPE_LABEL: Record<string, string> = {
  manual: 'Manual',
  expiry_reminder: 'Expiry reminder',
  auto_disable: 'Auto-disable',
};

const TEMPLATES = [
  {
    key: 'maintenance',
    label: 'Scheduled Maintenance',
    subject: 'Scheduled Network Maintenance',
    message:
      'Dear valued subscriber, we will be performing scheduled network maintenance in your area. A brief service interruption may occur during this window. We apologize for any inconvenience and thank you for your patience.',
  },
  {
    key: 'repair',
    label: 'Repair in Progress',
    subject: 'Network Repair in Progress',
    message:
      'Dear subscriber, our technical team is currently repairing a network issue affecting your area. We are working to restore normal service as quickly as possible and will keep you updated. Thank you for your understanding.',
  },
  {
    key: 'commissioning',
    label: 'Commissioning / Activation',
    subject: 'Service Commissioning',
    message:
      'Hello! Your connection is scheduled for commissioning and activation. Kindly ensure your equipment is powered on and accessible. Please contact our support team if you need any assistance.',
  },
  {
    key: 'outage',
    label: 'Internet Outage',
    subject: 'Internet Outage Notice',
    message:
      'Dear subscriber, we are aware of an internet outage affecting your area and are coordinating with our upstream provider to restore service at the earliest time. We appreciate your patience and apologize for the inconvenience.',
  },
  {
    key: 'payment_reminder',
    label: 'Payment Reminder',
    subject: 'Payment Reminder',
    message:
      'Hi {name}, this is a friendly reminder that your {plan} plan (Account #{account}) is due on {due}. Amount due: {amount}. Please settle on or before the due date to avoid interruption of service. Thank you!',
  },
  {
    key: 'payment_confirmation',
    label: 'Payment Confirmation',
    subject: 'Payment Confirmation',
    message:
      'Hi {name}, we have received your payment of {amount} for your {plan} plan (Account #{account}). Your service is active until {due}. Thank you for your payment!',
  },
];

const TABS = [
  { key: 'send', label: 'Send' },
  { key: 'automation', label: 'Reminders & Auto-disable' },
  { key: 'smtp', label: 'Email (SMTP)' },
  { key: 'sms', label: 'SMS Setup' },
  { key: 'log', label: 'Log' },
];

const SMS_PROVIDERS = [
  { value: 'isms', label: 'bulksms.com.ph (iSMS)' },
  { value: 'semaphore', label: 'Semaphore (semaphore.co)' },
  { value: 'smsgate', label: 'SMSGate (sms-gate.app — Android)' },
];

const SMS_PROVIDER_DEFAULTS: Record<string, { sms_api_url: string }> = {
  isms: { sms_api_url: 'https://smtpapi.vocotext.com/isms_send_all_id.php' },
  semaphore: { sms_api_url: 'https://semaphore.co/api/v4/messages' },
  smsgate: { sms_api_url: 'https://api.sms-gate.app/3rdparty/v1/messages' },
};

export default function Notifications() {
  const [settings, setSettings] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>('email');
  const [target, setTarget] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<number[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [subject, setSubject] = useState('Notice from Pa-North');
  const [message, setMessage] = useState('');
  const [banner, setBanner] = useState('');
  const [bannerType, setBannerType] = useState<'success' | 'error' | 'info'>('success');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('send');
  const [smtpPass, setSmtpPass] = useState('');
  const [smsPass, setSmsPass] = useState('');

  const loadLogs = () => api.get('/notifications').then((r) => setLogs(r.data));

  useEffect(() => {
    api.get('/notifications/settings').then((r) => setSettings(r.data));
    api.get('/clients').then((r) => setClients(r.data));
    loadLogs();
  }, []);

  const applyTemplate = (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setSubject(t.subject);
    setMessage(t.message);
  };

  const toggleClient = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const filteredClients = clients.filter(
    (c) =>
      !clientSearch ||
      (c.customer || '').toLowerCase().includes(clientSearch.toLowerCase()) ||
      (c.username || '').toLowerCase().includes(clientSearch.toLowerCase())
  );

  const saveSettings = async (patch: any) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    const r = await api.put('/notifications/settings', next);
    setSettings(r.data);
  };

  const flash = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setBanner(msg);
    setBannerType(type);
    setTimeout(() => setBanner(''), 5000);
  };

  const send = async () => {
    if (!message.trim()) {
      flash('Please enter a message.', 'error');
      return;
    }
    if (target === 'selected' && selected.length === 0) {
      flash('Please select at least one client.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post('/notifications/send', {
        channel,
        target,
        clientIds: target === 'selected' ? selected : undefined,
        subject,
        message,
      });
      flash(`Sent to ${r.data.sent} client(s) via ${channel.toUpperCase()} (${r.data.skipped} skipped — no address on file).`);
      loadLogs();
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post('/notifications/run');
      flash(`Automations run: ${r.data.remindersSent} reminder(s) sent, ${r.data.marked} marked non-payment, ${r.data.disabled} auto-disabled.`);
      loadLogs();
    } finally {
      setBusy(false);
    }
  };

  const setS = (patch: any) => setSettings((s: any) => ({ ...s, ...patch }));
  const smsProvider = String(settings?.sms_provider || 'isms').toLowerCase();
  const setSmsProvider = (provider: string) => {
    const defaults = SMS_PROVIDER_DEFAULTS[provider] || SMS_PROVIDER_DEFAULTS.isms;
    setS({ sms_provider: provider, ...defaults });
  };
  const saveGateway = async () => {
    setBusy(true);
    try {
      const payload: any = { ...settings };
      if (smtpPass) payload.smtp_pass = smtpPass;
      if (smsPass) payload.sms_api_pass = smsPass;
      const r = await api.put('/notifications/settings', payload);
      setSettings(r.data);
      setSmtpPass('');
      setSmsPass('');
      flash('Gateway settings saved.');
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <Layout title="Notifications"><div className="text-slate-400">Loading…</div></Layout>;

  return (
    <Layout title="Notifications">
      <Flash message={banner} type={bannerType} onDismiss={() => setBanner('')} />

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5" />

      {tab === 'send' && (
        <Card title="Send Notification">
          <div className="space-y-3">
            <FormField label="Channel" hint="Uses each client's saved email and/or SMS contact number.">
              <div className="flex gap-2">
                {([['email', 'Email', Mail], ['sms', 'SMS', MessageSquare], ['both', 'Both', Send]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setChannel(key)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border ${channel === key ? 'bg-brand-500 text-white border-brand-500' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                  >
                    <Icon size={15} /> {label}
                  </button>
                ))}
              </div>
            </FormField>

            <FormField label="Recipients">
              <div className="flex gap-2 mb-2">
                {(['all', 'selected'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTarget(t)}
                    className={`px-3 py-1.5 rounded-lg text-sm border ${target === t ? 'bg-brand-500 text-white border-brand-500' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                  >
                    {t === 'all' ? 'All clients' : `Selected (${selected.length})`}
                  </button>
                ))}
              </div>
              {target === 'selected' && (
                <div className="border border-slate-200 rounded-lg">
                  <input
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                    placeholder="Search clients..."
                    className="w-full text-sm px-3 py-2 border-b border-slate-100 focus:outline-none"
                  />
                  <div className="max-h-40 overflow-y-auto">
                    {filteredClients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggleClient(c.id)} />
                        <span className="text-slate-700">{c.customer || c.username}</span>
                        <span className="text-slate-400 text-xs ml-auto">{c.email || c.contact || 'no contact'}</span>
                      </label>
                    ))}
                    {filteredClients.length === 0 && <div className="px-3 py-3 text-sm text-slate-400">No clients found.</div>}
                  </div>
                </div>
              )}
            </FormField>

            <FormField label="Message template">
              <select className="input" defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">— Choose a preformatted template —</option>
                {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <p className="text-xs text-slate-400 mt-1">
                Tokens are personalized per subscriber: <code>{'{name}'}</code>, <code>{'{account}'}</code>, <code>{'{plan}'}</code>, <code>{'{amount}'}</code>, <code>{'{due}'}</code>.
              </p>
            </FormField>

            {channel !== 'sms' && (
              <FormField label="Subject (email)">
                <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </FormField>
            )}
            <FormField label="Message">
              <textarea className="input min-h-[110px]" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Type your announcement or reminder…" />
              {(channel === 'sms' || channel === 'both') && (
                <p className="text-xs text-slate-400 mt-1">
                  SMS messages automatically end with your company name as a signature (from <strong>Company</strong> settings), e.g. <code>— Pa-North Fiber Internet</code>.
                </p>
              )}
            </FormField>
            <button type="button" className="btn-primary" onClick={send} disabled={busy}>
              <Send size={16} /> {busy ? 'Sending…' : target === 'all' ? 'Send to all clients' : `Send to ${selected.length} selected`}
            </button>
          </div>
        </Card>
      )}

      {tab === 'automation' && (
        <Card title="Reminder & Auto-disable Settings">
          <div className="space-y-4">
            <Row icon={<Bell size={16} className="text-brand-500" />} label="Expiry reminders" desc="Notify clients before their plan expires">
              <Toggle label="Expiry reminders" on={!!settings.reminder_enabled} onChange={() => saveSettings({ reminder_enabled: settings.reminder_enabled ? 0 : 1 })} />
            </Row>
            <div className="flex items-center justify-between text-sm pl-7">
              <span className="text-slate-500">Send reminder this many days before expiration</span>
              <input
                type="number"
                min={1}
                className="input w-20 text-center"
                value={settings.days_before}
                onChange={(e) => saveSettings({ days_before: Number(e.target.value) })}
              />
            </div>

            <div className="flex items-center gap-4 pl-7 text-sm">
              <label className="flex items-center gap-2"><Toggle label="Email reminders" on={!!settings.email_enabled} onChange={() => saveSettings({ email_enabled: settings.email_enabled ? 0 : 1 })} /> Email</label>
              <label className="flex items-center gap-2"><Toggle label="SMS reminders" on={!!settings.sms_enabled} onChange={() => saveSettings({ sms_enabled: settings.sms_enabled ? 0 : 1 })} /> SMS</label>
            </div>

            <div className="border-t border-slate-100 pt-3" />

            <Row icon={<PowerOff size={16} className="text-rose-500" />} label="Auto-disable on non-payment" desc="Disable when overdue past the grace period (from due date)">
              <Toggle label="Auto-disable on non-payment" on={!!settings.autodisable_enabled} onChange={() => saveSettings({ autodisable_enabled: settings.autodisable_enabled ? 0 : 1 })} />
            </Row>
            <div className="flex items-center justify-between text-sm pl-7">
              <span className="text-slate-500">Grace hours after due date (within grace → non-payment profile)</span>
              <input
                type="number"
                min={1}
                className="input w-20 text-center"
                value={settings.autodisable_hours}
                onChange={(e) => saveSettings({ autodisable_hours: Number(e.target.value) })}
              />
            </div>

            <div className="border-t border-slate-100 pt-3 flex items-center justify-between">
              <div className="text-xs text-slate-400 flex items-center gap-1.5"><Clock size={14} /> Runs automatically every 5 minutes.</div>
              <button type="button" className="inline-flex items-center gap-2 text-sm border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 text-slate-600" onClick={runNow} disabled={busy}>
                <PlayCircle size={15} /> Run checks now
              </button>
            </div>
          </div>
        </Card>
      )}

      {tab === 'smtp' && (
        <Card title="Email (SMTP) Setup">
          <div className="max-w-xl space-y-3">
            <p className="text-sm text-slate-500">Configure an SMTP server to actually deliver email notifications and receipts. Leave empty to keep messages in simulated mode.</p>
            <label className="flex items-center gap-2 text-sm">
              <Toggle label="Email notifications enabled" on={!!settings.email_enabled} onChange={() => saveSettings({ email_enabled: settings.email_enabled ? 0 : 1 })} /> Email notifications enabled
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="SMTP Host">
                <input className="input" placeholder="smtp.gmail.com" value={settings.smtp_host || ''} onChange={(e) => setS({ smtp_host: e.target.value })} />
              </FormField>
              <FormField label="Port">
                <input className="input" type="number" value={settings.smtp_port || 587} onChange={(e) => setS({ smtp_port: Number(e.target.value) })} />
              </FormField>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Toggle label="Use SSL/TLS" on={!!settings.smtp_secure} onChange={() => setS({ smtp_secure: settings.smtp_secure ? 0 : 1 })} /> Use SSL/TLS (port 465)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="SMTP Username">
                <input className="input" value={settings.smtp_user || ''} onChange={(e) => setS({ smtp_user: e.target.value })} />
              </FormField>
              <FormField label={settings.smtp_pass_set ? 'SMTP Password (saved)' : 'SMTP Password'}>
                <input className="input" type="password" placeholder={settings.smtp_pass_set ? '••••••• (leave blank to keep)' : ''} value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="From Address">
                <input className="input" placeholder="billing@pa-north.net" value={settings.smtp_from || ''} onChange={(e) => setS({ smtp_from: e.target.value })} />
              </FormField>
              <FormField label="Default From (fallback)">
                <input className="input" value={settings.email_from || ''} onChange={(e) => setS({ email_from: e.target.value })} />
              </FormField>
            </div>
            <button type="button" className="btn-primary" onClick={saveGateway} disabled={busy}>{busy ? 'Saving…' : 'Save SMTP Settings'}</button>
          </div>
        </Card>
      )}

      {tab === 'sms' && (
        <Card title="SMS Setup">
          <div className="max-w-xl space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <Toggle label="SMS notifications enabled" on={!!settings.sms_enabled} onChange={() => saveSettings({ sms_enabled: settings.sms_enabled ? 0 : 1 })} /> SMS notifications enabled
            </label>
            <FormField label="SMS Provider">
              <select className="input" value={smsProvider} onChange={(e) => setSmsProvider(e.target.value)}>
                {SMS_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </FormField>

            {smsProvider === 'smsgate' ? (
              <>
                <p className="text-sm text-slate-500">
                  Use a free <a className="text-brand-600 underline" href="https://sms-gate.app/" target="_blank" rel="noreferrer">SMSGate</a> Android phone as your SMS gateway. Install the app, enable <strong>Cloud</strong> or <strong>Local Server</strong>, then copy the username and password from the app home screen. SMS is sent via your phone SIM (load cost only, no API fees).
                </p>
                <FormField label="API Endpoint">
                  <input
                    className="input"
                    placeholder="https://api.sms-gate.app/3rdparty/v1/messages"
                    value={settings.sms_api_url || SMS_PROVIDER_DEFAULTS.smsgate.sms_api_url}
                    onChange={(e) => setS({ sms_api_url: e.target.value })}
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    Cloud: leave default. Local mode: use your phone IP, e.g. <code>http://192.168.1.50:8080</code> (MT-Billing server must be on the same LAN).
                  </p>
                </FormField>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="API Username">
                    <input className="input" value={settings.sms_api_user || ''} onChange={(e) => setS({ sms_api_user: e.target.value })} />
                  </FormField>
                  <FormField label={settings.sms_api_pass_set ? 'API Password (saved)' : 'API Password'}>
                    <input className="input" type="password" placeholder={settings.sms_api_pass_set ? '••••••• (leave blank to keep)' : ''} value={smsPass} onChange={(e) => setSmsPass(e.target.value)} />
                  </FormField>
                </div>
                <FormField label="SIM slot (optional)">
                  <select className="input" value={settings.sms_type || 0} onChange={(e) => setS({ sms_type: Number(e.target.value) })}>
                    <option value={0}>Default SIM</option>
                    <option value={1}>SIM 1</option>
                    <option value={2}>SIM 2</option>
                    <option value={3}>SIM 3</option>
                  </select>
                </FormField>
              </>
            ) : smsProvider === 'semaphore' ? (
              <>
                <p className="text-sm text-slate-500">
                  Connect your <a className="text-brand-600 underline" href="https://semaphore.co/" target="_blank" rel="noreferrer">Semaphore</a> account. Get your API key from the Semaphore dashboard. Messages are sent via <code>apikey</code>, <code>number</code>, <code>message</code>, and <code>sendername</code>.
                </p>
                <FormField label={settings.sms_api_pass_set ? 'API Key (saved)' : 'API Key'}>
                  <input className="input" type="password" placeholder={settings.sms_api_pass_set ? '••••••• (leave blank to keep)' : 'Your Semaphore API key'} value={smsPass} onChange={(e) => setSmsPass(e.target.value)} />
                </FormField>
                <FormField label="Sender Name (sendername)">
                  <input className="input" maxLength={11} placeholder="Approved sender name" value={settings.sms_sender || ''} onChange={(e) => setS({ sms_sender: e.target.value })} />
                  <p className="text-xs text-slate-400 mt-1">Must be an approved sender name on your Semaphore account.</p>
                </FormField>
                <FormField label="API Endpoint (optional)">
                  <input className="input" value={settings.sms_api_url || SMS_PROVIDER_DEFAULTS.semaphore.sms_api_url} onChange={(e) => setS({ sms_api_url: e.target.value })} />
                </FormField>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-500">
                  Connect your <a className="text-brand-600 underline" href="https://www.bulksms.com.ph/sms_api.php" target="_blank" rel="noreferrer">bulksms.com.ph</a> (iSMS) account to send real SMS. Requests use the <code>un</code>, <code>pwd</code>, <code>dstno</code>, <code>msg</code>, <code>type</code>, <code>agreedterm</code> and <code>sendid</code> parameters.
                </p>
                <FormField label="API Endpoint">
                  <input className="input" value={settings.sms_api_url || ''} onChange={(e) => setS({ sms_api_url: e.target.value })} />
                </FormField>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="API Username (un)">
                    <input className="input" value={settings.sms_api_user || ''} onChange={(e) => setS({ sms_api_user: e.target.value })} />
                  </FormField>
                  <FormField label={settings.sms_api_pass_set ? 'API Password (pwd) (saved)' : 'API Password (pwd)'}>
                    <input className="input" type="password" placeholder={settings.sms_api_pass_set ? '••••••• (leave blank to keep)' : ''} value={smsPass} onChange={(e) => setSmsPass(e.target.value)} />
                  </FormField>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Sender ID (sendid)">
                    <input className="input" maxLength={11} value={settings.sms_sender || ''} onChange={(e) => setS({ sms_sender: e.target.value })} />
                  </FormField>
                  <FormField label="Message Type">
                    <select className="input" value={settings.sms_type || 1} onChange={(e) => setS({ sms_type: Number(e.target.value) })}>
                      <option value={1}>ASCII (English) — up to 153 chars</option>
                      <option value={2}>Unicode — up to 63 chars</option>
                    </select>
                  </FormField>
                </div>
              </>
            )}
            <button type="button" className="btn-primary" onClick={saveGateway} disabled={busy}>{busy ? 'Saving…' : 'Save SMS Settings'}</button>
          </div>
        </Card>
      )}

      {tab === 'log' && (
        <Card title="Notification Log" noPadding>
          <div className="p-5">
            <DataTable
              columns={[
                { key: 'time', label: 'Time' },
                { key: 'channel', label: 'Channel' },
                { key: 'type', label: 'Type' },
                { key: 'recipient', label: 'Recipient' },
                { key: 'message', label: 'Message', className: 'max-w-[280px]' },
                { key: 'status', label: 'Status' },
              ]}
              rows={logs.map((l) => ({
                key: l.id,
                cells: [
                  <span className="text-slate-400 whitespace-nowrap">{new Date(l.date).toLocaleString()}</span>,
                  <span className="inline-flex items-center gap-1 text-slate-600">
                    {l.channel === 'email' ? <Mail size={14} /> : <MessageSquare size={14} />} {l.channel}
                  </span>,
                  <span className="text-slate-500">{TYPE_LABEL[l.type] || l.type}</span>,
                  <span className="text-slate-600">
                    {l.customer}
                    <div className="text-[11px] text-slate-400">{l.recipient || '—'}</div>
                  </span>,
                  <span className="text-slate-500 truncate block max-w-[280px]" title={l.message}>{l.message}</span>,
                  <span>
                    <StatusBadge status={l.status} />
                    <div className="text-[11px] text-slate-400">{l.detail}</div>
                  </span>,
                ],
              }))}
              emptyMessage="No notifications yet."
            />
          </div>
        </Card>
      )}
    </Layout>
  );
}

function Row({ icon, label, desc, children }: { icon: React.ReactNode; label: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <div className="text-sm font-medium text-slate-700">{label}</div>
          <div className="text-xs text-slate-400">{desc}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
