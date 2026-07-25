import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckCircle2, Loader2, Camera, ShieldCheck, Info, Clock3, ImageIcon,
  ZoomIn, Download, X, SwitchCamera, Upload, Copy, Check, AlertCircle,
} from 'lucide-react';
import { PRODUCT_TITLE } from '../branding';
import { getApiBase } from '../config';

type Channel = 'gcash' | 'maya' | '';

function parseMoneyToken(raw: string): number | null {
  const n = Number(String(raw).replace(/,/g, '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 5_000_000) return null;
  return Math.round(n * 100) / 100;
}

type PrepOpts = {
  contrast?: number;
  threshold?: number | null;
  scale?: number;
  /** Prefer lower portion of screenshot (where Ref No. often sits). */
  focusBottom?: boolean;
};

/** Upscale + contrast / threshold variants so Tesseract reads receipts more reliably. */
async function preprocessForOcr(dataUrl: string, opts: PrepOpts = {}): Promise<string> {
  const contrast = opts.contrast ?? 1.45;
  const threshold = opts.threshold ?? null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const srcW = img.width;
        const srcH = img.height;
        const cropY = opts.focusBottom ? Math.floor(srcH * 0.28) : 0;
        const cropH = srcH - cropY;
        const maxSide = Math.max(srcW, cropH);
        const autoScale = maxSide < 900 ? 2.6 : maxSide < 1400 ? 1.8 : 1.35;
        const scale = opts.scale ?? autoScale;
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(cropH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, cropY, srcW, cropH, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          let v = Math.max(0, Math.min(255, (g - 128) * contrast + 128));
          if (threshold != null) v = v >= threshold ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Fix common OCR letter→digit mistakes inside reference-like tokens. */
function normalizeOcrRefToken(raw: string): string {
  return String(raw || '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/[Zz]/g, '2')
    .replace(/[Gg]/g, '6')
    .replace(/[^A-Za-z0-9]/g, '');
}

/** Extract likely GCash/Maya/bank reference numbers from OCR text. */
function extractReferenceCandidates(text: string): string[] {
  const normalized = text
    .replace(/[\u00A0\t]+/g, ' ')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1');
  const cleaned = normalized.replace(/[ \t]+/g, ' ').trim();
  const scored = new Map<string, number>();
  const add = (raw: string, score: number) => {
    const v = normalizeOcrRefToken(raw);
    if (v.length < 8 || v.length > 28) return;
    if (/^09\d{9}$/.test(v)) return; // mobile
    if (/^63\d{10}$/.test(v)) return;
    if (/^\d{1,7}$/.test(v)) return;
    // Prefer digit-heavy refs (GCash/Maya)
    const digits = v.replace(/\D/g, '');
    const digitRatio = digits.length / v.length;
    if (digitRatio < 0.6) return;
    let bonus = digitRatio >= 0.85 ? 4 : 1;
    // Typical GCash/Maya lengths
    if (digits.length >= 12 && digits.length <= 16) bonus += 4;
    if (digits.length === 13 || digits.length === 14) bonus += 2;
    scored.set(digits.length >= 10 ? digits : v, Math.max(scored.get(digits.length >= 10 ? digits : v) || 0, score + bonus));
  };

  // Line-oriented: anything on a Ref/Txn line — join digits on that line (+ next if it looks like a ref)
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/(ref(?:erence)?|txn|trans(?:action)?|confirm(?:ation)?|trace|control\s*no)/i.test(line)) {
      const next = lines[i + 1] || '';
      const nextDigits = next.replace(/\D/g, '');
      const nextLooksLikeRef =
        nextDigits.length >= 10 &&
        nextDigits.length <= 16 &&
        !/[₱.]/.test(next) &&
        !/(amount|total|php|sent|paid)/i.test(next);
      const chunk = nextLooksLikeRef ? `${line} ${next}` : line;
      // Prefer grouped digit patterns over "all digits on the line" (avoids sucking in dates/amounts)
      const groups = chunk.match(/\d{3,5}(?:[\s-]\d{3,5}){2,5}/g);
      if (groups) for (const g of groups) add(g, 16);
      const continuous = chunk.match(/\d{10,16}/g);
      if (continuous) for (const g of continuous) add(g, 15);
      // Digits-only after stripping labels on the ref line
      const afterLabel = chunk.replace(/^.*?(?:no\.?|number|#|id|num)\s*[:.-]?\s*/i, '');
      const digitsOnly = afterLabel.replace(/\D/g, '');
      if (digitsOnly.length >= 10 && digitsOnly.length <= 16) add(digitsOnly, 18);
    }
  }

  const labeled = [
    /(?:Ref(?:erence)?|Txn|Trans(?:action)?|Confirmation|Trace|Control)\s*(?:No\.?|Number|#|ID|Num)?\s*[:.-]?\s*((?:\d[\d\s-]{8,28}\d))/gi,
    /(?:Ref(?:erence)?\s*No\.?)\s*((?:\d{3,5}[\s-]){2,5}\d{3,5}|\d{10,16})/gi,
  ];
  for (const re of labeled) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) add(m[1], 14);
  }

  // GCash-style grouped digits (3–5 groups)
  let m: RegExpExecArray | null;
  const grouped = /\b(\d{3,5}(?:[\s-]\d{3,5}){2,5})\b/g;
  while ((m = grouped.exec(cleaned))) add(m[1], 12);

  // Continuous digit runs (OCR sometimes drops spaces)
  const longDigits = /\b(\d{10,16})\b/g;
  while ((m = longDigits.exec(cleaned))) add(m[1], 8);

  // Join adjacent short digit tokens: "1234 567 89012" → missing space variants
  const loose = cleaned.match(/(?:\d{2,5}[\s-]+){3,6}\d{2,5}/g);
  if (loose) for (const g of loose) add(g, 11);

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([v]) => v)
    .slice(0, 8);
}

/**
 * Extract peso amounts from receipt OCR.
 * Prefers values near Amount/Total labels; returns best match for `due`.
 */
function extractReceiptAmount(text: string, due: number): { amount: number | null; candidates: number[] } {
  const cleaned = text.replace(/[\u00A0\t]+/g, ' ').replace(/\s+/g, ' ');
  const scored: { value: number; score: number }[] = [];
  const push = (raw: string, score: number) => {
    const v = parseMoneyToken(raw);
    if (v == null) return;
    scored.push({ value: v, score });
  };

  const labeled = [
    /(?:Amount|Total(?:\s+Amount)?|You\s+sent|You\s+paid|Paid|Transfer(?:\s+Amount)?|Sent)\s*[:.-]?\s*(?:₱|PHP|PhP|P)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi,
    /(?:₱|PHP|PhP)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi,
  ];
  for (const re of labeled) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) push(m[1], re.source.startsWith('(?:Amount') ? 20 : 12);
  }

  // Bare money-looking decimals
  const bare = /\b([0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{2}|[0-9]+\.[0-9]{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = bare.exec(cleaned))) push(m[1], 5);

  if (!scored.length) return { amount: null, candidates: [] };

  // Dedupe by value, keep highest score
  const bestByValue = new Map<number, number>();
  for (const s of scored) bestByValue.set(s.value, Math.max(bestByValue.get(s.value) || 0, s.score));
  const unique = Array.from(bestByValue.entries())
    .map(([value, score]) => ({ value, score }))
    .sort((a, b) => b.score - a.score || b.value - a.value);

  const dueN = Number(due) || 0;
  const tol = 0.05; // OCR cents noise
  const covering = unique.filter((u) => u.value + tol >= dueN);
  const pick =
    covering.sort((a, b) => {
      // Prefer closest to due among amounts that cover it
      const da = Math.abs(a.value - dueN);
      const db = Math.abs(b.value - dueN);
      return da - db || b.score - a.score;
    })[0] ||
    unique[0];

  return {
    amount: pick?.value ?? null,
    candidates: unique.map((u) => u.value).slice(0, 6),
  };
}

async function recognizeReceiptText(dataUrl: string): Promise<string> {
  const Tesseract = await import('tesseract.js');
  const variants = await Promise.all([
    preprocessForOcr(dataUrl, { contrast: 1.5 }),
    preprocessForOcr(dataUrl, { contrast: 1.85, threshold: 145 }),
    preprocessForOcr(dataUrl, { contrast: 1.6, focusBottom: true }),
    preprocessForOcr(dataUrl, { contrast: 1.9, threshold: 150, focusBottom: true }),
  ]);

  const texts: string[] = [];
  // Full-page general pass on first two variants
  for (const img of variants.slice(0, 2)) {
    const result = await Tesseract.recognize(img, 'eng', { logger: () => undefined });
    if (result.data.text) texts.push(result.data.text);
  }

  // Digit-focused pass (helps Ref No. when letters confuse OCR)
  const { createWorker } = Tesseract;
  const worker = await createWorker('eng');
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789- ',
      preserve_interword_spaces: '1',
    } as any);
    for (const img of [variants[2], variants[3], variants[0]]) {
      const r = await worker.recognize(img);
      if (r.data.text) texts.push(r.data.text);
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }

  return texts.join('\n');
}

