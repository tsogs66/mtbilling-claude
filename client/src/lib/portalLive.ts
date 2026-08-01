import { getApiBase } from '../config';

type LiveHandler = (event: string, data: any) => void;

/**
 * Subscribe to portal SSE. Uses fetch (supports Authorization / X-Portal-Token).
 * Reconnects automatically while the page is open.
 */
export function subscribePortalLive(opts: {
  path: string;
  headers?: Record<string, string>;
  onEvent: LiveHandler;
  onStatus?: (status: 'connecting' | 'live' | 'retry') => void;
}): () => void {
  const ctrl = new AbortController();
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      opts.onStatus?.('connecting');
      try {
        const res = await fetch(`${getApiBase()}${opts.path}`, {
          headers: {
            Accept: 'text/event-stream',
            ...(opts.headers || {}),
          },
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok || !res.body) {
          opts.onStatus?.('retry');
          await sleep(2000);
          continue;
        }
        opts.onStatus?.('live');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const chunk of parts) {
            const lines = chunk.split('\n');
            let event = 'message';
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try {
              const data = JSON.parse(dataLines.join('\n'));
              opts.onEvent(event, data);
            } catch {
              /* ignore malformed */
            }
          }
        }
      } catch (e: any) {
        if (stopped || e?.name === 'AbortError') break;
        opts.onStatus?.('retry');
      }
      if (!stopped) await sleep(2000);
    }
  };

  void loop();
  return () => {
    stopped = true;
    ctrl.abort();
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
