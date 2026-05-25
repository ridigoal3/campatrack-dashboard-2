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

/**
 * Tabla virtual: solo monta filas visibles en tbody cuando hay muchas filas.
 * @param {{ scrollEl: Element|null, tbody: HTMLElement, rowHeight?: number, overscan?: number, threshold?: number }} opts
 */
export function createDashVirtualTbody(opts) {
  const scrollEl = opts.scrollEl || null;
  const tbody = opts.tbody;
  const rowHeight = opts.rowHeight ?? 36;
  const overscan = opts.overscan ?? 8;
  const threshold = opts.threshold ?? 64;
  let rows = [];
  let onScroll = null;
  let enabled = false;

  function unbind() {
    if (onScroll && scrollEl) scrollEl.removeEventListener("scroll", onScroll);
    onScroll = null;
    enabled = false;
  }

  function paint() {
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = "";
      unbind();
      return;
    }
    if (rows.length <= threshold) {
      unbind();
      tbody.innerHTML = rows.join("");
      return;
    }
    if (!scrollEl) {
      tbody.innerHTML = rows.join("");
      return;
    }
    enabled = true;
    const viewH = scrollEl.clientHeight || 400;
    const scrollTop = scrollEl.scrollTop || 0;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);
    const topH = start * rowHeight;
    const bottomH = Math.max(0, (rows.length - end) * rowHeight);
    const pad = (h) =>
      h > 0
        ? `<tr class="dash-virt-spacer" aria-hidden="true"><td colspan="60" style="height:${h}px;padding:0;border:none;line-height:0"></td></tr>`
        : "";
    tbody.innerHTML = pad(topH) + rows.slice(start, end).join("") + pad(bottomH);
  }

  function mount(rowHtmlList) {
    rows = Array.isArray(rowHtmlList) ? rowHtmlList : [];
    if (!onScroll && scrollEl) {
      onScroll = () => {
        if (!enabled) return;
        coalesceDashAnimationFrame(`virt-${tbody.id || "dash"}`, paint);
      };
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
    }
    paint();
  }

  function refreshLayout() {
    if (rows.length > threshold) paint();
  }

  return { mount, refreshLayout, unbind, getRowCount: () => rows.length };
}
