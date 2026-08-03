import { useEffect, useState } from 'react';
import { Banknote, Pencil, Plus, Save, Store, Trash2, UploadCloud } from 'lucide-react';
import { Card, FormField, Modal, ModalFooter } from '../ui';
import { api } from '../../api';
import { cropMerchantQr, compressImageDataUrl } from '../../lib/cropMerchantQr';

type Merchant = {
  id: number;
  name: string;
  photo?: string | null;
  address?: string | null;
  notes?: string | null;
  active: boolean;
  sortOrder?: number;
};

type PayCompany = {
  gcash_qr?: string | null;
  maya_qr?: string | null;
  gcash_number?: string;
  maya_number?: string;
  payment_instructions?: string;
};

export function PortalPaymentsPanel({ onToast }: { onToast: (msg: string) => void }) {
  const [company, setCompany] = useState<PayCompany | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [qrBusy, setQrBusy] = useState<string | null>(null);
  const [savingCompany, setSavingCompany] = useState(false);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<Partial<Merchant> | null>(null);
  const [busyMerchant, setBusyMerchant] = useState(false);

  const load = async () => {
    const [c, m] = await Promise.all([
      api.get('/company'),
      api.get('/payment-merchants'),
    ]);
    setCompany({
      gcash_qr: c.data.gcash_qr || null,
      maya_qr: c.data.maya_qr || null,
      gcash_number: c.data.gcash_number || '',
      maya_number: c.data.maya_number || '',
      payment_instructions: c.data.payment_instructions || '',
    });
    setMerchants(m.data.merchants || []);
  };

  useEffect(() => {
    void load().catch(() => setError('Could not load payment settings'));
  }, []);

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
      setQrBusy(key);
      try {
        const { dataUrl } = await cropMerchantQr(file);
        setCompany((c) => (c ? { ...c, [key]: dataUrl } : c));
      } catch {
        setError(`Could not process ${label} image.`);
      } finally {
        setQrBusy(null);
      }
    };
    input.click();
  };

  const saveCompanyPay = async () => {
    if (!company) return;
    setSavingCompany(true);
    setError('');
    try {
      const cur = await api.get('/company');
      const r = await api.put('/company', {
        ...cur.data,
        gcash_qr: company.gcash_qr,
        maya_qr: company.maya_qr,
        gcash_number: company.gcash_number,
        maya_number: company.maya_number,
        payment_instructions: company.payment_instructions,
      });
      setCompany({
        gcash_qr: r.data.gcash_qr || null,
        maya_qr: r.data.maya_qr || null,
        gcash_number: r.data.gcash_number || '',
        maya_number: r.data.maya_number || '',
        payment_instructions: r.data.payment_instructions || '',
      });
      onToast('GCash / Maya payment photos saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save payment photos');
    } finally {
      setSavingCompany(false);
    }
  };

  const uploadMerchantPhoto = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !edit) return;
      if (file.size > 3 * 1024 * 1024) {
        setError('Photo must be 3MB or smaller.');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const compressed = await compressImageDataUrl(String(reader.result), 720, 0.85);
          setEdit((e) => (e ? { ...e, photo: compressed } : e));
        } catch {
          setEdit((e) => (e ? { ...e, photo: String(reader.result) } : e));
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const saveMerchant = async () => {
    if (!edit?.name?.trim()) {
      setError('Merchant name is required');
      return;
    }
    setBusyMerchant(true);
    setError('');
    try {
      if (edit.id) {
        await api.put(`/payment-merchants/${edit.id}`, {
          name: edit.name,
          photo: edit.photo ?? null,
          address: edit.address || null,
          notes: edit.notes || null,
          active: edit.active !== false,
        });
        onToast('Merchant updated');
      } else {
        await api.post('/payment-merchants', {
          name: edit.name,
          photo: edit.photo ?? null,
          address: edit.address || null,
          notes: edit.notes || null,
          active: edit.active !== false,
        });
        onToast('Merchant added');
      }
      setEdit(null);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save merchant');
    } finally {
      setBusyMerchant(false);
    }
  };

  const removeMerchant = async (id: number) => {
    if (!confirm('Remove this cash merchant?')) return;
    await api.delete(`/payment-merchants/${id}`);
    onToast('Merchant removed');
    await load();
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm rounded-lg px-3 py-2 bg-rose-50 text-rose-700 border border-rose-100">{error}</div>
      )}

      <Card title="GCash / Maya QR photos" icon={UploadCloud}>
        <p className="text-sm text-slate-500 mb-4">
          These photos appear on the subscriber payment portal when customers choose GCash or Maya.
          Moved here from Company settings.
        </p>
        {company && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {(
                [
                  { key: 'gcash_qr' as const, label: 'GCash QR', accent: 'bg-sky-50 border-sky-100' },
                  { key: 'maya_qr' as const, label: 'Maya QR', accent: 'bg-emerald-50 border-emerald-100' },
                ] as const
              ).map(({ key, label, accent }) => (
                <div key={key} className={`rounded-2xl border p-4 ${accent}`}>
                  <div className="text-sm font-medium text-slate-700 mb-2">{label}</div>
                  <div className="border border-white/80 rounded-xl h-40 flex items-center justify-center bg-white overflow-hidden mb-3">
                    {qrBusy === key ? (
                      <span className="text-slate-400 text-sm">Cropping QR…</span>
                    ) : company[key] ? (
                      <img src={company[key]!} alt={label} className="max-h-36 max-w-[95%] object-contain" />
                    ) : (
                      <span className="text-slate-300 text-sm">No QR uploaded</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      type="button"
                      className="btn-secondary text-xs py-1.5"
                      disabled={qrBusy !== null}
                      onClick={() => void uploadMerchantQr(key, label)}
                    >
                      <UploadCloud size={14} /> Upload
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
              <FormField label="GCash number (optional)">
                <input
                  className="input font-mono text-sm"
                  value={company.gcash_number || ''}
                  onChange={(e) => setCompany({ ...company, gcash_number: e.target.value })}
                  placeholder="09xxxxxxxxx"
                />
              </FormField>
              <FormField label="Maya number (optional)">
                <input
                  className="input font-mono text-sm"
                  value={company.maya_number || ''}
                  onChange={(e) => setCompany({ ...company, maya_number: e.target.value })}
                  placeholder="09xxxxxxxxx"
                />
              </FormField>
            </div>
            <FormField label="Extra payment instructions">
              <textarea
                className="input min-h-[72px] text-sm mt-3"
                value={company.payment_instructions || ''}
                onChange={(e) => setCompany({ ...company, payment_instructions: e.target.value })}
                placeholder="e.g. Put your account number in the message field. Pay exact amount."
              />
            </FormField>
            <button
              type="button"
              className="btn-primary mt-4"
              disabled={savingCompany || qrBusy !== null}
              onClick={() => void saveCompanyPay()}
            >
              <Save size={16} /> {savingCompany ? 'Saving…' : 'Save GCash / Maya'}
            </button>
          </>
        )}
      </Card>

      <Card
        title="Cash merchants"
        icon={Store}
        right={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setEdit({ name: '', photo: null, address: '', notes: '', active: true })}
          >
            <Plus size={16} /> Add merchant
          </button>
        }
      >
        <p className="text-sm text-slate-500 mb-3">
          Subscribers paying <b>cash</b> on the payment portal pick one of these merchants.
        </p>
        {merchants.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">No cash merchants yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {merchants.map((m) => (
              <li key={m.id} className="py-3 flex items-start gap-3">
                <div className="h-14 w-14 rounded-xl border border-slate-200 bg-slate-50 overflow-hidden shrink-0 flex items-center justify-center">
                  {m.photo ? (
                    <img src={m.photo} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Banknote size={20} className="text-slate-300" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-800">
                    {m.name}
                    {!m.active && (
                      <span className="ml-2 text-[11px] font-medium text-slate-400 uppercase">Inactive</span>
                    )}
                  </div>
                  {m.address && <div className="text-xs text-slate-500 mt-0.5">{m.address}</div>}
                  {m.notes && <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">{m.notes}</div>}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button type="button" className="btn-secondary !px-2 !py-1.5" onClick={() => setEdit({ ...m })}>
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-secondary !px-2 !py-1.5 text-rose-600"
                    onClick={() => void removeMerchant(m.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {edit && (
        <Modal title={edit.id ? 'Edit merchant' : 'Add cash merchant'} onClose={() => setEdit(null)}>
          <div className="space-y-3">
            <FormField label="Name">
              <input
                className="input"
                value={edit.name || ''}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="e.g. Juan's Sari-sari / Barangay Hall"
              />
            </FormField>
            <FormField label="Address / landmark (optional)">
              <input
                className="input"
                value={edit.address || ''}
                onChange={(e) => setEdit({ ...edit, address: e.target.value })}
              />
            </FormField>
            <FormField label="Notes (optional)">
              <textarea
                className="input min-h-[64px]"
                value={edit.notes || ''}
                onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
              />
            </FormField>
            <div>
              <div className="text-sm font-medium text-slate-700 mb-1.5">Photo</div>
              <div className="h-36 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden mb-2">
                {edit.photo ? (
                  <img src={edit.photo} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-slate-300 text-sm">No photo</span>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary text-xs" onClick={() => void uploadMerchantPhoto()}>
                  <UploadCloud size={14} /> Upload photo
                </button>
                {edit.photo && (
                  <button
                    type="button"
                    className="text-xs text-rose-600 hover:underline"
                    onClick={() => setEdit({ ...edit, photo: null })}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={edit.active !== false}
                onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
              />
              Active (shown on payment portal)
            </label>
          </div>
          <ModalFooter>
            <button type="button" className="btn-secondary" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={busyMerchant} onClick={() => void saveMerchant()}>
              {busyMerchant ? 'Saving…' : 'Save merchant'}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}
