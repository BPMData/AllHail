import type { PromptMode } from '../shared/prompts.ts';

export type HistoryEntry = {
  id: string;
  createdAt: number;
  mode: PromptMode;
  model: string;
  text: string;
  originalText?: string;
  stashedEditedText?: string;
  sourceName?: string;
  thumbnailDataUrl?: string;
};

const DB_NAME = 'allhail-history';
const DB_VERSION = 1;
const STORE_NAME = 'descriptions';
const MAX_STORED_ITEMS = 50;

function openHistoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open history database'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  try {
    const db = await openHistoryDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);

      // Trim oldest records beyond MAX_STORED_ITEMS.
      const index = store.index('createdAt');
      const keysReq = index.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = keysReq.result;
        if (keys.length > MAX_STORED_ITEMS) {
          const excess = keys.slice(0, keys.length - MAX_STORED_ITEMS);
          for (const key of excess) {
            store.delete(key);
          }
        }
      };

      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Graceful degradation if storage is blocked.
  }
}

export async function listHistoryEntries(limit = MAX_STORED_ITEMS): Promise<HistoryEntry[]> {
  try {
    const db = await openHistoryDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      const rows = await new Promise<HistoryEntry[]>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as HistoryEntry[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('Failed to read history'));
      });
      await txDone(tx);
      return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  try {
    const db = await openHistoryDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Ignore storage failures gracefully.
  }
}

export async function clearHistory(): Promise<void> {
  try {
    const db = await openHistoryDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Ignore storage failures gracefully.
  }
}

export function applyDescriptionEdit<T extends { text: string; originalText?: string; stashedEditedText?: string }>(
  entry: T,
  nextText: string
): T {
  const trimmed = nextText.trim();
  if (!trimmed) return entry;
  const baseOriginal = entry.originalText ?? entry.text;
  if (trimmed === baseOriginal.trim()) {
    const rest = { ...entry };
    delete rest.originalText;
    delete rest.stashedEditedText;
    return { ...rest, text: baseOriginal };
  }
  const next = {
    ...entry,
    text: trimmed,
    originalText: baseOriginal,
  };
  delete next.stashedEditedText;
  return next;
}

export function resetDescriptionToOriginal<
  T extends { text: string; originalText?: string; stashedEditedText?: string },
>(entry: T): T {
  if (!entry.originalText) return entry;
  const rest = { ...entry };
  delete rest.originalText;
  return {
    ...rest,
    text: entry.originalText,
    stashedEditedText: entry.text,
  };
}

export function restoreStashedEdit<T extends { text: string; originalText?: string; stashedEditedText?: string }>(
  entry: T
): T {
  if (!entry.stashedEditedText) return entry;
  const rest = { ...entry };
  delete rest.stashedEditedText;
  return {
    ...rest,
    text: entry.stashedEditedText,
    originalText: entry.text,
  };
}
