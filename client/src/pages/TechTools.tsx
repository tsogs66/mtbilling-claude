import { useEffect, useMemo, useState } from 'react';
import { Cable, Plus, Pencil, Trash2, RotateCcw, ArrowDownCircle, Boxes, Route } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, Modal, ModalFooter, FormField, IconAction, TabPills } from '../components/ui';
import { api } from '../api';
import { computeNapChainDbm, isAsymmetricType, ratioLegLabel, type ChainNapLike, type SplitterLike } from '../lib/opticalBudget';

type SplitterType = 'FBT' | 'PLC' | 'FBTC';

interface SplitterRow {
  id: number;
  type: SplitterType;
  ratio: string;
  ports: number | null;
  throughLossDb: number;
  tapLossDb: number | null;
  notes: string | null;
  sortOrder: number;
}

const TYPE_LABELS: Record<SplitterType, string> = {
  PLC: 'PLC splitter',
  FBT: 'FBT splitter',
  FBTC: 'FBTC (tap cassette)',
};

interface TopologyNap {
  id: number;
  name: string;
  kind: string;
  ports: number;
  parentId: number | null;
  code?: string | null;
  splitterType?: 'FBT' | 'PLC' | 'FBTC' | null;
  splitterRatio?: string | null;
  fbtcLeg?: 'through' | 'tap' | null;
  originSplitterId?: number | null;
  txDbm?: number | null;
  oltName?: string | null;
  parentKind?: string | null;
  usedPorts?: number;
  availablePorts?: number;
}

