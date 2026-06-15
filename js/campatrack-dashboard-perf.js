/**
 * Utilidades de rendimiento para dashboards CampaTrack (vanilla JS).
 * Equivalente práctico a useMemo / debounce / virtualización sin React.
 */

export function createDashSignature(parts) {
  return parts.map((p) => (p == null ? "" : String(p))).join("\x1f");
}

export function createDashMemoStore() {
  const store = new Map();
  return {
    get(key) {
      return store.get(key);
    },
    set(key, val) {
      store.set(key, val);
    },
    clear() {
      store.clear();
    },
    delete(key) {
      store.delete(key);
    }
  };
}

export function coalesceDashAnimationFrame(key, fn) {
  const k = String(key || "default");
  if (!coalesceDashAnimationFrame._pending) coalesceDashAnimationFrame._pending = new Map();
  const pending = coalesceDashAnimationFrame._pending;
  if (pending.has(k)) return;
  const id = requestAnimationFrame(() => {
    pending.delete(k);
    try {
      fn();
    } catch (e) {
      console.warn("[CampaTrack dash-perf]", e);
    }
  });
  pending.set(k, id);
}

export function createDashDebounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** Evita repintar SVG/canvas si la huella de datos no cambió. */
export function createDashRenderGate() {
  let lastFp = null;
  return {
    shouldSkip(fp) {
      return fp != null && fp === lastFp;
    },
    remember(fp) {
      lastFp = fp;
    },
    reset() {
      lastFp = null;
    }
  };
}

export { createDashVirtualTbody, createVirtualTbody } from "./campatrack-virtual-table.js";