/** Public subscriber payment page — no panel login required. */
export default function SubscriberPay() {
  const { token } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [channel, setChannel] = useState<Channel>('');
  const [ref, setRef] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [ocrHints, setOcrHints] = useState<string[]>([]);
  const [ocrAmount, setOcrAmount] = useState<number | null>(null);
  const [ocrAmountCandidates, setOcrAmountCandidates] = useState<number[]>([]);
  const [done, setDone] = useState<any>(null);
  const [qrZoomOpen, setQrZoomOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dueAmountRef = useRef(0);

  useEffect(() => {
    document.title = `Pay — ${PRODUCT_TITLE}`;
    fetch(`${getApiBase()}/public/pay/${token}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Not found');
        setData(j);
        dueAmountRef.current = Number(j.amount || 0);
        if (j.payChannel === 'gcash' || j.payChannel === 'maya') setChannel(j.payChannel);
        if (j.externalRef) setRef(j.externalRef);
      })
      .catch((e) => setError(e.message || 'Could not load payment link'));
  }, [token]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const startCamera = async (facing: 'environment' | 'user' = facingMode) => {
    setCameraError('');
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera is not supported on this device/browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setCameraError('Could not open camera. Allow camera permission and try again.');
    }
  };

  useEffect(() => {
    if (!cameraOpen) {
      stopCamera();
      return;
    }
    void startCamera(facingMode);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen, facingMode]);

  useEffect(() => {
    if (!qrZoomOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQrZoomOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [qrZoomOpen]);

  const runOcr = async (dataUrl: string) => {
    setOcrBusy(true);
    setOcrHints([]);
    setOcrAmount(null);
    setOcrAmountCandidates([]);
    try {
      const text = await recognizeReceiptText(dataUrl);
      const candidates = extractReferenceCandidates(text);
      setOcrHints(candidates);
      if (candidates[0]) {
        setRef((prev) => {
          const p = prev.trim().replace(/[^A-Za-z0-9]/g, '');
          if (!p || p.length < 8) return candidates[0];
          // Upgrade if OCR found a longer/better ref that contains the typed prefix
          const better = candidates.find(
            (c) => c.length > p.length && (c.startsWith(p) || p.startsWith(c.slice(0, Math.min(8, c.length)))),
          );
          return better || prev;
        });
      }
      const due = dueAmountRef.current || 0;
      const { amount, candidates: amts } = extractReceiptAmount(text, due);
      setOcrAmount(amount);
      setOcrAmountCandidates(amts);
    } catch {
      setOcrHints([]);
      setOcrAmount(null);
      setOcrAmountCandidates([]);
    } finally {
      setOcrBusy(false);
    }
  };

  const clearReceipt = () => {
    setScreenshot(null);
    setOcrHints([]);
    setOcrAmount(null);
    setOcrAmountCandidates([]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const applyCapturedPhoto = (dataUrl: string) => {
    // Rough size guard (~6MB raw base64 is far larger; keep payloads reasonable)
    if (dataUrl.length > 8 * 1024 * 1024) {
      setError('Photo is too large. Try again closer / with less detail.');
      return;
    }
    setError('');
    setScreenshot(dataUrl);
    setCameraOpen(false);
    void runOcr(dataUrl);
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      setError('Screenshot must be 6MB or smaller.');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => applyCapturedPhoto(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCameraError('Camera is not ready yet.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    applyCapturedPhoto(canvas.toDataURL('image/jpeg', 0.85));
  };

  const copyAccount = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy number. Long-press to copy instead.');
    }
  };

  const downloadQr = async (src: string, label: string) => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${label.replace(/\s+/g, '-').toLowerCase() || 'payment'}-qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in new tab if download fails (e.g. cross-origin)
      window.open(src, '_blank', 'noopener,noreferrer');
    }
  };

  const submit = async () => {
    if (!channel) {
      setError('Select GCash or Maya.');
      return;
    }
    if (!ref.trim() || ref.trim().length < 4) {
      setError('Enter your transaction / reference number (required).');
      return;
    }
    const due = Number(data?.amount || 0);
    if (screenshot) {
      if (ocrBusy) {
        setError('Still reading your receipt — please wait.');
        return;
      }
      if (ocrAmount == null) {
        setError('Could not read the amount from your receipt. Upload a clearer screenshot.');
        return;
      }
      if (ocrAmount + 0.05 < due) {
        setError(
          `Receipt amount ₱${ocrAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is below amount due ₱${due.toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
        );
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${getApiBase()}/public/pay/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          reference: ref.trim(),
          screenshot,
          ocrAmount: ocrAmount ?? undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Submit failed');
      setDone(j);
      setData((d: any) => (d ? { ...d, status: 'submitted', payChannel: channel, externalRef: ref.trim() } : d));
    } catch (e: any) {
      setError(e.message || 'Submit failed');
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b1220] p-6">
        <div className="bg-white rounded-3xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="text-rose-600 font-semibold mb-2">Payment link unavailable</div>
          <div className="text-sm text-slate-500">{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b1220]">
        <Loader2 className="animate-spin text-sky-400" size={28} />
      </div>
    );
  }

  const paid = data.status === 'paid';
  const submitted = data.status === 'submitted' || done?.status === 'submitted';
  const expired = data.status === 'expired';
  const rejected = data.status === 'rejected';
  const company = data.company || {};
  const accountHint = channel === 'gcash' ? company.gcashNumber : channel === 'maya' ? company.mayaNumber : null;
  const merchantQr =
    channel === 'gcash'
      ? company.gcashQr || company.paymentQr
      : channel === 'maya'
        ? company.mayaQr || company.paymentQr
        : company.gcashQr || company.mayaQr || company.paymentQr || null;
  const qrLabel = channel === 'gcash' ? 'GCash' : channel === 'maya' ? 'Maya' : 'Payment';
  const dueAmount = Number(data.amount || 0);
  const amountCoversDue = ocrAmount != null && ocrAmount + 0.05 >= dueAmount;
  const hasManualRef = ref.trim().length >= 4;
  // No receipt → submit with manual reference only.
  // With receipt → amount must be readable and ≥ amount due.
  const canSubmit =
    Boolean(channel) &&
    hasManualRef &&
    (!screenshot || (!ocrBusy && ocrAmount != null && amountCoversDue));

  return (
    <div className="h-full min-h-[100dvh] relative overflow-x-hidden overflow-y-auto">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_#1e3a5f_0%,_#0b1220_55%,_#070b14_100%)]" />
      <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23ffffff\' fill-opacity=\'0.04\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")' }} />

      <div className="relative z-10 max-w-lg mx-auto px-4 py-8 sm:py-12">
        {/* Brand header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/95 shadow-lg overflow-hidden mb-3">
            {company.logo ? (
              <img src={company.logo} alt="" className="max-h-14 max-w-14 object-contain" />
            ) : (
              <ShieldCheck className="text-sky-600" size={28} />
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">{company.name || 'ISP Billing'}</h1>
          {company.address && <p className="text-sm text-slate-400 mt-1">{company.address}</p>}
          <p className="text-[11px] uppercase tracking-[0.2em] text-sky-300/80 mt-3">Secure payment portal</p>
        </div>

        <div className="rounded-3xl bg-white shadow-2xl shadow-black/40 overflow-hidden">
          {/* Amount strip */}
          <div className="bg-gradient-to-r from-sky-600 to-indigo-600 px-6 py-5 text-white">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-sky-100 text-xs font-medium uppercase tracking-wide">Amount due</div>
                <div className="text-3xl sm:text-4xl font-bold tracking-tight mt-0.5">
                  ₱{Number(data.amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                </div>
                <div className="text-sky-100 text-xs mt-1">{data.months || 1} month{(data.months || 1) > 1 ? 's' : ''} · {data.plan || 'Plan'}</div>
              </div>
              <div className="text-right text-sm">
                <div className="text-sky-100 text-xs">Account</div>
                <div className="font-mono font-semibold">{data.account || '—'}</div>
                <div className="text-sky-100/90 text-xs mt-1 truncate max-w-[140px]">{data.customer}</div>
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6 space-y-5">
            {/* How to pay */}
            <section className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
              <div className="flex items-start gap-2 text-slate-800 font-semibold text-sm mb-2">
                <Info size={16} className="text-sky-600 mt-0.5 shrink-0" />
                How to pay
              </div>
              <ol className="text-sm text-slate-600 space-y-1.5 list-decimal pl-5">
                <li>Choose <b>GCash</b> or <b>Maya</b> below (or scan with any bank app).</li>
                <li>Tap the QR to enlarge, or download it, then scan and pay the exact amount.</li>
                <li>
                  Upload a screenshot or take a photo of your transaction — we will{' '}
                  <b>automatically read the Reference / Transaction No.</b> from it.
                </li>
                <li>Or enter the <b>Reference / Transaction No.</b> manually and submit without a photo.</li>
              </ol>
              <p className="text-xs text-slate-600 mt-3 rounded-xl bg-white border border-slate-200 px-3 py-2.5 leading-relaxed">
                <span className="font-semibold text-slate-800">QR Ph / InstaPay:</span> All payment QR codes on this page can be scanned and paid using{' '}
                <b>any participating Philippine bank</b> or e-wallet (GCash, Maya, BDO, BPI, UnionBank, and others) — not only the wallet shown on the QR.
              </p>
              {company.paymentInstructions && (
                <p className="text-xs text-slate-500 mt-3 border-t border-slate-200 pt-3 whitespace-pre-wrap">{company.paymentInstructions}</p>
              )}
            </section>

            {!paid && !expired && !submitted && (
              <>
                {/* Channel select — sliding GCash / Maya */}
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Pay with</div>
                  <div
                    className="relative grid grid-cols-2 rounded-2xl bg-slate-100 p-1"
                    role="tablist"
                    aria-label="Payment wallet"
                  >
                    <span
                      aria-hidden
                      className={`absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-xl shadow-sm transition-all duration-300 ease-out ${
                        channel === 'maya'
                          ? 'left-[calc(50%+2px)] bg-[#00D632]'
                          : channel === 'gcash'
                            ? 'left-1 bg-[#007DFE]'
                            : 'left-1 bg-transparent shadow-none'
                      }`}
                    />
                    <button
                      type="button"
                      role="tab"
                      aria-selected={channel === 'gcash'}
                      onClick={() => {
                        setChannel('gcash');
                        setCopied(false);
                      }}
                      className="relative z-10 flex items-center justify-center rounded-xl px-2 py-2.5 focus:outline-none"
                    >
                      <img
                        src="/wallets/gcash.svg"
                        alt="GCash"
                        className={`h-9 w-auto max-w-[7.5rem] rounded-lg transition ${
                          channel === 'gcash' ? 'ring-2 ring-white/80 shadow-sm' : 'opacity-80'
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={channel === 'maya'}
                      onClick={() => {
                        setChannel('maya');
                        setCopied(false);
                      }}
                      className="relative z-10 flex items-center justify-center rounded-xl px-2 py-2.5 focus:outline-none"
                    >
                      <img
                        src="/wallets/maya.svg"
                        alt="Maya"
                        className={`h-9 w-auto max-w-[7.5rem] rounded-lg transition ${
                          channel === 'maya' ? 'ring-2 ring-white/80 shadow-sm' : 'opacity-80'
                        }`}
                      />
                    </button>
                  </div>
                  {accountHint && (
                    <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <span className="text-xs text-slate-500 shrink-0">Send to</span>
                      <span className="font-mono text-sm font-semibold text-slate-800 truncate flex-1">{accountHint}</span>
                      <button
                        type="button"
                        onClick={() => void copyAccount(accountHint)}
                        className="shrink-0 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 hover:text-sky-700 transition"
                        aria-label={copied ? 'Copied' : 'Copy account number'}
                        title={copied ? 'Copied' : 'Copy'}
                      >
                        {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                      </button>
                    </div>
                  )}
                </div>

                {/* Merchant QR — zoom + download + scan line */}
                {merchantQr && (
                  <div className="flex flex-col items-center gap-2 py-1">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {qrLabel}
                    </div>
                    <button
                      type="button"
                      onClick={() => setQrZoomOpen(true)}
                      className="pay-qr-frame group relative w-56 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                      aria-label="Enlarge QR code"
                    >
                      <img
                        src={merchantQr}
                        alt="Payment QR"
                        className="w-full h-auto max-h-72 object-contain select-none"
                        draggable={false}
                      />
                      <span className="pay-qr-scanline" aria-hidden />
                      <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-lg bg-black/55 px-2 py-1 text-[10px] font-medium text-white opacity-90 group-hover:opacity-100">
                        <ZoomIn size={12} /> Tap to zoom
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void downloadQr(merchantQr, qrLabel)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 hover:border-slate-300 transition"
                    >
                      <Download size={16} className="text-sky-600" />
                      Download
                    </button>
                    <div className="text-xs text-slate-500 text-center px-2 max-w-xs leading-relaxed">
                      {channel
                        ? `Open ${channel === 'maya' ? 'Maya' : 'GCash'} — or any Philippine bank app — → Scan QR → pay the exact amount`
                        : 'Select GCash or Maya above, then scan the matching QR'}
                      <span className="block mt-1 text-slate-400">
                        Works with InstaPay / QR Ph — any participating PH bank or e-wallet.
                      </span>
                    </div>
                  </div>
                )}
                {!merchantQr && channel && (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                    No {channel === 'maya' ? 'Maya' : 'GCash'} QR uploaded yet. Your ISP should add it under Company settings.
                    {accountHint ? <> Meanwhile send to <span className="font-mono font-semibold">{accountHint}</span>.</> : null}
                  </div>
                )}

                {/* Reference */}
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Transaction / Reference No. <span className="text-rose-500">*</span>
                  </span>
                  <input
                    className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-400"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    placeholder="Required — from your GCash / Maya receipt"
                    required
                  />
                </label>

                {ocrHints.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-[11px] text-slate-400 self-center mr-1">Detected ref:</span>
                    {ocrHints.map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setRef(h)}
                        className="text-xs font-mono px-2 py-1 rounded-lg bg-sky-50 text-sky-700 border border-sky-100 hover:bg-sky-100"
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                )}

                {screenshot && !ocrBusy && (
                  <div
                    className={`rounded-xl border px-3 py-2.5 text-sm ${
                      amountCoversDue
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : ocrAmount == null
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-rose-50 border-rose-200 text-rose-900'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {amountCoversDue ? (
                        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                      ) : (
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      )}
                      <div className="min-w-0">
                        {ocrAmount == null ? (
                          <>
                            <div className="font-medium">Could not read amount from receipt</div>
                            <div className="text-xs mt-0.5 opacity-90">
                              Upload a clearer full-screen screenshot showing Amount and Ref No.
                            </div>
                          </>
                        ) : amountCoversDue ? (
                          <>
                            <div className="font-medium">
                              Receipt amount ₱{ocrAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} — OK to submit
                            </div>
                            <div className="text-xs mt-0.5 opacity-90">
                              Equal to or higher than amount due (₱{dueAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })})
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="font-medium">
                              Receipt amount ₱{ocrAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is below amount due
                            </div>
                            <div className="text-xs mt-0.5 opacity-90">
                              Need at least ₱{dueAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} to submit
                            </div>
                          </>
                        )}
                        {ocrAmountCandidates.length > 1 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            <span className="text-[11px] opacity-70 self-center">Other amounts:</span>
                            {ocrAmountCandidates.map((a) => (
                              <button
                                key={a}
                                type="button"
                                onClick={() => setOcrAmount(a)}
                                className={`text-xs font-mono px-2 py-0.5 rounded-lg border ${
                                  ocrAmount === a ? 'bg-white border-current font-semibold' : 'bg-white/60 border-black/10'
                                }`}
                              >
                                ₱{a.toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {screenshot && ocrBusy && (
                  <div className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2.5 text-sm text-sky-800 flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin shrink-0" />
                    Reading reference number and amount from receipt…
                  </div>
                )}

                {/* Receipt — camera or file upload */}
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                    Receipt photo <span className="normal-case font-normal text-slate-400">(optional)</span>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onFilePick}
                  />
                  {screenshot ? (
                    <div className="relative rounded-2xl overflow-hidden border border-slate-200">
                      <img src={screenshot} alt="Receipt" className="w-full max-h-56 object-contain bg-slate-50" />
                      <div className="absolute top-2 right-2 flex gap-1">
                        {ocrBusy && (
                          <span className="bg-black/60 text-white text-[11px] px-2 py-1 rounded-lg flex items-center gap-1">
                            <Loader2 size={12} className="animate-spin" /> Reading…
                          </span>
                        )}
                        <button
                          type="button"
                          className="bg-white/95 text-xs px-2 py-1 rounded-lg border border-slate-200"
                          onClick={() => {
                            setCameraOpen(true);
                            setCameraError('');
                          }}
                        >
                          Retake
                        </button>
                        <button
                          type="button"
                          className="bg-white/95 text-xs px-2 py-1 rounded-lg border border-slate-200"
                          onClick={() => fileRef.current?.click()}
                        >
                          Upload
                        </button>
                        <button
                          type="button"
                          className="bg-white/95 text-xs px-2 py-1 rounded-lg border border-slate-200"
                          onClick={clearReceipt}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCameraOpen(true);
                          setCameraError('');
                        }}
                        className="rounded-2xl border-2 border-dashed border-slate-200 hover:border-sky-300 hover:bg-sky-50/50 px-3 py-5 flex flex-col items-center gap-1.5 text-slate-500 transition"
                      >
                        <Camera size={22} className="text-sky-600" />
                        <span className="text-sm font-medium text-slate-700">Take photo</span>
                        <span className="text-[11px] text-slate-400 text-center leading-snug">Use camera</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="rounded-2xl border-2 border-dashed border-slate-200 hover:border-sky-300 hover:bg-sky-50/50 px-3 py-5 flex flex-col items-center gap-1.5 text-slate-500 transition"
                      >
                        <Upload size={22} className="text-sky-600" />
                        <span className="text-sm font-medium text-slate-700">Upload</span>
                        <span className="text-[11px] text-slate-400 text-center leading-snug">From files / gallery</span>
                      </button>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2.5">{error}</div>
                )}

                <button
                  type="button"
                  disabled={busy || (Boolean(screenshot) && ocrBusy) || !canSubmit}
                  onClick={submit}
                  className="w-full rounded-2xl bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-semibold py-3.5 shadow-lg shadow-sky-600/25 disabled:opacity-60 transition"
                >
                  {busy
                    ? 'Submitting…'
                    : screenshot && ocrBusy
                      ? 'Reading receipt…'
                      : !channel
                        ? 'Select GCash or Maya'
                        : !hasManualRef
                          ? 'Enter reference / transaction no.'
                          : screenshot && !amountCoversDue
                            ? 'Receipt amount must cover amount due'
                            : 'Submit payment for review'}
                </button>
                {!screenshot && (
                  <p className="text-[11px] text-center text-slate-400 -mt-2">
                    You can submit with just the reference number — receipt photo is optional
                  </p>
                )}
                <p className="text-[11px] text-center text-slate-400 flex items-center justify-center gap-1">
                  <Clock3 size={12} /> Internet restores after your ISP verifies this payment
                </p>
              </>
            )}

            {submitted && !paid && (
              <div className="rounded-2xl bg-sky-50 border border-sky-100 px-4 py-5 text-center">
                <Clock3 className="mx-auto text-sky-600 mb-2" size={28} />
                <div className="font-bold text-sky-900">Proof submitted — under review</div>
                <div className="text-sm text-sky-800 mt-1">
                  Channel: <b className="uppercase">{data.payChannel || channel}</b>
                  {data.externalRef || ref ? (
                    <> · Ref: <span className="font-mono">{data.externalRef || ref}</span></>
                  ) : null}
                </div>
                <p className="text-xs text-sky-700 mt-2">Hang tight — service will restore once verified.</p>
              </div>
            )}

            {paid && (
              <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-5 text-center">
                <CheckCircle2 className="mx-auto text-emerald-600 mb-2" size={32} />
                <div className="font-bold text-emerald-800">Payment confirmed</div>
                <div className="text-sm text-emerald-700 mt-1">Your service is being restored.</div>
              </div>
            )}

            {rejected && !paid && (
              <div className="rounded-2xl bg-rose-50 border border-rose-100 px-4 py-4 text-center text-sm text-rose-800">
                Payment proof was not accepted. Contact your ISP or submit again with a clearer reference/screenshot.
                <button
                  type="button"
                  className="mt-3 w-full rounded-xl border border-rose-200 bg-white py-2.5 text-rose-700 font-medium"
                  onClick={() => setData((d: any) => (d ? { ...d, status: 'pending' } : d))}
                >
                  Try again
                </button>
              </div>
            )}

            {expired && !paid && (
              <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-3 text-center">
                This payment link has expired. Contact your ISP for a new link.
              </div>
            )}
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-500 mt-6 flex items-center justify-center gap-1">
          <ImageIcon size={12} /> Powered by {PRODUCT_TITLE}
        </p>
      </div>

      {/* QR zoom overlay */}
      {qrZoomOpen && merchantQr && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged payment QR"
          onClick={() => setQrZoomOpen(false)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
            onClick={() => setQrZoomOpen(false)}
            aria-label="Close"
          >
            <X size={22} />
          </button>
          <div
            className="pay-qr-frame relative w-full max-w-sm rounded-3xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={merchantQr}
              alt={`${qrLabel} enlarged`}
              className="w-full h-auto object-contain select-none"
              draggable={false}
            />
            <span className="pay-qr-scanline pay-qr-scanline--lg" aria-hidden />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void downloadQr(merchantQr, qrLabel);
            }}
            className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-lg hover:bg-slate-50"
          >
            <Download size={18} className="text-sky-600" />
            Download
          </button>
          <p className="mt-3 text-xs text-white/70">Tap outside to close</p>
        </div>
      )}

      {/* Camera capture modal — no file / gallery picker */}
      {cameraOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black"
          role="dialog"
          aria-modal="true"
          aria-label="Take receipt photo"
        >
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <button
              type="button"
              className="rounded-full bg-white/10 p-2 hover:bg-white/20"
              onClick={() => setCameraOpen(false)}
              aria-label="Close camera"
            >
              <X size={22} />
            </button>
            <span className="text-sm font-medium">Receipt photo</span>
            <button
              type="button"
              className="rounded-full bg-white/10 p-2 hover:bg-white/20"
              onClick={() => setFacingMode((f) => (f === 'environment' ? 'user' : 'environment'))}
              aria-label="Switch camera"
            >
              <SwitchCamera size={22} />
            </button>
          </div>

          <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
            {cameraError ? (
              <div className="px-6 text-center text-sm text-rose-200 max-w-sm">{cameraError}</div>
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            {!cameraError && (
              <div className="pointer-events-none absolute inset-8 rounded-2xl border border-white/35 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            )}
          </div>

          <div className="px-6 py-5 pb-8 flex flex-col items-center gap-3 bg-black">
            {cameraError ? (
              <button
                type="button"
                onClick={() => void startCamera(facingMode)}
                className="rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white"
              >
                Retry camera
              </button>
            ) : (
              <button
                type="button"
                onClick={capturePhoto}
                className="h-16 w-16 rounded-full border-4 border-white bg-white/90 shadow-lg active:scale-95 transition"
                aria-label="Capture photo"
              />
            )}
            <p className="text-[11px] text-white/55 text-center">Align the receipt, then tap the shutter</p>
          </div>
        </div>
      )}
    </div>
  );
}
