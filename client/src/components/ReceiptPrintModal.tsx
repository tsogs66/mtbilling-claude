import { useCallback, useMemo, useRef, useState } from 'react';
import { Copy, Loader2, Printer, Share2 } from 'lucide-react';
import { Modal } from './ui';
import { copyTextOrPrompt } from '../lib/clipboard';
import { buildReceiptHtml, buildReceiptText, type PaymentReceipt } from '../lib/receiptPrint';
import { isNativeApp } from '../config';

type Props = {
  receipt: PaymentReceipt;
  onClose: () => void;
};

export default function ReceiptPrintModal({ receipt, onClose }: Props) {
  const native = isNativeApp();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [busy, setBusy] = useState<'share' | 'copy' | 'print' | null>(null);
  const [hint, setHint] = useState('');

  const html = useMemo(() => buildReceiptHtml(receipt, { autoPrint: false }), [receipt]);
  const text = useMemo(() => buildReceiptText(receipt), [receipt]);

  const share = useCallback(async () => {
    setBusy('share');
    setHint('');
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${receipt.company || 'Receipt'} — ${receipt.account || ''}`,
          text,
        });
        setHint('Shared. Pick your printer app if prompted.');
      } else {
        const ok = await copyTextOrPrompt(text);
        setHint(ok ? 'Receipt copied — paste into your printer app.' : 'Could not copy receipt.');
      }
    } catch (e: unknown) {
      const err = e as { name?: string };
      if (err?.name !== 'AbortError') {
        setHint('Share cancelled or unavailable. Try Copy text instead.');
      }
    } finally {
      setBusy(null);
    }
  }, [receipt.account, receipt.company, text]);

  const copy = useCallback(async () => {
    setBusy('copy');
    setHint('');
    try {
      const ok = await copyTextOrPrompt(text);
      setHint(ok ? 'Receipt copied to clipboard.' : 'Could not copy — select text in the preview.');
    } finally {
      setBusy(null);
    }
  }, [text]);

  const print = useCallback(() => {
    setBusy('print');
    setHint('');
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (!win) {
      setBusy(null);
      setHint('Preview not ready. Use Share instead.');
      return;
    }

    let done = false;
    const finish = (msg?: string) => {
      if (done) return;
      done = true;
      setBusy(null);
      if (msg) setHint(msg);
    };

    const onAfterPrint = () => finish(native ? 'Print finished.' : undefined);
    win.addEventListener('afterprint', onAfterPrint, { once: true });

    try {
      const mql = win.matchMedia('print');
      const onChange = () => {
        if (!mql.matches) {
          mql.removeEventListener('change', onChange);
          finish();
        }
      };
      mql.addEventListener('change', onChange);
    } catch {
      /* ignore */
    }

    window.setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        finish('Print unavailable on this device. Use Share and pick a printer app.');
        return;
      }
      window.setTimeout(() => finish(), native ? 45000 : 120000);
    }, 200);
  }, [native]);

  return (
    <Modal
      title="Payment receipt"
      subtitle={
        native
          ? 'Tap Share and choose your printer app (RawBT, Bluetooth Print, etc.). Avoid system Print on Android — it can freeze the app.'
          : 'Preview receipt · print or share'
      }
      onClose={onClose}
      wide
      maxWidth="lg"
      footer={
        <div className="flex flex-col sm:flex-row flex-wrap gap-2 w-full sm:justify-end">
          <button type="button" className="btn-secondary w-full sm:w-auto" onClick={onClose} disabled={!!busy}>
            Close
          </button>
          <button type="button" className="btn-secondary w-full sm:w-auto inline-flex items-center justify-center gap-2" onClick={copy} disabled={!!busy}>
            {busy === 'copy' ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}
            Copy text
          </button>
          <button type="button" className="btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2" onClick={share} disabled={!!busy}>
            {busy === 'share' ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
            Share to printer
          </button>
          {!native && (
            <button type="button" className="btn-secondary w-full sm:w-auto inline-flex items-center justify-center gap-2" onClick={print} disabled={!!busy}>
              {busy === 'print' ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
              Print
            </button>
          )}
        </div>
      }
    >
      {hint && (
        <div className="text-sm text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 mb-3">{hint}</div>
      )}
      <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-100 max-h-[min(52dvh,420px)] overflow-y-auto">
        <iframe
          ref={iframeRef}
          title="Receipt preview"
          srcDoc={html}
          className="w-full min-h-[320px] bg-white border-0"
          sandbox="allow-same-origin"
        />
      </div>
      <p className="text-xs text-slate-400 mt-3 leading-relaxed">
        PC: 58mm paper, scale 100%, margins none. Content is inset for POS-5890U-L.
      </p>
    </Modal>
  );
}
