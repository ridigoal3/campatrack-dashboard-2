/**
 * AUDITORÍA TEMPORAL DE RENDIMIENTO — CampaTrack (vanilla JS).
 * Activar: ?perf_audit=1  o  localStorage.setItem('campatrack_perf_audit','1'); location.reload();
 * Escenario producción (datos GitHub cargados): ?perf_audit=1&perf_run=1
 * Manual: await __campatrackPerfAudit.runProductionAudit()
 * Reporte: __campatrackPerfAudit.printReport() | .exportJson() | .exportProductionMarkdown()
 * Desactivar: localStorage.removeItem('campatrack_perf_audit'); location.reload();
 * ELIMINAR este archivo y los hooks marcados PERF_AUDIT al concluir la auditoría.
 */

let _enabled = false;

const _measures = new Map();
const _renders = new Map();
const _arrayOps = new Map();
const _interactions = [];
const _memorySnaps = [];
const _moduleLoads = new Map();
const _stateChanges = [];
const _callTree = new Map();
let _callStack = [];
let _currentInteraction = null;
let _interactionSeq = 0;
let _contextProvider = null;
let _productionRunner = null;
let _sessionContextStart = null;
let _sessionContextEnd = null;
let _autoRunScheduled = false;
let _walkthroughRunner = null;
let _definitiveMode = false;
let _definitivePhase = "idle";
let _definitiveStartedAt = null;
let _definitiveInteractivePromise = null;
let _definitiveFinishResolve = null;
let _memoryIntervalId = null;
let _longTasks = [];
let _longTaskObserver = null;

/** Funciones CRM críticas — informe dedicado */
const CRM_CRITICAL_MEASURES = [
  "render:DashboardCrmTabla",
  "data:aggregateDashboardCrmMetricsByRowKey",
  "render:DashboardCrmPivotFuente",
  "render:DashboardKpisCrm",
  "render:DashboardCrmBottomPanels",
  "data:getDashboardFilteredData"
];

/** Funciones obligatorias del informe definitivo */
const MANDATORY_MEASURES = [
  "render:DashboardCrmTabla",
  "data:aggregateDashboardCrmMetricsByRowKey",
  "render:DashboardCrmPivotFuente",
  "render:DashboardCrmBottomPanels",
  "render:DashboardKpisCrm",
  "data:getDashboardFilteredData",
  "render:DashboardTablaPlataforma",
  "render:DashboardChartPlataforma",
  "render:DashboardCrmCompareChart"
];

const HYDRATION_REQUIRED = [
  ["modeloAnalitico", "Modelo analítico (modeloAnalitico)"],
  ["crmLeads", "CRM Leads (crmLeads)"],
  ["planningRows", "Planning (planningRows)"],
  ["relacionesMeta", "Relaciones META (relacionesMeta)"],
  ["relacionesCrm", "Relaciones CRM (relacionesCrm)"]
];

