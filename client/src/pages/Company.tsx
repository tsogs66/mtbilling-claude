import { useEffect, useRef, useState } from 'react';
import { Building2, UploadCloud } from 'lucide-react';
import Layout from '../components/Layout';
import { SettingsSection, FormField, Flash, LoadingPage, Toast } from '../components/ui';
import { api } from '../api';
import { useCompany } from '../context/CompanyContext';
import { cropMerchantQr, compressImageDataUrl } from '../lib/cropMerchantQr';

export default function Company() {
  const { refresh } = useCompany();
  const [company, setCompany] = useState<any>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('No file chosen');
  const [qrBusy, setQrBusy] = useState<string | null>(null);
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

  const uploadMerchantQr = async (key: 'gcash_qr' | 'maya_qr', label: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) {
        setError(`${label} must be 3MB or smaller.`);
        return;
      }
      setError('');
      setInfo('');
      setQrBusy(key);
      try {
        const { dataUrl, cropped } = await cropMerchantQr(file);
        setCompany((c: any) => ({ ...c, [key]: dataUrl }));
        setInfo(
          cropped
            ? `${label}: cropped to the QR code only. Save Changes to apply.`
            : `${label}: no QR detected in the image — uploaded as-is. Save Changes to apply.`,
        );
      } catch {
        setError(`Could not process ${label} image.`);
      } finally {
        setQrBusy(null);
      }
    };
    input.click();
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
          <div className="text-sm font-semibold text-slate-800">Subscriber payment (GCash / Maya)</div>
          <p className="text-xs text-slate-400 -mt-3">
            Upload each merchant QR (or a full GCash/Maya screenshot). We auto-crop to the QR code when possible.
            The pay page shows the matching QR when the subscriber picks GCash or Maya.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {([
              { key: 'gcash_qr' as const, label: 'GCash QR', accent: 'bg-sky-50 border-sky-100' },
              { key: 'maya_qr' as const, label: 'Maya QR', accent: 'bg-emerald-50 border-emerald-100' },
            ]).map(({ key, label, accent }) => (
              <div key={key} className={`rounded-2xl border p-4 ${accent}`}>
                <div className="text-sm font-medium text-slate-700 mb-2">{label}</div>
                <div className="border border-white/80 rounded-xl h-44 flex items-center justify-center bg-white overflow-hidden mb-3">
                  {qrBusy === key ? (
                    <span className="text-slate-400 text-sm">Cropping QR…</span>
                  ) : company[key] ? (
                    <img src={company[key]} alt={label} className="max-h-40 max-w-[95%] object-contain" />
                  ) : (
                    <span className="text-slate-300 text-sm">No QR uploaded</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <button
                    type="button"
                    className="btn-secondary text-xs py-1.5"
                    disabled={qrBusy !== null}
                    onClick={() => uploadMerchantQr(key, label)}
                  >
                    <UploadCloud size={14} /> Upload {label}
                  </button>
                  {company[key] && (
                    <button
                      type="button"
                      className="text-xs text-rose-600 hover:underline"
                      onClick={() => setCompany({ ...company, [key]: null })}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="GCash number (optional)">
              <input className="input font-mono text-sm" value={company.gcash_number || ''} onChange={(e) => setCompany({ ...company, gcash_number: e.target.value })} placeholder="09xxxxxxxxx" />
            </FormField>
            <FormField label="Maya number (optional)">
              <input className="input font-mono text-sm" value={company.maya_number || ''} onChange={(e) => setCompany({ ...company, maya_number: e.target.value })} placeholder="09xxxxxxxxx" />
            </FormField>
          </div>
          <FormField label="Extra payment instructions">
            <textarea
              className="input min-h-[72px] text-sm"
              value={company.payment_instructions || ''}
              onChange={(e) => setCompany({ ...company, payment_instructions: e.target.value })}
              placeholder="e.g. Put your account number in the message field. Pay exact amount."
            />
          </FormField>

          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <button type="button" className="btn-primary" onClick={save} disabled={saving || qrBusy !== null}>
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
