import { useEffect, useRef, useState } from 'react';
import { Building2, UploadCloud } from 'lucide-react';
import Layout from '../components/Layout';
import { SettingsSection, FormField, Flash, LoadingPage, Toast } from '../components/ui';
import { api } from '../api';
import { useCompany } from '../context/CompanyContext';
import { compressImageDataUrl } from '../lib/cropMerchantQr';

export default function Company() {
  const { refresh } = useCompany();
  const [company, setCompany] = useState<any>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('No file chosen');
  const topRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 4000);
  };

  useEffect(() => {
    api.get('/company').then((r) => setCompany(r.data));
  }, []);

  const onLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('Logo must be 2MB or smaller.');
      return;
    }
    setError('');
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const compressed = await compressImageDataUrl(String(reader.result), 512, 0.88);
        setCompany((c: any) => ({ ...c, logo: compressed }));
      } catch {
        setCompany((c: any) => ({ ...c, logo: reader.result }));
      }
    };
    reader.readAsDataURL(file);
  };


  const save = async () => {
    setError('');
    setInfo('');
    setSaving(true);
    try {
      const r = await api.put('/company', company);
      setCompany(r.data);
      await refresh();
      showToast('Company details saved successfully.');
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        status === 413
          ? 'Upload too large (HTTP 413). Re-upload QRs (they will be compressed) or raise nginx client_max_body_size, then try Save again.'
          : e?.response?.data?.error || e?.message || 'Could not save company details.';
      setError(msg);
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      setSaving(false);
    }
  };

  if (!company) return <Layout title="Company"><LoadingPage label="Loading company profile…" /></Layout>;

  return (
    <Layout title="Company">
      <div ref={topRef} />
      <Flash message={error} type="error" onDismiss={() => setError('')} />
      <Flash message={info} type="info" onDismiss={() => setInfo('')} />
      <Toast message={toast} />

      <SettingsSection icon={Building2} title="Company Branding & Information">
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-start">
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Company Logo</div>
              <div className="border border-slate-200 rounded-2xl h-32 flex items-center justify-center bg-gradient-to-br from-slate-50 to-white overflow-hidden shadow-inner">
                {company.logo ? (
                  <img src={company.logo} alt="Company logo" className="max-h-28 max-w-[90%] object-contain" />
                ) : (
                  <span className="text-slate-300 text-sm">No logo</span>
                )}
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Upload Logo</div>
              <div className="flex items-center gap-3 flex-wrap">
                <button type="button" onClick={() => fileRef.current?.click()} className="btn-primary">
                  <UploadCloud size={16} /> Choose file
                </button>
                <span className="text-sm text-brand-600 font-medium">{fileName}</span>
                <input ref={fileRef} type="file" accept="image/png,image/svg+xml,image/jpeg" className="hidden" onChange={onLogo} />
              </div>
              <p className="text-xs text-slate-400 mt-2">Recommended: PNG or SVG with transparent background. Max 2MB.</p>
            </div>
          </div>

          <div className="border-t border-slate-100" />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <FormField label="Company Name">
              <input className="input" value={company.name || ''} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
            </FormField>
          </div>

          <FormField
            label="Contact Numbers"
            hint="One number per line — press Enter for a new line. All lines print on payment receipts (e.g. Globe, PLDT, Smart)."
          >
            <textarea
              className="input min-h-[96px] font-mono text-sm"
              rows={4}
              value={company.phone || ''}
              onChange={(e) => setCompany({ ...company, phone: e.target.value })}
              placeholder={'Globe - 0432331237\nPLDT - 0433494204 / 0437747409\nSmart - 09283068822'}
            />
          </FormField>

          <FormField
            label="Email Addresses"
            hint="One email per line — press Enter for a new line. Shown on printed receipts."
          >
            <textarea
              className="input min-h-[72px] font-mono text-sm"
              rows={3}
              value={company.email || ''}
              onChange={(e) => setCompany({ ...company, email: e.target.value })}
              placeholder={'billing@example.com\nsupport@example.com'}
            />
          </FormField>

          <FormField
            label="Address"
            hint="One line per row on receipts — press Enter for a new line (e.g. barangay, city, province)."
          >
            <textarea className="input min-h-[96px]" value={company.address || ''} onChange={(e) => setCompany({ ...company, address: e.target.value })} />
          </FormField>

          <div className="border-t border-slate-100 pt-5" />
          <div className="text-sm font-semibold text-slate-800">Subscriber payment (GCash / Maya / Cash)</div>
          <p className="text-xs text-slate-500 -mt-3 leading-relaxed">
            Payment QR photos and cash merchants are managed under{' '}
            <a href="/subscriber-portal?tab=payments" className="text-brand-600 font-semibold hover:underline">
              Subscriber Portal → Payments
            </a>
            . They appear on the public payment portal when subscribers pay.
          </p>

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            {toast && (
              <span className="text-sm font-medium text-emerald-700">{toast}</span>
            )}
          </div>
        </div>
      </SettingsSection>
    </Layout>
  );
}