export default function TechTools() {
  const [rows, setRows] = useState<SplitterRow[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [typeTab, setTypeTab] = useState<SplitterType>('PLC');
  const [naps, setNaps] = useState<TopologyNap[]>([]);
  const [splitters, setSplitters] = useState<SplitterLike[]>([]);

  const load = () => api.get('/tech-tools/splitters').then((r) => setRows(r.data));
  const loadNaps = () => api.get('/naps?all=1').then((r) => setNaps(r.data));
  const loadSplitters = () => api.get('/splitters').then((r) => setSplitters(r.data));
  useEffect(() => {
    load();
    loadNaps();
    loadSplitters();
  }, []);

  const del = async (id: number) => {
    await api.delete(`/tech-tools/splitters/${id}`);
    load();
  };

  const filtered = rows.filter((r) => r.type === typeTab);
  const isFbtc = typeTab === 'FBTC';
  const isAsymmetric = isAsymmetricType(typeTab);

  return (
    <Layout title="Tech Tools">
      <Card
        title="Splitter Loss Reference"
        icon={Cable}
        right={
          <button
            className="btn-primary"
            onClick={() =>
              setEdit({ type: typeTab, ratio: '', ports: '', throughLossDb: '', tapLossDb: '', notes: '' })
            }
          >
            <Plus size={16} /> Add Row
          </button>
        }
      >
        <div className="mb-4">
          <TabPills
            tabs={[
              { key: 'PLC', label: 'PLC' },
              { key: 'FBT', label: 'FBT' },
              { key: 'FBTC', label: 'FBTC (Tap Cassette)' },
            ]}
            active={typeTab}
            onChange={(k) => setTypeTab(k as SplitterType)}
          />
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Typical/reference insertion-loss values — verify against your actual hardware's datasheet for
          precision-critical budgets. Every row is editable.
        </p>
        <DataTable
          columns={[
            { key: 'ratio', label: 'Ratio' },
            { key: 'ports', label: isFbtc ? 'Cassette Ports' : 'Ports', align: 'right' },
            { key: 'through', label: isAsymmetric ? 'Through Loss (dB)' : 'Loss (dB)', align: 'right' },
            ...(isAsymmetric ? [{ key: 'tap', label: 'Tap Loss (dB)', align: 'right' as const }] : []),
            { key: 'notes', label: 'Notes' },
            { key: 'actions', label: 'Actions', align: 'right' },
          ]}
          rows={filtered.map((r) => ({
            key: r.id,
            cells: [
              <span className="font-medium text-slate-800">{r.ratio}</span>,
              <span className="text-slate-600">{r.ports ?? '—'}</span>,
              <span className="text-slate-700">{r.throughLossDb.toFixed(1)}</span>,
              ...(isAsymmetric
                ? [<span className="text-slate-700">{r.tapLossDb != null ? r.tapLossDb.toFixed(1) : '—'}</span>]
                : []),
              <span className="text-slate-500 text-xs">{r.notes}</span>,
              <div className="flex items-center justify-end gap-1">
                <IconAction
                  icon={Pencil}
                  title="Edit"
                  tone="sky"
                  onClick={() => setEdit({ ...r, ports: r.ports ?? '', tapLossDb: r.tapLossDb ?? '' })}
                />
                <IconAction icon={Trash2} title="Delete" tone="rose" onClick={() => del(r.id)} />
              </div>,
            ],
          }))}
          emptyMessage="No reference rows for this type yet."
        />
      </Card>

      <div className="mt-5">
        <BudgetCalculator rows={rows} />
      </div>

      <div className="mt-5">
        <AvailableNaps naps={naps} />
      </div>

      <div className="mt-5">
        <TopologyDbmLookup naps={naps} rows={rows} splitters={splitters} />
      </div>

      {edit && <SplitterModal row={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </Layout>
  );
}

function AvailableNaps({ naps }: { naps: TopologyNap[] }) {
  const [q, setQ] = useState('');
  const boxes = useMemo(() => {
    const term = q.trim().toLowerCase();
    return naps
      .filter((n) => n.kind === 'nap')
      .filter((n) => !term || n.name.toLowerCase().includes(term) || (n.code || '').toLowerCase().includes(term))
      .sort((a, b) => (b.availablePorts ?? 0) - (a.availablePorts ?? 0));
  }, [naps, q]);

  return (
    <Card
      title="Available NAPs"
      icon={Boxes}
      right={
        <input
          className="input w-56"
          placeholder="Search NAP name or code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      }
    >
      <p className="text-xs text-slate-400 mb-3">
        Free ports per NAP box, computed from the live topology (splitter capacity minus assigned clients).
        Sorted by most available first — use this to pick where a new subscriber should land.
      </p>
      <DataTable
        columns={[
          { key: 'name', label: 'NAP' },
          { key: 'olt', label: 'Upstream' },
          { key: 'splitter', label: 'Splitter' },
          { key: 'used', label: 'Used', align: 'right' },
          { key: 'avail', label: 'Available', align: 'right' },
        ]}
        rows={boxes.map((n) => {
          const full = (n.availablePorts ?? 0) <= 0;
          return {
            key: n.id,
            cells: [
              <span className="font-medium text-slate-800">{n.code ? `${n.code} · ${n.name}` : n.name}</span>,
              <span className="text-slate-500 text-xs">{n.oltName || '—'}</span>,
              <span className="text-slate-600 text-xs">{n.splitterType && n.splitterRatio ? `${n.splitterType} ${n.splitterRatio}` : '—'}</span>,
              <span className="text-slate-600">{n.usedPorts ?? 0} / {n.ports}</span>,
              <span className={`font-semibold ${full ? 'text-rose-600' : 'text-emerald-600'}`}>
                {full ? 'Full' : n.availablePorts}
              </span>,
            ],
          };
        })}
        emptyMessage="No NAPs in the topology yet — add them from the Topology map."
      />
    </Card>
  );
}

function TopologyDbmLookup({ naps, rows, splitters }: { naps: TopologyNap[]; rows: SplitterRow[]; splitters: SplitterLike[] }) {
  const napOnly = useMemo(() => naps.filter((n) => n.kind === 'nap'), [naps]);
  const [napId, setNapId] = useState<number | ''>('');
  const [minDbm, setMinDbm] = useState('-28');
  const [maxDbm, setMaxDbm] = useState('-8');

  useEffect(() => {
    if (napId === '' && napOnly.length > 0) setNapId(napOnly[0].id);
  }, [napOnly, napId]);

  const napsById = useMemo(() => new Map(naps.map((n) => [n.id, n as ChainNapLike])), [naps]);
  const splittersById = useMemo(() => new Map(splitters.map((s) => [s.id, s])), [splitters]);
  const splitterRefs = useMemo(
    () => rows.map((r) => ({ type: r.type, ratio: r.ratio, ports: r.ports, throughLossDb: r.throughLossDb, tapLossDb: r.tapLossDb })),
    [rows]
  );
  const result = useMemo(
    () => (napId ? computeNapChainDbm(Number(napId), napsById, splitterRefs, splittersById) : null),
    [napId, napsById, splitterRefs, splittersById]
  );
  const nap = napId ? naps.find((n) => n.id === napId) : undefined;

  const min = Number(minDbm);
  const max = Number(maxDbm);
  const inRange = !!result && Number.isFinite(min) && Number.isFinite(max) && result.receivedDbm >= min && result.receivedDbm <= max;
  const marginal =
    !!result && !inRange && Number.isFinite(min) && Number.isFinite(max) && result.receivedDbm >= min - 2 && result.receivedDbm <= max + 2;

  return (
    <Card title="Topology dBm Lookup" icon={Route}>
      <p className="text-xs text-slate-400 mb-4">
        Walks a NAP's upstream chain (OLT → intermediate NAPs → this NAP) using each hop's splitter type/ratio
        set in the Topology map, and applies the matching loss from the reference table above.
      </p>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <FormField label="NAP">
          <select className="input" value={napId} onChange={(e) => setNapId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Select…</option>
            {napOnly.map((n) => (
              <option key={n.id} value={n.id}>
                {n.code ? `${n.code} · ${n.name}` : n.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Acceptable min (dBm)">
          <input className="input" type="number" step="0.1" value={minDbm} onChange={(e) => setMinDbm(e.target.value)} />
        </FormField>
        <FormField label="Acceptable max (dBm)">
          <input className="input" type="number" step="0.1" value={maxDbm} onChange={(e) => setMaxDbm(e.target.value)} />
        </FormField>
      </div>

      {!result ? (
        <p className="text-sm text-slate-400">No topology chain found — set an upstream OLT/NAP for this box on the Topology map.</p>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Hop</th>
                  <th className="text-right px-4 py-2 font-medium">Loss</th>
                  <th className="text-right px-4 py-2 font-medium">Running power</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-500">{result.oltName || 'OLT'} (Tx)</td>
                  <td className="px-4 py-2 text-right text-slate-400">—</td>
                  <td className="px-4 py-2 text-right font-medium text-slate-700">{result.originDbm.toFixed(2)} dBm</td>
                </tr>
                {result.stages.map((s, i) => (
                  <tr key={`${s.napId}-${i}`} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-600">
                      {s.name}{' '}
                      {s.splitterType && s.splitterRatio
                        ? `(${s.splitterType} ${s.splitterRatio}${isAsymmetricType(s.splitterType) ? ` · ${s.leg}` : ''})`
                        : '(no splitter set)'}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-500">{s.lossDb != null ? `−${s.lossDb.toFixed(1)} dB` : 'no ref'}</td>
                    <td className="px-4 py-2 text-right font-medium text-slate-700">{s.after.toFixed(2)} dBm</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className={`rounded-xl border p-4 flex items-center justify-between ${
              inRange ? 'border-emerald-200 bg-emerald-50' : marginal ? 'border-amber-200 bg-amber-50' : 'border-rose-200 bg-rose-50'
            }`}
          >
            <div>
              <div className="text-xs uppercase tracking-wide font-semibold text-slate-500">
                Estimated received power at {nap?.name}
              </div>
              <div className="text-2xl font-bold text-slate-900">{result.receivedDbm.toFixed(2)} dBm</div>
            </div>
            <div
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${
                inRange ? 'bg-emerald-100 text-emerald-700' : marginal ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
              }`}
            >
              {inRange ? 'Within budget' : marginal ? 'Marginal — check' : 'Out of budget'}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function SplitterModal({ row, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...row });
  const [busy, setBusy] = useState(false);
  const isEdit = !!row.id;
  const isFbtc = form.type === 'FBTC';
  const isAsymmetric = isAsymmetricType(form.type);
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.ratio?.trim() || form.throughLossDb === '') return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/tech-tools/splitters/${row.id}`, form);
      else await api.post('/tech-tools/splitters', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit Splitter Row' : 'Add Splitter Row'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Type" required>
            <select className="input" value={form.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="PLC">PLC</option>
              <option value="FBT">FBT</option>
              <option value="FBTC">FBTC (tap cassette)</option>
            </select>
          </FormField>
          <FormField label="Ratio" required hint={isAsymmetric ? 'e.g. 95:5 (through:tap)' : 'e.g. 1:8'}>
            <input className="input" value={form.ratio || ''} onChange={(e) => set({ ratio: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={isFbtc ? 'Cassette Ports' : 'Ports'} hint="Informational">
            <input
              className="input"
              type="number"
              value={form.ports ?? ''}
              onChange={(e) => set({ ports: e.target.value })}
            />
          </FormField>
          <FormField label={isAsymmetric ? 'Through Loss (dB)' : 'Loss (dB)'} required>
            <input
              className="input"
              type="number"
              step="0.1"
              value={form.throughLossDb ?? ''}
              onChange={(e) => set({ throughLossDb: e.target.value })}
            />
          </FormField>
        </div>
        {isAsymmetric && (
          <FormField label="Tap Loss (dB)" hint="Subscriber-drop leg">
            <input
              className="input"
              type="number"
              step="0.1"
              value={form.tapLossDb ?? ''}
              onChange={(e) => set({ tapLossDb: e.target.value })}
            />
          </FormField>
        )}
        <FormField label="Notes">
          <input className="input" value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} />
        </FormField>
      </div>
    </Modal>
  );
}

interface Stage {
  id: number;
  splitterId: number | '';
  leg: 'through' | 'tap';
}

function BudgetCalculator({ rows }: { rows: SplitterRow[] }) {
  const [originDbm, setOriginDbm] = useState<string>('5');
  const [minDbm, setMinDbm] = useState<string>('-28');
  const [maxDbm, setMaxDbm] = useState<string>('-8');
  const [stages, setStages] = useState<Stage[]>([{ id: 1, splitterId: '', leg: 'through' }]);
  const nextId = useMemo(() => Math.max(0, ...stages.map((s) => s.id)) + 1, [stages]);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const lastStage = stages[stages.length - 1];
  const lastIsTerminalTap = !!(
    lastStage &&
    lastStage.splitterId &&
    isAsymmetricType(byId.get(Number(lastStage.splitterId))?.type) &&
    lastStage.leg === 'tap'
  );

  const origin = Number(originDbm);
  const min = Number(minDbm);
  const max = Number(maxDbm);

  const results = useMemo(() => {
    let running = Number.isFinite(origin) ? origin : 0;
    return stages.map((s) => {
      const row = s.splitterId ? byId.get(Number(s.splitterId)) : undefined;
      if (!row) return { stage: s, row: undefined, loss: 0, after: running };
      const loss = isAsymmetricType(row.type) ? (s.leg === 'tap' ? row.tapLossDb ?? 0 : row.throughLossDb) : row.throughLossDb;
      running = running - loss;
      return { stage: s, row, loss, after: running };
    });
  }, [stages, byId, origin]);

  const finalDbm = results.length ? results[results.length - 1].after : origin;
  const inRange = Number.isFinite(min) && Number.isFinite(max) && finalDbm >= min && finalDbm <= max;
  const marginal = !inRange && Number.isFinite(min) && Number.isFinite(max) && (finalDbm >= min - 2 && finalDbm <= max + 2);

  const addStage = () => setStages((s) => [...s, { id: nextId, splitterId: '', leg: 'through' }]);
  const removeStage = (id: number) => setStages((s) => (s.length > 1 ? s.filter((x) => x.id !== id) : s));
  const updateStage = (id: number, patch: Partial<Stage>) =>
    setStages((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const reset = () => setStages([{ id: 1, splitterId: '', leg: 'through' }]);

  return (
    <Card title="Optical Budget Calculator" icon={ArrowDownCircle}>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <FormField label="Origin — OLT PON Tx power (dBm)" hint="Typical GPON: +3 to +7">
          <input className="input" type="number" step="0.1" value={originDbm} onChange={(e) => setOriginDbm(e.target.value)} />
        </FormField>
        <FormField label="Acceptable min (dBm)" hint="Typical ONU Rx sensitivity">
          <input className="input" type="number" step="0.1" value={minDbm} onChange={(e) => setMinDbm(e.target.value)} />
        </FormField>
        <FormField label="Acceptable max (dBm)">
          <input className="input" type="number" step="0.1" value={maxDbm} onChange={(e) => setMaxDbm(e.target.value)} />
        </FormField>
      </div>

      <div className="space-y-2 mb-4">
        {stages.map((s, i) => {
          const row = s.splitterId ? byId.get(Number(s.splitterId)) : undefined;
          const isFbtcRow = isAsymmetricType(row?.type);
          const disabled = i > 0 && stages.slice(0, i).some((prev) => {
            const prevRow = prev.splitterId ? byId.get(Number(prev.splitterId)) : undefined;
            return isAsymmetricType(prevRow?.type) && prev.leg === 'tap';
          });
          return (
            <div key={s.id} className={`flex flex-wrap items-end gap-2 p-3 rounded-xl border border-slate-200 ${disabled ? 'opacity-40' : ''}`}>
              <span className="text-xs font-semibold text-slate-400 w-16 pb-2">Stage {i + 1}</span>
              <div className="flex-1 min-w-[220px]">
                <FormField label="Splitter">
                  <select
                    className="input"
                    disabled={disabled}
                    value={s.splitterId}
                    onChange={(e) => updateStage(s.id, { splitterId: e.target.value ? Number(e.target.value) : '', leg: 'through' })}
                  >
                    <option value="">Select…</option>
                    {(['PLC', 'FBT', 'FBTC'] as SplitterType[]).map((t) => (
                      <optgroup key={t} label={TYPE_LABELS[t]}>
                        {rows
                          .filter((r) => r.type === t)
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.ratio}
                              {r.ports ? ` — ${r.ports}p` : ''}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </FormField>
              </div>
              {isFbtcRow && (
                <div className="w-40">
                  <FormField label="Split">
                    <select
                      className="input"
                      disabled={disabled}
                      value={s.leg}
                      onChange={(e) => updateStage(s.id, { leg: e.target.value as 'through' | 'tap' })}
                    >
                      <option value="through">{ratioLegLabel(row?.ratio, 'through')} — continue trunk</option>
                      <option value="tap">{ratioLegLabel(row?.ratio, 'tap')} — subscriber drop</option>
                    </select>
                  </FormField>
                </div>
              )}
              <div className="pb-2 text-sm text-slate-600 whitespace-nowrap">
                {row ? `−${(isFbtcRow ? (s.leg === 'tap' ? row.tapLossDb ?? 0 : row.throughLossDb) : row.throughLossDb).toFixed(1)} dB` : ''}
              </div>
              <IconAction icon={Trash2} title="Remove stage" tone="rose" onClick={() => removeStage(s.id)} />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 mb-5">
        <button className="btn-secondary" onClick={addStage} disabled={lastIsTerminalTap}>
          <Plus size={16} /> Add Stage
        </button>
        <button className="btn-secondary" onClick={reset}>
          <RotateCcw size={16} /> Reset
        </button>
        {lastIsTerminalTap && (
          <span className="text-xs text-slate-400">Tap leg ends the run — this is the subscriber's drop.</span>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Stage</th>
              <th className="text-right px-4 py-2 font-medium">Loss</th>
              <th className="text-right px-4 py-2 font-medium">Running power</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-100">
              <td className="px-4 py-2 text-slate-500">Origin</td>
              <td className="px-4 py-2 text-right text-slate-400">—</td>
              <td className="px-4 py-2 text-right font-medium text-slate-700">{Number.isFinite(origin) ? origin.toFixed(2) : '—'} dBm</td>
            </tr>
            {results.map((r, i) => (
              <tr key={r.stage.id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-slate-600">
                  {r.row ? `${TYPE_LABELS[r.row.type]} ${r.row.ratio}${r.row.type === 'FBTC' ? ` (${r.stage.leg})` : ''}` : `Stage ${i + 1} — not set`}
                </td>
                <td className="px-4 py-2 text-right text-slate-500">{r.row ? `−${r.loss.toFixed(1)} dB` : '—'}</td>
                <td className="px-4 py-2 text-right font-medium text-slate-700">{r.after.toFixed(2)} dBm</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className={`mt-4 rounded-xl border p-4 flex items-center justify-between ${
          inRange
            ? 'border-emerald-200 bg-emerald-50'
            : marginal
              ? 'border-amber-200 bg-amber-50'
              : 'border-rose-200 bg-rose-50'
        }`}
      >
        <div>
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-500">Estimated received power</div>
          <div className="text-2xl font-bold text-slate-900">{finalDbm.toFixed(2)} dBm</div>
        </div>
        <div
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${
            inRange ? 'bg-emerald-100 text-emerald-700' : marginal ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
          }`}
        >
          {inRange ? 'Within budget' : marginal ? 'Marginal — check' : 'Out of budget'}
        </div>
      </div>
    </Card>
  );
}
