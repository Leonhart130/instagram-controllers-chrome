/** Persisted player preferences, cached in memory so reads are synchronous. */

export interface Prefs {
  volume: number;
  muted: boolean;
  speed: number;
}

/** Offered in the menu, and the range a stored value is allowed to take. */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const KEY = "igvc:prefs";
const DEFAULTS: Prefs = { volume: 1, muted: true, speed: 1 };

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
  // Clamped rather than snapped to the menu: a value typed into storage by hand
  // should still work, but a nonsense one must not make every video unplayable.
  const speed =
    typeof p.speed === "number" && p.speed >= 0.0625 && p.speed <= 16 ? p.speed : DEFAULTS.speed;
  return { volume, speed, muted: typeof p.muted === "boolean" ? p.muted : DEFAULTS.muted };
}

export const prefs = {
  get current(): Prefs {
    return cache;
  },

  async load(): Promise<void> {
    if (!storageAvailable()) return;
    // Registered before the read, so a failing first get() cannot leave
    // cross-tab sync silently unwired.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[KEY]) cache = sanitize(changes[KEY].newValue);
      });
    } catch {
      /* extension context unavailable */
    }
    try {
      const stored = await chrome.storage.sync.get(KEY);
      if (stored?.[KEY]) cache = sanitize(stored[KEY]);
    } catch {
      /* first run, or storage unavailable — defaults are fine */
    }
  },

  update(patch: Partial<Prefs>): void {
    const next = sanitize({ ...cache, ...patch });
    if (next.volume === cache.volume && next.muted === cache.muted && next.speed === cache.speed) return;
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
