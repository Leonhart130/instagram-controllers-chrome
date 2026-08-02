/** Persisted player preferences, cached in memory so reads are synchronous. */

export interface Prefs {
  volume: number;
  muted: boolean;
}

const KEY = "igvc:prefs";
const DEFAULTS: Prefs = { volume: 1, muted: true };

let cache: Prefs = { ...DEFAULTS };
let saveTimer: number | undefined;

/** False in the dev harness, and if the extension context is ever invalidated
 *  (which happens on every reload of an unpacked extension). */
function storageAvailable(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.sync;
}

function sanitize(raw: unknown): Prefs {
  const p = (raw ?? {}) as Partial<Prefs>;
  const volume = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : DEFAULTS.volume;
  return { volume, muted: typeof p.muted === "boolean" ? p.muted : DEFAULTS.muted };
}

export const prefs = {
  get current(): Prefs {
    return cache;
  },

  async load(): Promise<void> {
    if (!storageAvailable()) return;
    try {
      const stored = await chrome.storage.sync.get(KEY);
      if (stored?.[KEY]) cache = sanitize(stored[KEY]);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[KEY]) cache = sanitize(changes[KEY].newValue);
      });
    } catch {
      /* first run, or storage unavailable — defaults are fine */
    }
  },

  update(patch: Partial<Prefs>): void {
    const next = sanitize({ ...cache, ...patch });
    if (next.volume === cache.volume && next.muted === cache.muted) return;
    cache = next;
    if (!storageAvailable()) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        chrome.storage.sync.set({ [KEY]: cache }).catch(() => {});
      } catch {
        /* extension context invalidated after a reload */
      }
    }, 300);
  },
};
