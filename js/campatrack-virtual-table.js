/**
 * Virtualización de tbody para tablas grandes (vanilla JS).
 * Equivalente liviano a react-window FixedSizeList: solo filas visibles en DOM.
 */

function coalesceVirtualPaint(key, fn) {
  const k = String(key || "vt");
  if (!coalesceVirtualPaint._pending) coalesceVirtualPaint._pending = new Map();
  const pending = coalesceVirtualPaint._pending;
  if (pending.has(k)) return;
  const id = requestAnimationFrame(() => {
    pending.delete(k);
    try {
      fn();
    } catch (e) {
      console.warn("[CampaTrack virtual-table]", e);
    }
  });
  pending.set(k, id);
}

/**
 * @param {{
 *   scrollEl: Element|null,
 *   tbody: HTMLElement,
 *   rowHeight?: number,
 *   overscan?: number,
 *   threshold?: number,
 *   colspan?: number,
 *   uid?: string,
 * }} opts
 */
export function createVirtualTbody(opts) {
  const scrollEl = opts.scrollEl || null;
  const tbody = opts.tbody;
  const rowHeight = opts.rowHeight ?? 36;
  const overscan = opts.overscan ?? 10;
  const threshold = opts.threshold ?? 50;
  const colspan = opts.colspan ?? 60;
  const uid = opts.uid || tbody?.id || "virtual-tbody";

  /** @type {string[]} */
  let rowHtml = [];
  let onScroll = null;
  let enabled = false;
  let lastFingerprint = null;

  function unbind() {
    if (onScroll && scrollEl) scrollEl.removeEventListener("scroll", onScroll);
    onScroll = null;
    enabled = false;
  }

  function spacerRow(heightPx) {
    if (!(heightPx > 0)) return "";
    return `<tr class="campatrack-virt-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${heightPx}px;padding:0;border:none;line-height:0;pointer-events:none"></td></tr>`;
  }

  function paint() {
    if (!tbody) return;
    if (!rowHtml.length) {
      tbody.innerHTML = "";
      unbind();
      return;
    }
    if (rowHtml.length <= threshold) {
      unbind();
      tbody.innerHTML = rowHtml.join("");
      return;
    }
    if (!scrollEl) {
      tbody.innerHTML = rowHtml.join("");
      return;
    }
    enabled = true;
    const viewH = scrollEl.clientHeight || 400;
    const scrollTop = scrollEl.scrollTop || 0;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(rowHtml.length, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);
    const topH = start * rowHeight;
    const bottomH = Math.max(0, (rowHtml.length - end) * rowHeight);
    tbody.innerHTML = spacerRow(topH) + rowHtml.slice(start, end).join("") + spacerRow(bottomH);
  }

  /**
   * @param {string[]|HTMLElement[]} rows filas HTML o nodos TR
   * @param {string|null} [fingerprint] si coincide con el anterior, solo refresca layout
   */
  function mount(rows, fingerprint) {
    if (fingerprint != null && fingerprint === lastFingerprint) {
      refreshLayout();
      return;
    }
    lastFingerprint = fingerprint ?? null;
    if (!rows?.length) {
      rowHtml = [];
      paint();
      return;
    }
    if (rows[0] instanceof HTMLElement) {
      rowHtml = rows.map((tr) => tr.outerHTML);
    } else {
      rowHtml = rows.slice();
    }
    if (!onScroll && scrollEl) {
      onScroll = () => {
        if (!enabled) return;
        coalesceVirtualPaint(uid, paint);
      };
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
    }
    paint();
  }

  function refreshLayout() {
    if (rowHtml.length > threshold) paint();
  }

  /** Actualiza clase de selección en filas visibles sin remontar todo. */
  function reapplyRowClass(attrName, activeValue, className) {
    if (!tbody || activeValue == null || activeValue === "") return;
    const sel = String(activeValue);
    tbody.querySelectorAll(`tr[${attrName}]`).forEach((tr) => {
      tr.classList.toggle(className, tr.getAttribute(attrName) === sel);
    });
  }

  function scrollToIndex(index) {
    if (!scrollEl || index < 0) return;
    const maxTop = Math.max(0, rowHtml.length * rowHeight - scrollEl.clientHeight);
    scrollEl.scrollTop = Math.min(maxTop, index * rowHeight);
    paint();
  }

  function getRowCount() {
    return rowHtml.length;
  }

  function isVirtualized() {
    return rowHtml.length > threshold && !!scrollEl;
  }

  return {
    mount,
    refreshLayout,
    unbind,
    getRowCount,
    isVirtualized,
    reapplyRowClass,
    scrollToIndex
  };
}

/** @deprecated alias */
export function createDashVirtualTbody(opts) {
  return createVirtualTbody(opts);
}