function _now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function _memMb() {
  try {
    const m = performance.memory;
    if (m && m.usedJSHeapSize) return Math.round((m.usedJSHeapSize / 1048576) * 10) / 10;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function _ensureMeasure(name) {
  if (!_measures.has(name)) {
    _measures.set(name, {
      name,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      minMs: Infinity,
      category: "",
      recordsProcessed: [],
      metaSamples: []
    });
  }
  return _measures.get(name);
}

function _recordMeasure(name, category, ms, meta = {}) {
  const e = _ensureMeasure(name);
  e.category = category || e.category;
  e.count += 1;
  e.totalMs += ms;
  e.maxMs = Math.max(e.maxMs, ms);
  e.minMs = Math.min(e.minMs, ms);
  if (meta.records != null) e.recordsProcessed.push(Number(meta.records) || 0);
  if (meta.rows != null && meta.records == null) e.recordsProcessed.push(Number(meta.rows) || 0);
  if (e.metaSamples.length < 5) e.metaSamples.push(meta);

  if (category === "render") {
    const r = _renders.get(name) || { name, count: 0, totalMs: 0 };
    r.count += 1;
    r.totalMs += ms;
    _renders.set(name, r);
  }

  if (_callStack.length) {
    const parent = _callStack.length > 1 ? _callStack[_callStack.length - 2] : "(root)";
    const key = `${parent} → ${name}`;
    const node = _callTree.get(key) || { edge: key, count: 0, totalMs: 0 };
    node.count += 1;
    node.totalMs += ms;
    _callTree.set(key, node);
  }
}

export function perfAuditEnabled() {
  return _enabled;
}

export function perfAuditInit() {
  try {
    if (typeof window === "undefined") return false;
    const q = new URLSearchParams(window.location.search).get("perf_audit");
    if (q === "1") {
      try {
        localStorage.setItem("campatrack_perf_audit", "1");
      } catch (_) {
        /* ignore */
      }
    }
    _enabled = q === "1" || localStorage.getItem("campatrack_perf_audit") === "1";
  } catch (_) {
    _enabled = false;
  }
  if (!_enabled) return false;

  window.__campatrackPerfAudit = {
    enabled: () => _enabled,
    printReport: perfAuditPrintReport,
    exportJson: perfAuditExportJson,
    exportMarkdown: perfAuditExportMarkdown,
    exportProductionMarkdown: perfAuditExportProductionMarkdown,
    printProductionReport: perfAuditPrintProductionReport,
    reset: perfAuditReset,
    snapshotMemory: perfAuditSnapshotMemory,
    getMeasures: () => _measures,
    getInteractions: () => _interactions,
    getContext: perfAuditGetContext,
    runProductionAudit: perfAuditRunProduction,
    downloadProductionReport: perfAuditDownloadProductionReport,
    validateHydration: perfAuditValidateFullHydration,
    startDefinitiveAudit: perfAuditStartDefinitiveAudit,
    finishDefinitiveAudit: perfAuditFinishDefinitiveAudit,
    exportDefinitiveMarkdown: perfAuditExportDefinitiveMarkdown,
    exportDefinitiveJson: perfAuditExportDefinitiveJson,
    downloadDefinitiveReport: perfAuditDownloadDefinitiveReport,
    getPhase: () => _definitivePhase
  };

  perfAuditSnapshotMemory("init");
  console.info(
    "[PERF AUDIT] Activa. Definitiva: ?perf_audit=1&perf_definitive=1 | Manual: await __campatrackPerfAudit.startDefinitiveAudit()"
  );
  return true;
}

export function perfAuditRegisterWalkthroughRunner(fn) {
  _walkthroughRunner = typeof fn === "function" ? fn : null;
}

export function perfAuditRegisterContext(fn) {
  _contextProvider = typeof fn === "function" ? fn : null;
}

export function perfAuditGetContext() {
  try {
    return _contextProvider ? _contextProvider() : null;
  } catch (_) {
    return null;
  }
}

export function perfAuditRegisterProductionRunner(fn) {
  _productionRunner = typeof fn === "function" ? fn : null;
}

export function perfAuditCaptureSessionStart(ctx) {
  _sessionContextStart = ctx || perfAuditGetContext();
}

export function perfAuditCaptureSessionEnd(ctx) {
  _sessionContextEnd = ctx || perfAuditGetContext();
}

function _measureRow(name) {
  const m = _measures.get(name);
  if (!m) {
    return {
      name,
      count: 0,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0,
      minMs: 0,
      avgRecords: null
    };
  }
  return {
    name: m.name,
    category: m.category,
    count: m.count,
    totalMs: Math.round(m.totalMs * 100) / 100,
    avgMs: m.count ? Math.round((m.totalMs / m.count) * 100) / 100 : 0,
    maxMs: Math.round(m.maxMs * 100) / 100,
    minMs: m.minMs === Infinity ? 0 : Math.round(m.minMs * 100) / 100,
    avgRecords:
      m.recordsProcessed.length > 0
        ? Math.round(m.recordsProcessed.reduce((a, b) => a + b, 0) / m.recordsProcessed.length)
        : null,
    lastMeta: m.metaSamples[m.metaSamples.length - 1] || null
  };
}

function _crmCriticalMetrics() {
  return CRM_CRITICAL_MEASURES.map((name) => _measureRow(name));
}

function _filterInteractionTimelines() {
  return _interactions
    .filter((ix) => String(ix.trigger || "").includes("filter") || String(ix.trigger || "").includes("dashboard"))
    .map((ix) => ({
      id: ix.id,
      trigger: ix.trigger,
      durationMs: Math.round((ix.durationMs || 0) * 100) / 100,
      extra: ix.extra || {},
      meta: ix.meta || {},
      phases: (ix.phases || []).map((p) => ({
        name: p.name,
        ms: Math.round(p.ms * 100) / 100,
        records: p.meta?.records ?? p.meta?.rows ?? p.meta?.crmLeads ?? ""
      }))
    }));
}

export async function perfAuditValidateFullHydration() {
  const ctx = perfAuditGetContext();
  const missing = [];
  for (const [key, label] of HYDRATION_REQUIRED) {
    const val = ctx?.[key] ?? 0;
    if (val <= 0) missing.push({ key, label, value: val });
  }
  return { ok: missing.length === 0, missing, context: ctx || null };
}

export async function perfAuditWaitForFullHydration(maxMs = 300000) {
  const t0 = _now();
  let lastLog = 0;
  while (_now() - t0 < maxMs) {
    const v = await perfAuditValidateFullHydration();
    if (v.ok) {
      console.info("[PERF AUDIT] Hidratación completa desde GitHub:", v.context);
      return v.context;
    }
    if (_now() - lastLog > 3000) {
      lastLog = _now();
      const pend = v.missing.map((m) => `${m.label} = ${m.value}`).join(" | ");
      console.warn(`[PERF AUDIT] Esperando hidratación… Pendiente: ${pend}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const v = await perfAuditValidateFullHydration();
  const pend = v.missing.map((m) => m.label).join(", ");
  throw new Error(`[PERF AUDIT] Timeout: no se hidrataron todas las colecciones. Falta: ${pend}`);
}

export async function perfAuditWaitForRealData(maxMs = 180000) {
  const t0 = _now();
  while (_now() - t0 < maxMs) {
    const ctx = perfAuditGetContext();
    if (ctx?.hasData && ((ctx.crmLeads ?? 0) > 0 || (ctx.modeloAnalitico ?? 0) > 0)) {
      return ctx;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    "[PERF AUDIT] Timeout: no hay datos reales cargados desde GitHub (crmLeads/modeloAnalitico en 0)."
  );
}

export async function perfAuditRunProduction() {
  if (!_productionRunner) {
    throw new Error("[PERF AUDIT] Escenario de producción no registrado.");
  }
  await perfAuditWaitForRealData();
  const report = await _productionRunner();
  if (report && typeof report === "object") {
    report.sessionContext = {
      start: _sessionContextStart,
      end: _sessionContextEnd
    };
  }
  try {
    window.__campatrackPerfAudit.lastProductionReport = report;
  } catch (_) {
    /* ignore */
  }
  return report;
}

function _startLongTaskObserver() {
  _longTasks = [];
  if (typeof PerformanceObserver === "undefined") return;
  try {
    _longTaskObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        _longTasks.push({
          duration: Math.round(e.duration * 100) / 100,
          startTime: Math.round(e.startTime * 100) / 100
        });
      }
    });
    _longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch (_) {
    _longTaskObserver = null;
  }
}

function _stopLongTaskObserver() {
  try {
    _longTaskObserver?.disconnect();
  } catch (_) {
    /* ignore */
  }
  _longTaskObserver = null;
}

function _showDefinitiveBanner(text) {
  if (typeof document === "undefined") return;
  let el = document.getElementById("campatrackPerfAuditBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "campatrackPerfAuditBanner";
    el.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:99999;max-width:420px;padding:12px 16px;" +
      "background:#0f172a;color:#e2e8f0;font:13px/1.4 system-ui,sans-serif;border-radius:8px;" +
      "box-shadow:0 4px 24px rgba(0,0,0,.35);border:1px solid #334155";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "block";
}

function _hideDefinitiveBanner() {
  document.getElementById("campatrackPerfAuditBanner")?.remove();
}

function _startInteractiveMemoryPolling() {
  if (_memoryIntervalId) clearInterval(_memoryIntervalId);
  _memoryIntervalId = setInterval(() => {
    if (_definitivePhase === "interactive") perfAuditSnapshotMemory("interactive-poll");
  }, 30000);
}

function _stopInteractiveMemoryPolling() {
  if (_memoryIntervalId) {
    clearInterval(_memoryIntervalId);
    _memoryIntervalId = null;
  }
}

export async function perfAuditStartDefinitiveAudit() {
  if (_definitiveMode && _definitivePhase === "interactive") {
    throw new Error("[PERF AUDIT] Auditoría definitiva ya en fase interactiva.");
  }
  await perfAuditWaitForFullHydration();
  perfAuditReset();
  _definitiveMode = true;
  _definitivePhase = "auto-walk";
  _definitiveStartedAt = _now();
  _startLongTaskObserver();
  perfAuditSnapshotMemory("definitive-inicio");
  perfAuditCaptureSessionStart(perfAuditGetContext());

  console.info("[PERF AUDIT] Recorrido automático inicial…");
  if (_walkthroughRunner) {
    await _walkthroughRunner();
  } else {
    console.warn("[PERF AUDIT] Sin walkthrough registrado.");
  }

  _definitivePhase = "interactive";
  perfAuditSnapshotMemory("definitive-post-walkthrough");
  _startInteractiveMemoryPolling();
  _showDefinitiveBanner(
    "Auditoría activa — usa CampaTrack 5-10 min. Finalizar: __campatrackPerfAudit.finishDefinitiveAudit()"
  );
  console.info(
    "%c[PERF AUDIT] FASE INTERACTIVA — Usa el sistema con normalidad 5-10 min.\nFinalizar: await __campatrackPerfAudit.finishDefinitiveAudit()",
    "color:#22c55e;font-weight:bold"
  );

  _definitiveInteractivePromise = new Promise((resolve) => {
    _definitiveFinishResolve = resolve;
  });
  return _definitiveInteractivePromise;
}

export async function perfAuditFinishDefinitiveAudit() {
  if (!_definitiveMode || _definitivePhase !== "interactive") {
    throw new Error("[PERF AUDIT] No hay auditoría en fase interactiva. Ejecuta startDefinitiveAudit() primero.");
  }
  _definitivePhase = "finished";
  _stopInteractiveMemoryPolling();
  _stopLongTaskObserver();
  perfAuditSnapshotMemory("definitive-fin");
  perfAuditCaptureSessionEnd(perfAuditGetContext());
  _hideDefinitiveBanner();

  const report = _buildDefinitiveReport();
  try {
    window.__campatrackPerfAudit.lastDefinitiveReport = report;
  } catch (_) {
    /* ignore */
  }
  _definitiveFinishResolve?.(report);
  console.info("[PERF AUDIT] Auditoría definitiva finalizada.");
  perfAuditPrintDefinitiveSummary();
  return report;
}

function perfAuditTryScheduleDefinitiveOrAutoRun() {
  if (!_enabled || _autoRunScheduled) return;
  try {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("perf_definitive") === "1") {
      if (!_walkthroughRunner) {
        console.warn("[PERF AUDIT] Walkthrough aún no registrado; reintentando tras hidratación.");
        return;
      }
      _autoRunScheduled = true;
      void (async () => {
        try {
          await perfAuditStartDefinitiveAudit();
        } catch (e) {
          console.error("[PERF AUDIT] Auditoría definitiva falló al iniciar:", e);
          _autoRunScheduled = false;
        }
      })();
      return;
    }
    if (params.get("perf_run") === "1") perfAuditTryScheduleAutoRun();
  } catch (_) {
    /* ignore */
  }
}

function perfAuditTryScheduleAutoRun() {
  if (!_enabled || _autoRunScheduled || !_productionRunner) return;
  try {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("perf_run") !== "1") return;
    _autoRunScheduled = true;
    void (async () => {
      try {
        console.info("[PERF AUDIT] Auto-run: esperando datos GitHub…");
        await perfAuditWaitForRealData();
        console.info("[PERF AUDIT] Auto-run: iniciando escenario producción…");
        const report = await perfAuditRunProduction();
        console.info("[PERF AUDIT] Auto-run completado.");
        perfAuditPrintProductionReport();
        console.info(
          "[PERF AUDIT] Markdown: __campatrackPerfAudit.exportProductionMarkdown() | Descargar: __campatrackPerfAudit.downloadProductionReport()"
        );
        return report;
      } catch (e) {
        console.error("[PERF AUDIT] Auto-run falló:", e);
      }
    })();
  } catch (_) {
    /* ignore */
  }
}

export function perfAuditScheduleAutoRunAfterHydrate() {
  perfAuditTryScheduleDefinitiveOrAutoRun();
}

export function perfAuditReset() {
  _definitiveMode = false;
  _definitivePhase = "idle";
  _definitiveStartedAt = null;
  _definitiveFinishResolve = null;
  _definitiveInteractivePromise = null;
  _longTasks = [];
  _stopLongTaskObserver();
  _stopInteractiveMemoryPolling();
  _hideDefinitiveBanner();
  _measures.clear();
  _renders.clear();
  _arrayOps.clear();
  _interactions.length = 0;
  _memorySnaps.length = 0;
  _moduleLoads.clear();
  _stateChanges.length = 0;
  _callTree.clear();
  _callStack = [];
  _currentInteraction = null;
  _sessionContextStart = null;
  _sessionContextEnd = null;
}

export function perfAuditSnapshotMemory(label) {
  if (!_enabled) return;
  _memorySnaps.push({ label: String(label || ""), at: _now(), mb: _memMb(), ts: Date.now() });
}

/** @returns {() => void} */
export function perfMeasureStart(name, category = "general") {
  if (!_enabled) return () => {};
  const t0 = _now();
  _callStack.push(name);
  return (meta = {}) => {
    const ms = _now() - t0;
    _callStack.pop();
    _recordMeasure(name, category, ms, meta);
    if (_currentInteraction) {
      _currentInteraction.phases.push({
        name,
        category,
        ms,
        at: _now(),
        meta
      });
    }
  };
}

export function perfMeasure(name, category, fn, meta = {}) {
  if (!_enabled) return fn();
  const end = perfMeasureStart(name, category);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => end(meta));
    }
    end(meta);
    return result;
  } catch (e) {
    end({ ...meta, error: String(e?.message || e) });
    throw e;
  }
}

export function perfBeginInteraction(trigger, meta = {}) {
  if (!_enabled) return;
  _interactionSeq += 1;
  _currentInteraction = {
    id: _interactionSeq,
    trigger: String(trigger || "unknown"),
    start: _now(),
    meta,
    phases: []
  };
}

export function perfEndInteraction(extra = {}) {
  if (!_enabled || !_currentInteraction) return;
  _currentInteraction.end = _now();
  _currentInteraction.durationMs = _currentInteraction.end - _currentInteraction.start;
  _currentInteraction.extra = extra;
  const ix = _currentInteraction;
  _interactions.push(ix);
  _currentInteraction = null;
  if (typeof requestAnimationFrame === "function") {
    const tEnd = ix.end;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ix.layoutPaintApproxMs = Math.round((_now() - tEnd) * 100) / 100;
      });
    });
  }
  perfAuditSnapshotMemory("post-interaction");
}

export function perfTrackFilterChange(field, value, module = "dashboard") {
  if (!_enabled) return;
  _stateChanges.push({
    at: _now(),
    module,
    field: String(field || ""),
    value: value == null ? "" : String(value).slice(0, 80)
  });
}

export function perfTrackModuleLoad(moduleName, ms, meta = {}) {
  if (!_enabled) return;
  const key = String(moduleName || "unknown");
  const prev = _moduleLoads.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
  prev.count += 1;
  prev.totalMs += ms;
  prev.maxMs = Math.max(prev.maxMs, ms);
  prev.lastMeta = meta;
  _moduleLoads.set(key, prev);
}

export function perfArrayOp(op, label, arr, fn) {
  if (!_enabled) return fn();
  const t0 = _now();
  const len = Array.isArray(arr) ? arr.length : 0;
  try {
    return fn();
  } finally {
    const ms = _now() - t0;
    const key = `${op}:${label}`;
    const e = _arrayOps.get(key) || { op, label, count: 0, totalMs: 0, maxMs: 0, inputSizes: [] };
    e.count += 1;
    e.totalMs += ms;
    e.maxMs = Math.max(e.maxMs, ms);
    if (e.inputSizes.length < 20) e.inputSizes.push(len);
    _arrayOps.set(key, e);
    _recordMeasure(`array:${op}:${label}`, "array-op", ms, { records: len, op });
  }
}

function _rankMeasures(limit = 20) {
  return [..._measures.values()]
    .map((m) => ({
      name: m.name,
      category: m.category,
      count: m.count,
      totalMs: Math.round(m.totalMs * 100) / 100,
      avgMs: m.count ? Math.round((m.totalMs / m.count) * 100) / 100 : 0,
      maxMs: Math.round(m.maxMs * 100) / 100,
      avgRecords:
        m.recordsProcessed.length > 0
          ? Math.round(m.recordsProcessed.reduce((a, b) => a + b, 0) / m.recordsProcessed.length)
          : null
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

function _buildReport() {
  const topRenders = [..._renders.values()].sort((a, b) => b.totalMs - a.totalMs);
  const topArrayOps = [..._arrayOps.values()].sort((a, b) => b.totalMs - a.totalMs);
  const topFlame = [..._callTree.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 25);
  const lastInteraction = _interactions[_interactions.length - 1] || null;
  const filteredData = _measureRow("data:getDashboardFilteredData");
  const ctx = _sessionContextEnd || _sessionContextStart || perfAuditGetContext();

  return {
    generatedAt: new Date().toISOString(),
    note: "CampaTrack usa vanilla JS (no React). Métricas de ejecución real — no estimaciones.",
    dataSource: "GitHub (sesión producción)",
    sessionContext: {
      start: _sessionContextStart,
      end: _sessionContextEnd,
      current: ctx
    },
    summary: {
      measureCount: [..._measures.values()].reduce((a, m) => a + m.count, 0),
      interactionCount: _interactions.length,
      memorySnapshots: _memorySnaps.length,
      sharedDashboardFilterState: "estadoFiltrosDashboard (Plataforma + CRM comparten objeto)",
      getDashboardFilteredDataCalls: filteredData.count,
      crmLeadsProcessed: ctx?.crmLeads ?? _sessionContextEnd?.crmLeads ?? _sessionContextStart?.crmLeads ?? null,
      planningRows: ctx?.planningRows ?? null,
      relacionesMeta: ctx?.relacionesMeta ?? null,
      relacionesCrm: ctx?.relacionesCrm ?? null,
      modeloAnalitico: ctx?.modeloAnalitico ?? null
    },
    crmCriticalMetrics: _crmCriticalMetrics(),
    filterInteractionTimelines: _filterInteractionTimelines(),
    top20: _rankMeasures(20),
    renders: topRenders,
    kpis: _rankMeasures(50).filter((m) => m.category === "kpi"),
    charts: _rankMeasures(50).filter((m) => m.category === "chart"),
    tables: _rankMeasures(50).filter((m) => m.category === "table"),
    dataOps: _rankMeasures(50).filter((m) => m.category === "data"),
    arrayOps: topArrayOps.map((a) => ({
      ...a,
      avgMs: a.count ? Math.round((a.totalMs / a.count) * 100) / 100 : 0,
      totalMs: Math.round(a.totalMs * 100) / 100
    })),
    moduleLoads: Object.fromEntries(_moduleLoads),
    stateChanges: _stateChanges.slice(-50),
    memory: _memorySnaps,
    interactions: _interactions.slice(-15),
    lastInteractionTimeline: lastInteraction,
    flameEdges: topFlame
  };
}

export function perfAuditExportJson() {
  return JSON.stringify(_buildReport(), null, 2);
}

function _fmtMs(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function _mdTable(rows, cols) {
  if (!rows.length) return "_Sin mediciones._\n\n";
  const head = `| ${cols.map((c) => c.label).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`;
  const body = rows
    .map((r) => `| ${cols.map((c) => String(r[c.key] ?? "")).join(" | ")} |`)
    .join("\n");
  return `${head}${body}\n\n`;
}

export function perfAuditExportMarkdown() {
  const r = _buildReport();
  const top = r.top20[0];
  const topKpi = r.kpis[0];
  const topChart = r.charts[0];
  const topTable = r.tables[0];
  const topData = r.dataOps[0];
  const lastIx = r.lastInteractionTimeline;
  const mem0 = r.memory[0];
  const memLast = r.memory[r.memory.length - 1];

  let md = `# Informe de auditoría dinámica — CampaTrack\n\n`;
  md += `_Generado: ${r.generatedAt}_\n\n`;
  md += `> ${r.note}\n\n`;

  md += `## Resumen ejecutivo\n\n`;
  md += `- Mediciones registradas: **${r.summary.measureCount}**\n`;
  md += `- Interacciones cronometradas: **${r.summary.interactionCount}**\n`;
  md += `- Estado compartido Plataforma/CRM: **${r.summary.sharedDashboardFilterState}**\n`;
  if (top) {
    md += `- Operación más costosa (tiempo acumulado): **${top.name}** (${_fmtMs(top.totalMs)} ms total, ${_fmtMs(top.avgMs)} ms prom.)\n`;
  }
  if (mem0 && memLast && mem0.mb != null && memLast.mb != null) {
    md += `- Memoria JS heap: **${mem0.mb} MB** (inicio) → **${memLast.mb} MB** (última captura)\n`;
  }
  md += `\n`;

  md += `## React Profiler\n\n`;
  md += `No aplica (stack vanilla JS). Equivalente — funciones render instrumentadas:\n\n`;
  md += _mdTable(r.renders.slice(0, 15), [
    { key: "name", label: "Función" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" }
  ]);

  md += `## KPIs\n\n`;
  md += _mdTable(r.kpis.slice(0, 10), [
    { key: "name", label: "KPI" },
    { key: "count", label: "Ejecuciones" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" },
    { key: "avgRecords", label: "Registros prom." }
  ]);

  md += `## Gráficos\n\n`;
  md += _mdTable(r.charts.slice(0, 10), [
    { key: "name", label: "Gráfico" },
    { key: "count", label: "Ejecuciones" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" }
  ]);

  md += `## Tablas\n\n`;
  md += _mdTable(r.tables.slice(0, 10), [
    { key: "name", label: "Tabla" },
    { key: "count", label: "Ejecuciones" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" },
    { key: "avgRecords", label: "Filas prom." }
  ]);

  md += `## Embudo / agregaciones CRM\n\n`;
  const crmData = r.dataOps.filter((m) => /crm|Crm|aggregate|PlatformLeads/i.test(m.name));
  md += _mdTable(crmData.slice(0, 8), [
    { key: "name", label: "Función" },
    { key: "count", label: "Ejecuciones" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" },
    { key: "avgRecords", label: "Registros prom." }
  ]);

  md += `## Estados\n\n`;
  md += `Cambios de filtro registrados (últimos 20):\n\n`;
  md += _mdTable(r.stateChanges.slice(-20), [
    { key: "field", label: "Campo" },
    { key: "value", label: "Valor" },
    { key: "module", label: "Módulo" }
  ]);

  md += `## Renderizados\n\n`;
  md += _mdTable(
    r.renders.slice(0, 20).map((x) => ({
      ...x,
      avgMs: x.count ? _fmtMs(x.totalMs / x.count) : 0
    })),
    [
      { key: "name", label: "Función" },
      { key: "count", label: "Renders" },
      { key: "totalMs", label: "Total ms" },
      { key: "avgMs", label: "Prom ms" }
    ]
  );

  md += `## CPU / operaciones array\n\n`;
  md += _mdTable(r.arrayOps.slice(0, 15), [
    { key: "label", label: "Etiqueta" },
    { key: "op", label: "Op" },
    { key: "count", label: "Ejecuciones" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" }
  ]);

  md += `## Memoria\n\n`;
  md += _mdTable(r.memory, [
    { key: "label", label: "Etapa" },
    { key: "mb", label: "MB heap" }
  ]);

  md += `## Flame Chart (edges)\n\n`;
  md += _mdTable(
    r.flameEdges.slice(0, 20).map((e) => ({ ...e, totalMs: _fmtMs(e.totalMs) })),
    [
      { key: "edge", label: "Cadena" },
      { key: "count", label: "Veces" },
      { key: "totalMs", label: "Total ms" }
    ]
  );

  md += `## Timeline (última interacción)\n\n`;
  if (lastIx) {
    md += `- Trigger: \`${lastIx.trigger}\`\n`;
    md += `- Duración total: **${_fmtMs(lastIx.durationMs)} ms**\n\n`;
    md += _mdTable(
      (lastIx.phases || []).map((p) => ({
        fase: p.name,
        categoria: p.category,
        ms: _fmtMs(p.ms),
        records: p.meta?.records ?? p.meta?.rows ?? ""
      })),
      [
        { key: "fase", label: "Fase" },
        { key: "categoria", label: "Categoría" },
        { key: "ms", label: "ms" },
        { key: "records", label: "Registros" }
      ]
    );
  } else {
    md += `_Sin interacciones registradas._\n\n`;
  }

  md += `## Latencia por módulo\n\n`;
  const modRows = Object.entries(r.moduleLoads).map(([name, v]) => ({
    modulo: name,
    cargas: v.count,
    totalMs: _fmtMs(v.totalMs),
    maxMs: _fmtMs(v.maxMs),
    promMs: v.count ? _fmtMs(v.totalMs / v.count) : 0
  }));
  md += _mdTable(modRows, [
    { key: "modulo", label: "Módulo" },
    { key: "cargas", label: "Cargas" },
    { key: "promMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" }
  ]);

  md += `## Ranking general (Top 20)\n\n`;
  md += _mdTable(r.top20, [
    { key: "name", label: "Nombre" },
    { key: "category", label: "Categoría" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" }
  ]);

  md += `## Cuellos de botella (priorizados)\n\n`;
  const bottlenecks = r.top20.slice(0, 10).map((m, i) => {
    return `${i + 1}. **${m.name}** — ${_fmtMs(m.totalMs)} ms acumulados (${m.count}×, prom ${_fmtMs(m.avgMs)} ms, máx ${_fmtMs(m.maxMs)} ms)`;
  });
  md += bottlenecks.length ? bottlenecks.join("\n") + "\n\n" : "_Insuficientes datos._\n\n";

  md += `## Conclusión\n\n`;
  md += `- **Origen principal de lentitud (medido):** ${top ? `\`${top.name}\` (${_fmtMs(top.totalMs)} ms acumulados)` : "Ejecutar escenario con datos reales."}\n`;
  md += `- **Componente/función más costosa:** ${top?.name ?? "—"}\n`;
  md += `- **KPI más costoso:** ${topKpi ? `\`${topKpi.name}\` (prom ${_fmtMs(topKpi.avgMs)} ms)` : "—"}\n`;
  md += `- **Gráfico más costoso:** ${topChart ? `\`${topChart.name}\` (prom ${_fmtMs(topChart.avgMs)} ms)` : "—"}\n`;
  md += `- **Tabla más costosa:** ${topTable ? `\`${topTable.name}\` (prom ${_fmtMs(topTable.avgMs)} ms)` : "—"}\n`;
  md += `- **Proceso de datos más costoso:** ${topData ? `\`${topData.name}\` (prom ${_fmtMs(topData.avgMs)} ms)` : "—"}\n`;
  md += `- **Estados compartidos Dashboard CRM / Plataforma:** Sí — \`estadoFiltrosDashboard\` y \`programaSeleccionado\`.\n`;
  md += `- **Optimizaciones sugeridas (solo diagnóstico, NO implementadas):** ver ranking Top 20; priorizar funciones con mayor \`totalMs\`.\n`;

  return md;
}

export function perfAuditExportProductionMarkdown() {
  const r = _buildReport();
  const s = r.summary;
  const ctx = r.sessionContext?.start || r.sessionContext?.current || {};
  let md = `# Auditoría producción — CampaTrack (métricas reales)\n\n`;
  md += `_Generado: ${r.generatedAt}_\n\n`;
  md += `> Datos desde GitHub en sesión real. Sin estimaciones.\n\n`;

  md += `## Contexto del dataset\n\n`;
  md += `- **crmLeads:** ${ctx.crmLeads ?? s.crmLeadsProcessed ?? "—"}\n`;
  md += `- **Filas Planning:** ${ctx.planningRows ?? s.planningRows ?? "—"}\n`;
  md += `- **Relaciones META:** ${ctx.relacionesMeta ?? s.relacionesMeta ?? "—"}\n`;
  md += `- **Relaciones CRM:** ${ctx.relacionesCrm ?? s.relacionesCrm ?? "—"}\n`;
  md += `- **Modelo analítico:** ${ctx.modeloAnalitico ?? s.modeloAnalitico ?? "—"}\n`;
  md += `- **Llamadas getDashboardFilteredData:** ${s.getDashboardFilteredDataCalls ?? 0}\n\n`;

  md += `## Métricas CRM críticas\n\n`;
  md += _mdTable(r.crmCriticalMetrics, [
    { key: "name", label: "Función" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" },
    { key: "avgRecords", label: "Registros prom." }
  ]);

  md += `## Todos los renders (tiempos reales)\n\n`;
  md += _mdTable(
    r.top20.filter((m) => m.category === "render" || m.name.startsWith("render:")),
    [
      { key: "name", label: "Función" },
      { key: "count", label: "Ejecuciones" },
      { key: "totalMs", label: "Total ms" },
      { key: "avgMs", label: "Prom ms" },
      { key: "maxMs", label: "Máx ms" }
    ]
  );

  md += `## Filtro → render completo (timelines)\n\n`;
  if (!r.filterInteractionTimelines.length) {
    md += `_Sin interacciones de filtro registradas._\n\n`;
  } else {
    for (const ix of r.filterInteractionTimelines) {
      md += `### ${ix.trigger} — **${ix.durationMs} ms** total\n\n`;
      if (ix.extra?.crmLeads != null) {
        md += `- crmLeads en interacción: ${ix.extra.crmLeads}\n`;
      }
      md += _mdTable(ix.phases, [
        { key: "name", label: "Fase" },
        { key: "ms", label: "ms" },
        { key: "records", label: "Registros" }
      ]);
    }
  }

  md += `## Ranking general\n\n`;
  md += _mdTable(r.top20, [
    { key: "name", label: "Nombre" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" }
  ]);

  return md;
}

export function perfAuditPrintProductionReport() {
  const r = _buildReport();
  console.group("[PERF AUDIT] Informe producción (datos reales)");
  console.log("Dataset:", r.sessionContext?.start || r.sessionContext?.current);
  console.log("Resumen:", r.summary);
  console.table(r.crmCriticalMetrics);
  if (r.filterInteractionTimelines.length) {
    console.group("Timelines filtro → render");
    r.filterInteractionTimelines.forEach((ix) => {
      console.log(`${ix.trigger}: ${ix.durationMs} ms`);
      console.table(ix.phases);
    });
    console.groupEnd();
  }
  console.groupEnd();
  return r;
}

export function perfAuditDownloadProductionReport() {
  if (typeof document === "undefined") return;
  const md = perfAuditExportProductionMarkdown();
  const json = perfAuditExportJson();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dl = (content, name, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  dl(md, `campatrack-perf-${ts}.md`, "text/markdown");
  dl(json, `campatrack-perf-${ts}.json`, "application/json");
}

export function perfAuditPrintReport() {
  const r = _buildReport();
  console.group("[PERF AUDIT] Informe");
  console.log("Resumen:", r.summary);
  console.table(r.top20);
  if (r.lastInteractionTimeline) {
    console.group("Última interacción — timeline");
    console.log("Trigger:", r.lastInteractionTimeline.trigger);
    console.log("Duración total (ms):", Math.round(r.lastInteractionTimeline.durationMs * 100) / 100);
    console.table(
      (r.lastInteractionTimeline.phases || []).map((p) => ({
        fase: p.name,
        categoria: p.category,
        ms: Math.round(p.ms * 100) / 100,
        records: p.meta?.records ?? p.meta?.rows ?? ""
      }))
    );
    console.groupEnd();
  }
  console.group("Memoria (MB usados)");
  console.table(r.memory);
  console.groupEnd();
  console.group("Array ops");
  console.table(r.arrayOps.slice(0, 15));
  console.groupEnd();
  console.group("Flame edges (top)");
  console.table(r.flameEdges);
  console.groupEnd();
  console.groupEnd();
  return r;
}

function _totalMeasuredMs() {
  return [..._measures.values()].reduce((a, m) => a + m.totalMs, 0);
}

function _rankMeasuresWithPct(limit = 20) {
  const grand = _totalMeasuredMs() || 1;
  return _rankMeasures(limit).map((m) => ({
    ...m,
    pctTotal: Math.round((m.totalMs / grand) * 10000) / 100
  }));
}

function _filterRenderInteractionStats() {
  const ixs = _interactions.filter((ix) => ix.trigger === "dashboard:filter-render");
  if (!ixs.length) {
    return { name: "interaction:dashboard:filter-render (renderDashboardFromFiltersNow)", count: 0, totalMs: 0, avgMs: 0, maxMs: 0, avgRecords: null, pctTotal: 0 };
  }
  const totalMs = ixs.reduce((a, ix) => a + (ix.durationMs || 0), 0);
  const maxMs = Math.max(...ixs.map((ix) => ix.durationMs || 0));
  const grand = _totalMeasuredMs() + totalMs || 1;
  return {
    name: "interaction:dashboard:filter-render (renderDashboardFromFiltersNow)",
    count: ixs.length,
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / ixs.length) * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    avgRecords: null,
    pctTotal: Math.round((totalMs / grand) * 10000) / 100
  };
}

function _mandatoryMetricsWithPct() {
  const grand = _totalMeasuredMs() || 1;
  const rows = MANDATORY_MEASURES.map((name) => {
    const m = _measureRow(name);
    return { ...m, pctTotal: Math.round((m.totalMs / grand) * 10000) / 100 };
  });
  rows.push(_filterRenderInteractionStats());
  return rows.sort((a, b) => b.totalMs - a.totalMs);
}

function _memoryAnalysis() {
  const withMb = _memorySnaps.filter((s) => s.mb != null);
  if (!withMb.length) return { initial: null, max: null, final: null, delta: null };
  const mbs = withMb.map((s) => s.mb);
  const initial = withMb[0].mb;
  const final = withMb[withMb.length - 1].mb;
  return {
    initial,
    max: Math.max(...mbs),
    final,
    delta: Math.round((final - initial) * 10) / 10,
    snapshots: withMb
  };
}

function _renderAnalysis() {
  const renders = [..._renders.values()].sort((a, b) => b.totalMs - a.totalMs);
  const top = renders[0] || null;
  const byCount = [..._renders.values()].sort((a, b) => b.count - a.count);
  const topCount = byCount[0] || null;
  let topInteraction = null;
  let maxIxRenders = 0;
  for (const ix of _interactions) {
    const n = (ix.phases || []).length;
    if (n > maxIxRenders) {
      maxIxRenders = n;
      topInteraction = ix;
    }
  }
  return {
    mostCostlyRender: top,
    mostFrequentRender: topCount,
    interactionWithMostPhases: topInteraction
      ? { trigger: topInteraction.trigger, phases: maxIxRenders, durationMs: topInteraction.durationMs }
      : null
  };
}

function _buildOptimizationPlan(top20, mandatory) {
  const items = [];
  const add = (title, benefit, risk, complexity, modules, priority) => {
    items.push({ title, benefit, risk, complexity, modules, priority, compatibleDraftPublish: "Sí — no altera borrador/publicar" });
  };
  const top = top20[0];
  const crmTabla = mandatory.find((m) => m.name.includes("DashboardCrmTabla"));
  const agg = mandatory.find((m) => m.name.includes("aggregateDashboardCrm"));
  const pivot = mandatory.find((m) => m.name.includes("PivotFuente"));
  const filtData = mandatory.find((m) => m.name.includes("getDashboardFilteredData"));
  const filterIx = mandatory.find((m) => m.name.includes("filter-render"));

  if (crmTabla && crmTabla.totalMs > 0) {
    add(
      `Optimizar ${crmTabla.name} (${crmTabla.pctTotal}% tiempo medido)`,
      `Reducción estimada proporcional a ${crmTabla.totalMs} ms acumulados medidos`,
      "Medio — riesgo en selección filas y totales",
      "Alta",
      "Dashboard CRM",
      1
    );
  }
  if (agg && agg.totalMs > 0) {
    add(
      `Memoizar ${agg.name} (${agg.pctTotal}%)`,
      `${agg.totalMs} ms acumulados en ${agg.count} ejecuciones`,
      "Bajo si invalidación por firma de filtros",
      "Media",
      "Dashboard CRM",
      2
    );
  }
  if (pivot && pivot.totalMs > 0) {
    add(
      `Diferir/lazy ${pivot.name} (${pivot.pctTotal}%)`,
      `${pivot.totalMs} ms medidos`,
      "Medio — panel inferior CRM",
      "Media",
      "Dashboard CRM",
      3
    );
  }
  if (filtData && filtData.count > 5) {
    add(
      `Reducir llamadas ${filtData.name} (${filtData.count}× medidas)`,
      `${filtData.totalMs} ms acumulados`,
      "Bajo",
      "Baja",
      "Dashboard",
      4
    );
  }
  if (filterIx && filterIx.count > 0) {
    add(
      `Coalesce renderDashboardFromFiltersNow (${filterIx.avgMs} ms prom.)`,
      `${filterIx.totalMs} ms en cascada filtro→render`,
      "Medio",
      "Media",
      "Dashboard Plataforma + CRM",
      5
    );
  }
  if (top && !items.some((i) => i.title.includes(top.name))) {
    add(
      `Atacar cuello de botella medido: ${top.name} (${top.pctTotal}%)`,
      `${top.totalMs} ms acumulados`,
      "Variable",
      "Variable",
      "Varios",
      items.length + 1
    );
  }
  return items.slice(0, 10);
}

function _allInteractionTimelines() {
  return _interactions.map((ix) => ({
    id: ix.id,
    trigger: ix.trigger,
    durationMs: Math.round((ix.durationMs || 0) * 100) / 100,
    layoutPaintApproxMs: ix.layoutPaintApproxMs ?? null,
    extra: ix.extra || {},
    phases: (ix.phases || []).map((p) => ({
      name: p.name,
      category: p.category,
      ms: Math.round(p.ms * 100) / 100,
      crmLeads: p.meta?.crmLeads ?? "",
      planningRows: p.meta?.planningRows ?? "",
      records: p.meta?.records ?? p.meta?.rows ?? ""
    }))
  }));
}

function _buildDefinitiveReport() {
  const top20 = _rankMeasuresWithPct(20);
  const mandatory = _mandatoryMetricsWithPct();
  const mem = _memoryAnalysis();
  const renderA = _renderAnalysis();
  const ctx = _sessionContextEnd || _sessionContextStart || perfAuditGetContext();
  const sessionDurationMin = _definitiveStartedAt ? Math.round((_now() - _definitiveStartedAt) / 600) / 100 : null;

  return {
    type: "definitive",
    generatedAt: new Date().toISOString(),
    sessionDurationMin,
    dataSource: "GitHub — sesión real",
    sessionContext: { start: _sessionContextStart, end: _sessionContextEnd },
    dataset: ctx,
    summary: {
      totalMeasuredMs: Math.round(_totalMeasuredMs() * 100) / 100,
      measureCount: [..._measures.values()].reduce((a, m) => a + m.count, 0),
      interactionCount: _interactions.length,
      stateChangeCount: _stateChanges.length,
      getDashboardFilteredDataCalls: _measureRow("data:getDashboardFilteredData").count,
      longTaskCount: _longTasks.length,
      longTaskTotalMs: Math.round(_longTasks.reduce((a, t) => a + t.duration, 0) * 100) / 100
    },
    mandatoryMetrics: mandatory,
    top20,
    memory: mem,
    renderAnalysis: renderA,
    allTimelines: _allInteractionTimelines(),
    stateChanges: _stateChanges,
    moduleLoads: Object.fromEntries(_moduleLoads),
    arrayOps: [..._arrayOps.values()],
    longTasks: _longTasks.slice(-50),
    flameEdges: [..._callTree.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 25),
    optimizationPlan: _buildOptimizationPlan(top20, mandatory),
    analysis: {
      bottleneck: top20[0] || null,
      mostCpuApprox: _longTasks.length
        ? _longTasks.reduce((best, t) => (t.duration > (best?.duration || 0) ? t : best), null)
        : top20[0] || null,
      mostMemory: mem.max,
      mostRenders: renderA.mostFrequentRender,
      mostCostlyRender: renderA.mostCostlyRender,
      mostTraversals: mandatory.find((m) => m.name.includes("aggregate")) || top20.find((m) => m.category === "data")
    }
  };
}

function _fixRenderAnalysisTypo(r) {
  if (r.analysis && r.renderAnalysis) {
    r.analysis.mostCostlyRender = r.renderAnalysis.mostCostlyRender;
  }
  return r;
}

export function perfAuditExportDefinitiveJson() {
  return JSON.stringify(_fixRenderAnalysisTypo(_buildDefinitiveReport()), null, 2);
}

export function perfAuditExportDefinitiveMarkdown() {
  const r = _fixRenderAnalysisTypo(_buildDefinitiveReport());
  const d = r.dataset || {};
  let md = `# Informe definitivo de auditoría de rendimiento — CampaTrack\n\n`;
  md += `_Generado: ${r.generatedAt}_ | Duración sesión: **${r.sessionDurationMin ?? "—"} min**\n\n`;
  md += `> Métricas obtenidas en sesión real con datos GitHub. Sin estimaciones.\n\n`;

  md += `## 1. Contexto del dataset (validación previa)\n\n`;
  md += `- modeloAnalitico: **${d.modeloAnalitico ?? "—"}**\n`;
  md += `- crmLeads: **${d.crmLeads ?? "—"}**\n`;
  md += `- planningRows: **${d.planningRows ?? "—"}**\n`;
  md += `- relacionesMeta: **${d.relacionesMeta ?? "—"}**\n`;
  md += `- relacionesCrm: **${d.relacionesCrm ?? "—"}**\n\n`;

  md += `## 2. Funciones obligatorias\n\n`;
  md += _mdTable(r.mandatoryMetrics, [
    { key: "name", label: "Función" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" },
    { key: "avgMs", label: "Prom ms" },
    { key: "maxMs", label: "Máx ms" },
    { key: "avgRecords", label: "Registros prom." },
    { key: "pctTotal", label: "% tiempo" }
  ]);

  md += `## 3. Ranking Top 20\n\n`;
  md += _mdTable(r.top20, [
    { key: "name", label: "Función" },
    { key: "count", label: "Ejecuciones" },
    { key: "totalMs", label: "Total ms" },
    { key: "pctTotal", label: "% total" },
    { key: "avgRecords", label: "Registros prom." }
  ]);

  md += `## 4. Renderizados\n\n`;
  const ra = r.renderAnalysis;
  md += `- **Render más costoso (tiempo acumulado):** ${ra.mostCostlyRender?.name ?? "—"} (${ra.mostCostlyRender?.totalMs ?? 0} ms)\n`;
  md += `- **Render más frecuente:** ${ra.mostFrequentRender?.name ?? "—"} (${ra.mostFrequentRender?.count ?? 0}×)\n`;
  if (ra.interactionWithMostPhases) {
    md += `- **Interacción con más fases:** \`${ra.interactionWithMostPhases.trigger}\` (${ra.interactionWithMostPhases.phases} fases, ${ra.interactionWithMostPhases.durationMs} ms)\n`;
  }
  md += `\n`;

  md += `## 5. Memoria (JS heap Chrome)\n\n`;
  md += `- Inicial: **${r.memory.initial ?? "—"} MB**\n`;
  md += `- Máxima: **${r.memory.max ?? "—"} MB**\n`;
  md += `- Final: **${r.memory.final ?? "—"} MB**\n`;
  md += `- Delta: **${r.memory.delta ?? "—"} MB**\n\n`;

  md += `## 6. CPU (Long Tasks medidos)\n\n`;
  md += `- Cantidad long tasks: **${r.summary.longTaskCount}**\n`;
  md += `- Tiempo total long tasks: **${r.summary.longTaskTotalMs} ms**\n\n`;

  md += `## 7. Timelines por interacción\n\n`;
  for (const ix of r.allTimelines) {
    md += `### ${ix.trigger} — ${ix.durationMs} ms`;
    if (ix.layoutPaintApproxMs != null) md += ` (+ ~${ix.layoutPaintApproxMs} ms layout/paint aprox.)`;
    md += `\n\n`;
    md += _mdTable(ix.phases, [
      { key: "name", label: "Fase" },
      { key: "ms", label: "ms" },
      { key: "records", label: "Registros" },
      { key: "crmLeads", label: "crmLeads" }
    ]);
  }

  md += `## 8. Cambios de estado (filtros / navegación)\n\n`;
  md += `_Total: ${r.stateChanges.length} eventos_\n\n`;
  md += _mdTable(r.stateChanges.slice(-40), [
    { key: "field", label: "Campo" },
    { key: "value", label: "Valor" },
    { key: "module", label: "Módulo" }
  ]);

  md += `## 9. Análisis (solo evidencia medida)\n\n`;
  const b = r.analysis.bottleneck;
  md += `- **Mayor cuello de botella:** ${b ? `\`${b.name}\` — ${b.totalMs} ms (${b.pctTotal}% del tiempo medido)` : "—"}\n`;
  md += `- **Mayor consumo CPU (long task):** ${r.summary.longTaskTotalMs} ms acumulados en ${r.summary.longTaskCount} tareas\n`;
  md += `- **Memoria máxima:** ${r.memory.max ?? "—"} MB\n`;
  md += `- **Más renderizados:** ${ra.mostFrequentRender?.name ?? "—"} (${ra.mostFrequentRender?.count ?? 0}×)\n`;
  md += `- **Más recorridos (data ops):** ${r.analysis.mostTraversals?.name ?? "—"} (${r.analysis.mostTraversals?.count ?? 0}×, ${r.analysis.mostTraversals?.avgRecords ?? "—"} reg. prom.)\n`;
  md += `- **getDashboardFilteredData:** ${r.summary.getDashboardFilteredDataCalls} llamadas\n\n`;

  md += `## 10. Plan de optimización (diagnóstico — NO implementado)\n\n`;
  for (const [i, item] of r.optimizationPlan.entries()) {
    md += `### ${i + 1}. ${item.title}\n\n`;
    md += `- Beneficio esperado: ${item.benefit}\n`;
    md += `- Riesgo: ${item.risk}\n`;
    md += `- Complejidad: ${item.complexity}\n`;
    md += `- Módulos: ${item.modules}\n`;
    md += `- Borrador/Publicar: ${item.compatibleDraftPublish}\n`;
    md += `- Prioridad: **${item.priority}**\n\n`;
  }

  md += `## Notas metodológicas\n\n`;
  md += `- Layout/paint: aproximación post-interacción vía doble \`requestAnimationFrame\`.\n`;
  md += `- CPU: \`PerformanceObserver\` longtask cuando el navegador lo soporta.\n`;
  md += `- \`renderDashboardFromFiltersNow\`: medido como interacción \`dashboard:filter-render\`.\n`;

  return md;
}

export function perfAuditPrintDefinitiveSummary() {
  const r = _fixRenderAnalysisTypo(_buildDefinitiveReport());
  console.group("[PERF AUDIT] Informe definitivo");
  console.log("Dataset:", r.dataset);
  console.table(r.mandatoryMetrics);
  console.table(r.top20);
  console.log("Memoria:", r.memory);
  console.groupEnd();
  return r;
}

export function perfAuditDownloadDefinitiveReport() {
  if (typeof document === "undefined") return;
  const md = perfAuditExportDefinitiveMarkdown();
  const json = perfAuditExportDefinitiveJson();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dl = (content, name, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  dl(md, `campatrack-auditoria-definitiva-${ts}.md`, "text/markdown");
  dl(json, `campatrack-auditoria-definitiva-${ts}.json`, "application/json");
}

/* Auto-init al importar */
perfAuditInit();
