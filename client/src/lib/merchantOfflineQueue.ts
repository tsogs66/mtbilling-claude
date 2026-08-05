/**
 * Offline queue for merchant collect / deposit POSTs.
 * Prefers IndexedDB; falls back to localStorage when IDB is unavailable.
 */

export type MerchantOfflineItem = {
  id: string;
  type: 'collect' | 'deposit';
  payload: Record<string, unknown>;
  createdAt: string;
};

const DB_NAME = 'mt-merchant-offline';
const STORE = 'queue';
const LS_KEY = 'mt_merchant_offline_queue';

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function idbAvailable() {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function lsRead(): MerchantOfflineItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function lsWrite(items: MerchantOfflineItem[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

async function idbEnqueue(item: MerchantOfflineItem) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('enqueue failed'));
    };
  });
}

async function idbList(): Promise<MerchantOfflineItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      db.close();
      const rows = (req.result || []) as MerchantOfflineItem[];
      rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      resolve(rows);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error('list failed'));
    };
  });
}

async function idbRemove(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('remove failed'));
    };
  });
}

export async function enqueue(opts: {
  type: 'collect' | 'deposit';
  payload: Record<string, unknown>;
  createdAt?: string;
}): Promise<MerchantOfflineItem> {
  const item: MerchantOfflineItem = {
    id: uid(),
    type: opts.type,
    payload: opts.payload,
    createdAt: opts.createdAt || new Date().toISOString(),
  };
  if (idbAvailable()) {
    try {
      await idbEnqueue(item);
      return item;
    } catch {
      /* fall through to localStorage */
    }
  }
  const all = lsRead();
  all.push(item);
  lsWrite(all);
  return item;
}

export async function listPending(): Promise<MerchantOfflineItem[]> {
  if (idbAvailable()) {
    try {
      return await idbList();
    } catch {
      /* fall through */
    }
  }
  return lsRead().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function remove(id: string): Promise<void> {
  if (idbAvailable()) {
    try {
      await idbRemove(id);
      return;
    } catch {
      /* fall through */
    }
  }
  lsWrite(lsRead().filter((x) => x.id !== id));
}

type ApiLike = {
  post: (url: string, body?: unknown) => Promise<unknown>;
};

/** POST pending items to /merchant/collect or /merchant/deposits. Returns synced count. */
export async function flush(api: ApiLike): Promise<{ synced: number; failed: number; remaining: number }> {
  const pending = await listPending();
  let synced = 0;
  let failed = 0;
  for (const item of pending) {
    const url = item.type === 'collect' ? '/merchant/collect' : '/merchant/deposits';
    try {
      await api.post(url, item.payload);
      await remove(item.id);
      synced += 1;
    } catch {
      failed += 1;
      // Stop on first failure to preserve order / avoid partial double-posts mid-outage
      break;
    }
  }
  const remaining = (await listPending()).length;
  return { synced, failed, remaining };
}

/** True when the error looks like a network / offline failure (not a 4xx business error). */
export function isNetworkFailure(err: any): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err?.response) return true;
  return false;
}
