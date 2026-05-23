import {
  appState,
  ensurePlanningDraftShape,
  ensureDataGeneralDraftShape,
  ensureRelacionesDraftShape,
  ensureRelacionesCrmDraftShape,
  ensureCrmLeadsDraftShape,
  ensureCampatrackUsersDraftShape,
  ensureAuditoriaDraftShape,
  getPlanningRecordIdSeq,
  setPlanningRecordIdSeq,
  bumpAppStatePendingChanges,
  resetAppStatePendingChanges,
  applyPlanningOriginalFromDraft,
  hydrateAppStateDraftFromApiBundle,
  initAppState,
  isRelacionPlataformaRow,
  sanitizeRelacionesDraftChannels
} from "./app-state.js";
import { syncCampatrackGithubAfterPublish } from "./github-backup.js";
import {
  buildGithubRawDataJsonUrl,
  hasClientGithubConfigComplete,
  loadClientGithubConfig,
  parseGithubRepoInput,
  saveClientGithubConfig,
  validateClientGithubConnection
} from "./campatrack-github-config.js";
import { campatrackShouldPersistKeyToDisk } from "./campatrack-persistence-policy.js";
import {
  createEmptyCampatrackBundle,
  loadModularBundleFromGithub,
  campatrackMonthKeyFromFecha,
  replaceCrmGithubSnapshotFromSerializedRows,
  partitionRowsByMonth
} from "./campatrack-data-store.js";
import {
  campatrackGateInit,
  campatrackGateRegisterModuleBoot,
  campatrackGateOnGithubConfigured,
  campatrackGateOnLogout,
  campatrackGateBeginDataLoad,
  campatrackGateOnDataReady,
  campatrackGateOnDataError,
  campatrackGateMaybeBootModules,
  campatrackGateIsReady
} from "./campatrack-app-gate.js";

/**
 * Debe cargarse solo como módulo ES (p. ej. `import "./_app.impl.js"` desde `app.js` con `type="module"`).
 * No añadir `export` de listado global: los stubs en `js/modules/` ya no re-exportan desde aquí.
 */

/** Tras validar credenciales en modo lite, evita un segundo GET del mismo bundle en `afterLoginSuccess`. */
let campatrackLiteLoginBundleCache = null;

/**
 * Tras publicar con éxito, sincroniza backup + data.json en GitHub sin bloquear la UI ni revertir el guardado local/API.
 * @param {object} dataCompletaReal bundle ya generado por `buildMemorySnapshotForPublish`
 * @param {{ username?: string }} user sesión CampaTrack
 */
function scheduleGithubSyncAfterSuccessfulPublish(dataCompletaReal, user) {
  try {
    const ghUser = String(user?.username || "admin").replace(/[^a-zA-Z0-9_-]/g, "_");
    void syncCampatrackGithubAfterPublish(dataCompletaReal, ghUser).catch((err) => {
      console.error("[GitHub] Error en backup o actualización (publicación local ya completada):", err);
    });
  } catch (e) {
    console.error("[GitHub] No se pudo programar sincronización:", e);
  }
}

/**
 * Almacén clave-valor persistente en `localStorage` (prefijo propio para no colisionar con otras claves del origen).
 * Tras el login, la data se hidrata con GET /api/data; los borradores locales sobreviven al cerrar el navegador hasta publicar o cerrar sesión.
 */
function createCampatrackPrefixedLocalStorageKV(prefix) {
  const pre = String(prefix);
  const memFallback = Object.create(null);
  const canUseLs =
    typeof window !== "undefined" &&
    typeof window.localStorage !== "undefined" &&
    window.localStorage != null;
  function lsGet(key) {
    if (!canUseLs) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function lsSet(key, val) {
    if (!canUseLs) return false;
    try {
      window.localStorage.setItem(key, val);
      return true;
    } catch {
      return false;
    }
  }
  function lsRemove(key) {
    if (!canUseLs) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  function lsKeysWithPrefix() {
    if (!canUseLs) return [];
    const out = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(pre)) out.push(k);
      }
    } catch {
      /* ignore */
    }
    return out;
  }
  return {
    getItem(k) {
      const key = String(k);
      const full = pre + key;
      const fromLs = lsGet(full);
      if (fromLs != null) return fromLs;
      return Object.prototype.hasOwnProperty.call(memFallback, key) ? memFallback[key] : null;
    },
    setItem(k, v) {
      const key = String(k);
      const full = pre + key;
      const str = String(v);
      if (!campatrackShouldPersistKeyToDisk(key)) {
        memFallback[key] = str;
        return;
      }
      if (lsSet(full, str)) {
        delete memFallback[key];
        return;
      }
      memFallback[key] = str;
    },
    removeItem(k) {
      const key = String(k);
      delete memFallback[key];
      lsRemove(pre + key);
    },
    clear() {
      for (const key of Object.keys(memFallback)) delete memFallback[key];
      for (const full of lsKeysWithPrefix()) lsRemove(full);
    }
  };
}

const CAMPATRACK_APP_KV_LS_PREFIX = "campatrack_kv_v1:";
const CAMPATRACK_APP_SESSION_LS_PREFIX = "campatrack_sess_v1:";

const appMemoryKV = createCampatrackPrefixedLocalStorageKV(CAMPATRACK_APP_KV_LS_PREFIX);

/** Sesión y flags de UI: persisten entre reinicios del navegador hasta logout manual. */
const appMemorySession = createCampatrackPrefixedLocalStorageKV(CAMPATRACK_APP_SESSION_LS_PREFIX);

/** JSON del último bundle aplicado tras publicar con éxito en la API (equivalente a `dataOriginal` serializado). */
let dataOriginalBundleJson = null;

function syncDataOriginalFromPublishedDraft(publishedSnapshot) {
  try {
    if (publishedSnapshot != null && typeof publishedSnapshot === "object" && !Array.isArray(publishedSnapshot)) {
      dataOriginalBundleJson = JSON.stringify(publishedSnapshot);
    } else {
      dataOriginalBundleJson = JSON.stringify(buildMemorySnapshotForPublish());
    }
  } catch (_) {
    dataOriginalBundleJson = null;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  /* Sin semilla desde data.json: la carga inicial ocurre tras login vía `cargarDataDesdeAPI`. */
});

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTHS_EN_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Claves de `distribucionMensual` por mes (índice 0 = ene … 11 = dic). */
const DIST_MES_KEYS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const newCampaignBtn = document.getElementById("newCampaignBtn");
const editRecordBtn = document.getElementById("editRecordBtn");
const deleteRecordBtn = document.getElementById("deleteRecordBtn");
const planningBody = document.getElementById("planningBody");
const campaignModal = document.getElementById("campaignModal");
const campaignForm = document.getElementById("campaignForm");
const cancelBtn = document.getElementById("cancelBtn");
const modalTitle = document.getElementById("modalTitle");
const previewBody = document.getElementById("previewBody");
const percentHint = document.getElementById("percentHint");
const cplTargetInput = document.getElementById("cplTarget");
const cplHistoricoHint = document.getElementById("cplHistoricoHint");
const programTypeSelect = document.getElementById("programType");
const programNameInput = document.getElementById("programName");
const programNameEditInput = document.getElementById("programNameEdit");
const programDropdown = document.getElementById("programDropdown");
const newProgramBtn = document.getElementById("newProgramBtn");
const formError = document.getElementById("formError");
const totalInversionValue = document.getElementById("totalInversionValue");
const filterTipo = document.getElementById("filterTipo");
const filterPrograma = document.getElementById("filterPrograma");
const filterProgramaList = document.getElementById("filterProgramaList");
const filterIntake = document.getElementById("filterIntake");
const trackingSelect = document.getElementById("tracking");
const plataformaSelect = document.getElementById("plataforma");
const intakeSelect = document.getElementById("intake");
const startDateInput = document.getElementById("startDate");
const endDateInput = document.getElementById("endDate");
const totalBudgetInput = document.getElementById("totalBudget");
const gastoDiarioInput = document.getElementById("gastoDiario");
const targetLeadsInput = document.getElementById("targetLeads");
const bitacoraTimelineList = document.getElementById("bitacoraTimelineList");
const bitacoraFiltroTipoSelect = document.getElementById("bitacoraFiltroTipo");
const bitacoraFiltroProgramaInput = document.getElementById("bitacoraFiltroPrograma");
const bitacoraFechaRangoInput = document.getElementById("bitacoraFechaRango");
const bitacoraLimpiarFiltrosBtn = document.getElementById("bitacoraLimpiarFiltrosBtn");
const bitacoraExportBtn = document.getElementById("bitacoraExportBtn");
const bitacoraOrdenSelect = document.getElementById("bitacoraOrdenSelect");
const bitacoraPageSizeSelect = document.getElementById("bitacoraPageSizeSelect");
const bitacoraPaginationInfo = document.getElementById("bitacoraPaginationInfo");
const bitacoraPaginationNav = document.getElementById("bitacoraPaginationNav");
const bitacoraFormFecha = document.getElementById("bitacoraFormFecha");
const bitacoraFormPrograma = document.getElementById("bitacoraFormPrograma");
const bitacoraFormTipo = document.getElementById("bitacoraFormTipo");
const bitacoraFormImpacto = document.getElementById("bitacoraFormImpacto");
const bitacoraFormCambios = document.getElementById("bitacoraFormCambios");
const bitacoraFormImportante = document.getElementById("bitacoraFormImportante");
const bitacoraFormCharCount = document.getElementById("bitacoraFormCharCount");
const bitacoraGuardarEntradaBtn = document.getElementById("bitacoraGuardarEntradaBtn");
const bitacoraGuardarEntradaLabel = document.getElementById("bitacoraGuardarEntradaLabel");
const bitacoraCancelarEdicionBtn = document.getElementById("bitacoraCancelarEdicionBtn");
const bitacoraFormModeLabel = document.getElementById("bitacoraFormModeLabel");
/** Rango del toolbar Planning (filtro por solape de fechas) */
let planningFechaRangoPicker = null;
let planningFilterFechaIni = "";
let planningFilterFechaFin = "";

/** Filas Planning: leer siempre con `planningDraftRecords()` (= `appState.dataDraft.planning.records`); evita alias obsoleto si el bundle sobrescribe `dataDraft.planning`. */
ensurePlanningDraftShape();
function planningDraftRecords() {
  return ensurePlanningDraftShape().records;
}
let selectedRecordId = null;
let editingRecordId = null;
const bitacoraData = [];
let bitacoraFechaRangoPicker = null;
let bitacoraEditingId = null;
let bitacoraPageIndex = 1;
const bitacoraFiltros = {
  tipo: "",
  programa: "",
  fechaInicio: "",
  fechaFin: ""
};
const BITACORA_CAMBIOS_MAX = 1000;

/** Catálogo dinámico persistido en `catalogos_sistema` (tipos, programas, tracking, plataformas, intakes). */
let catalogosSistema = {
  tipos: [],
  programas: [],
  tracking: [],
  plataformas: [],
  intakes: []
};

/** ID único por fila de planning (no usar nombre/programa como clave). */
function newPlanningRecordId() {
  return Date.now() + Math.random();
}

/** Comparación estable de ids (localStorage / DOM pueden mezclar número y string). */
function samePlanningRecordId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Asigna id a filas legacy y desduplica ids repetidos para que Editar resuelva siempre la fila correcta. */
function ensurePlanningRecordsHaveStableUniqueIds() {
  return ensurePlanningArrayStableUniqueIds(planningDraftRecords());
}
/** Fechas de referencia en edición (tras hidratar) para detectar cambio real de rango sin falsos positivos. */
let editCampaignBaselineDates = null;
let presupuestoManualMode = false;
/** Declarados pronto para que `syncCentroCostosYConsumoDesdePlanning` pueda ejecutarse tras hidratar datos. */
let dashboardUiInicializado = false;
let dashboardFiltrosInicializados = false;

/** Centros de costo (bolsas) — persistencia en localStorage `cc_data` */
const centrosCostos = [];
let centroCostoIdSeq = 1;
/** Fila de centro de costos seleccionada en la tabla principal (`data-cc-id`). */
let selectedCcRowId = null;
/** Consumo por campaña (planning record id) — `consumo_por_campaña` */
const consumoPorCampaña = {};

/** Por defecto aplazar escritura a localStorage hasta "Publicar" (evita sembrar LS obsoleto antes del login y GET /api/data). */
let appDeferredDiskPersistence = true;
let appPublishSnapshotBaselineJson = null;
let appPendingPublishCount = 0;
let appPublishModalBusy = false;
/** >0 mientras se refresca UI tras descartar/publicar: no contar persistencias programáticas como borrador. */
let appSuppressDraftNotifications = 0;

const DEFAULT_PROGRAMS = [
  { tipo: "MBA", nombre: "Administracion de Negocios" },
  { tipo: "MA", nombre: "Marketing Analitico" },
  { tipo: "DO", nombre: "Direccion de Operaciones" },
  { tipo: "DI", nombre: "Diseno de Innovacion" },
  { tipo: "PE", nombre: "Programa Ejecutivo Comercial" },
  { tipo: "SE", nombre: "Seminario Estrategico de Ventas" },
  { tipo: "Charla", nombre: "Charla" },
  { tipo: "Webinar", nombre: "Webinar" },
  { tipo: "Alcance", nombre: "Alcance" }
];

/** Tipos de convocatoria: no aplican restricciones de cruce de fechas entre intakes ni fecha mínima encadenada. */
function planningTipoSinRestriccionCruceFechas(tipo) {
  const t = String(tipo ?? "").trim();
  return t === "Charla" || t === "Webinar" || t === "Alcance";
}

/** Campañas de awareness: sin leads/CPL en formulario ni en distribución mensual de preview. */
function planningTipoAlcance(tipo) {
  return String(tipo ?? "").trim() === "Alcance";
}

/** Charla / Webinar: se permiten varias filas con la misma configuración si las fechas no se solapan. */
function planningTipoCharlaOWebinar(tipo) {
  const t = String(tipo ?? "").trim();
  return t === "Charla" || t === "Webinar";
}

/**
 * Misma combinación tipo + programa + intake + tracking + plataforma (Charla/Webinar)
 * y rangos de fechas que se cruzan.
 */
function hasCharlaWebinarMismaConfigSolapeFechas(candidate, excludeId = null) {
  if (!planningTipoCharlaOWebinar(candidate.tipo)) return false;
  return planningDraftRecords().some((r) => {
    if (excludeId != null && samePlanningRecordId(r.id, excludeId)) return false;
    if (r.tipo !== candidate.tipo) return false;
    if (r.programa !== candidate.programa) return false;
    if (r.intake !== candidate.intake) return false;
    if (r.tracking !== candidate.tracking) return false;
    if (r.plataforma !== candidate.plataforma) return false;
    return dateRangesOverlap(candidate.fechaInicio, candidate.fechaFin, r.fechaInicio, r.fechaFin);
  });
}

/** Ajusta visibilidad y comportamiento del modal de campaña cuando el tipo es Alcance. */
function updateCampaignFormAlcanceMode() {
  if (!campaignForm || !programTypeSelect) return;
  const tipo = String(programTypeSelect.value || "").trim();
  const isAlcance = planningTipoAlcance(tipo);
  const previewTable = document.querySelector("#campaignModal .preview-table");
  if (previewTable) previewTable.classList.toggle("preview-table--alcance", isAlcance);

  const cplLabel = document.getElementById("campaignCplTargetLabel");
  const leadsLabel = document.getElementById("campaignTargetLeadsLabel");
  if (cplLabel) cplLabel.classList.toggle("hidden", isAlcance);
  if (leadsLabel) leadsLabel.classList.toggle("hidden", isAlcance);

  if (cplTargetInput) {
    cplTargetInput.disabled = isAlcance;
    cplTargetInput.removeAttribute("required");
  }
  if (targetLeadsInput) {
    targetLeadsInput.disabled = isAlcance;
    if (isAlcance) targetLeadsInput.removeAttribute("required");
    else targetLeadsInput.setAttribute("required", "required");
  }

  if (isAlcance) {
    if (cplTargetInput) cplTargetInput.value = "0";
    if (targetLeadsInput) targetLeadsInput.value = "0";
    presupuestoManualMode = true;
    setPresupuestoInputReadonly(false);
  } else {
    presupuestoManualMode = false;
    setPresupuestoInputReadonly(true);
    syncPresupuestoFromLeadsCpl();
  }

  if (cplHistoricoHint) {
    cplHistoricoHint.classList.toggle("hidden", isAlcance);
    if (isAlcance) cplHistoricoHint.textContent = "";
  }
}

const programs = [];

function programKey(p) {
  return `${String(p.tipo)}||${String(p.nombre)}`.toLowerCase();
}

function resetProgramsFromDefaults() {
  programs.length = 0;
  DEFAULT_PROGRAMS.forEach((p) => programs.push({ tipo: p.tipo, nombre: p.nombre }));
}

function hydratarProgramas() {
  resetProgramsFromDefaults();
  try {
    const raw = appMemoryKV.getItem("programas");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const seen = new Set(programs.map(programKey));
        arr.forEach((p) => {
          if (!p || !p.tipo || !p.nombre) return;
          const k = programKey(p);
          if (seen.has(k)) return;
          seen.add(k);
          programs.push({ tipo: String(p.tipo).trim(), nombre: String(p.nombre).trim() });
        });
      }
    }
    const legacyRaw = appMemoryKV.getItem(LS_PLANNING_DATA) || appMemoryKV.getItem("planningData");
    if (legacyRaw) {
      const data = JSON.parse(legacyRaw);
      if (data && typeof data === "object" && Array.isArray(data.programs)) {
        const seen = new Set(programs.map(programKey));
        data.programs.forEach((p) => {
          if (!p || !p.tipo || !p.nombre) return;
          const k = programKey(p);
          if (seen.has(k)) return;
          seen.add(k);
          programs.push({ tipo: String(p.tipo).trim(), nombre: String(p.nombre).trim() });
        });
        persistProgramas();
      }
    }
  } catch (err) {
    console.warn("No se pudo cargar programas", err);
  }
}

function persistProgramas() {
  try {
    appMemoryKV.setItem("programas", JSON.stringify(programs));
  } catch (err) {
    console.warn("No se pudo guardar programas", err);
  }
  syncCatalogosSistemaDesdeMemoria();
  refreshPlanningCatalogUi();
  guardarDebounce();
}

const LS_CC_DATA = "cc_data";
const LS_PLANNING_DATA = "planning_data";
const LS_CONSUMO_CAMPANA = "consumo_por_campaña";
const LS_BITACORA_DATA = "bitacora_data";
const LS_CATALOGOS_SISTEMA = "catalogos_sistema";
/** Lista de equipos en memoria (catálogo fijo también en `ensureCampatrackTeamsSeed`). */
const LS_CAMPATRACK_TEAMS = "campatrack_teams_db";

/** Equipos canónicos: no existe equipo «general»; aislamiento estricto por `user.teamId` en sesión. */
const CAMPATRACK_TEAM_DEFINITIONS = [
  { id: "team_maestrias", nombre: "Posgrado Maestrías" },
  { id: "team_edex", nombre: "Posgrado EDEX" }
];

function campatrackCanonTeamDefinitions() {
  return CAMPATRACK_TEAM_DEFINITIONS;
}

function campatrackGetCanonTeamIds() {
  return CAMPATRACK_TEAM_DEFINITIONS.map((x) => x.id);
}

function campatrackIsCanonTeamId(id) {
  return campatrackGetCanonTeamIds().includes(String(id || "").trim());
}

/** `teams[]` desde borrador usuario; migra desde `teamId` suelto si hace falta. */
function campatrackNormalizeTeamsFromDraftRecord(rec) {
  if (!rec || typeof rec !== "object") return [];
  let list = [];
  if (Array.isArray(rec.teams)) {
    list = rec.teams.map((x) => String(x || "").trim()).filter(Boolean);
  }
  list = [...new Set(list)].filter(campatrackIsCanonTeamId);
  const legacy = rec.teamId != null ? String(rec.teamId).trim() : "";
  if (!list.length && legacy && campatrackIsCanonTeamId(legacy)) list = [legacy];
  return list;
}

/** Copia completa en memoria de planning (todos los equipos) para merge al persistir y borradores. */
let planningMergedRecordsCache = null;

/** Alinea la caché merge con `appState.dataDraft.planning` tras hidratar desde API. */
function syncPlanningMergedCacheFromAppStateDraft() {
  const removed = sanitizePlanningDuplicatesInDraftInPlace({ silent: true });
  if (removed > 0) {
    try {
      console.info(`[Planning] Eliminados ${removed} duplicado(s) estructural(es) tras hidratar el bundle.`);
    } catch (_) {
      /* ignore */
    }
  }
  planningMergedRecordsCache = ensurePlanningDraftShape().records.map((r) =>
    r && typeof r === "object" ? { ...r } : r
  );
  migratePlanningRowsTeamIds(planningMergedRecordsCache);
}

try {
  globalThis.__campatrackSyncPlanningAfterHydrate = syncPlanningMergedCacheFromAppStateDraft;
} catch (_) {
  /* ignore */
}
let dataAdsReportMergedCache = null;
let dataAnunciosMergedCache = null;
let modeloMergedCache = null;
let medidasMergedCache = null;
let campaniasUnicasMergedCache = null;

function getCampatrackStoredTeams() {
  try {
    const raw = appMemoryKV.getItem(LS_CAMPATRACK_TEAMS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveCampatrackStoredTeams(list) {
  try {
    appMemoryKV.setItem(LS_CAMPATRACK_TEAMS, JSON.stringify(Array.isArray(list) ? list : []));
  } catch (e) {
    console.warn("No se pudo guardar equipos", e);
  }
}

function ensureCampatrackTeamsSeed() {
  const snap = JSON.stringify(CAMPATRACK_TEAM_DEFINITIONS);
  try {
    if (JSON.stringify(getCampatrackStoredTeams()) !== snap) {
      saveCampatrackStoredTeams(JSON.parse(JSON.stringify(CAMPATRACK_TEAM_DEFINITIONS)));
    }
  } catch (_) {
    saveCampatrackStoredTeams(JSON.parse(JSON.stringify(CAMPATRACK_TEAM_DEFINITIONS)));
  }
  return getCampatrackStoredTeams();
}

function resolveCampatrackTeamNombre(teamId) {
  const id = String(teamId || "").trim();
  if (!id) return "";
  const t = getCampatrackStoredTeams().find((x) => String(x?.id) === id);
  return String(t?.nombre || "").trim();
}

/**
 * Normaliza id de equipo canónico o etiqueta desde el catálogo.
 * IDs desconocidos se devuelven tal cual (datos huérfanos no cruzan con sesión válida).
 */
function resolveCampatrackTeamId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  ensureCampatrackTeamsSeed();
  const list = getCampatrackStoredTeams();
  if (list.some((t) => String(t?.id) === s)) return s;
  const byNombre = list.find((t) => String(t?.nombre || "").trim().toLowerCase() === s.toLowerCase());
  if (byNombre) return String(byNombre.id);
  return campatrackIsCanonTeamId(s) ? s : s;
}

/**
 * Equipo activo = sesión (`user.teamId` elegido en login). Sin sesión válida cadena vacía.
 */
function getCurrentTeamId() {
  try {
    const u = getUser();
    const tid = u && u.teamId != null ? String(u.teamId).trim() : "";
    if (tid) return resolveCampatrackTeamId(tid) || tid;
  } catch (_) {
    /* ignore */
  }
  return "";
}

function normalizeRowTeamId(row) {
  const v = row && row.teamId != null ? String(row.teamId).trim() : "";
  if (!v) return "";
  return resolveLegacyGeneralTeamIdForSession(v);
}

function resolveLegacyGeneralTeamIdForSession(rawTeamId, sessionTeamId = getCurrentTeamId()) {
  const raw = String(rawTeamId ?? "").trim();
  if (!raw) return "";
  const resolved = resolveCampatrackTeamId(raw) || raw;
  if (resolved === "team_general") {
    const current = String(sessionTeamId ?? "").trim();
    return current || resolved;
  }
  return resolved;
}

function rowBelongsToCurrentTeam(row) {
  const ct = String(getCurrentTeamId()).trim();
  if (!ct) return false;
  return rowBelongsToTeam(row, ct);
}

function rowBelongsToTeam(row, teamId) {
  const ct = String(teamId ?? "").trim();
  if (!ct) return false;
  const rt = String(normalizeRowTeamId(row)).trim();
  if (!rt) return false;
  return rt === ct;
}

/** Campaña cuyo centro de costo debe materializarse desde el JSON del Planning (`centroCosto` / `centroCostoId`, etc.). */
function planningRecordRelevantForCentroImport(rec) {
  if (!rec) return false;
  const sessionTeam = String(getCurrentTeamId() || "").trim();
  if (!sessionTeam) return !String(normalizeRowTeamId(rec)).trim();
  if (rowBelongsToCurrentTeam(rec)) return true;
  return !String(normalizeRowTeamId(rec)).trim();
}

/** Filas del borrador que deben fusionarse en el cache publicado: equipo de sesión + filas sin teamId (se estampan al publicar). */
function planningDraftRowsForPlanningMerge() {
  const draft = planningDraftRecords();
  const ct = String(getCurrentTeamId() || "").trim();
  if (!ct) return draft.slice();
  return draft.filter((r) => {
    const rt = normalizeRowTeamId(r);
    if (!rt) return true;
    return rowBelongsToCurrentTeam(r);
  });
}

/** Misma partición que `campaign_data.user_id` en API: `teamId` canónico; si falta, username (legado). */
function campatrackCampaignDataPartitionKeyFromUserLike(userLike) {
  const u =
    userLike != null && typeof userLike === "object"
      ? userLike
      : typeof getUser === "function"
        ? getUser()
        : null;
  if (!u || typeof u !== "object") return "";
  const tidRaw = String(u.teamId ?? "").trim();
  if (tidRaw) {
    const canon =
      typeof resolveCampatrackTeamId === "function"
        ? resolveCampatrackTeamId(tidRaw)
        : "";
    return canon || tidRaw;
  }
  return String(u.username ?? "").trim();
}

function mergeRowsByTeamId(fullBase, memoryRows, teamId, getTeamIdFromRow) {
  const tid = String(teamId);
  const base = Array.isArray(fullBase) ? fullBase : [];
  const others = base.filter((r) => String(getTeamIdFromRow(r)) !== tid);
  const stamped = (memoryRows || []).map((r) => {
    const tr = typeof r === "object" && r ? { ...r } : r;
    if (tr && typeof tr === "object") tr.teamId = tid;
    return tr;
  });
  return others.concat(stamped);
}

/**
 * Llave estable para comparar “misma configuración” de campaña (sin fechas): tipo · programa · plataforma · intake · tracking.
 */
function planningStructuralKey(record) {
  if (!record || typeof record !== "object") return "";
  const parts = [
    String(record.tipo ?? "").trim().toLowerCase(),
    String(record.programa ?? "").trim().toLowerCase(),
    String(record.plataforma ?? "").trim().toLowerCase(),
    String(record.intake ?? "").trim().toLowerCase(),
    String(record.tracking ?? "").trim().toLowerCase()
  ];
  return parts.join("\u241e");
}

/** Identidad completa típico “duplicado real” (config + vigencia ISO). */
function planningExactFingerprint(record) {
  if (!record || typeof record !== "object") return "";
  return (
    `${planningStructuralKey(record)}\u241e${String(record.fechaInicio ?? "").trim()}\u241e${String(record.fechaFin ?? "").trim()}`
  );
}

function planningMergedRowDedupeScore(record, sessionTeamId) {
  let sc = 0;
  const tid = String(sessionTeamId || "").trim();
  const rt = String(normalizeRowTeamId(record) || "").trim();
  if (tid && rt === tid) sc += 1_000_000;
  else if (!rt) sc += 50_000;
  else sc += 10_000;
  const p = Number(record?.presupuesto) || 0;
  sc += Math.min(p, 1e12) / 1e6;
  const idNum = Number(record?.id);
  if (Number.isFinite(idNum)) sc += idNum / (Number.MAX_SAFE_INTEGER / 1000);
  return sc;
}

/**
 * Elimina filas repetidas tras merges defectuosos: mismo id, o mismo huella exacta (config + fechas).
 * Conserva preferentemente la fila con equipo de sesión, presupuesto y datos más informados.
 * @returns {typeof planningDraftRecords()}
 */
function sanitizeStructuralDuplicatePlanningRows(records, sessionTeamId) {
  const raw = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];
  if (!raw.length) return [];

  const list = raw.map((r) => ({ ...r }));
  list.sort(
    (a, b) => planningMergedRowDedupeScore(b, sessionTeamId) - planningMergedRowDedupeScore(a, sessionTeamId)
  );

  const seenFp = new Set();
  const seenId = new Set();
  const out = [];
  for (const r of list) {
    const sk = planningStructuralKey(r);
    if (!sk) continue;
    const fp = planningExactFingerprint(r);
    const rid = r.id != null ? String(r.id).trim() : "";
    if (rid && seenId.has(rid)) continue;
    if (seenFp.has(fp)) continue;
    if (rid) seenId.add(rid);
    seenFp.add(fp);
    out.push(r);
  }

  /** Reindexar unicidad estable de ids (conserva valores únicos, re-emite colisionados). */
  ensurePlanningArrayStableUniqueIds(out);
  return out;
}

/**
 * Fusion Planning: reemplazo atómico de la partición del equipo en curso + fichas nuevas/desde servidor,
 * eliminando filas huérfanas sin teamId que el merge genérico dejaba coexistiendo con la misma campaña ya asignada a equipo (duplicados visibles).
 *
 * Conserva todas las demás particiones intactas en `fullBase`.
 */
function mergePlanningDraftIntoMergeCache(fullBase, draftRowsForSession, sessionTeamId) {
  const tid = String(sessionTeamId || "").trim();
  const base = Array.isArray(fullBase) ? fullBase : [];
  const mem = Array.isArray(draftRowsForSession) ? draftRowsForSession : [];

  const stamped = mem.map((r) => {
    const tr = r && typeof r === "object" ? { ...r } : r;
    if (tr && typeof tr === "object" && tid) tr.teamId = tid;
    return tr;
  });

  const draftIds = new Set(
    stamped.map((r) => (r && r.id != null ? String(r.id).trim() : "")).filter(Boolean)
  );

  const keptBase = [];
  for (const r of base) {
    if (!r || typeof r !== "object") continue;
    const rid = r.id != null ? String(r.id).trim() : "";
    const rt = String(normalizeRowTeamId(r) || "").trim();
    if (rid && draftIds.has(rid)) continue;
    if (tid && rt === tid) continue;
    keptBase.push(r);
  }

  return sanitizeStructuralDuplicatePlanningRows(keptBase.concat(stamped), tid || getCurrentTeamId());
}

/** Devuelve filas saneadas dentro del borrador Planning y cuenta eliminaciones. */
function sanitizePlanningDuplicatesInDraftInPlace(opts = {}) {
  const silent = opts.silent === true;
  const tid = String(getCurrentTeamId() || "").trim();
  const draft = ensurePlanningDraftShape().records;
  const before = draft.length;
  const next = sanitizeStructuralDuplicatePlanningRows(draft.slice(), tid);
  const removed = Math.max(0, before - next.length);
  if (removed && !silent) {
    registrarAuditoria({
      modulo: "planning",
      accion: "editar",
      campo: "sanitize_duplicados_planning",
      valorAnterior: { filasAntes: before },
      valorNuevo: { filasDespues: next.length, eliminadas: removed },
      descripcion: `Limpieza de duplicados estructural en Planning (draft): ${removed} fila(s) eliminada(s).`
    });
  }
  draft.length = 0;
  next.forEach((row) => draft.push(row));
  return removed;
}

async function confirmSanitizePlanningDuplicatesFromToolbar() {
  const cur = ensurePlanningDraftShape().records.map((r) => (typeof r === "object" ? { ...r } : r));
  const tid = String(getCurrentTeamId() || "").trim();
  const sanitized = sanitizeStructuralDuplicatePlanningRows(cur, tid);
  const removed = Math.max(0, cur.length - sanitized.length);
  if (removed <= 0) {
    showCampatrackToast("No se encontraron duplicados estructuralmente idénticos en el borrador.", "info");
    return;
  }
  const okExtra = await showAppDialog({
    message:
      `Se pueden eliminar ${removed} fila(s) redundantes:\n• misma combinación tipo · programa · plataforma · intake · tracking\n• mismas fechas inicio/fin ISO\n• o mismo id repetido por merges antiguos\n\n` +
      `Se conservará la copia mejor priorizada (equipo de sesión, presupuesto e id).\n¿Aplicar en el borrador y quedar listo para Publicar?`,
    primaryText: "Sí, limpiar duplicados",
    secondaryText: "Cancelar",
    showSecondary: true
  });
  if (!okExtra) return;
  sanitizePlanningDuplicatesInDraftInPlace({ silent: false });
  rebuildPlanningTable();
  persistPlanningData();
  showCampatrackToast(
    `Se eliminaron ${removed} duplicado(s) en Planning. Quedan en el borrador hasta Publicar.`,
    "success"
  );
}

function readParsedPlanningPayloadFromDisk() {
  try {
    const raw = appMemoryKV.getItem("planning") || appMemoryKV.getItem(LS_PLANNING_DATA) || appMemoryKV.getItem("planningData");
    if (!raw) return { rows: [], recordIdSeq: 1 };
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { rows: data, recordIdSeq: null };
    if (data && typeof data === "object" && Array.isArray(data.records)) {
      return { rows: data.records, recordIdSeq: data.recordIdSeq };
    }
  } catch (err) {
    console.warn("readParsedPlanningPayloadFromDisk", err);
  }
  return { rows: [], recordIdSeq: 1 };
}

function migratePlanningRowsTeamIds(allRows) {
  let changed = false;
  const sessionTeamId = getCurrentTeamId();
  for (const r of allRows) {
    if (!r || typeof r !== "object") continue;
    const raw = r.teamId == null ? "" : String(r.teamId).trim();
    if (!raw) continue;
    const next = resolveLegacyGeneralTeamIdForSession(raw, sessionTeamId);
    if (String(r.teamId).trim() !== next) {
      r.teamId = next;
      changed = true;
    }
  }
  return changed;
}

function migrateMissingTeamIdOnRows(arr) {
  let changed = false;
  const sessionTeamId = getCurrentTeamId();
  for (const r of arr || []) {
    if (!r || typeof r !== "object") continue;
    const raw = r.teamId == null ? "" : String(r.teamId).trim();
    if (!raw) continue;
    const next = resolveLegacyGeneralTeamIdForSession(raw, sessionTeamId);
    if (String(r.teamId).trim() !== next) {
      r.teamId = next;
      changed = true;
    }
  }
  return changed;
}

function ensurePlanningArrayStableUniqueIds(arr) {
  let changed = false;
  const seen = new Set();
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const key = r.id == null || r.id === "" ? "" : String(r.id);
    const invalid = !key || key === "undefined" || key === "null" || seen.has(key);
    if (invalid) {
      let nid;
      do {
        nid = newPlanningRecordId();
      } while (seen.has(String(nid)));
      r.id = nid;
      seen.add(String(nid));
      changed = true;
    } else {
      seen.add(key);
    }
  }
  return changed;
}

function recomputePlanningMergedCacheFromRecords() {
  const tid = getCurrentTeamId();
  const base =
    Array.isArray(planningMergedRecordsCache) && planningMergedRecordsCache.length > 0
      ? planningMergedRecordsCache.slice()
      : readParsedPlanningPayloadFromDisk().rows;
  planningMergedRecordsCache = mergePlanningDraftIntoMergeCache(
    base,
    planningDraftRowsForPlanningMerge(),
    tid
  );
}

function reloadPlanningWorkingSliceFromCache() {
  const draft = ensurePlanningDraftShape();
  let src = Array.isArray(planningMergedRecordsCache) && planningMergedRecordsCache.length
    ? planningMergedRecordsCache.slice()
    : [];
  if (!src.length && Array.isArray(draft.records) && draft.records.length) {
    syncPlanningMergedCacheFromAppStateDraft();
    src = Array.isArray(planningMergedRecordsCache) ? planningMergedRecordsCache.slice() : [];
  }
  draft.records.length = 0;
  src.forEach((r) => {
    if (rowBelongsToCurrentTeam(r)) draft.records.push(r && typeof r === "object" ? { ...r } : r);
  });
  const maxId = draft.records.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  if (Number.isFinite(Number(getPlanningRecordIdSeq()))) {
    setPlanningRecordIdSeq(Math.max(1, Math.round(Number(getPlanningRecordIdSeq())), maxId + 1));
  } else if (maxId) {
    setPlanningRecordIdSeq(maxId + 1);
  }
}

function writePlanningPayloadToLocalStorage(mergedRows, seq) {
  const payload = { records: mergedRows, recordIdSeq: seq };
  try {
    appMemoryKV.setItem(LS_PLANNING_DATA, JSON.stringify(payload));
    appMemoryKV.setItem("planning", JSON.stringify(mergedRows));
  } catch (err) {
    console.warn("No se pudo guardar planning_data", err);
  }
}

function readFullConsumoFromDisk() {
  try {
    const raw = appMemoryKV.getItem(LS_CONSUMO_CAMPANA);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function getPlanningRowByIdFromMergedCache(id) {
  const key = String(id);
  const merged = Array.isArray(planningMergedRecordsCache) ? planningMergedRecordsCache : [];
  const fromMerged = merged.find((r) => r && samePlanningRecordId(r.id, key));
  if (fromMerged) return fromMerged;
  return ensurePlanningDraftShape().records.find((r) => r && samePlanningRecordId(r.id, key)) || null;
}

function mergeConsumoForPersist() {
  /* `consumo_por_campaña` ya no forma parte del bundle publicado (se deriva del Planning).
   * Se mantiene el objeto memoria solo por compatibilidad con código legacy que lo leyera. */
  syncConsumoFromRecords();
  return {};
}
const BITACORA_TIPO_OPTIONS = ["MA", "SE", "PE", "MBA", "DI", "DO", "Charla", "Webinar", "Alcance"];

/** Semillas alineadas con opciones base del HTML (planning); el catálogo en localStorage las amplía con el uso. */
const CATALOGO_SEMILLA_TIPOS = ["MBA", "MA", "DO", "DI", "PE", "SE", "Charla", "Webinar", "Alcance"];
const CATALOGO_SEMILLA_TRACKING = ["Leadgen", "Pixel", "Google"];
const CATALOGO_SEMILLA_PLATAFORMAS = ["Meta", "Google", "TikTok", "LinkedIn"];
const CATALOGO_SEMILLA_INTAKES = ["Intake 1", "Intake 2", "Intake 3", "Intake 4"];

/** CC, bitácora y modelo en `appState.dataDraft` (misma idea que planning); no appMemoryKV. */
function syncCcBitacoraModeloDraftFromRuntime() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  appState.dataDraft.cc_data = {
    centros: JSON.parse(JSON.stringify(centrosCostos)),
    seq: centroCostoIdSeq
  };
  appState.dataDraft.bitacora_data = JSON.parse(JSON.stringify(bitacoraData));
  const modeloSer = serializeModelo(modeloMergedCache || modeloAnalitico);
  appState.dataDraft.modelo = modeloSer;
  appState.dataDraft.modeloAnalitico = modeloSer;
  appState.dataDraft.campatrack_users_db = JSON.parse(JSON.stringify(ensureCampatrackUsersDraftShape()));
  appState.dataDraft.auditoria = JSON.parse(JSON.stringify(ensureAuditoriaDraftShape()));
}

function applyCcBitacoraModeloRuntimeFromDraftOrBundle(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  if (source.cc_data && typeof source.cc_data === "object" && Array.isArray(source.cc_data.centros)) {
    centrosCostos.length = 0;
    source.cc_data.centros.forEach((r) => centrosCostos.push(normalizeCentroCostoRow(r)));
    if (Number.isFinite(Number(source.cc_data.seq)))
      centroCostoIdSeq = Math.max(1, Math.round(Number(source.cc_data.seq)));
    let maxN = 0;
    centrosCostos.forEach((r) => {
      const m = String(r.id).match(/^cc_(\d+)$/i);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    centroCostoIdSeq = Math.max(centroCostoIdSeq, maxN + 1);
  }
  if (Array.isArray(source.bitacora_data)) {
    bitacoraData.length = 0;
    const rows = source.bitacora_data.map((r) => normalizeBitacoraRow(r));
    sortBitacoraRowsNewestFirst(rows);
    rows.forEach((r) => bitacoraData.push(r));
  }
  const modeloSerArr = Array.isArray(source.modeloAnalitico)
    ? source.modeloAnalitico
    : Array.isArray(source.modelo)
      ? source.modelo
      : null;
  if (modeloSerArr) {
    const rows = deserializeModelo(modeloSerArr);
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) modeloMergedCache = rows;
    else {
      const base = Array.isArray(modeloMergedCache) && modeloMergedCache.length ? modeloMergedCache : readFullModeloFromLegacyStorage();
      modeloMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    modeloAnalitico = modeloMergedCache.filter(rowBelongsToCurrentTeam);
  }
}

function syncCcBitacoraModeloRuntimeFromDataDraftAfterHydrate() {
  applyCcBitacoraModeloRuntimeFromDraftOrBundle(appState.dataDraft);
}

try {
  globalThis.__campatrackSyncCcBitacoraModeloAfterHydrate = syncCcBitacoraModeloRuntimeFromDataDraftAfterHydrate;
} catch (_) {
  /* ignore */
}

function persistCentrosCostos() {
  syncCcBitacoraModeloDraftFromRuntime();
  if (!shouldDeferDiskPersistence()) {
    guardarTodo({ incluirTablasData: false });
    guardarDebounce();
  }
  registerUnpublishedDraftMutation();
}

function persistConsumoPorCampaña() {
  syncConsumoFromRecords();
}

function hydratarCentrosCostos() {
  try {
    const fromDraft = appState.dataDraft?.cc_data;
    centrosCostos.length = 0;
    if (fromDraft && typeof fromDraft === "object" && Array.isArray(fromDraft.centros)) {
      fromDraft.centros.forEach((r) => {
        if (r && r.id != null) centrosCostos.push(normalizeCentroCostoRow(r));
      });
      if (Number.isFinite(Number(fromDraft.seq))) centroCostoIdSeq = Math.max(centroCostoIdSeq, Number(fromDraft.seq));
      let maxN = 0;
      centrosCostos.forEach((r) => {
        const m = String(r.id).match(/^cc_(\d+)$/i);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      });
      centroCostoIdSeq = Math.max(centroCostoIdSeq, maxN + 1);
    }
  } catch (err) {
    console.warn("No se pudo cargar cc_data desde el borrador", err);
  }
}

/**
 * Centro de costo persistido en `cc_data`: solo identidad, nombre visible y techo manual.
 * (Campos legacy `agrupador` / `nombreProyecto` se migran a `nombre`.)
 */
function normalizeCentroCostoRow(r) {
  const tidRaw = r?.teamId != null ? String(r.teamId).trim() : "";
  const teamId = tidRaw ? resolveCampatrackTeamId(tidRaw) || tidRaw : "";
  const nombreLegacy = String(r.nombre ?? r.agrupador ?? "").trim();
  const nombreExtra = String(r.nombreProyecto ?? "").trim();
  const nombre = nombreLegacy || nombreExtra || "";
  return {
    id: String(r.id),
    nombre,
    inversionTotal: Math.max(0, Number(r.inversionTotal) || 0),
    teamId
  };
}

function getCentroCostoDisplayName(cc) {
  if (!cc) return "";
  const n = String(cc.nombre ?? cc.agrupador ?? "").trim();
  return n || String(cc.id || "").trim();
}

function getCentroCostoKey(cc) {
  return getCentroCostoDisplayName(cc);
}

function resolveCentroCostoByValue(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const byId = centrosCostos.find((c) => String(c.id) === v);
  if (byId) return byId;
  const vl = v.toLowerCase();
  return (
    centrosCostos.find((c) => String(c.nombre || c.agrupador || "").trim().toLowerCase() === vl) || null
  );
}

/** Valor persistido en Planning (`centroCosto` / `centroCostoId`): siempre id estable del centro. */
function normalizeCentroCostoSelectionValue(value) {
  const cc = resolveCentroCostoByValue(value);
  return cc ? String(cc.id) : String(value ?? "").trim();
}

function planningRecordCentroRefRaw(record) {
  if (!record) return "";
  const legacy = record.centro_costo ?? record.CentroCosto ?? record.centroCostoNombre;
  const a = record.centroCosto ?? legacy;
  const b = record.centroCostoId ?? record.centroCostoID;
  const s =
    a !== undefined && a !== null && String(a).trim() !== ""
      ? String(a).trim()
      : String(b ?? "").trim();
  return s;
}

function planningRecordCanonicalCentroId(record) {
  const raw = planningRecordCentroRefRaw(record);
  if (!raw) return "";
  const cc = resolveCentroCostoByValue(raw);
  return cc ? String(cc.id) : "";
}

function recordUsesCentroCostoRow(record, cc) {
  if (!record || !cc) return false;
  return planningRecordCanonicalCentroId(record) === String(cc.id);
}

function getRecordsLinkedToCentroCostoRow(cc) {
  return planningDraftRecords().filter((r) => recordUsesCentroCostoRow(r, cc));
}

/** Nombre por defecto al crear una bolsa materializada desde referencias solo en Planning. */
function deriveNombreCentroImportadoDesdePlanning(rawRef, idCanon) {
  const raw = String(rawRef || "").trim();
  const id = String(idCanon || "").trim();
  if (/^cc_\d+$/i.test(id) && (!raw || raw === id)) return id;
  if (raw && raw.localeCompare(id, undefined, { sensitivity: "accent" }) !== 0) return raw;
  return id || raw || "Centro de costo";
}

/**
 * Crea filas en `cc_data` leyendo el centro elegido en cada campaña del Planning (JSON:
 * `centroCosto`, `centroCostoId`, o claves legacy como `centro_costo`), cuando aún no hay bolsa local.
 * `inversionTotal` queda 0 hasta que lo edites; el uso se deriva del Planning.
 * @returns {number} Cuántos centros nuevos se añadieron.
 */
function ensureCentrosCostosRowsFromPlanningAssignments() {
  const sessionTeam = String(getCurrentTeamId() || "").trim();

  /** @type {Set<string>} */
  const provisional = new Set();
  let added = 0;

  planningDraftRecords()
    .filter((r) => planningRecordRelevantForCentroImport(r))
    .forEach((rec) => {
      const raw = planningRecordCentroRefRaw(rec);
      const v = String(raw || "").trim();
      if (!v) return;
      if (resolveCentroCostoByValue(v)) return;

      const id = String(normalizeCentroCostoSelectionValue(v) || v).trim();
      if (!id) return;
      if (provisional.has(id)) return;
      if (centrosCostos.some((c) => String(c.id) === id)) return;

      const teamRow = String(normalizeRowTeamId(rec) || sessionTeam).trim();
      const tid = resolveCampatrackTeamId(teamRow) || teamRow || sessionTeam;

      centrosCostos.push(
        normalizeCentroCostoRow({
          id,
          nombre: deriveNombreCentroImportadoDesdePlanning(v, id),
          inversionTotal: 0,
          teamId: tid
        })
      );
      provisional.add(id);
      added += 1;
    });

  if (added > 0) {
    let maxN = 0;
    centrosCostos.forEach((r) => {
      const m = String(r.id).match(/^cc_(\d+)$/i);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    if (maxN > 0) centroCostoIdSeq = Math.max(centroCostoIdSeq, maxN + 1);
    persistCentrosCostos();
  }
  return added;
}

/**
 * Inversión atribuible a una campaña del Planning para consumo de centro de costo:
 * suma de inversión mensual (misma fuente que la tabla / `distribucionMensual`).
 * - Con distribución mensual guardada: suma de los 12 meses.
 * - Un solo año natural en el rango: suma de los meses calculados para ese año.
 * - Varios años sin DM persistida: `presupuesto` total (evita doble conteo al repartir el mismo total por año).
 */
function getPlanningRecordConsumedInvestment(rec) {
  if (!rec) return 0;
  const fromDm = monthlyArraysFromDistribucionMensual(rec.distribucionMensual);
  if (fromDm) {
    return fromDm.monthlyInvestment.reduce((a, v) => a + (Number(v) || 0), 0);
  }
  const s = parseDateInput(rec.fechaInicio);
  const e = parseDateInput(rec.fechaFin);
  if (!s || !e) return Math.max(0, Number(rec.presupuesto) || 0);
  const y0 = s.getFullYear();
  const y1 = e.getFullYear();
  if (y0 === y1) {
    const { monthlyInvestment } = computeMonthlyArraysForRecordWithOverrides(rec, y0);
    return monthlyInvestment.reduce((a, v) => a + (Number(v) || 0), 0);
  }
  return Math.max(0, Number(rec.presupuesto) || 0);
}

function getUsedInversionCentro(centroId, excludeRecordId = null) {
  const cid = normalizeCentroCostoSelectionValue(centroId);
  if (!cid) return 0;
  return planningDraftRecords().reduce((sum, r) => {
    if (excludeRecordId != null && samePlanningRecordId(r.id, excludeRecordId)) return sum;
    if (planningRecordCanonicalCentroId(r) !== cid) return sum;
    return sum + getPlanningRecordConsumedInvestment(r);
  }, 0);
}

function getSaldoDisponibleCentro(centroId, excludeRecordId = null) {
  const cc = resolveCentroCostoByValue(centroId);
  if (!cc) return 0;
  const total = Number(cc.inversionTotal) || 0;
  return Math.max(0, total - getUsedInversionCentro(cc.id, excludeRecordId));
}

function validateCentroCostoPresupuesto(ccId, budget, excludeRecordId) {
  if (!ccId) return true;
  if (!resolveCentroCostoByValue(ccId)) {
    showFormError("Centro de costo no válido.");
    return false;
  }
  const saldo = getSaldoDisponibleCentro(ccId, excludeRecordId);
  const b = Number(budget) || 0;
  if (b > saldo + 0.005) {
    showFormError(
      `El presupuesto supera el saldo disponible del centro de costo (${formatMoney(saldo) || "$0"}).`
    );
    return false;
  }
  return true;
}

/**
 * Reconstruye `consumoPorCampaña` desde `records`: cada campaña con CC asigna
 * `porAno[yyyy][mes]` con la inversión mensual de `distribucionMensual` (o equivalente).
 * Un cambio de centro en una campaña equivale a dejar de contar esos importes en el CC
 * anterior y contarlos en el nuevo, sin duplicar filas de planning.
 */
function syncConsumoFromRecords() {
  Object.keys(consumoPorCampaña).forEach((k) => {
    delete consumoPorCampaña[k];
  });
  planningDraftRecords().forEach((rec) => {
    const ccKey = planningRecordCanonicalCentroId(rec);
    if (!ccKey) return;
    const s = parseDateInput(rec.fechaInicio);
    const e = parseDateInput(rec.fechaFin);
    if (!s || !e) return;
    const porAno = {};
    for (let y = s.getFullYear(); y <= e.getFullYear(); y += 1) {
      const { monthlyInvestment } = computeMonthlyArraysForRecordWithOverrides(rec, y);
      porAno[String(y)] = monthlyInvestment.map((v) => Number(v) || 0);
    }
    consumoPorCampaña[String(rec.id)] = {
      centroCostoId: ccKey,
      presupuestoTotal: getPlanningRecordConsumedInvestment(rec),
      porAno
    };
  });
}

function planningRecordOverlapsYmdRange(rangeStart, rangeEnd, desdeStr, hastaStr) {
  const ds = desdeStr ? parseDateInput(desdeStr) : null;
  const de = hastaStr ? parseDateInput(hastaStr) : null;
  if (ds && rangeEnd < ds) return false;
  if (de && rangeStart > de) return false;
  return true;
}

/** Días calendario inclusivos entre dos límites (medianoche normalizada mediodía estable). */
function countInclusiveCalendarDays(rangeStart, rangeEnd) {
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) return 0;
  const rs = new Date(
    rangeStart.getFullYear(),
    rangeStart.getMonth(),
    rangeStart.getDate(),
    12,
    0,
    0
  );
  const re = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 12, 0, 0);
  return Math.floor((re - rs) / 86400000) + 1;
}

/**
 * Reparte lo que cuenta como gasto contra el centro (`getPlanningRecordConsumedInvestment`)
 * en las 12 columnas Ene–Dic del UI (métricas de años distintos se suman por mes de calendario).
 *
 * Opcionalmente recorta por `desde/hasta`; el importe se escala proporcionalmente a los días
 * de campaña contenidos en el recorte, para que Σ columnas coincida con el gasto reconocido
 * del periodo sobre esa campaña.
 *
 * @returns {number[]|null} 12 valores o null si fuera del alcance
 */
function allocatePlanningRecordConsumptionToCalendarMonthColumns(rec, desdeStr, hastaStr) {
  const s = parseDateInput(rec.fechaInicio);
  const e = parseDateInput(rec.fechaFin);
  if (!s || !e || s > e) {
    const desdeTrim0 = String(desdeStr || "").trim();
    const hastaTrim0 = String(hastaStr || "").trim();
    if (desdeTrim0 || hastaTrim0) return null;
    const tc = getPlanningRecordConsumedInvestment(rec);
    return tc > 0 ? distributeBudget(tc, Array.from({ length: 12 }, () => 1)) : null;
  }
  const desdeTrim = String(desdeStr || "").trim();
  const hastaTrim = String(hastaStr || "").trim();
  if (!planningRecordOverlapsYmdRange(s, e, desdeTrim, hastaTrim)) return null;

  let segStart = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 12, 0, 0);
  let segEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 12, 0, 0);
  const ds = desdeTrim ? parseDateInput(desdeTrim) : null;
  const de = hastaTrim ? parseDateInput(hastaTrim) : null;
  if (ds) {
    const clipped = new Date(ds.getFullYear(), ds.getMonth(), ds.getDate(), 12, 0, 0);
    if (segStart < clipped) segStart = clipped;
  }
  if (de) {
    const clipe = new Date(de.getFullYear(), de.getMonth(), de.getDate(), 12, 0, 0);
    if (segEnd > clipe) segEnd = clipe;
  }
  if (segStart > segEnd) return null;

  const totalCons = getPlanningRecordConsumedInvestment(rec);
  const fullDays = countInclusiveCalendarDays(s, e);
  const clipDays = countInclusiveCalendarDays(segStart, segEnd);
  if (fullDays <= 0 || clipDays <= 0) return Array.from({ length: 12 }, () => 0);
  const pool =
    hastaTrim || desdeTrim
      ? Math.max(0, totalCons) * (clipDays / fullDays)
      : Math.max(0, totalCons);
  if (pool <= 0) return Array.from({ length: 12 }, () => 0);

  const weights = Array.from({ length: 12 }, () => 0);
  for (let y = segStart.getFullYear(); y <= segEnd.getFullYear(); y += 1) {
    for (let m = 0; m < 12; m += 1) {
      weights[m] += countDaysInMonthIntersection(segStart, segEnd, y, m);
    }
  }
  return distributeBudget(pool, weights);
}

/**
 * Desglose mensual derivado solo de Planning en memoria (sin persistencia).
 * Llama internamente a `aggregatePlanningMonthlyByDimensionForRecords` sobre un subconjunto ya filtrado.
 */
function buildCostCenterMonthlyBreakdownFromPlanning(records, dateFilter) {
  return aggregatePlanningMonthlyByDimensionForRecords(records, dateFilter);
}

/**
 * Agrega inversión mensual del Planning por dimensión (subconjunto explícito de filas).
 * @param {{ desde?: string, hasta?: string }} [dateFilter] Si se indica `desde` y/o `hasta` (YYYY-MM-DD), solo cuenta campañas cuyo rango intersecta el filtro.
 */
function aggregatePlanningMonthlyByDimensionForRecords(records, dateFilter) {
  const byTipo = new Map();
  const byPlataforma = new Map();
  const byIntake = new Map();
  const desdeStr = dateFilter && String(dateFilter.desde || "").trim();
  const hastaStr = dateFilter && String(dateFilter.hasta || "").trim();

  const addTo = (map, key, monthIdx, val) => {
    const k = String(key || "—").trim() || "—";
    if (!map.has(k)) map.set(k, Array.from({ length: 12 }, () => 0));
    const row = map.get(k);
    row[monthIdx] += val;
  };

  (Array.isArray(records) ? records : []).forEach((rec) => {
    const monthly = allocatePlanningRecordConsumptionToCalendarMonthColumns(
      rec,
      desdeStr ?? "",
      hastaStr ?? ""
    );
    if (!monthly || !monthly.length) return;
    for (let m = 0; m < 12; m += 1) {
      const v = Number(monthly[m]) || 0;
      if (v <= 0) continue;
      addTo(byTipo, rec.tipo, m, v);
      addTo(byPlataforma, rec.plataforma, m, v);
      addTo(byIntake, rec.intake, m, v);
    }
  });

  return { byTipo, byPlataforma, byIntake };
}

/** Agrega inversión mensual de todo el Planning del equipo actual (rangos opcionales). */
function aggregatePlanningMonthlyByDimension(dateFilter) {
  return aggregatePlanningMonthlyByDimensionForRecords(
    planningDraftRecords().filter((r) => planningRecordRelevantForCentroImport(r)),
    dateFilter
  );
}

/**
 * Filas Planning para las tablas de desglose (tipo / plataforma / intake):
 * - mismo alcance que el consumo contra bolsas: equipo actual + filas legacy sin `teamId`;
 * - solo campañas con centro de costo resuelto (`planningRecordCanonicalCentroId`);
 * - centro: selección/filtro de bolsa o todas las que tienen CC.
 *
 * Todo se lee del borrador en memoria (`planningDraftRecords`); persistir servidor sigue en «Publicar».
 */
function planningRecordsForCostCenterBreakdown() {
  const teamRows = planningDraftRecords().filter(
    (r) => planningRecordRelevantForCentroImport(r) && planningRecordCanonicalCentroId(r)
  );
  const fromRowSel = selectedCcRowId ? String(selectedCcRowId).trim() : "";
  const fromFilter =
    document.getElementById("ccFilterAgrupador") instanceof HTMLSelectElement
      ? String(document.getElementById("ccFilterAgrupador").value || "").trim()
      : "";
  const centroScope = fromRowSel || fromFilter;
  if (!centroScope) return teamRows;
  return teamRows.filter((r) => planningRecordCanonicalCentroId(r) === String(centroScope));
}

function getCcChartDateFilterFromDom() {
  const desde = document.getElementById("ccFilterDesde")?.value?.trim() ?? "";
  const hasta = document.getElementById("ccFilterHasta")?.value?.trim() ?? "";
  return { desde, hasta };
}

function syncCcAgrupadorFilterOptions() {
  const sel = document.getElementById("ccFilterAgrupador");
  if (!sel) return;
  const cur = sel.value;
  const rows = centrosCostos.filter((c) => rowBelongsToCurrentTeam(c)).sort((a, b) => {
    const la = getCentroCostoDisplayName(a) || String(a.id);
    const lb = getCentroCostoDisplayName(b) || String(b.id);
    return la.localeCompare(lb, "es");
  });
  sel.innerHTML =
    `<option value="">${escapeHtml("Todos")}</option>` +
    rows
      .map((c) => {
        const id = String(c.id);
        const lab = getCentroCostoDisplayName(c) || id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(lab)}</option>`;
      })
      .join("");
  if (rows.some((c) => String(c.id) === cur)) sel.value = cur;
}

function centroCostoPasaFiltrosTabla(cc, used, inversionTotal) {
  const agrSel = document.getElementById("ccFilterAgrupador")?.value?.trim() ?? "";
  const estSel = document.getElementById("ccFilterEstado")?.value?.trim() ?? "";
  if (agrSel && String(cc.id) !== agrSel) return false;
  const pct = inversionTotal > 0 ? (used / inversionTotal) * 100 : 0;
  const riesgo = inversionTotal > 0 && pct > 90;
  if (estSel === "riesgo" && !riesgo) return false;
  if (estSel === "ok" && riesgo) return false;
  return true;
}

function closeAllCcUiDropdowns() {
  document.querySelectorAll("#costCenterModule .cc-dropdown-panel").forEach((p) => {
    p.hidden = true;
  });
  document.querySelectorAll("#costCenterModule .cc-more-actions-btn").forEach((b) => {
    b.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll("#costCenterModule .cc-row-menu-btn").forEach((b) => {
    b.setAttribute("aria-expanded", "false");
  });
}

function renderCcKpiStrip() {
  let totalInv = 0;
  let totalUsed = 0;
  let riesgoCount = 0;
  centrosCostos.filter((cc) => rowBelongsToCurrentTeam(cc)).forEach((cc) => {
    const inv = Number(cc.inversionTotal) || 0;
    const used = getUsedInversionCentro(cc.id, null);
    totalInv += inv;
    totalUsed += used;
    const pct = inv > 0 ? (used / inv) * 100 : 0;
    if (inv > 0 && pct > 90) riesgoCount += 1;
  });
  const saldo = Math.max(0, totalInv - totalUsed);
  const pctExec = totalInv > 0 ? (totalUsed / totalInv) * 100 : 0;
  const pctSaldo = totalInv > 0 ? (saldo / totalInv) * 100 : 0;

  const setTxt = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };
  setTxt("ccKpiPresupuestoTotal", formatMoneyCc(totalInv) || "$0");
  setTxt("ccKpiInversionUsada", formatMoneyCc(totalUsed) || "$0");
  setTxt("ccKpiSaldo", formatMoneyCc(saldo) || "$0");
  setTxt("ccKpiEjecucionPct", `${pctExec.toFixed(2)}%`);
  setTxt("ccKpiCentrosRiesgo", String(riesgoCount));
  setTxt("ccKpiInversionUsadaSub", `${pctExec.toFixed(2)}% del presupuesto`);
  setTxt("ccKpiSaldoSub", `${pctSaldo.toFixed(2)}% disponible`);

  const barUsada = document.getElementById("ccKpiBarUsada");
  const barSaldo = document.getElementById("ccKpiBarSaldo");
  const barEjec = document.getElementById("ccKpiBarEjecucion");
  if (barUsada) barUsada.style.width = `${Math.min(100, pctExec)}%`;
  if (barSaldo) barSaldo.style.width = `${Math.min(100, pctSaldo)}%`;
  if (barEjec) barEjec.style.width = `${Math.min(100, pctExec)}%`;
}

/**
 * Agrupa filas de plataforma del Planning en Google / Meta / (Otros si aplica),
 * manteniendo desglose mensual por columna.
 */
function mergeCcPlataformaMapByFamilia(byPlataforma) {
  const google = Array.from({ length: 12 }, () => 0);
  const meta = Array.from({ length: 12 }, () => 0);
  const otros = Array.from({ length: 12 }, () => 0);
  if (!byPlataforma || byPlataforma.size === 0) return new Map();
  for (const [platKey, row] of byPlataforma.entries()) {
    const fam = dashPlataformaFamilyKey(platKey);
    for (let m = 0; m < 12; m += 1) {
      const v = Number(row[m]) || 0;
      if (fam === "google") google[m] += v;
      else if (fam === "meta") meta[m] += v;
      else otros[m] += v;
    }
  }
  const out = new Map();
  out.set("Google", google);
  out.set("Meta", meta);
  if (otros.some((x) => Number(x) > 0)) out.set("Otros", otros);
  return out;
}

function sortCcIntakeKeysForSummary(keys) {
  const rank = (k) => {
    const s = String(k ?? "").trim();
    const m1 = /^intake\s*(\d+)/i.exec(s);
    if (m1) return Number(m1[1]);
    const m2 = /^(\d+)$/.exec(s);
    if (m2) return Number(m2[1]);
    return 1e6;
  };
  return [...keys].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return String(a).localeCompare(String(b), "es");
  });
}

/** Orden estable de tipos de campaña (similar al Planning legible). El resto va alfabético al final. */
function sortCcTipoKeysForSummary(keys) {
  const order = ["MA", "SE", "DI", "MBA", "PE", "DO", "ALCANCE", "CHARLA", "WEBINAR"];
  const rank = (key) => {
    const k = String(key ?? "").trim().toUpperCase();
    const ix = order.indexOf(k);
    return ix >= 0 ? ix : 1000;
  };
  return [...keys].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a).localeCompare(String(b), "es");
  });
}

function exportCcCentrosCostosCsv() {
  void showAppDialog({
    message: "La exportación a CSV está deshabilitada. Los datos se consolidan en el servidor al publicar.",
    primaryText: "Entendido",
    showSecondary: false,
    primaryDanger: false
  });
}

async function runDeleteCentroCostoFlowForId(ccId) {
  if (!ccId) return;
  const cc = centrosCostos.find((c) => String(c.id) === String(ccId));
  if (!cc) return;

  const linked = getRecordsLinkedToCentroCostoRow(cc);
  if (!linked.length) {
    finalizeDeleteCentroCostoRow(cc.id);
    return;
  }

  const continuar = await showAppDialog({
    message:
      "Este Centro de Costos tiene campañas asociadas.\nSi lo eliminas, deberás reasignar esos consumos a otro Centro de Costos.\n¿Deseas continuar?",
    primaryText: "Confirmar",
    secondaryText: "Cancelar",
    showSecondary: true,
    primaryDanger: false
  });
  if (!continuar) return;

  const nuevoKey = await showCcReassignDialog(cc.id);
  if (!nuevoKey) return;

  const normalized = normalizeCentroCostoSelectionValue(nuevoKey);
  if (!normalized || !resolveCentroCostoByValue(normalized)) {
    await showAppDialog({
      message: "El centro de costos elegido no es válido.",
      showSecondary: false,
      primaryText: "Cerrar"
    });
    return;
  }

  linked.forEach((r) => {
    r.centroCosto = normalized;
    r.centroCostoId = normalized;
  });
  rebuildPlanningTable();
  persistPlanningData();
  finalizeDeleteCentroCostoRow(cc.id);
}

/**
 * Tablas de resumen bajo Centro de costos: agregan inversión mensual del PLANNING
 * (computeMonthlyArraysForRecordWithOverrides → monthlyInvestment), por dimensión.
 */
function renderCcSummaryTable(el, map, opts) {
  if (!el) return;
  const colLabel = String(opts?.colLabel || "Dimensión");
  const captionText = String(opts?.caption || "Resumen Planning");
  const theme = String(opts?.theme || "tipo");
  const omitCaption = opts?.omitCaption === true;
  const TYPE_LABELS = {
    MA: "Maestría",
    SE: "Segundas especialidades",
    DI: "Diplomados",
    MBA: "MBA",
    PE: "Programa de especialización",
    DO: "Doctorado",
    ALCANCE: "Alcance",
    CHARLA: "Charla",
    WEBINAR: "Webinar"
  };
  const isTipoTable = String(colLabel).toLowerCase() === "tipo";
  const isIntakeTable = String(colLabel).toLowerCase() === "intake";
  const isPlataformaTable = String(colLabel).toLowerCase() === "plataforma";
  el.classList.toggle("cc-planning-summary--tipo", isTipoTable);
  el.classList.toggle("cc-analytic-monthly-table", Boolean(opts?.analyticStyle));
  let keys = Array.from(map.keys());
  if (opts?.preserveKeyOrder) {
    /* orden de inserción del Map (p. ej. Google → Meta → Otros) */
  } else if (isIntakeTable) {
    keys = sortCcIntakeKeysForSummary(keys);
  } else if (isTipoTable) {
    keys = sortCcTipoKeysForSummary(keys);
  } else if (isPlataformaTable) {
    keys.sort((a, b) => String(a).localeCompare(String(b), "es"));
  } else {
    keys.sort((a, b) => String(a).localeCompare(String(b), "es"));
  }
  const monthlyTotals = Array.from({ length: 12 }, () => 0);
  const colCount = 14;
  const caption = omitCaption
    ? ""
    : `<caption class="cc-ps-caption cc-ps-caption--${escapeHtml(theme)}">${escapeHtml(captionText)}</caption>`;
  const head =
    `${caption}<thead><tr><th scope="col" class="cc-ps-th cc-ps-th-dim">` +
    escapeHtml(colLabel) +
    `</th>` +
    MONTHS.map((mes) => `<th scope="col" class="cc-ps-th">${escapeHtml(mes)}</th>`).join("") +
    `<th scope="col" class="cc-ps-th cc-ps-th-total">Total</th></tr></thead>`;

  if (!keys.length) {
    const totalCells = monthlyTotals
      .map((v) => `<td class="cc-ps-td-num">${escapeHtml(formatMoneyCc(v) || "$0")}</td>`)
      .join("");
    el.innerHTML =
      head +
      `<tbody><tr><td class="cc-ps-td-empty" colspan="${colCount}">Sin datos para este alcance: no hay campañas con centro de costo asignado, o no hay inversión mensual en el rango de fechas aplicado.</td></tr></tbody>` +
      `<tfoot><tr class="cc-ps-total-row"><th scope="row">TOTAL</th>${totalCells}<td class="cc-ps-td-num">${escapeHtml(formatMoneyCc(0) || "$0")}</td></tr></tfoot>`;
    return;
  }

  const body = keys
    .map((key) => {
      const row = map.get(key);
      const displayKey = isTipoTable ? TYPE_LABELS[String(key).toUpperCase()] || key : key;
      row.forEach((v, idx) => {
        monthlyTotals[idx] += Number(v) || 0;
      });
      const tot = row.reduce((a, b) => a + b, 0);
      const cells = row
        .map((v) => `<td class="cc-ps-td-num">${escapeHtml(formatMoneyCc(v) || "$0")}</td>`)
        .join("");
      return `<tr><th scope="row" class="cc-ps-td-dim">${escapeHtml(String(displayKey))}</th>${cells}<td class="cc-ps-td-num cc-ps-td-rowtotal">${escapeHtml(formatMoneyCc(tot) || "$0")}</td></tr>`;
    })
    .join("");
  const grandTotal = monthlyTotals.reduce((a, b) => a + b, 0);
  const totalCells = monthlyTotals
    .map((v) => `<td class="cc-ps-td-num">${escapeHtml(formatMoneyCc(v) || "$0")}</td>`)
    .join("");
  el.innerHTML =
    head +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr class="cc-ps-total-row"><th scope="row">TOTAL</th>${totalCells}<td class="cc-ps-td-num">${escapeHtml(formatMoneyCc(grandTotal) || "$0")}</td></tr></tfoot>`;
}

function renderCentroCostosMainTable() {
  const table = document.getElementById("ccMainTable");
  const tbody = document.getElementById("ccMainBody");
  if (!tbody || !table) return;

  let totalInversion = 0;
  let totalUsed = 0;
  let totalSaldo = 0;

  tbody.innerHTML = centrosCostos
    .filter((cc) => rowBelongsToCurrentTeam(cc))
    .map((cc) => {
      const used = getUsedInversionCentro(cc.id, null);
      const inversionTotal = Number(cc.inversionTotal) || 0;
      const saldo = Math.max(0, inversionTotal - used);
      const pct = inversionTotal > 0 ? (used / inversionTotal) * 100 : 0;
      const pctRest = inversionTotal > 0 ? Math.max(0, 100 - pct) : 0;
      const riesgo = inversionTotal > 0 && pct > 90;
      if (!centroCostoPasaFiltrosTabla(cc, used, inversionTotal)) return "";
      totalInversion += inversionTotal;
      totalUsed += used;
      totalSaldo += saldo;
      const idEsc = escapeHtml(cc.id);
      const nm = getCentroCostoDisplayName(cc);
      const pctStr = `${pct.toFixed(2)}%`;
      const pctRestStr = `${pctRest.toFixed(2)}%`;
      let barClass = "cc-pct-bar-fill";
      if (pct > 90) barClass += " cc-pct-bar-fill--risk";
      else if (pct > 70) barClass += " cc-pct-bar-fill--warn";
      const badge = riesgo
        ? `<span class="cc-badge cc-badge--riesgo">RIESGO</span>`
        : `<span class="cc-badge cc-badge--ok">OK</span>`;
      return `<tr data-cc-id="${idEsc}">
        <td contenteditable="true" class="cc-editable" data-cc-field="nombre">${escapeHtml(nm)}</td>
        <td contenteditable="true" class="cc-editable cc-td-num" data-cc-field="inversionTotal">${escapeHtml(String(cc.inversionTotal))}</td>
        <td class="cc-td-num cc-td-readonly">${escapeHtml(formatMoneyCc(used) || "$0")}</td>
        <td class="cc-td-num cc-td-readonly cc-td-saldo">${escapeHtml(formatMoneyCc(saldo) || "$0")}</td>
        <td class="cc-td-num cc-pct-cell">
          <div class="cc-pct-wrap">
            <div class="cc-pct-bar-track" aria-hidden="true"><span class="${barClass}" style="width:${Math.min(100, pct)}%"></span></div>
            <span>${escapeHtml(pctStr)}</span>
          </div>
        </td>
        <td class="cc-td-num cc-td-readonly">${escapeHtml(pctRestStr)}</td>
        <td>${badge}</td>
        <td class="cc-td-actions" data-cc-stop-row-select>
          <div class="cc-dropdown cc-row-dd">
            <button type="button" class="cc-row-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="Acciones para fila"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>
            <div class="cc-dropdown-panel cc-row-dd-panel" role="menu" hidden>
              <button type="button" class="cc-dropdown-item cc-dropdown-item--danger" data-cc-action="delete" role="menuitem">Eliminar centro</button>
            </div>
          </div>
        </td>
      </tr>`;
    })
    .filter(Boolean)
    .join("");

  const totalRow = `<tr class="cc-total-row">
      <td><strong>TOTAL</strong></td>
      <td class="cc-td-num">${escapeHtml(formatMoneyCc(totalInversion) || "$0")}</td>
      <td class="cc-td-num">${escapeHtml(formatMoneyCc(totalUsed) || "$0")}</td>
      <td class="cc-td-num">${escapeHtml(formatMoneyCc(totalSaldo) || "$0")}</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`;

  let tfoot = table.querySelector("tfoot");
  if (!tfoot) {
    tfoot = document.createElement("tfoot");
    table.appendChild(tfoot);
  }
  tfoot.innerHTML = totalRow;

  tbody.querySelectorAll("tr[data-cc-id]").forEach((tr) => {
    tr.classList.toggle("row-selected", String(tr.getAttribute("data-cc-id")) === String(selectedCcRowId));
  });
  updateCcDeleteRowButtonState();
}

function updateCcDeleteRowButtonState() {
  const del = document.getElementById("ccDeleteRowBtn");
  if (del) del.disabled = !selectedCcRowId;
  const moreDel = document.getElementById("ccMoreDeleteBtn");
  if (moreDel) moreDel.disabled = !selectedCcRowId;
}

function refreshCentroCostosUI() {
  ensureCentrosCostosRowsFromPlanningAssignments();
  if (!document.getElementById("ccMainBody")) {
    populateCentroCostoSelect();
    return;
  }
  syncCcAgrupadorFilterOptions();
  renderCcKpiStrip();
  renderCentroCostosMainTable();
  const breakdownRows = planningRecordsForCostCenterBreakdown();
  const agg = buildCostCenterMonthlyBreakdownFromPlanning(breakdownRows, getCcChartDateFilterFromDom());
  const hintEl = document.getElementById("ccAnalyticsScopeHint");
  if (hintEl) {
    const fromRowSel = selectedCcRowId ? String(selectedCcRowId).trim() : "";
    const fromFilter =
      document.getElementById("ccFilterAgrupador") instanceof HTMLSelectElement
        ? String(document.getElementById("ccFilterAgrupador").value || "").trim()
        : "";
    const scopeId = fromRowSel || fromFilter;
    const cc = scopeId ? centrosCostos.find((c) => String(c.id) === String(scopeId)) : null;
    if (cc) {
      hintEl.textContent =
        `Desglose mensual solo con campañas que tienen centro de costo: «${getCentroCostoDisplayName(cc)}».`;
    } else {
      hintEl.textContent =
        "Desglose mensual: solo campañas del equipo con centro de costo asignado; las demás se excluyen.";
    }
  }
  renderCcSummaryTable(document.getElementById("ccResumenTipo"), agg.byTipo, {
    colLabel: "Tipo",
    caption: "Por tipo — inversión mensual (Planning)",
    theme: "tipo",
    omitCaption: false,
    analyticStyle: true
  });
  renderCcSummaryTable(document.getElementById("ccResumenPlataforma"), agg.byPlataforma, {
    colLabel: "Plataforma",
    caption: "Por plataforma — inversión mensual (Planning)",
    theme: "plataforma",
    omitCaption: false,
    analyticStyle: true
  });
  renderCcSummaryTable(document.getElementById("ccResumenIntake"), agg.byIntake, {
    colLabel: "Intake",
    caption: "Por intake — inversión mensual (Planning)",
    theme: "intake",
    omitCaption: false,
    analyticStyle: true
  });
  populateCentroCostoSelect();
  const ts = document.getElementById("ccModuleUpdatedAt");
  if (ts) {
    try {
      ts.textContent = `Actualizado: ${new Date().toLocaleString("es-CL")}`;
    } catch {
      ts.textContent = "";
    }
  }
}

/**
 * Recálculo global del módulo Centro de Costos:
 * - Re-render tabla principal (bolsas), KPIs, filtros y tablas analíticas mensuales
 *
 * Debe llamarse tras crear/editar/eliminar campañas o cambiar Centro de Costos.
 */
function recalcularCentroCostos() {
  refreshCentroCostosUI();
}

/**
 * Quita todo centro de costo en las campañas Planning del equipo actual y elimina las bolsas (cc_data)
 * de ese mismo equipo. Irreversible en el borrador (revertir solo con Descartar o copia anterior).
 */
async function runResetCompletoCentroCostosParaEquipoActual() {
  const tid = String(getCurrentTeamId() || "").trim();
  if (!tid) {
    void showAppDialog({
      message: "No hay equipo de sesión. Inicia sesión con un equipo para limpiar Centro de costos.",
      primaryText: "Entendido",
      showSecondary: false
    });
    return;
  }

  const bolsaQty = centrosCostos.filter((c) => rowBelongsToCurrentTeam(c)).length;
  let campCc = 0;
  planningDraftRecords()
    .filter((r) => rowBelongsToCurrentTeam(r))
    .forEach((r) => {
      if (String(planningRecordCentroRefRaw(r) || "").trim()) campCc += 1;
    });

  const ok = await showAppDialog({
    message:
      `Vas a reiniciar Centro de costos para el equipo actual.\n\n` +
      `• Se eliminarán ${bolsaQty} bolsa(s) guardada(s).\n` +
      `• Se quitarán los campos centro de costo en ${campCc} campaña(s) del Planning que los tengan.\n\n` +
      `Las campañas y sus montos siguen igual; solo se quita la relación al centro.\nLos cambios quedan en el borrador hasta que publiques.\n\n¿Continuar?`,
    primaryText: "Sí, limpiar todo",
    secondaryText: "Cancelar",
    showSecondary: true,
    primaryDanger: true
  });
  if (!ok) return;

  planningDraftRecords()
    .filter((r) => rowBelongsToCurrentTeam(r))
    .forEach((r) => {
      r.centroCosto = "";
      r.centroCostoId = "";
    });

  for (let i = centrosCostos.length - 1; i >= 0; i -= 1) {
    if (rowBelongsToCurrentTeam(centrosCostos[i])) centrosCostos.splice(i, 1);
  }

  let maxN = 0;
  centrosCostos.forEach((r) => {
    const m = String(r.id).match(/^cc_(\d+)$/i);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });
  centroCostoIdSeq = Math.max(centroCostoIdSeq, maxN > 0 ? maxN + 1 : 1);

  selectedCcRowId = null;

  registrarAuditoria({
    modulo: "planning",
    accion: "editar",
    campo: "centro_costo_reset_equipo",
    valorAnterior: { bolsasEquipo: bolsaQty, campanasConCc: campCc },
    valorNuevo: { bolsasEquipo: 0, campanasSinCc: "todas_equipo_actual" },
    descripcion:
      `Reset Centro de costos (equipo): ${bolsaQty} bolsa(s) eliminada(s), ${campCc} campaña(s) sin centro asignado.`
  });

  persistCentrosCostos();
  rebuildPlanningTable();
  persistPlanningData();
  syncConsumoFromRecords();
  persistConsumoPorCampaña();
  populateCentroCostoSelect();
  refreshCentroCostosUI();

  void showAppDialog({
    message:
      "Listo: Planning sin centro de costo y tabla de bolsas vacía para tu equipo.\nRecuerda publicar si quieres guardarlo en el servidor.",
    primaryText: "OK",
    showSecondary: false
  });
}

function populateCentroCostoSelect() {
  ensureCentrosCostosRowsFromPlanningAssignments();
  const sel = document.getElementById("centroCostoSelect");
  if (!sel) return;
  const curId = normalizeCentroCostoSelectionValue(sel.value);
  const seen = new Set();
  const options = centrosCostos
    .filter((c) => rowBelongsToCurrentTeam(c))
    .map((c) => {
      const id = String(c.id);
      if (!id || seen.has(id)) return "";
      seen.add(id);
      const label = getCentroCostoDisplayName(c) || id;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    })
    .filter(Boolean)
    .join("");
  sel.innerHTML =
    `<option value="">${escapeHtml("Sin centro de costo")}</option>` + options;
  if (curId && seen.has(curId)) sel.value = curId;
}

function updateCentroCostoSaldoHint() {
  const hint = document.getElementById("centroCostoSaldoHint");
  const sel = document.getElementById("centroCostoSelect");
  if (!hint || !sel) return;
  const id = sel.value;
  if (!id) {
    hint.textContent = "";
    return;
  }
  const saldo = getSaldoDisponibleCentro(id, editingRecordId);
  hint.textContent = `Saldo disponible: ${formatMoneyCc(saldo) || "$0"}`;
}

function initCentroCostosModule() {
  const addBtn = document.getElementById("ccAddRowBtn");
  const deleteBtn = document.getElementById("ccDeleteRowBtn");
  const tbody = document.getElementById("ccMainBody");
  const selCc = document.getElementById("centroCostoSelect");
  const editBtn = document.getElementById("ccEditRowBtn");
  const exportBtn = document.getElementById("ccExportBtn");
  const clearF = document.getElementById("ccClearFiltersBtn");
  const filtAgr = document.getElementById("ccFilterAgrupador");
  const filtEst = document.getElementById("ccFilterEstado");
  const filtDesde = document.getElementById("ccFilterDesde");
  const filtHasta = document.getElementById("ccFilterHasta");
  const moreBtn = document.getElementById("ccMoreActionsBtn");
  const morePanel = document.getElementById("ccMoreActionsPanel");
  const moreDel = document.getElementById("ccMoreDeleteBtn");
  const resetModBtn = document.getElementById("ccResetModuloBtn");

  selCc?.addEventListener("change", () => updateCentroCostoSaldoHint());

  addBtn?.addEventListener("click", () => {
    const tid = String(getCurrentTeamId()).trim();
    if (!tid) return;
    const id = `cc_${centroCostoIdSeq++}`;
    centrosCostos.push(
      normalizeCentroCostoRow({
        id,
        nombre: "",
        inversionTotal: 0,
        teamId: tid
      })
    );
    persistCentrosCostos();
    refreshCentroCostosUI();
  });

  editBtn?.addEventListener("click", () => {
    if (!selectedCcRowId) return;
    const rid = String(selectedCcRowId).replace(/["\\]/g, "");
    const cell = tbody?.querySelector(`tr[data-cc-id="${rid}"] td[data-cc-field="nombre"]`);
    if (cell instanceof HTMLElement) {
      cell.focus();
      const range = document.createRange();
      range.selectNodeContents(cell);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });

  exportBtn?.addEventListener("click", () => exportCcCentrosCostosCsv());

  const onCcFilterChange = () => {
    refreshCentroCostosUI();
  };
  filtAgr?.addEventListener("change", onCcFilterChange);
  filtEst?.addEventListener("change", onCcFilterChange);
  filtDesde?.addEventListener("change", onCcFilterChange);
  filtHasta?.addEventListener("change", onCcFilterChange);

  clearF?.addEventListener("click", () => {
    if (filtAgr) filtAgr.value = "";
    if (filtEst) filtEst.value = "";
    if (filtDesde) filtDesde.value = "";
    if (filtHasta) filtHasta.value = "";
    refreshCentroCostosUI();
  });

  moreBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!morePanel) return;
    const opening = morePanel.hidden;
    closeAllCcUiDropdowns();
    if (opening) {
      morePanel.hidden = false;
      moreBtn.setAttribute("aria-expanded", "true");
    }
  });

  moreDel?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeAllCcUiDropdowns();
    void runDeleteCentroCostoFlowForId(selectedCcRowId);
  });

  resetModBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeAllCcUiDropdowns();
    void runResetCompletoCentroCostosParaEquipoActual();
  });

  document.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;
    if (ev.target.closest("#costCenterModule .cc-header-more-dd")) return;
    if (ev.target.closest("#costCenterModule .cc-row-dd")) return;
    closeAllCcUiDropdowns();
  });

  tbody?.addEventListener("click", (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    const menuBtn = e.target.closest(".cc-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const wrap = menuBtn.closest(".cc-dropdown");
      const panel = wrap?.querySelector(".cc-dropdown-panel");
      const wasOpen = panel && !panel.hidden;
      document.querySelectorAll("#costCenterModule .cc-row-dd .cc-dropdown-panel").forEach((p) => {
        p.hidden = true;
      });
      document.querySelectorAll("#costCenterModule .cc-row-menu-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
      if (panel && !wasOpen) {
        panel.hidden = false;
        menuBtn.setAttribute("aria-expanded", "true");
      }
      return;
    }
    const delAct = e.target.closest('[data-cc-action="delete"]');
    if (delAct) {
      e.stopPropagation();
      document.querySelectorAll("#costCenterModule .cc-row-dd .cc-dropdown-panel").forEach((p) => {
        p.hidden = true;
      });
      const tr = delAct.closest("tr[data-cc-id]");
      const rowId = tr?.getAttribute("data-cc-id");
      void runDeleteCentroCostoFlowForId(rowId);
      return;
    }

    const tr = e.target.closest("tbody tr[data-cc-id]");
    if (!tr) return;
    if (e.target.closest("[data-cc-stop-row-select]")) return;
    const td = e.target.closest("td");
    if (td && td.hasAttribute("data-cc-field")) return;
    const id = tr.getAttribute("data-cc-id") || "";
    if (!id) return;
    if (String(selectedCcRowId) === String(id)) {
      selectedCcRowId = null;
    } else {
      selectedCcRowId = id;
    }
    tbody.querySelectorAll("tr[data-cc-id]").forEach((row) => {
      row.classList.toggle("row-selected", String(row.getAttribute("data-cc-id")) === String(selectedCcRowId));
    });
    updateCcDeleteRowButtonState();
  });

  deleteBtn?.addEventListener("click", () => {
    void runDeleteCentroCostoFlowForId(selectedCcRowId);
  });

  tbody?.addEventListener("blur", (e) => {
    const td = e.target instanceof HTMLElement ? e.target.closest("td[data-cc-field]") : null;
    if (!td) return;
    const tr = td.closest("tr[data-cc-id]");
    if (!tr) return;
    const id = tr.getAttribute("data-cc-id") || "";
    const field = td.getAttribute("data-cc-field") || "";
    const cc = centrosCostos.find((c) => String(c.id) === id);
    if (!cc || !field) return;
    let raw = (td.textContent || "").trim();
    if (field === "inversionTotal") {
      const n = limpiarNumero(raw);
      cc.inversionTotal = Number.isFinite(n) ? Math.max(0, n) : 0;
      td.textContent = String(cc.inversionTotal);
    } else if (field === "nombre") {
      cc.nombre = raw;
      td.textContent = getCentroCostoDisplayName(cc);
    } else {
      cc[field] = raw;
    }
    persistCentrosCostos();
    refreshCentroCostosUI();
  }, true);

  tbody?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("td[data-cc-field]")) {
      e.preventDefault();
      e.target.blur();
    }
  });
}

function initCentroCostosTabs() {
  const tabDesglose = document.getElementById("ccTabDesglose");
  const tabDetalle = document.getElementById("ccTabDetalle");
  const paneDesglose = document.getElementById("ccPaneDesglose");
  const paneDetalle = document.getElementById("ccPaneDetalle");
  if (!tabDesglose || !tabDetalle || !paneDesglose || !paneDetalle) return;

  const setActive = (which) => {
    const isDesglose = which === "desglose";
    paneDesglose.classList.toggle("hidden", !isDesglose);
    paneDetalle.classList.toggle("hidden", isDesglose);
    tabDesglose.classList.toggle("data-subtab-active", isDesglose);
    tabDetalle.classList.toggle("data-subtab-active", !isDesglose);
    tabDesglose.setAttribute("aria-selected", isDesglose ? "true" : "false");
    tabDetalle.setAttribute("aria-selected", isDesglose ? "false" : "true");
    if (isDesglose) refreshCentroCostosUI();
  };

  tabDesglose.addEventListener("click", () => setActive("desglose"));
  tabDetalle.addEventListener("click", () => setActive("detalle"));
  setActive("detalle");
}

/**
 * Recalcula consumo por campaña desde `records` (incluye distribución mensual guardada),
 * persiste `consumo_por_campaña` y vuelve a pintar el módulo Centro de Costos y resúmenes.
 * Equivale a “restar del CC anterior / sumar al nuevo”: al reconstruir desde el estado actual
 * de cada campaña, el agregado por centro y por mes queda consistente tras cambiar CC.
 */
function syncCentroCostosYConsumoDesdePlanning() {
  ensureCentrosCostosRowsFromPlanningAssignments();
  syncConsumoFromRecords();
  persistConsumoPorCampaña();
  recalcularCentroCostos();
  if (dashboardUiInicializado) {
    try {
      renderDashboardFromFilters();
    } catch (err) {
      console.warn("No se pudo refrescar el dashboard tras sincronizar planning", err);
    }
  }
}

function shouldDeferDiskPersistence() {
  return appDeferredDiskPersistence === true;
}

function cancelPendingDraftNotify() {
  if (appPublishIncrementDebounceTimer != null) {
    clearTimeout(appPublishIncrementDebounceTimer);
    appPublishIncrementDebounceTimer = null;
  }
}

/** Agrupa en +1 los avisos de borrador disparados en la misma acción (persist + REGENERAR + guardar). */
let appPublishIncrementDebounceTimer = null;

function withDraftNotificationsSuppressed(fn) {
  appSuppressDraftNotifications += 1;
  try {
    return fn();
  } finally {
    appSuppressDraftNotifications -= 1;
  }
}

/**
 * Marca que hay cambios respecto a lo último publicado: evita que un GET /api/data en segundo plano
 * (p. ej. al abrir el Dashboard) sobrescriba el borrador en memoria.
 */
function currentMemorySnapshotJsonForPublishCompare() {
  try {
    return JSON.stringify(buildMemorySnapshotForPublish());
  } catch (_) {
    return null;
  }
}

/** True si el estado en memoria coincide con el baseline de “publicado” (sin cambios reales). */
function appPublishBaselineMatchesCurrent() {
  if (!appPublishSnapshotBaselineJson) return true;
  const cur = currentMemorySnapshotJsonForPublishCompare();
  if (cur == null) return true;
  return cur === appPublishSnapshotBaselineJson;
}

function flushPublishCountIncrementFromUserAction() {
  if (appSuppressDraftNotifications > 0) return;
  if (appPublishBaselineMatchesCurrent()) return;
  appPendingPublishCount += 1;
  bumpAppStatePendingChanges();
  updatePublishDraftToolbar();
  persistPublishDraftMeta();
}

function registerUnpublishedDraftMutation() {
  if (appSuppressDraftNotifications > 0) return;
  if (appPublishBaselineMatchesCurrent()) return;
  if (appPublishIncrementDebounceTimer != null) clearTimeout(appPublishIncrementDebounceTimer);
  appPublishIncrementDebounceTimer = setTimeout(() => {
    appPublishIncrementDebounceTimer = null;
    flushPublishCountIncrementFromUserAction();
  }, 160);
}

const MAX_AUDITORIA_ENTRIES = 8000;

function serializeAuditoriaValue(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v !== null) {
    try {
      const s = JSON.stringify(v);
      return s.length > 1200 ? `${s.slice(0, 1200)}…` : s;
    } catch {
      return String(v);
    }
  }
  return v;
}

function generarAuditoriaId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `aud_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Registro de cambios (planning / data) en `appState.dataDraft.auditoria`; el borrador se marca al persistir el módulo afectado. */
function registrarAuditoria(evento) {
  if (!evento || typeof evento !== "object") return;
  const mod = evento.modulo;
  const act = evento.accion;
  if (mod !== "planning" && mod !== "data") return;
  if (act !== "crear" && act !== "editar" && act !== "eliminar") return;
  try {
    const user = typeof getUser === "function" ? getUser() : null;
    if (!user || !String(user.username || "").trim()) return;
    const teamId = user.teamId != null ? String(user.teamId).trim() : "";
    if (!teamId) return;
    const row = {
      id: generarAuditoriaId(),
      fecha: new Date().toISOString(),
      usuario: String(user.username || "").trim(),
      teamId,
      modulo: mod,
      accion: act,
      campo: String(evento.campo || ""),
      valorAnterior: serializeAuditoriaValue(evento.valorAnterior),
      valorNuevo: serializeAuditoriaValue(evento.valorNuevo),
      descripcion: String(evento.descripcion || "")
    };
    const list = ensureAuditoriaDraftShape();
    list.unshift(row);
    if (list.length > MAX_AUDITORIA_ENTRIES) list.length = MAX_AUDITORIA_ENTRIES;
  } catch (e) {
    console.warn("registrarAuditoria", e);
  }
}

function diffPlanningRecordForAudit(recordId, before, after) {
  if (!before || !after) return;
  const rid = String(recordId ?? "");
  const keys = [
    "fechaInicio",
    "fechaFin",
    "presupuesto",
    "leads",
    "tipo",
    "programa",
    "intake",
    "plataforma",
    "tracking",
    "centroCosto",
    "centroCostoId"
  ];
  for (const k of keys) {
    const bv = before[k];
    const av = after[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      registrarAuditoria({
        modulo: "planning",
        accion: "editar",
        campo: k,
        valorAnterior: bv,
        valorNuevo: av,
        descripcion: `Planning id ${rid}: ${k}`
      });
    }
  }
  if (JSON.stringify(before.metas) !== JSON.stringify(after.metas)) {
    registrarAuditoria({
      modulo: "planning",
      accion: "editar",
      campo: "metas",
      valorAnterior: before.metas,
      valorNuevo: after.metas,
      descripcion: `Planning id ${rid}: metas`
    });
  }
  if (JSON.stringify(before.distribucionMensual) !== JSON.stringify(after.distribucionMensual)) {
    registrarAuditoria({
      modulo: "planning",
      accion: "editar",
      campo: "distribucionMensual",
      valorAnterior: null,
      valorNuevo: null,
      descripcion: `Planning id ${rid}: distribución mensual`
    });
  }
  if (JSON.stringify(before.monthlyInvOverride) !== JSON.stringify(after.monthlyInvOverride)) {
    registrarAuditoria({
      modulo: "planning",
      accion: "editar",
      campo: "monthlyInvOverride",
      valorAnterior: null,
      valorNuevo: null,
      descripcion: `Planning id ${rid}: overrides mensuales`
    });
  }
}

function notifyDraftChanged() {
  if (!shouldDeferDiskPersistence()) return;
  if (appSuppressDraftNotifications > 0) return;
  registerUnpublishedDraftMutation();
}

function runWithDiskPersistenceEnabled(fn) {
  const prev = appDeferredDiskPersistence;
  appDeferredDiskPersistence = false;
  try {
    fn();
  } finally {
    appDeferredDiskPersistence = prev;
  }
}

function buildMemorySnapshotForPublish() {
  syncCcBitacoraModeloDraftFromRuntime();
  recomputePlanningMergedCacheFromRecords();
  migratePlanningRowsTeamIds(planningMergedRecordsCache || []);
  reloadPlanningWorkingSliceFromCache();
  refreshTeamScopedDataCachesForSnapshot();
  const planningSnap = JSON.parse(JSON.stringify(planningMergedRecordsCache && planningMergedRecordsCache.length ? planningMergedRecordsCache : planningDraftRecords()));
  return {
    planning_data: { records: planningSnap, recordIdSeq: getPlanningRecordIdSeq() },
    cc_data: { centros: JSON.parse(JSON.stringify(centrosCostos)), seq: centroCostoIdSeq },
    catalogos_sistema: JSON.parse(JSON.stringify(catalogosSistema)),
    programs: JSON.parse(JSON.stringify(programs)),
    bitacora_data: JSON.parse(JSON.stringify(bitacoraData)),
    data_general: serializeDataReal(ensureDataGeneralDraftShape()),
    data_ads_report: serializeDataReal(dataAdsReportMergedCache || dataAdsReport),
    data_anuncios: serializeDataAnuncios(dataAnunciosMergedCache || dataAnuncios),
    campaniasUnicasData: JSON.parse(JSON.stringify(campaniasUnicasMergedCache || campaniasUnicasData)),
    relaciones: JSON.parse(JSON.stringify(ensureRelacionesDraftShape())),
    relaciones_crm: JSON.parse(JSON.stringify(ensureRelacionesCrmDraftShape())),
    crm_leads: serializeCrmLeads(ensureCrmLeadsDraftShape()),
    medidas: JSON.parse(JSON.stringify(medidasMergedCache || medidas)),
    modelo: serializeModelo(modeloMergedCache || modeloAnalitico),
    campatrack_users_db: JSON.parse(JSON.stringify(getCampatrackStoredUsers())),
    auditoria: JSON.parse(JSON.stringify(ensureAuditoriaDraftShape()))
  };
}

/** Metadatos de “publicar” para sobrevivir a cierre del navegador (misma capa que `appMemoryKV`). */
const LS_PUBLISH_PENDING = "__campatrack_publish_pending";
const LS_PUBLISH_BASELINE = "__campatrack_publish_baseline_json";

function persistPublishDraftMeta() {
  try {
    appMemoryKV.setItem(LS_PUBLISH_PENDING, String(Math.max(0, Math.min(999999, appPendingPublishCount))));
    if (appPublishSnapshotBaselineJson)
      appMemoryKV.setItem(LS_PUBLISH_BASELINE, appPublishSnapshotBaselineJson);
    else appMemoryKV.removeItem(LS_PUBLISH_BASELINE);
  } catch (e) {
    console.warn("persistPublishDraftMeta", e);
  }
}

function captureAppPublishBaseline() {
  try {
    appPublishSnapshotBaselineJson = JSON.stringify(buildMemorySnapshotForPublish());
  } catch (err) {
    console.warn("captureAppPublishBaseline", err);
    appPublishSnapshotBaselineJson = null;
  }
}

const SS_PUBLISH_FRESH_SERVER_HYDRATE = "campatrack_publish_fresh_server_hydrate";

/** Tras cargar data desde el servidor (login o GET): estado = publicado, contador 0, sin “cambios fantasma”. */
function resetPublishDraftAfterServerHydrate() {
  cancelPendingDraftNotify();
  captureAppPublishBaseline();
  appPendingPublishCount = 0;
  resetAppStatePendingChanges();
  updatePublishDraftToolbar();
  persistPublishDraftMeta();
  try {
    sessionStorage.setItem(SS_PUBLISH_FRESH_SERVER_HYDRATE, "1");
  } catch (_) {
    /* ignore */
  }
}

/**
 * Tras hidratar tablas desde almacenamiento local: si había borrador pendiente, restaura contador y baseline
 * (para “Descartar” y la barra de publicar). Si no, alinea baseline al estado actual.
 */
function restoreOrResetPublishDraftAfterBoot() {
  cancelPendingDraftNotify();
  if (typeof isCampatrackAuthenticated !== "function" || !isCampatrackAuthenticated()) {
    resetPublishDraftAfterServerHydrate();
    return;
  }
  try {
    if (sessionStorage.getItem(SS_PUBLISH_FRESH_SERVER_HYDRATE) === "1") {
      sessionStorage.removeItem(SS_PUBLISH_FRESH_SERVER_HYDRATE);
      resetPublishDraftAfterServerHydrate();
      return;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const rawP = appMemoryKV.getItem(LS_PUBLISH_PENDING);
    const n =
      rawP != null && String(rawP).trim() !== ""
        ? Math.max(0, Math.min(999999, parseInt(String(rawP), 10) || 0))
        : 0;
    const rawB = appMemoryKV.getItem(LS_PUBLISH_BASELINE);
    if (n > 0 && rawB && String(rawB).trim()) {
      appPublishSnapshotBaselineJson = String(rawB);
      if (appPublishBaselineMatchesCurrent()) {
        resetPublishDraftAfterServerHydrate();
        return;
      }
      appPendingPublishCount = n;
      updatePublishDraftToolbar();
      persistPublishDraftMeta();
      return;
    }
  } catch (_) {
    /* ignore */
  }
  resetPublishDraftAfterServerHydrate();
}

function applyMemorySnapshotFromBundle(snap) {
  if (!snap || typeof snap !== "object") return;
  if (snap.planning_data && Array.isArray(snap.planning_data.records)) {
    const rows = snap.planning_data.records.map((r) => (typeof r === "object" && r ? { ...r } : r));
    migratePlanningRowsTeamIds(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) {
      planningMergedRecordsCache = sanitizeStructuralDuplicatePlanningRows(rows, getCurrentTeamId());
    } else {
      const tid = getCurrentTeamId();
      const base =
        Array.isArray(planningMergedRecordsCache) && planningMergedRecordsCache.length > 0
          ? planningMergedRecordsCache.slice()
          : readParsedPlanningPayloadFromDisk().rows;
      planningMergedRecordsCache = mergePlanningDraftIntoMergeCache(base, rows, tid);
    }
    if (Number.isFinite(Number(snap.planning_data.recordIdSeq)))
      setPlanningRecordIdSeq(Math.max(1, Math.round(Number(snap.planning_data.recordIdSeq))));
    reloadPlanningWorkingSliceFromCache();
  }
  if (snap.cc_data && Array.isArray(snap.cc_data.centros)) {
    centrosCostos.length = 0;
    snap.cc_data.centros.forEach((r) => centrosCostos.push(normalizeCentroCostoRow(r)));
    if (Number.isFinite(Number(snap.cc_data.seq)))
      centroCostoIdSeq = Math.max(1, Math.round(Number(snap.cc_data.seq)));
  }
  if (snap.catalogos_sistema && typeof snap.catalogos_sistema === "object") {
    catalogosSistema = snap.catalogos_sistema;
    ensureCatalogosSistemaShape();
  }
  if (Array.isArray(snap.programs)) {
    programs.length = 0;
    snap.programs.forEach((p) => programs.push(p));
  }
  if (Array.isArray(snap.bitacora_data)) {
    bitacoraData.length = 0;
    const rows = snap.bitacora_data.map((r) => normalizeBitacoraRow(r));
    sortBitacoraRowsNewestFirst(rows);
    rows.forEach((r) => bitacoraData.push(r));
  }
  if (snap.data_general) {
    const dg = ensureDataGeneralDraftShape();
    const base = dg.slice();
    const rows = deserializeDataReal(snap.data_general);
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    const merged =
      distinctTeams.size > 1 ? rows : mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    dg.length = 0;
    merged.forEach((r) => dg.push(r));
    syncDataRealViewFromDraft();
  } else {
    ensureDataGeneralDraftShape().length = 0;
    syncDataRealViewFromDraft();
  }
  if (snap.data_ads_report) {
    const rows = deserializeDataReal(snap.data_ads_report);
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) dataAdsReportMergedCache = rows;
    else {
      const base = Array.isArray(dataAdsReportMergedCache) && dataAdsReportMergedCache.length ? dataAdsReportMergedCache : readFullDataAdsRowsFromDisk();
      dataAdsReportMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    dataAdsReport = dataAdsReportMergedCache.filter(rowBelongsToCurrentTeam);
  } else {
    dataAdsReportMergedCache = [];
    dataAdsReport = [];
  }
  if (snap.data_anuncios) {
    const rows = deserializeDataAnuncios(snap.data_anuncios);
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) dataAnunciosMergedCache = rows;
    else {
      const base = Array.isArray(dataAnunciosMergedCache) && dataAnunciosMergedCache.length ? dataAnunciosMergedCache : readFullDataAnunciosRowsFromDisk();
      dataAnunciosMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    dataAnuncios = dataAnunciosMergedCache.filter(rowBelongsToCurrentTeam);
  } else {
    dataAnunciosMergedCache = [];
    dataAnuncios = [];
  }
  if (Array.isArray(snap.campaniasUnicasData)) {
    const rows = snap.campaniasUnicasData.map((r) => (typeof r === "object" && r ? { ...r } : r));
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) campaniasUnicasMergedCache = rows;
    else {
      const base =
        Array.isArray(campaniasUnicasMergedCache) && campaniasUnicasMergedCache.length ? campaniasUnicasMergedCache : readFullCampaniasUnicasFromDisk();
      campaniasUnicasMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    campaniasUnicasData = campaniasUnicasMergedCache.filter(rowBelongsToCurrentTeam);
  } else {
    campaniasUnicasMergedCache = [];
    campaniasUnicasData = [];
  }
  if (Array.isArray(snap.relaciones)) {
    const dr = ensureRelacionesDraftShape();
    const rows = snap.relaciones.map((r) => (typeof r === "object" && r ? { ...r } : r));
    dr.length = 0;
    rows.forEach((r) => dr.push(r));
  } else {
    ensureRelacionesDraftShape().length = 0;
  }
  if (Array.isArray(snap.relaciones_crm)) {
    const drCrm = ensureRelacionesCrmDraftShape();
    const rowsCrm = snap.relaciones_crm.map((r) => (typeof r === "object" && r ? { ...r } : r));
    drCrm.length = 0;
    rowsCrm.forEach((r) => drCrm.push(r));
    syncRelacionesCrmViewFromDraft();
  } else {
    ensureRelacionesCrmDraftShape().length = 0;
    syncRelacionesCrmViewFromDraft();
  }
  sanitizeRelacionesDraftChannels();
  syncRelacionesViewFromDraft();
  if (Array.isArray(snap.medidas)) {
    const rows = snap.medidas.map((r) => (typeof r === "object" && r ? { ...r } : r));
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) medidasMergedCache = rows;
    else {
      const base = Array.isArray(medidasMergedCache) && medidasMergedCache.length ? medidasMergedCache : readFullMedidasFromDisk();
      medidasMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    medidas = medidasMergedCache.filter(rowBelongsToCurrentTeam);
  } else {
    medidasMergedCache = [];
    medidas = [];
  }
  if (Array.isArray(snap.modelo)) {
    const rows = deserializeModelo(snap.modelo);
    migrateMissingTeamIdOnRows(rows);
    const distinctTeams = new Set(rows.map(normalizeRowTeamId));
    if (distinctTeams.size > 1) modeloMergedCache = rows;
    else {
      const base = Array.isArray(modeloMergedCache) && modeloMergedCache.length ? modeloMergedCache : readFullModeloFromLegacyStorage();
      modeloMergedCache = mergeRowsByTeamId(base, rows, getCurrentTeamId(), normalizeRowTeamId);
    }
    modeloAnalitico = modeloMergedCache.filter(rowBelongsToCurrentTeam);
  } else {
    modeloMergedCache = [];
    modeloAnalitico = [];
  }
  if (Array.isArray(snap.campatrack_users_db)) {
    const uDraft = ensureCampatrackUsersDraftShape();
    uDraft.length = 0;
    snap.campatrack_users_db.forEach((u) => {
      uDraft.push(u && typeof u === "object" ? { ...u } : u);
    });
  } else {
    ensureCampatrackUsersDraftShape().length = 0;
  }
  if (Array.isArray(snap.auditoria)) {
    const aud = ensureAuditoriaDraftShape();
    aud.length = 0;
    snap.auditoria.forEach((x) => {
      aud.push(x && typeof x === "object" ? { ...x } : x);
    });
  } else {
    ensureAuditoriaDraftShape().length = 0;
  }
  const allRows = dataReal.concat(dataAdsReport, dataAnuncios);
  dataIdSeq = Math.max(1, ...allRows.map((r) => Number(r._id) || 0)) + 1;
  if (hasDataGeneralLoaded()) pruneRelacionesWithoutData();
  selectedRecordId = null;
  selectedCcRowId = null;
}

function flushAllPersistedStateToDisk() {
  runWithDiskPersistenceEnabled(() => {
    try {
      recomputePlanningMergedCacheFromRecords();
      const mergedPlan = planningMergedRecordsCache || planningDraftRecords().slice();
      writePlanningPayloadToLocalStorage(mergedPlan, getPlanningRecordIdSeq());
    } catch (err) {
      console.warn("flush planning", err);
    }
    syncCcBitacoraModeloDraftFromRuntime();
    saveCatalogosSistema();
    refreshTeamScopedDataCachesForSnapshot();
    guardarEnLocalStorage(LS_KEYS.dataAdsReport, serializeDataReal(dataAdsReportMergedCache || dataAdsReport));
    guardarEnLocalStorage(LS_KEYS.dataAnuncios, serializeDataAnuncios(dataAnunciosMergedCache || dataAnuncios));
    guardarEnLocalStorage(LS_KEYS.campaniasUnicasData, campaniasUnicasMergedCache || campaniasUnicasData);
    guardarEnLocalStorage(LS_KEYS.medidas, medidasMergedCache || medidas);
    try {
      appMemoryKV.setItem("programas", JSON.stringify(programs));
    } catch (err) {
      console.warn("flush programas", err);
    }
    guardarTodo({ incluirTablasData: true });
  });
  /** POST al servidor lo ejecuta `runPublishFlowWithModal` (await) para no duplicar ni cerrar antes del OK. */
}

function refreshTodosModulosTrasBorradorOPublicar() {
  syncCentroCostosYConsumoDesdePlanning();
  rebuildPlanningTable();
  refreshCentroCostosUI();
  renderCcKpiStrip();
  renderBitacoraTipoSelect();
  renderBitacoraTable();
  renderTablaData();
  renderTablaAnuncios();
  renderTablaCampañas();
  refreshAdsReportFilterOptions();
  renderAdsReportModule();
  try {
    renderRelacionesPlanningList();
    renderRelacionesDataList();
    renderRelacionesTabla();
    renderRelacionesEstado();
  } catch (_) {}
  REGENERAR_MODELO();
  if (Array.isArray(modeloAnalitico) && modeloAnalitico.length > 0) {
    renderModeloTabla();
    refreshSegmentadoresValues();
    refreshMedidasFiltros();
  }
  renderMedidasTabla();
  if (typeof window.campatrackRefreshUsersListIfVisible === "function") {
    try {
      window.campatrackRefreshUsersListIfVisible();
    } catch (_) {}
  }
  if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
    try {
      globalThis.__campatrackRebuildAuditoriaAfterHydrate();
    } catch (_) {}
  }
  if (dashboardUiInicializado) {
    try {
      renderDashboardFromFilters();
    } catch (_) {}
  }
  if (!document.getElementById("dashboardModule")?.classList.contains("hidden")) {
    try {
      renderDashboard();
    } catch (_) {}
  }
  updateFilterProgramaState();
  syncCatalogosSistemaDesdeMemoria();
  refreshPlanningCatalogUi();
  updateTotalInversion();
  updateActionButtons();
  actualizarFiltrosCache();
}

function updatePublishDraftToolbar() {
  const pub = document.getElementById("appDraftPublishBtn");
  const dis = document.getElementById("appDraftDiscardBtn");
  const n = appPendingPublishCount;
  if (pub) {
    pub.disabled = n === 0 || appPublishModalBusy;
    pub.setAttribute("aria-disabled", pub.disabled ? "true" : "false");
    pub.classList.toggle("app-draft-btn--publish-active", n > 0 && !pub.disabled);
    const countLabel = n > 99 ? "99+" : String(Math.max(0, n));
    const countHtml =
      n > 0
        ? `<span class="app-draft-publish-count" aria-hidden="true"> (${countLabel})</span>`
        : "";
    pub.innerHTML = `<span class="app-draft-publish-label">Revisar y publicar</span>${countHtml}`;
    pub.setAttribute("aria-label", n > 0 ? `Revisar y publicar, ${countLabel} cambios pendientes` : "Revisar y publicar (sin cambios)");
  }
  if (dis) {
    dis.disabled = n === 0 || appPublishModalBusy;
    dis.setAttribute("aria-disabled", dis.disabled ? "true" : "false");
  }
}

function setPublishModalPhase(phase) {
  const overlay = document.getElementById("appPublishModalOverlay");
  const progressPhase = document.getElementById("appPublishModalPhaseProgress");
  const donePhase = document.getElementById("appPublishModalPhaseDone");
  if (!overlay || !progressPhase || !donePhase) return;
  const showProg = phase === "progress";
  progressPhase.classList.toggle("hidden", !showProg);
  donePhase.classList.toggle("hidden", showProg);
  overlay.setAttribute("data-phase", phase);
}

function openPublishModal() {
  const overlay = document.getElementById("appPublishModalOverlay");
  const bar = document.getElementById("appPublishProgressBar");
  if (!overlay || !bar) return;
  bar.style.width = "0%";
  setPublishModalPhase("progress");
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
}

function closePublishModal() {
  const overlay = document.getElementById("appPublishModalOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  setPublishModalPhase("progress");
}

async function runPublishFlowWithModal() {
  if (appPublishModalBusy || appPendingPublishCount === 0) return;
  const overlayCheck = document.getElementById("appPublishModalOverlay");
  const barCheck = document.getElementById("appPublishProgressBar");
  if (!overlayCheck || !barCheck) {
    try {
      flushAllPersistedStateToDisk();
    } catch (err) {
      console.warn("Publicar sin modal", err);
    }
    const authedBare = typeof isCampatrackAuthenticated === "function" && isCampatrackAuthenticated();
    if (authedBare) {
      try {
        await persistPublishedBundleToBackend();
      } catch (err) {
        console.error("[CampaTrack publicar] Falló el guardado:", err);
        showCampatrackToast(String(err?.message || "No se pudo publicar en el servidor."), "error");
        updatePublishDraftToolbar();
        return;
      }
    }
    cancelPendingDraftNotify();
    captureAppPublishBaseline();
    appPendingPublishCount = 0;
    resetAppStatePendingChanges();
    updatePublishDraftToolbar();
    persistPublishDraftMeta();
    return;
  }
  appPublishModalBusy = true;
  updatePublishDraftToolbar();
  openPublishModal();
  const bar = barCheck;
  let progress = 0;
  let flushDone = false;
  const runFlush = () => {
    if (flushDone) return;
    flushDone = true;
    try {
      flushAllPersistedStateToDisk();
    } catch (err) {
      console.warn("Publicar: error al volcar copia local", err);
    }
  };
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      progress = Math.min(100, progress + 2);
      if (bar) bar.style.width = `${progress}%`;
      if (progress >= 10 && progress < 12) runFlush();
      if (progress >= 100) {
        clearInterval(iv);
        runFlush();
        resolve();
      }
    }, 100);
  });

  const authed = typeof isCampatrackAuthenticated === "function" && isCampatrackAuthenticated();
  let serverOk = true;
  if (authed) {
    try {
      serverOk = (await persistPublishedBundleToBackend()) === true;
    } catch (err) {
      serverOk = false;
      console.error("[CampaTrack publicar] Falló el guardado en servidor:", err);
      showCampatrackToast(
        String(err?.message || "No se pudo publicar en el servidor. Revisa la conexión e inténtalo de nuevo."),
        "error"
      );
    }
  }

  if (authed && !serverOk) {
    setPublishModalPhase("progress");
    closePublishModal();
    appPublishModalBusy = false;
    updatePublishDraftToolbar();
    return;
  }

  cancelPendingDraftNotify();
  captureAppPublishBaseline();
  appPendingPublishCount = 0;
  resetAppStatePendingChanges();
  setPublishModalPhase("done");
  updatePublishDraftToolbar();
  persistPublishDraftMeta();
  await new Promise((r) => setTimeout(r, 1500));
  closePublishModal();
  appPublishModalBusy = false;
  updatePublishDraftToolbar();
}

async function confirmDiscardDraftChanges() {
  if (appPendingPublishCount === 0 || appPublishModalBusy) return;
  const ok = await showAppDialog({
    message: "¿Descartar todos los cambios no publicados? Se restaurará el último estado guardado.",
    primaryText: "Descartar",
    secondaryText: "Cancelar",
    showSecondary: true,
    primaryDanger: true
  });
  if (!ok) return;
  if (!appPublishSnapshotBaselineJson) {
    cancelPendingDraftNotify();
    captureAppPublishBaseline();
    appPendingPublishCount = 0;
    resetAppStatePendingChanges();
    updatePublishDraftToolbar();
    persistPublishDraftMeta();
    return;
  }
  try {
    applyMemorySnapshotFromBundle(JSON.parse(appPublishSnapshotBaselineJson));
  } catch (err) {
    console.warn("Descartar borrador", err);
    await showAppDialog({
      message: "No se pudo restaurar el estado. Intenta recargar la página.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false
    });
    return;
  }
  cancelPendingDraftNotify();
  appPendingPublishCount = 0;
  resetAppStatePendingChanges();
  updatePublishDraftToolbar();
  persistPublishDraftMeta();
  withDraftNotificationsSuppressed(() => {
    refreshTodosModulosTrasBorradorOPublicar();
  });
  updatePublishDraftToolbar();
}

function initDraftPublishToolbar() {
  const pub = document.getElementById("appDraftPublishBtn");
  const dis = document.getElementById("appDraftDiscardBtn");
  pub?.addEventListener("click", () => {
    void runPublishFlowWithModal();
  });
  dis?.addEventListener("click", () => {
    void confirmDiscardDraftChanges();
  });
  updatePublishDraftToolbar();
}

function persistPlanningData(opts = {}) {
  const fromBootstrap = opts.fromBootstrap === true;
  recomputePlanningMergedCacheFromRecords();
  const merged = planningMergedRecordsCache || planningDraftRecords().slice();
  migratePlanningRowsTeamIds(merged);
  reloadPlanningWorkingSliceFromCache();
  const maxMergedId = merged.reduce((m, r) => Math.max(m, Number(r?.id) || 0), 0);
  if (Number.isFinite(Number(getPlanningRecordIdSeq()))) {
    setPlanningRecordIdSeq(Math.max(Math.max(1, Math.round(Number(getPlanningRecordIdSeq()))), maxMergedId + 1));
  } else if (maxMergedId) {
    setPlanningRecordIdSeq(maxMergedId + 1);
  }
  if (!shouldDeferDiskPersistence()) {
    try {
      writePlanningPayloadToLocalStorage(merged, getPlanningRecordIdSeq());
    } catch (err) {
      console.warn("No se pudo guardar planning_data", err);
    }
  }
  if (!fromBootstrap) registerUnpublishedDraftMutation();
  syncCentroCostosYConsumoDesdePlanning();
  REGENERAR_MODELO();
  if (!shouldDeferDiskPersistence()) {
    guardarTodo({ incluirTablasData: false });
    guardarDebounce();
  }
  syncCatalogosSistemaDesdeMemoria();
  refreshPlanningCatalogUi();
}

function hydratarPlanningData() {
  try {
    const parsed = readParsedPlanningPayloadFromDisk();
    const allRows = parsed.rows.slice();
    const teamMigrated = migratePlanningRowsTeamIds(allRows);
    const idsChanged = ensurePlanningArrayStableUniqueIds(allRows);
    const maxAll = allRows.reduce((m, r) => Math.max(m, Number(r?.id) || 0), 0);
    if (Number.isFinite(Number(parsed.recordIdSeq))) {
      setPlanningRecordIdSeq(Math.max(Math.max(1, Math.round(Number(parsed.recordIdSeq))), maxAll + 1));
    } else if (maxAll) {
      setPlanningRecordIdSeq(maxAll + 1);
    } else {
      setPlanningRecordIdSeq(Math.max(1, Number(getPlanningRecordIdSeq()) || 1));
    }
    planningMergedRecordsCache = sanitizeStructuralDuplicatePlanningRows(allRows, getCurrentTeamId());
    reloadPlanningWorkingSliceFromCache();
    return idsChanged || teamMigrated;
  } catch (err) {
    console.warn("No se pudo cargar planning_data", err);
  }
  return false;
}

function agregarValorSiNoExiste(lista, valor) {
  if (!Array.isArray(lista)) return lista;
  const v = String(valor ?? "").trim();
  if (!v) return lista;
  if (!lista.includes(v)) lista.push(v);
  return lista;
}

function ensureCatalogosSistemaShape() {
  if (!catalogosSistema || typeof catalogosSistema !== "object") {
    catalogosSistema = { tipos: [], programas: [], tracking: [], plataformas: [], intakes: [] };
    return;
  }
  ["tipos", "programas", "tracking", "plataformas", "intakes"].forEach((k) => {
    if (!Array.isArray(catalogosSistema[k])) catalogosSistema[k] = [];
  });
}

function loadCatalogosSistemaFromStorage() {
  catalogosSistema = { tipos: [], programas: [], tracking: [], plataformas: [], intakes: [] };
  ensureCatalogosSistemaShape();
  try {
    const raw = appMemoryKV.getItem(LS_CATALOGOS_SISTEMA);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    (Array.isArray(data.tipos) ? data.tipos : []).forEach((x) => agregarValorSiNoExiste(catalogosSistema.tipos, x));
    (Array.isArray(data.programas) ? data.programas : []).forEach((x) => agregarValorSiNoExiste(catalogosSistema.programas, x));
    (Array.isArray(data.tracking) ? data.tracking : []).forEach((x) => agregarValorSiNoExiste(catalogosSistema.tracking, x));
    (Array.isArray(data.plataformas) ? data.plataformas : []).forEach((x) => agregarValorSiNoExiste(catalogosSistema.plataformas, x));
    (Array.isArray(data.intakes) ? data.intakes : []).forEach((x) => agregarValorSiNoExiste(catalogosSistema.intakes, x));
  } catch (err) {
    console.warn("No se pudo cargar catalogos_sistema", err);
  }
}

function saveCatalogosSistema() {
  ensureCatalogosSistemaShape();
  if (!shouldDeferDiskPersistence()) {
    try {
      appMemoryKV.setItem(LS_CATALOGOS_SISTEMA, JSON.stringify(catalogosSistema));
    } catch (err) {
      console.warn("No se pudo guardar catalogos_sistema", err);
    }
  } else {
    notifyDraftChanged();
  }
}

function ordenarCatalogoInPlace(arr) {
  if (!Array.isArray(arr)) return;
  arr.sort((a, b) => String(a).localeCompare(String(b), "es", { sensitivity: "base" }));
}

function mergeFuentesEnCatalogosSistema() {
  ensureCatalogosSistemaShape();
  CATALOGO_SEMILLA_TIPOS.forEach((x) => agregarValorSiNoExiste(catalogosSistema.tipos, x));
  BITACORA_TIPO_OPTIONS.forEach((x) => agregarValorSiNoExiste(catalogosSistema.tipos, x));
  CATALOGO_SEMILLA_TRACKING.forEach((x) => agregarValorSiNoExiste(catalogosSistema.tracking, x));
  CATALOGO_SEMILLA_PLATAFORMAS.forEach((x) => agregarValorSiNoExiste(catalogosSistema.plataformas, x));
  CATALOGO_SEMILLA_INTAKES.forEach((x) => agregarValorSiNoExiste(catalogosSistema.intakes, x));

  programs.forEach((p) => {
    agregarValorSiNoExiste(catalogosSistema.tipos, p.tipo);
    agregarValorSiNoExiste(catalogosSistema.programas, p.nombre);
  });
  planningDraftRecords().forEach((r) => {
    agregarValorSiNoExiste(catalogosSistema.tipos, r.tipo);
    agregarValorSiNoExiste(catalogosSistema.programas, r.programa);
    agregarValorSiNoExiste(catalogosSistema.tracking, r.tracking);
    agregarValorSiNoExiste(catalogosSistema.plataformas, r.plataforma);
    agregarValorSiNoExiste(catalogosSistema.intakes, r.intake);
  });
  bitacoraData.forEach((b) => {
    agregarValorSiNoExiste(catalogosSistema.tipos, b.tipo);
    agregarValorSiNoExiste(catalogosSistema.programas, b.programa);
  });

  ordenarCatalogoInPlace(catalogosSistema.tipos);
  ordenarCatalogoInPlace(catalogosSistema.programas);
  ordenarCatalogoInPlace(catalogosSistema.tracking);
  ordenarCatalogoInPlace(catalogosSistema.plataformas);
  ordenarCatalogoInPlace(catalogosSistema.intakes);
}

function syncCatalogosSistemaDesdeMemoria() {
  loadCatalogosSistemaFromStorage();
  mergeFuentesEnCatalogosSistema();
  saveCatalogosSistema();
}

function fillHtmlSelectFromCatalog(selectEl, firstOptionsHtml, catalogValues, selectedValue) {
  if (!selectEl) return;
  const prev =
    selectedValue !== undefined && selectedValue !== null ? String(selectedValue) : String(selectEl.value || "");
  const sorted = [...new Set((catalogValues || []).map((x) => String(x || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
  selectEl.innerHTML = firstOptionsHtml + sorted.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (prev && [...selectEl.options].some((o) => o.value === prev)) selectEl.value = prev;
}

function collectProgramNamesForPlanningTipo(tipo) {
  const t = String(tipo || "").trim();
  const names = new Set();
  getProgramsByType(t).forEach((p) => {
    const n = String(p?.nombre || "").trim();
    if (n) names.add(n);
  });
  ensurePlanningDraftShape().records.forEach((r) => {
    if (String(r.tipo || "").trim() !== t) return;
    const n = String(r.programa || "").trim();
    if (n) names.add(n);
  });
  bitacoraData.forEach((b) => {
    if (String(b.tipo || "").trim() !== t) return;
    const n = String(b.programa || "").trim();
    if (n) names.add(n);
  });
  (catalogosSistema.programas || []).forEach((raw) => {
    const n = String(raw || "").trim();
    if (!n) return;
    if (programs.some((p) => String(p.tipo) === t && String(p.nombre) === n)) names.add(n);
    if (planningDraftRecords().some((r) => String(r.tipo || "").trim() === t && String(r.programa || "").trim() === n)) names.add(n);
    if (bitacoraData.some((b) => String(b.tipo || "").trim() === t && String(b.programa || "").trim() === n)) names.add(n);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function refreshPlanningCampaignFormCombos() {
  ensureCatalogosSistemaShape();
  const tipoSel = programTypeSelect?.value || "";
  const trackSel = trackingSelect?.value || "";
  const platSel = plataformaSelect?.value || "";
  const intakeSel = intakeSelect?.value || "";

  fillHtmlSelectFromCatalog(
    programTypeSelect,
    `<option value="">Seleccionar tipo</option>`,
    catalogosSistema.tipos,
    tipoSel
  );
  fillHtmlSelectFromCatalog(trackingSelect, `<option value="">Seleccionar</option>`, catalogosSistema.tracking, trackSel);
  fillHtmlSelectFromCatalog(plataformaSelect, `<option value="">Seleccionar</option>`, catalogosSistema.plataformas, platSel);
  fillHtmlSelectFromCatalog(intakeSelect, `<option value="">Seleccionar intake</option>`, catalogosSistema.intakes, intakeSel);
}

function refreshPlanningToolbarFilterCombos() {
  ensureCatalogosSistemaShape();
  const tipoF = filterTipo?.value || "";
  const intakeF = filterIntake?.value || "";
  fillHtmlSelectFromCatalog(filterTipo, `<option value="">Todos</option>`, catalogosSistema.tipos, tipoF);
  fillHtmlSelectFromCatalog(filterIntake, `<option value="">Todos</option>`, catalogosSistema.intakes, intakeF);
  const platSel = document.getElementById("filterPlataformaPlanning");
  if (platSel instanceof HTMLSelectElement) {
    fillHtmlSelectFromCatalog(
      platSel,
      `<option value="">Todos</option>`,
      catalogosSistema.plataformas,
      platSel.value || ""
    );
  }
}

function refreshPlanningCatalogUi() {
  refreshPlanningToolbarFilterCombos();
  refreshPlanningCampaignFormCombos();
  updateFilterProgramaState();
}

let percentWeights = Array.from({ length: 12 }, () => 0);
let manualPercent = Array.from({ length: 12 }, () => false);
let lastPreview = null;
/** Overrides manuales de inversión por mes en vista previa (0-11); null = calcular por % */
let formPreviewInvOverride = Array.from({ length: 12 }, () => null);
/** Overrides manuales de leads por mes en vista previa; null = repartir según inversión */
let formPreviewLeadsOverride = Array.from({ length: 12 }, () => null);
/** Candado por fila/mes: si true, no se recalcula presupuesto ni leads del mes. */
let formPreviewRowLocked = Array.from({ length: 12 }, () => false);
const META_FIELDS = ["leads", "interesados", "postulantes", "matriculados", "cplMeta"];

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 1e-9) return `$${Math.round(n)}`;
  return `$${parseFloat(n.toFixed(10))}`;
}

function formatMoneyCc(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const hasDecimals = Math.abs(n - Math.round(n)) >= 1e-9;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0
  });
}

/** CPL siempre entero (sin decimales). */
function formatCpl(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.round(n));
}

function addDaysToDateString(yyyyMmDd, days) {
  const d = parseDateInput(yyyyMmDd);
  if (!d) return "";
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return formatDateInputFromDate(next);
}

/** Mismo tipo, programa, tracking, plataforma: solape de rangos [fi1,ff1] y [fi2,ff2] */
function dateRangesOverlap(fi1, ff1, fi2, ff2) {
  const a = parseDateInput(fi1);
  const b = parseDateInput(ff1);
  const c = parseDateInput(fi2);
  const d = parseDateInput(ff2);
  if (!a || !b || !c || !d) return false;
  return a <= d && b >= c;
}

function hasIntakeDateOverlap(candidate, excludeId = null) {
  if (planningTipoSinRestriccionCruceFechas(candidate.tipo)) return false;
  return planningDraftRecords().some((r) => {
    if (excludeId != null && samePlanningRecordId(r.id, excludeId)) return false;
    if (planningTipoSinRestriccionCruceFechas(r.tipo)) return false;
    if (
      r.tipo !== candidate.tipo ||
      r.programa !== candidate.programa ||
      r.tracking !== candidate.tracking ||
      r.plataforma !== candidate.plataforma
    ) {
      return false;
    }
    if (r.intake === candidate.intake) return false;
    return dateRangesOverlap(candidate.fechaInicio, candidate.fechaFin, r.fechaInicio, r.fechaFin);
  });
}

/** Fecha mínima de inicio: día siguiente al máximo fechaFin existente (mismo tipo, programa, tracking, plataforma). */
function computeMinFechaInicioForForm(excludeId = null) {
  const tipo = programTypeSelect?.value || "";
  const programa = (programNameInput?.value || "").trim();
  const tracking = trackingSelect?.value || "";
  const plataforma = plataformaSelect?.value || "";
  if (!tipo || !programa || !tracking || !plataforma) return null;
  if (planningTipoSinRestriccionCruceFechas(tipo)) return null;
  let maxEnd = null;
  for (const r of planningDraftRecords()) {
    if (excludeId != null && samePlanningRecordId(r.id, excludeId)) continue;
    if (r.tipo !== tipo || r.programa !== programa || r.tracking !== tracking || r.plataforma !== plataforma) continue;
    const e = parseDateInput(r.fechaFin);
    if (!e) continue;
    if (!maxEnd || e > maxEnd) maxEnd = e;
  }
  if (!maxEnd) return null;
  return addDaysToDateString(formatDateInputFromDate(maxEnd), 1);
}

function applyFormDateConstraints(options = {}) {
  const { preserveValues = false } = options;
  const minStart = computeMinFechaInicioForForm(editingRecordId);
  const minStartParsed = minStart ? parseDateInput(minStart) : null;
  if (startDateInput) {
    if (minStart) startDateInput.setAttribute("min", minStart);
    else startDateInput.removeAttribute("min");
    const sp = parseDateInput(startDateInput.value || "");
    if (!preserveValues && minStartParsed && sp && sp < minStartParsed) startDateInput.value = "";
  }
  const startVal = startDateInput?.value || "";
  const startParsed = parseDateInput(startVal);
  if (endDateInput) {
    if (!startVal || !startParsed) {
      endDateInput.disabled = true;
      endDateInput.value = "";
      endDateInput.removeAttribute("min");
    } else {
      endDateInput.disabled = false;
      const minEnd = addDaysToDateString(startVal, 1);
      if (minEnd) endDateInput.setAttribute("min", minEnd);
      const endVal = endDateInput.value;
      if (endVal) {
        const endParsed = parseDateInput(endVal);
        const minEndParsed = parseDateInput(minEnd);
        if (!preserveValues && endParsed && minEndParsed && endParsed < minEndParsed) endDateInput.value = "";
      }
    }
  }
}

/** Visualización Inicio/Fin en tabla: dd-Mmm en inglés (solo display; el dato sigue siendo YYYY-MM-DD). */
function formatDateDdMmm(value) {
  const d = parseDateInput(value);
  if (!d) return "";
  const day = String(d.getDate()).padStart(2, "0");
  return `${day}-${MONTHS_EN_SHORT[d.getMonth()]}`;
}

function parseDateInput(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const parsed = new Date(year, month - 1, day);
  const valid = parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  return valid ? parsed : null;
}

function normalizeDateValueForInput(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateInputFromDate(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (parseDateInput(raw)) return raw;
  const ymdLoose = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymdLoose) {
    const y = Number(ymdLoose[1]);
    const m = Number(ymdLoose[2]);
    const d = Number(ymdLoose[3]);
    const parsed = new Date(y, m - 1, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) {
      return formatDateInputFromDate(parsed);
    }
  }
  const dmyLoose = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyLoose) {
    const d = Number(dmyLoose[1]);
    const m = Number(dmyLoose[2]);
    const y = Number(dmyLoose[3]);
    const parsed = new Date(y, m - 1, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) {
      return formatDateInputFromDate(parsed);
    }
  }
  const parsedNative = new Date(raw);
  if (!Number.isNaN(parsedNative.getTime())) {
    return formatDateInputFromDate(parsedNative);
  }
  return "";
}

function formatDateInputFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysInCalendarMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Días del rango [rangeStart, rangeEnd] que caen en el mes (year, monthIndex) — inicio/fin de mes correctos */
function countDaysInMonthIntersection(rangeStart, rangeEnd, year, monthIndex) {
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) return 0;
  const dim = daysInCalendarMonth(year, monthIndex);
  const monthFirst = new Date(year, monthIndex, 1, 12, 0, 0);
  const monthLast = new Date(year, monthIndex, dim, 12, 0, 0);
  const rs = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(), 12, 0, 0);
  const re = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 12, 0, 0);
  const segStart = rs > monthFirst ? rs : monthFirst;
  const segEnd = re < monthLast ? re : monthLast;
  if (segStart > segEnd) return 0;
  return Math.floor((segEnd - segStart) / 86400000) + 1;
}

function clipRangeToYear(fechaInicio, fechaFin, year) {
  const s = parseDateInput(fechaInicio);
  const e = parseDateInput(fechaFin);
  if (!s || !e || s > e) return null;
  const yStart = new Date(year, 0, 1, 12, 0, 0);
  const yEnd = new Date(year, 11, 31, 12, 0, 0);
  const rs = s < yStart ? yStart : s;
  const re = e > yEnd ? yEnd : e;
  if (rs > re) return null;
  return { fechaInicio: formatDateInputFromDate(rs), fechaFin: formatDateInputFromDate(re) };
}

function countDaysByMonthForRangeInYear(fechaInicio, fechaFin, year) {
  const monthly = Array.from({ length: 12 }, () => 0);
  const clip = clipRangeToYear(fechaInicio, fechaFin, year);
  if (!clip) return monthly;
  const s = parseDateInput(clip.fechaInicio);
  const e = parseDateInput(clip.fechaFin);
  if (!s || !e) return monthly;
  for (let m = 0; m < 12; m += 1) {
    monthly[m] = countDaysInMonthIntersection(s, e, year, m);
  }
  return monthly;
}

function distributeInteger(total, weights) {
  const sumWeights = weights.reduce((acc, n) => acc + n, 0);
  if (sumWeights === 0 || total <= 0) return Array.from({ length: weights.length }, () => 0);
  const raw = weights.map((w) => (total * w) / sumWeights);
  const base = raw.map((n) => Math.floor(n));
  let remainder = total - base.reduce((acc, n) => acc + n, 0);
  const order = raw.map((n, idx) => ({ idx, decimal: n - Math.floor(n) })).sort((a, b) => b.decimal - a.decimal);
  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    base[order[i].idx] += 1;
    remainder -= 1;
  }
  return base;
}

function distributeBudget(totalBudget, weights) {
  const budget = Number(totalBudget) || 0;
  if (Math.abs(budget - Math.round(budget)) < 1e-9) {
    return distributeInteger(Math.round(budget), weights);
  }
  const cents = distributeInteger(Math.round(budget * 100), weights);
  return cents.map((n) => n / 100);
}

/** Ajusta inversión mensual respetando overrides y repartiendo el resto como en planning guardado. */
function applyMonthlyInvOverridesToDistribution(baseInv, monthlyDays, totalBudget, overrides) {
  const presupuesto = Number(totalBudget) || 0;
  const presupuestoEntero = Math.abs(presupuesto - Math.round(presupuesto)) < 1e-9;
  const inv = baseInv.slice();
  const fixed = new Set();
  for (let i = 0; i < 12; i += 1) {
    if (overrides[i] != null && overrides[i] !== undefined && monthlyDays[i] > 0) {
      const raw = Math.max(0, Number(overrides[i]) || 0);
      inv[i] = presupuestoEntero ? Math.round(raw) : raw;
      fixed.add(i);
    }
  }
  let sumFixed = [...fixed].reduce((s, i) => s + inv[i], 0);
  if (sumFixed > presupuesto && sumFixed > 0) {
    if (presupuestoEntero) {
      const fixedIdx = [...fixed];
      const fixedWeights = fixedIdx.map((i) => Math.max(0, inv[i] || 0));
      const distFixed = distributeInteger(Math.round(presupuesto), fixedWeights);
      fixedIdx.forEach((i, j) => {
        inv[i] = distFixed[j] || 0;
      });
    } else {
      const f = presupuesto / sumFixed;
      fixed.forEach((i) => {
        inv[i] *= f;
      });
    }
    sumFixed = presupuesto;
  }
  const remaining = Math.max(0, presupuesto - sumFixed);
  const flexIdx = [];
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] > 0 && !fixed.has(i)) flexIdx.push(i);
  }
  const flexW = flexIdx.map((i) => baseInv[i] || 0);
  const sumW = flexW.reduce((a, b) => a + b, 0);
  if (flexIdx.length) {
    if (sumW > 0 && remaining >= 0) {
      const dist = presupuestoEntero
        ? distributeInteger(Math.round(remaining), flexW)
        : distributeBudget(remaining, flexW);
      flexIdx.forEach((i, j) => {
        inv[i] = dist[j] || 0;
      });
    } else {
      if (presupuestoEntero) {
        const eqDist = distributeInteger(Math.round(remaining), flexIdx.map(() => 1));
        flexIdx.forEach((i, j) => {
          inv[i] = eqDist[j] || 0;
        });
      } else {
        const eq = remaining / flexIdx.length;
        flexIdx.forEach((i) => {
          inv[i] = eq;
        });
      }
    }
  }
  return inv;
}

function computeMonthlyArraysForRecord(record, year) {
  const monthlyDays = countDaysByMonthForRangeInYear(record.fechaInicio, record.fechaFin, year);
  const weights = monthlyDays.map((d) => (d > 0 ? d : 0));
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!sumW) {
    return {
      monthlyInvestment: Array.from({ length: 12 }, () => 0),
      monthlyLeads: Array.from({ length: 12 }, () => 0),
      monthlyCpl: Array.from({ length: 12 }, () => 0)
    };
  }
  const percents = distributeInteger(100, weights);
  const monthlyInvestment = distributeBudget(record.presupuesto, percents);
  const monthlyLeads = distributeInteger(record.leads, percents);
  const monthlyCpl = monthlyInvestment.map((inv, idx) =>
    monthlyLeads[idx] > 0 ? Math.round(inv / monthlyLeads[idx]) : 0
  );
  return { monthlyInvestment, monthlyLeads, monthlyCpl };
}

function monthlyArraysFromDistribucionMensual(dm) {
  if (!dm || typeof dm !== "object") return null;
  if (
    Array.isArray(dm.presupuesto) &&
    dm.presupuesto.length === 12 &&
    Array.isArray(dm.leads) &&
    dm.leads.length === 12
  ) {
    const monthlyInvestment = dm.presupuesto.map((x) => Number(x) || 0);
    const monthlyLeads = dm.leads.map((x) => Math.max(0, Math.round(Number(x) || 0)));
    const monthlyCpl = monthlyInvestment.map((inv, idx) =>
      monthlyLeads[idx] > 0 ? Math.round(inv / monthlyLeads[idx]) : 0
    );
    return { monthlyInvestment, monthlyLeads, monthlyCpl };
  }
  const monthlyInvestment = Array.from({ length: 12 }, () => 0);
  const monthlyLeads = Array.from({ length: 12 }, () => 0);
  let found = false;
  for (let i = 0; i < 12; i += 1) {
    const cell = dm[DIST_MES_KEYS[i]];
    if (!cell || typeof cell !== "object") continue;
    if (!("presupuesto" in cell) && !("leads" in cell)) continue;
    found = true;
    monthlyInvestment[i] = Number(cell.presupuesto) || 0;
    monthlyLeads[i] = Math.max(0, Math.round(Number(cell.leads) || 0));
  }
  if (!found) return null;
  const monthlyCpl = monthlyInvestment.map((inv, idx) =>
    monthlyLeads[idx] > 0 ? Math.round(inv / monthlyLeads[idx]) : 0
  );
  return { monthlyInvestment, monthlyLeads, monthlyCpl };
}

function computeMonthlyArraysForRecordWithOverrides(record, year) {
  const fromDm = monthlyArraysFromDistribucionMensual(record.distribucionMensual);
  if (fromDm) {
    return fromDm;
  }
  const monthlyDays = countDaysByMonthForRangeInYear(record.fechaInicio, record.fechaFin, year);
  const base = computeMonthlyArraysForRecord(record, year);
  const ov = record.monthlyInvOverride;
  if (!ov || !ov.some((x) => x != null && x !== undefined && Number(x) >= 0)) {
    return base;
  }
  const presupuesto = Number(record.presupuesto) || 0;
  const leads = Number(record.leads) || 0;
  const inv = base.monthlyInvestment.slice();
  const fixed = new Set();
  for (let i = 0; i < 12; i += 1) {
    if (ov[i] != null && ov[i] !== undefined && monthlyDays[i] > 0) {
      inv[i] = Math.max(0, Number(ov[i]) || 0);
      fixed.add(i);
    }
  }
  let sumFixed = [...fixed].reduce((s, i) => s + inv[i], 0);
  if (sumFixed > presupuesto && sumFixed > 0) {
    const f = presupuesto / sumFixed;
    fixed.forEach((i) => {
      inv[i] *= f;
    });
    sumFixed = presupuesto;
  }
  const remaining = Math.max(0, presupuesto - sumFixed);
  const flexIdx = [];
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] > 0 && !fixed.has(i)) flexIdx.push(i);
  }
  const flexW = flexIdx.map((i) => base.monthlyInvestment[i] || 0);
  const sumW = flexW.reduce((a, b) => a + b, 0);
  if (flexIdx.length) {
    if (sumW > 0 && remaining >= 0) {
      const dist = distributeBudget(remaining, flexW);
      flexIdx.forEach((i, j) => {
        inv[i] = dist[j] || 0;
      });
    } else {
      const eq = remaining / flexIdx.length;
      flexIdx.forEach((i) => {
        inv[i] = eq;
      });
    }
  }
  const weights = inv.map((v) => (v > 0 ? v : 0));
  const monthlyLeads = distributeInteger(leads, weights);
  const monthlyCpl = inv.map((invi, idx) => (monthlyLeads[idx] > 0 ? Math.round(invi / monthlyLeads[idx]) : 0));
  return { monthlyInvestment: inv, monthlyLeads, monthlyCpl };
}

function buildRecordRow(record) {
  const rid = String(record.id);
  const year = parseDateInput(record.fechaInicio)?.getFullYear() || new Date().getFullYear();
  const { monthlyInvestment, monthlyLeads, monthlyCpl } = computeMonthlyArraysForRecordWithOverrides(record, year);
  const monthlyDays = countDaysByMonthForRangeInYear(record.fechaInicio, record.fechaFin, year);
  const t = (s) => escapeHtml(String(s ?? ""));
  const row = document.createElement("tr");
  row.setAttribute("data-record-id", rid);
  const metas = record.metas || {};
  const metaCells = ["leads", "interesados", "postulantes", "matriculados", "cplMeta"]
    .map((key, idx) => {
      const raw = metas[key];
      let cellText = "";
      if (raw !== "" && raw !== undefined && raw !== null) {
        if (key === "cplMeta" && Number.isFinite(Number(raw))) cellText = formatCpl(raw);
        else cellText = String(raw);
      }
      const cls = idx === 4 ? "group-end" : "";
      return `<td class="${cls} planning-meta-cell planning-cell-dbl-editable" data-meta-key="${key}" data-record-id="${rid}">${t(cellText)}</td>`;
    })
    .join("");
  const mxInv = monthlyInvestment.reduce((a, v) => Math.max(a, Number(v) || 0), 0);
  const mxLead = monthlyLeads.reduce((a, v) => Math.max(a, Math.round(Number(v) || 0)), 0);
  const mxCpl = monthlyCpl.reduce((a, v) => Math.max(a, Number(v) || 0), 0);
  const configCells = `
    <td class="planning-body-cell planning-cell-intake planning-cell-readonly" data-record-id="${rid}">${t(record.intake)}</td>
    <td class="planning-body-cell planning-cell-dbl-editable" data-planning-edit="fechaInicio" data-record-id="${rid}">${t(formatDateDdMmm(record.fechaInicio))}</td>
    <td class="planning-body-cell planning-cell-dbl-editable" data-planning-edit="fechaFin" data-record-id="${rid}">${t(formatDateDdMmm(record.fechaFin))}</td>
    <td class="planning-body-cell planning-cell-plat planning-cell-readonly" data-record-id="${rid}">${planningPlataformaCellHtml(record.plataforma)}</td>
    <td class="planning-body-cell planning-cell-tracking planning-cell-readonly" data-record-id="${rid}"><span class="planning-tracking-label">${t(record.tracking)}</span></td>
    <td class="planning-body-cell planning-presupuesto-cell planning-cell-readonly" data-record-id="${rid}"><span class="planning-presupuesto-val">${escapeHtml(formatMoney(record.presupuesto) || "")}</span></td>
    <td class="group-end planning-body-cell planning-leads-total-cell planning-cell-readonly" data-record-id="${rid}"><span class="planning-leads-total-chip">${t(record.leads)}</span></td>
  `;
  const invCells = Array.from({ length: 12 }, (_, i) => {
    const cls = i === 11 ? "group-end" : "";
    if (monthlyDays[i] === 0) return `<td class="${cls} planning-mes-muted"></td>`;
    const v = monthlyInvestment[i];
    const tier = planningPillTier(v, mxInv);
    const inner = escapeHtml(formatMoney(v) || "");
    return `<td class="${cls} planning-cell-mes-inv planning-cell-dbl-editable" data-mcol-inv="${i}" data-record-id="${rid}"><span class="planning-pill planning-pill-inv ${tier}">${inner}</span></td>`;
  }).join("");
  const leadCells = monthlyLeads
    .map((n, i) => {
      const cls = i === 11 ? "group-end" : "";
      if (monthlyDays[i] === 0) return `<td class="${cls} planning-mes-muted"></td>`;
      const rn = Math.round(Number(n) || 0);
      const tier = planningPillTier(rn, mxLead);
      return `<td class="${cls} planning-cell-mes-lead planning-cell-dbl-editable" data-mcol-lead="${i}" data-record-id="${rid}"><span class="planning-pill planning-pill-lead ${tier}">${t(String(rn))}</span></td>`;
    })
    .join("");
  const cplCells = monthlyCpl
    .map((n, i) => {
      const cls = i === 11 ? "group-end" : "";
      if (monthlyDays[i] <= 0) return `<td class="${cls} planning-mes-muted"></td>`;
      const inner = n > 0 ? escapeHtml(formatCpl(n) || "") : "";
      const tier = n > 0 ? planningPillTier(n, mxCpl) : "planning-pill-tier--ghost";
      return `<td class="${cls} planning-cell-mes-cpl planning-cell-readonly" data-mcol-cpl="${i}" data-record-id="${rid}"><span class="planning-pill planning-pill-cpl ${tier}">${inner}</span></td>`;
    })
    .join("");
  row.innerHTML = `
    <td class="sticky-col-tipo planning-sticky-tipo planning-cell-readonly" data-record-id="${rid}"><span class="${planningTipoBadgeClassFromTipo(record.tipo)}">${t(record.tipo)}</span></td>
    <td class="sticky-col-program group-end planning-sticky-program planning-cell-readonly" data-record-id="${rid}">
      <span class="planning-campaign-name planning-campaign-name--only">${t(record.programa)}</span>
    </td>
    ${metaCells}
    ${configCells}
    ${invCells}${leadCells}${cplCells}`;
  return row;
}

/** Año de referencia para columnas mensuales de una fila de planning. */
function planningYearForRecord(record) {
  return parseDateInput(record.fechaInicio)?.getFullYear() || new Date().getFullYear();
}

/** Iguala presupuesto y leads totales del registro con la suma de la distribución mensual calculada. */
function syncRecordBudgetTotalsFromComputedMonths(record) {
  const y = planningYearForRecord(record);
  const { monthlyInvestment, monthlyLeads } = computeMonthlyArraysForRecordWithOverrides(record, y);
  let sumInv = 0;
  let sumLeads = 0;
  for (let i = 0; i < 12; i += 1) {
    sumInv += Number(monthlyInvestment[i]) || 0;
    sumLeads += Math.max(0, Math.round(Number(monthlyLeads[i]) || 0));
  }
  record.presupuesto = sumInv;
  record.leads = sumLeads;
}

/** Congela la vista mensual actual en `distribucionMensual` y quita overrides sueltos (coherente con edición en tabla). */
function materializeDistribucionPreservingComputed(record) {
  const y = planningYearForRecord(record);
  const calc = computeMonthlyArraysForRecordWithOverrides(record, y);
  const dm = {};
  for (let i = 0; i < 12; i += 1) {
    dm[DIST_MES_KEYS[i]] = {
      presupuesto: Math.max(0, Number(calc.monthlyInvestment[i]) || 0),
      leads: Math.max(0, Math.round(Number(calc.monthlyLeads[i]) || 0))
    };
  }
  record.distribucionMensual = dm;
  record.monthlyInvOverride = undefined;
}

function applyPlanningPresupuestoTotalFromCell(record, rawText) {
  const nt = Math.max(0, Number(String(rawText ?? "").replace(/[$,\s]/g, "")) || 0);
  const y = planningYearForRecord(record);
  const { monthlyInvestment } = computeMonthlyArraysForRecordWithOverrides(record, y);
  const oldSum = monthlyInvestment.reduce((a, x) => a + (Number(x) || 0), 0);
  record.presupuesto = nt;
  if (oldSum <= 0) {
    record.distribucionMensual = undefined;
    record.monthlyInvOverride = undefined;
    return;
  }
  const factor = nt / oldSum;
  const dm = record.distribucionMensual;
  if (dm && typeof dm === "object" && !Array.isArray(dm.presupuesto)) {
    for (let i = 0; i < 12; i += 1) {
      const c = dm[DIST_MES_KEYS[i]];
      if (c && typeof c === "object" && "presupuesto" in c) c.presupuesto = Math.max(0, (Number(c.presupuesto) || 0) * factor);
    }
    return;
  }
  if (record.monthlyInvOverride) {
    record.monthlyInvOverride = record.monthlyInvOverride.map((x) =>
      x != null && Number.isFinite(Number(x)) ? Math.max(0, Number(x) * factor) : x
    );
  }
}

function applyPlanningLeadsTotalFromCell(record, rawText) {
  const nl = Math.max(0, Math.round(Number(String(rawText ?? "").replace(/\D/g, "")) || 0));
  const y = planningYearForRecord(record);
  const { monthlyLeads } = computeMonthlyArraysForRecordWithOverrides(record, y);
  const oldSum = monthlyLeads.reduce((a, x) => a + Math.max(0, Math.round(Number(x) || 0)), 0);
  record.leads = nl;
  if (oldSum <= 0) return;
  const factor = nl / oldSum;
  const dm = record.distribucionMensual;
  if (dm && typeof dm === "object" && !Array.isArray(dm.presupuesto)) {
    for (let i = 0; i < 12; i += 1) {
      const c = dm[DIST_MES_KEYS[i]];
      if (c && typeof c === "object" && "leads" in c) c.leads = Math.max(0, Math.round((Number(c.leads) || 0) * factor));
    }
  }
}

function setPlanningMonthlyInvFromCell(record, monthIdx, rawText) {
  materializeDistribucionPreservingComputed(record);
  const key = DIST_MES_KEYS[monthIdx];
  const v = String(rawText ?? "").trim();
  const num = v === "" ? 0 : Math.max(0, Number(v));
  const invVal = Number.isFinite(num) ? num : 0;
  if (!record.distribucionMensual[key] || typeof record.distribucionMensual[key] !== "object")
    record.distribucionMensual[key] = { presupuesto: 0, leads: 0 };
  record.distribucionMensual[key].presupuesto = invVal;
  syncRecordBudgetTotalsFromComputedMonths(record);
}

function setPlanningMonthlyLeadFromCell(record, monthIdx, rawText) {
  materializeDistribucionPreservingComputed(record);
  const key = DIST_MES_KEYS[monthIdx];
  const leadsVal = Math.max(0, Math.round(Number(String(rawText ?? "").replace(/\D/g, "")) || 0));
  if (!record.distribucionMensual[key] || typeof record.distribucionMensual[key] !== "object")
    record.distribucionMensual[key] = { presupuesto: 0, leads: 0 };
  record.distribucionMensual[key].leads = leadsVal;
  syncRecordBudgetTotalsFromComputedMonths(record);
}

function setPlanningMonthlyCplFromCell(record, monthIdx, rawText) {
  materializeDistribucionPreservingComputed(record);
  const y = planningYearForRecord(record);
  const calc = computeMonthlyArraysForRecordWithOverrides(record, y);
  const inv = Number(calc.monthlyInvestment[monthIdx]) || 0;
  const cpl = Math.max(0, Number(String(rawText ?? "").replace(/[$,\s]/g, "")) || 0);
  const leads = cpl > 0 ? Math.max(0, Math.round(inv / cpl)) : 0;
  const key = DIST_MES_KEYS[monthIdx];
  if (!record.distribucionMensual[key] || typeof record.distribucionMensual[key] !== "object")
    record.distribucionMensual[key] = { presupuesto: 0, leads: 0 };
  record.distribucionMensual[key].leads = leads;
  syncRecordBudgetTotalsFromComputedMonths(record);
}

function planningEstadoCampana(record) {
  const fi = parseDateInput(record.fechaInicio);
  const ff = parseDateInput(record.fechaFin);
  if (!fi || !ff) return "Borrador";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (ff < today) return "Pausada";
  if (fi > today) return "Programada";
  return "Activa";
}

function planningRecordOverlapsToolbarDateFilter(record) {
  if (!planningFilterFechaIni || !planningFilterFechaFin) return true;
  return dateRangesOverlap(
    record.fechaInicio,
    record.fechaFin,
    planningFilterFechaIni,
    planningFilterFechaFin
  );
}

function planningPillTier(value, mx) {
  const n = Number(value) || 0;
  if (n <= 0) return "planning-pill-tier--ghost";
  if (!(mx > 0)) return "planning-pill-tier--md";
  const r = n / mx;
  if (r >= 0.72) return "planning-pill-tier--hi";
  if (r >= 0.38) return "planning-pill-tier--md";
  return "planning-pill-tier--lo";
}

function planningTipoBadgeClassFromTipo(tipo) {
  const t = String(tipo || "").toLowerCase();
  if (t.includes("charla")) return "planning-tipo-badge planning-tipo-badge--charla";
  if (t.includes("webinar")) return "planning-tipo-badge planning-tipo-badge--webinar";
  if (t.includes("alcance")) return "planning-tipo-badge planning-tipo-badge--alcance";
  if (t.includes("di") || t === "di") return "planning-tipo-badge planning-tipo-badge--di";
  if (
    t.includes("convers") ||
    t.includes("conversion") ||
    t.includes("tráfico") ||
    t.includes("trafico")
  ) return "planning-tipo-badge planning-tipo-badge--conv";
  return "planning-tipo-badge planning-tipo-badge--default";
}

function planningEstadoBadgeClass(estado) {
  switch (estado) {
    case "Activa":
      return "planning-status-badge planning-status-badge--activa";
    case "Programada":
      return "planning-status-badge planning-status-badge--programada";
    case "Pausada":
      return "planning-status-badge planning-status-badge--pausada";
    default:
      return "planning-status-badge planning-status-badge--borrador";
  }
}

function planningPlataformaCellHtml(platform) {
  const p = String(platform || "").trim();
  const pl = p.toLowerCase();
  let iconClass = "fa-solid fa-bullhorn";
  let mod = "planning-plat--default";
  if (pl.includes("meta") || pl.includes("facebook") || pl.includes("instagram")) {
    iconClass = "fa-brands fa-facebook-f";
    mod = "planning-plat--meta";
  } else if (pl.includes("google")) {
    iconClass = "fa-brands fa-google";
    mod = "planning-plat--google";
  } else if (pl.includes("tiktok")) {
    iconClass = "fa-brands fa-tiktok";
    mod = "planning-plat--tiktok";
  } else if (pl.includes("linkedin")) {
    iconClass = "fa-brands fa-linkedin-in";
    mod = "planning-plat--linkedin";
  }
  const disp = escapeHtml(p || "—");
  return `<span class="planning-plat-cell ${mod}"><i class="${iconClass}" aria-hidden="true"></i><span>${disp}</span></span>`;
}

function getFilteredRecords() {
  const tipo = filterTipo?.value || "";
  const programaEnabled = filterPrograma && !filterPrograma.disabled;
  const programaQ = programaEnabled ? (filterPrograma.value || "").trim().toLowerCase() : "";
  const intake = filterIntake?.value || "";
  const platEl = document.getElementById("filterPlataformaPlanning");
  const plat = platEl instanceof HTMLSelectElement ? String(platEl.value || "").trim() : "";
  const estEl = document.getElementById("filterEstadoPlanning");
  const estadoFiltro = estEl instanceof HTMLSelectElement ? String(estEl.value || "").trim() : "";
  const qEl = document.getElementById("planningToolbarSearch");
  const q = qEl instanceof HTMLInputElement ? String(qEl.value || "").trim().toLowerCase() : "";
  const filtered = ensurePlanningDraftShape().records.filter((r) => {
    if (tipo && r.tipo !== tipo) return false;
    if (intake && r.intake !== intake) return false;
    if (programaQ && !String(r.programa || "").toLowerCase().includes(programaQ)) return false;
    if (plat && String(r.plataforma || "").trim() !== plat) return false;
    if (estadoFiltro && planningEstadoCampana(r) !== estadoFiltro) return false;
    if (!planningRecordOverlapsToolbarDateFilter(r)) return false;
    if (q) {
      const blob = [
        r.programa,
        r.tipo,
        r.tracking,
        r.plataforma,
        r.intake,
        r.fechaInicio,
        r.fechaFin,
      ]
        .map((x) => String(x || "").toLowerCase())
        .join(" ");
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  return filtered.sort((a, b) =>
    String(a.programa || "").localeCompare(String(b.programa || ""), "es", { sensitivity: "base" }));
}

function syncSelectionToFilter() {
  if (!selectedRecordId) return;
  if (!getFilteredRecords().some((r) => samePlanningRecordId(r.id, selectedRecordId))) selectedRecordId = null;
}

function refreshProgramaFilterList() {
  if (!filterProgramaList || !filterTipo) return;
  const tipo = filterTipo.value || "";
  if (!tipo) {
    filterProgramaList.innerHTML = "";
    return;
  }
  const names = collectProgramNamesForPlanningTipo(tipo);
  filterProgramaList.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
}

function updateFilterProgramaState() {
  if (!filterPrograma || !filterTipo) return;
  const tipo = filterTipo.value || "";
  if (!tipo) {
    filterPrograma.disabled = true;
    filterPrograma.value = "";
    if (filterProgramaList) filterProgramaList.innerHTML = "";
  } else {
    filterPrograma.disabled = false;
    refreshProgramaFilterList();
  }
}

function updatePlanningKpis() {
  const list = getFilteredRecords();
  let inv = 0;
  let activas = 0;
  let impEst = 0;
  let clkEst = 0;
  let leadsSum = 0;
  for (const r of list) {
    const p = Number(r.presupuesto) || 0;
    inv += p;
    if (planningEstadoCampana(r) === "Activa") activas += 1;
    const L = Math.max(0, Math.round(Number(r.leads) || 0));
    leadsSum += L;
    if (L > 0) {
      impEst += Math.round(L * 420);
      clkEst += Math.round(L * 22);
    } else {
      impEst += Math.round(p * 28);
      clkEst += Math.round(Math.max(p * 0.9, 0));
    }
  }
  const valorLeadRef = 45;
  const roas = inv > 0 ? (leadsSum * valorLeadRef) / inv : 0;
  const invStr = formatMoney(inv) || "$0";
  if (totalInversionValue) totalInversionValue.textContent = invStr;
  const setTxt = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const fmtK = (n) => {
    const x = Math.round(Number(n) || 0);
    if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
    if (x >= 10_000) return `${Math.round(x / 1000)}k`;
    return String(x);
  };
  setTxt("planningKpiInversion", invStr);
  setTxt("planningKpiActivas", String(activas));
  setTxt("planningKpiImpresiones", fmtK(impEst));
  setTxt("planningKpiClics", fmtK(clkEst));
  setTxt("planningKpiLeadsTotal", fmtK(leadsSum));
  setTxt("planningKpiRoas", inv > 0 && leadsSum > 0 && roas > 0 ? `${roas.toFixed(1)}×` : "—");
}

function updateTotalInversion() {
  updatePlanningKpis();
}

function updateActionButtons() {
  const has = Boolean(selectedRecordId);
  if (editRecordBtn) editRecordBtn.disabled = !has;
  if (deleteRecordBtn) deleteRecordBtn.disabled = !has;
}

const PLANNING_GROUP_TONE_COUNT = 6;
const PLANNING_GROUP_TONE_CLASS_PREFIX = "planning-row-group-tone-";

function measurePlanningCellIntrinsicWidth(cell) {
  if (!(cell instanceof HTMLElement)) return 0;
  const cs = window.getComputedStyle(cell);
  const clone = cell.cloneNode(true);
  clone.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    "display:table-cell",
    `vertical-align:${cs.verticalAlign}`,
    "width:auto!important",
    "max-width:none!important",
    "min-width:0!important",
    `padding:${cs.padding}`,
    `font-size:${cs.fontSize}`,
    `font-weight:${cs.fontWeight}`,
    `font-family:${cs.fontFamily}`,
    `letter-spacing:${cs.letterSpacing}`,
    "box-sizing:border-box",
    "white-space:nowrap",
    `border:${cs.border}`,
  ].join(";");
  clone.querySelectorAll("*").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    el.style.maxWidth = "none";
    el.style.overflow = "visible";
    el.style.textOverflow = "clip";
    el.style.whiteSpace = "nowrap";
  });
  document.body.appendChild(clone);
  const w = clone.getBoundingClientRect().width;
  document.body.removeChild(clone);
  return Number.isFinite(w) ? w : 0;
}

function refreshPlanningStickyColumnWidths() {
  const mod = document.getElementById("planningModule");
  const table = planningBody?.closest("table");
  if (!mod?.classList.contains("plan-module-saas") || !table || !planningBody) return;

  let maxTipo = 0;
  table.querySelectorAll("thead th.sticky-col-tipo, tbody td.planning-sticky-tipo").forEach((cell) => {
    maxTipo = Math.max(maxTipo, measurePlanningCellIntrinsicWidth(cell));
  });
  let maxProg = 0;
  table.querySelectorAll("thead th.sticky-col-program, tbody td.sticky-col-program").forEach((cell) => {
    maxProg = Math.max(maxProg, measurePlanningCellIntrinsicWidth(cell));
  });

  const minTipo = 48;
  const minProg = 88;
  const capTipo = 260;
  const capProg = 520;
  const wTipo = Math.min(capTipo, Math.max(minTipo, Math.ceil(maxTipo + 6)));
  const wProg = Math.min(capProg, Math.max(minProg, Math.ceil(maxProg + 8)));

  mod.style.setProperty("--plan-sticky-tipo-w", `${wTipo}px`);
  mod.style.setProperty("--plan-sticky-program-w", `${wProg}px`);
}

function scheduleRefreshPlanningStickyColumnWidths() {
  requestAnimationFrame(() => {
    requestAnimationFrame(refreshPlanningStickyColumnWidths);
  });
}

function refreshPlanningProgramGroupBands() {
  if (!planningBody) return;
  const records = getFilteredRecords();
  const idToProg = new Map(records.map((r) => [String(r.id), String(r.programa ?? "").trim()]));
  const rows = [...planningBody.querySelectorAll("tr[data-record-id]")];
  let prevKey = null;
  let groupCounter = -1;
  rows.forEach((tr) => {
    const id = tr.getAttribute("data-record-id");
    const key = idToProg.get(String(id)) ?? "";
    if (prevKey !== key) {
      groupCounter++;
      prevKey = key;
    }
    const toneIx = groupCounter % PLANNING_GROUP_TONE_COUNT;
    for (let k = 0; k < PLANNING_GROUP_TONE_COUNT; k += 1) {
      tr.classList.remove(`${PLANNING_GROUP_TONE_CLASS_PREFIX}${k}`);
    }
    tr.classList.remove("planning-row-group-soft", "planning-row-group-base");
    tr.classList.add(`${PLANNING_GROUP_TONE_CLASS_PREFIX}${toneIx}`);
  });
}

function rebuildPlanningTable() {
  if (!planningBody) return;
  console.log("Estado actual planning:", appState.dataDraft.planning.records);
  planningBody.innerHTML = "";
  updateFilterProgramaState();
  syncSelectionToFilter();
  let planningSelectionMarked = false;
  getFilteredRecords().forEach((record) => {
    const row = buildRecordRow(record);
    if (
      selectedRecordId != null &&
      !planningSelectionMarked &&
      samePlanningRecordId(record.id, selectedRecordId)
    ) {
      row.classList.add("row-selected");
      planningSelectionMarked = true;
    }
    planningBody.appendChild(row);
  });
  refreshPlanningProgramGroupBands();
  scheduleRefreshPlanningStickyColumnWidths();
  updateTotalInversion();
  updateActionButtons();
}

/** Sustituye una sola fila del planning (evita re-render completo tras edición en celda). */
function replacePlanningRowElement(record) {
  if (!planningBody || !record) return;
  const oldRow = [...planningBody.querySelectorAll("tr[data-record-id]")].find((tr) =>
    samePlanningRecordId(tr.getAttribute("data-record-id"), record.id)
  );
  if (!oldRow) {
    rebuildPlanningTable();
    return;
  }
  const newRow = buildRecordRow(record);
  if (samePlanningRecordId(record.id, selectedRecordId)) newRow.classList.add("row-selected");
  oldRow.replaceWith(newRow);
  refreshPlanningProgramGroupBands();
  scheduleRefreshPlanningStickyColumnWidths();
  updateTotalInversion();
  updateActionButtons();
}

function getFormValues() {
  const formData = new FormData(campaignForm);
  const centroCostoRaw = String(formData.get("centroCosto") || "").trim();
  const programType = String((programTypeSelect?.value ?? formData.get("programType")) || "").trim();
  const isAlcance = planningTipoAlcance(programType);
  return {
    programType,
    programName: String(formData.get("programName") || "").trim(),
    intake: String(formData.get("intake") || "").trim(),
    tracking: String(formData.get("tracking") || "").trim(),
    plataforma: String(formData.get("plataforma") || "").trim(),
    startDateValue: String(formData.get("startDate") || ""),
    endDateValue: String(formData.get("endDate") || ""),
    totalBudget: Number(formData.get("totalBudget") || 0),
    cplTarget: isAlcance ? 0 : Number(formData.get("cplTarget") || 0),
    targetLeads: isAlcance ? 0 : Math.max(0, Math.round(Number(formData.get("targetLeads") || 0))),
    centroCosto: normalizeCentroCostoSelectionValue(centroCostoRaw)
  };
}

function setPresupuestoInputReadonly(readonly) {
  if (!totalBudgetInput) return;
  totalBudgetInput.readOnly = readonly;
  totalBudgetInput.classList.toggle("input-manual-unlocked", !readonly);
}

function syncPresupuestoFromLeadsCpl() {
  if (planningTipoAlcance(programTypeSelect?.value || "")) return;
  if (presupuestoManualMode || !totalBudgetInput || !targetLeadsInput || !cplTargetInput) return;
  const leads = Math.max(0, Math.round(Number(targetLeadsInput.value) || 0));
  const cpl = Number(cplTargetInput.value) || 0;
  if (leads > 0 && cpl > 0) {
    totalBudgetInput.value = String(Math.round(leads * cpl));
  } else if (!presupuestoManualMode) {
    totalBudgetInput.value = "";
  }
}

function updateGastoDiarioDisplay() {
  if (!gastoDiarioInput) return;
  const total = Number(totalBudgetInput?.value || 0);
  const start = parseDateInput(startDateInput?.value || "");
  const end = parseDateInput(endDateInput?.value || "");
  if (!(total > 0) || !(start instanceof Date) || !(end instanceof Date) || start > end) {
    gastoDiarioInput.value = "";
    return;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const dias = Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;
  gastoDiarioInput.value = dias > 0 ? String(Math.round(total / dias)) : "";
}

function syncCplFromPresupuestoLeads() {
  if (planningTipoAlcance(programTypeSelect?.value || "")) return;
  if (!cplTargetInput || !totalBudgetInput || !targetLeadsInput) return;
  const leads = Math.max(0, Math.round(Number(targetLeadsInput.value) || 0));
  const budget = Number(totalBudgetInput.value) || 0;
  if (leads > 0 && budget >= 0) {
    const cpl = budget / leads;
    cplTargetInput.value = Number.isFinite(cpl) && cpl > 0 ? String(Math.round(cpl)) : "";
  }
}

function showFormError(msg) {
  if (!formError) return;
  if (!msg) {
    formError.textContent = "";
    formError.classList.add("hidden");
    return;
  }
  formError.textContent = msg;
  formError.classList.remove("hidden");
}

/** @deprecated Comparación rápida de “misma configuración dimensional” sin fechas. Preferir planningStructuralKey(). */
function isDuplicateRecord(candidate, excludeId = null) {
  const sk = planningStructuralKey(candidate);
  if (!sk) return false;
  return planningDraftRecords().some((r) => {
    if (excludeId != null && samePlanningRecordId(r.id, excludeId)) return false;
    return planningStructuralKey(r) === sk;
  });
}

/**
 * Reglas anti-duplicado y anti-solape para campañas equivalentes:
 * mismo tipo · programa · plataforma · intake · tracking.
 * • Charla/Webinar: solo bloquea solape de rangos si la configuración coincide.
 * • Alcance y otros tipos sin cruce fuerte entre intakes: permiten coexistencia salvo fingerprint idéntico o solape sobre misma configuración.
 */
function getPlanningRecordIntegrityConflictMessage(candidate, excludeId = null) {
  if (!candidate || typeof candidate !== "object") return "";
  const t = String(candidate.tipo ?? "").trim();
  const s = parseDateInput(candidate.fechaInicio);
  const e = parseDateInput(candidate.fechaFin);

  if (planningTipoCharlaOWebinar(t)) {
    if (!s || !e) return "";
    if (hasCharlaWebinarMismaConfigSolapeFechas(candidate, excludeId)) {
      return "Ya existe una campaña Charla/Webinar con la misma configuración y un rango de fechas que se solapa.";
    }
    return "";
  }

  if (!s || !e || e < s) return "";

  const sk = planningStructuralKey(candidate);
  if (!sk) return "";

  for (const r of planningDraftRecords()) {
    if (excludeId != null && samePlanningRecordId(r.id, excludeId)) continue;
    if (planningStructuralKey(r) !== sk) continue;

    if (planningExactFingerprint(candidate) === planningExactFingerprint(r)) {
      return "Ya existe una campaña idéntica (misma configuración y mismas fechas de inicio y fin).";
    }

    if (!planningTipoAlcance(t) && dateRangesOverlap(candidate.fechaInicio, candidate.fechaFin, r.fechaInicio, r.fechaFin)) {
      return "El rango de fechas se cruza con otra campaña equivalente (mismo tipo, programa, plataforma, intake y tracking). Separa los periodos o diferencia algún campo clave.";
    }
  }

  return "";
}

function validateCandidateForm(candidate, excludeId) {
  const s = parseDateInput(candidate.fechaInicio);
  const e = parseDateInput(candidate.fechaFin);
  if (!s || !e) {
    showFormError("Indica fecha de inicio y fecha de fin válidas.");
    return false;
  }
  if (e < s) {
    showFormError("La fecha fin no puede ser anterior a la fecha de inicio.");
    return false;
  }
  const minStartStr = computeMinFechaInicioForForm(excludeId);
  const minS = minStartStr ? parseDateInput(minStartStr) : null;
  if (minS && s < minS) {
    showFormError(`La fecha de inicio debe ser ${minStartStr} o posterior (después del último rango existente para este programa).`);
    return false;
  }

  const integMsg = getPlanningRecordIntegrityConflictMessage(candidate, excludeId);
  if (integMsg) {
    showFormError(integMsg);
    return false;
  }

  return true;
}

function getMonthRange(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return [];
  const months = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const endCursor = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cursor <= endCursor) {
    months.push({ monthIndex: cursor.getMonth(), label: `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}` });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function autoPercentagesByDays(monthlyDays) {
  const total = monthlyDays.reduce((acc, d) => acc + d, 0);
  if (!total) return Array.from({ length: 12 }, () => 0);
  return distributeInteger(100, monthlyDays.map((d) => (d > 0 ? d : 0)));
}

function applyManualRedistribution(monthlyDays, editedIndex = null, editedValue = null) {
  const active = monthlyDays.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  const nextPercents = Array.from({ length: 12 }, () => 0);
  const nextManual = manualPercent.slice();

  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] === 0) {
      nextManual[i] = false;
      percentWeights[i] = 0;
    }
  }

  if (editedIndex !== null && active.includes(editedIndex)) {
    const clamped = Math.max(0, Math.min(100, Math.round(editedValue ?? 0)));
    nextManual[editedIndex] = true;
    percentWeights[editedIndex] = clamped;
  }

  const manualActive = active.filter((i) => nextManual[i]);
  const autoActive = active.filter((i) => !nextManual[i]);

  let manualSum = manualActive.reduce((acc, i) => acc + Math.max(0, Math.round(percentWeights[i] || 0)), 0);
  if (manualSum > 100) {
    if (editedIndex !== null && manualActive.includes(editedIndex)) {
      const othersManual = manualActive
        .filter((i) => i !== editedIndex)
        .reduce((acc, i) => acc + Math.max(0, Math.round(percentWeights[i] || 0)), 0);
      percentWeights[editedIndex] = Math.max(0, 100 - othersManual);
    }
    manualSum = manualActive.reduce((acc, i) => acc + Math.max(0, Math.round(percentWeights[i] || 0)), 0);
  }

  const remaining = Math.max(0, 100 - manualSum);
  const autoWeights = autoActive.map((i) => monthlyDays[i]);
  const autoDistribution = distributeInteger(remaining, autoWeights);

  manualActive.forEach((i) => {
    nextPercents[i] = Math.max(0, Math.round(percentWeights[i] || 0));
  });
  autoActive.forEach((i, idx) => {
    nextPercents[i] = autoDistribution[idx] || 0;
  });

  percentWeights = nextPercents.slice();
  manualPercent = nextManual.slice();
}

function recalcFromPercents(values, monthlyDays) {
  if (planningTipoAlcance(values.programType)) {
    const weights = percentWeights.map((p, idx) => (monthlyDays[idx] > 0 ? p : 0));
    let monthlyInvestment = distributeBudget(values.totalBudget, weights);
    if (formPreviewInvOverride.some((x) => x != null && x !== undefined)) {
      monthlyInvestment = applyMonthlyInvOverridesToDistribution(
        monthlyInvestment,
        monthlyDays,
        values.totalBudget,
        formPreviewInvOverride
      );
    }
    const monthlyLeads = Array.from({ length: 12 }, () => 0);
    const monthlyCpl = Array.from({ length: 12 }, () => 0);
    return { monthlyInvestment, monthlyLeads, monthlyCpl };
  }

  const activeIdx = [];
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] > 0) activeIdx.push(i);
  }
  const invAllSet =
    activeIdx.length > 0 &&
    activeIdx.every((i) => formPreviewInvOverride[i] != null && formPreviewInvOverride[i] !== undefined);
  if (invAllSet) {
    const monthlyInvestment = Array.from({ length: 12 }, (_, i) =>
      monthlyDays[i] > 0 ? Math.max(0, Number(formPreviewInvOverride[i]) || 0) : 0
    );
    const leadsAllSet =
      activeIdx.length > 0 &&
      activeIdx.every((i) => formPreviewLeadsOverride[i] != null && formPreviewLeadsOverride[i] !== undefined);
    let monthlyLeads;
    if (leadsAllSet) {
      monthlyLeads = Array.from({ length: 12 }, (_, i) =>
        monthlyDays[i] > 0 ? Math.max(0, Math.round(Number(formPreviewLeadsOverride[i]) || 0)) : 0
      );
    } else {
      const leadWeights = monthlyInvestment.map((v) => (v > 0 ? v : 0));
      const baseLeads = distributeInteger(values.targetLeads, leadWeights);
      monthlyLeads = baseLeads.map((bl, idx) => {
        if (monthlyDays[idx] <= 0) return 0;
        const lo = formPreviewLeadsOverride[idx];
        return lo != null && lo !== undefined ? Math.max(0, Math.round(Number(lo))) : bl;
      });
    }
    const monthlyCpl = monthlyInvestment.map((inv, idx) =>
      monthlyLeads[idx] > 0 ? Math.round(inv / monthlyLeads[idx]) : 0
    );
    return { monthlyInvestment, monthlyLeads, monthlyCpl };
  }

  const weights = percentWeights.map((p, idx) => (monthlyDays[idx] > 0 ? p : 0));
  let monthlyInvestment = distributeBudget(values.totalBudget, weights);
  if (formPreviewInvOverride.some((x) => x != null && x !== undefined)) {
    monthlyInvestment = applyMonthlyInvOverridesToDistribution(
      monthlyInvestment,
      monthlyDays,
      values.totalBudget,
      formPreviewInvOverride
    );
  }
  const leadWeights = monthlyInvestment.map((v) => (v > 0 ? v : 0));
  const baseLeads = distributeInteger(values.targetLeads, leadWeights);
  const monthlyLeads = baseLeads.map((bl, idx) => {
    if (monthlyDays[idx] <= 0) return 0;
    const lo = formPreviewLeadsOverride[idx];
    return lo != null && lo !== undefined ? Math.max(0, Math.round(Number(lo))) : bl;
  });
  const monthlyCpl = monthlyInvestment.map((inv, idx) =>
    monthlyLeads[idx] > 0 ? Math.round(inv / monthlyLeads[idx]) : 0
  );
  return { monthlyInvestment, monthlyLeads, monthlyCpl };
}

function renderPreview(monthlyDays, visibleMonths, monthlyInvestment, monthlyLeads, isAlcance = false) {
  if (!previewBody) return;
  const previewTable = previewBody.closest(".preview-table");
  if (previewTable) previewTable.classList.toggle("preview-table--alcance", Boolean(isAlcance));
  previewBody.innerHTML = "";
  visibleMonths.forEach((monthInfo) => {
    const idx = monthInfo.monthIndex;
    const leads = monthlyLeads[idx];
    const budget = monthlyInvestment[idx];
    const cpl = leads > 0 ? Math.round(budget / leads) : 0;
    const rowLockCls = formPreviewRowLocked[idx] ? "is-locked" : "";
    const tr = document.createElement("tr");
    if (formPreviewRowLocked[idx]) tr.classList.add("preview-row-locked");
    tr.innerHTML = `
      <td class="preview-month-cell ${rowLockCls}">
        <span class="preview-month-label">${monthInfo.label}</span>
        <button type="button" class="preview-row-lock-btn ${rowLockCls}" data-lock-month="${idx}" aria-label="Bloquear fila mes ${monthInfo.label}" title="Bloquear/Desbloquear fila">${formPreviewRowLocked[idx] ? "🔒" : "🔓"}</button>
      </td>
      <td>${monthlyDays[idx]}</td>
      <td><input class="percent-input" data-month-index="${idx}" type="number" min="0" max="100" step="1" value="${percentWeights[idx]}" ${formPreviewRowLocked[idx] ? "disabled" : ""}></td>
      <td class="preview-budget-cell ${rowLockCls}" data-preview-month="${idx}">${formatMoney(Math.round(Number(budget) || 0)) || ""}</td>
      <td class="preview-col-leads preview-leads-cell ${rowLockCls}" data-preview-month-lead="${idx}">${leads}</td>
      <td class="preview-col-cpl">${cpl > 0 ? formatCpl(cpl) || "" : ""}</td>
    `;
    previewBody.appendChild(tr);
  });
}

function setPercentHint() {
  if (!percentHint) return;
  const total = percentWeights.reduce((acc, n) => acc + n, 0);
  const manualCount = manualPercent.filter(Boolean).length;
  percentHint.textContent = `Total: ${total}% | Meses manuales: ${manualCount}`;
}

function hydrateEditPreviewFromRecord(record) {
  if (!campaignForm) return;
  applyFormDateConstraints({ preserveValues: true });
  let values = getFormValues();
  let startDate = parseDateInput(values.startDateValue);
  let endDate = parseDateInput(values.endDateValue);
  if (!(startDate && endDate)) {
    const fi = normalizeDateValueForInput(record.fechaInicio);
    const ff = normalizeDateValueForInput(record.fechaFin);
    if (startDateInput && fi) startDateInput.value = fi;
    if (endDateInput && ff) endDateInput.value = ff;
    applyFormDateConstraints({ preserveValues: true });
    values = getFormValues();
    startDate = parseDateInput(values.startDateValue);
    endDate = parseDateInput(values.endDateValue);
  }
  const datesValid = Boolean(startDate && endDate && startDate <= endDate);
  if (!datesValid) {
    updatePreview({ resetAll: true });
    return;
  }
  const year = startDate.getFullYear();
  const monthlyDays = countDaysByMonthForRangeInYear(values.startDateValue, values.endDateValue, year);
  const visibleMonths = getMonthRange(startDate, endDate);
  const calc = computeMonthlyArraysForRecordWithOverrides(record, year);

  const activeIdx = [];
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] > 0) activeIdx.push(i);
  }
  manualPercent = Array.from({ length: 12 }, () => false);
  if (activeIdx.length) {
    const w = activeIdx.map((i) => Math.max(0, calc.monthlyInvestment[i] || 0));
    const sumW = w.reduce((a, b) => a + b, 0);
    if (sumW > 0) {
      const distP = distributeInteger(100, w);
      percentWeights = Array.from({ length: 12 }, () => 0);
      activeIdx.forEach((i, j) => {
        percentWeights[i] = distP[j] || 0;
      });
    } else {
      percentWeights = autoPercentagesByDays(monthlyDays);
    }
  } else {
    percentWeights = Array.from({ length: 12 }, () => 0);
  }

  formPreviewInvOverride = Array.from({ length: 12 }, (_, i) =>
    monthlyDays[i] > 0 ? calc.monthlyInvestment[i] : null
  );
  formPreviewLeadsOverride = Array.from({ length: 12 }, (_, i) =>
    monthlyDays[i] > 0 ? calc.monthlyLeads[i] : null
  );
  formPreviewRowLocked = getAutoLockedRowsForEdit(monthlyDays, year);

  const monthlyInvestment = calc.monthlyInvestment.map((x) => Number(x) || 0);
  let monthlyLeads = calc.monthlyLeads.map((x) => Math.max(0, Math.round(Number(x) || 0)));
  let monthlyCpl = calc.monthlyCpl.slice();
  if (planningTipoAlcance(record.tipo)) {
    monthlyLeads = Array.from({ length: 12 }, () => 0);
    monthlyCpl = Array.from({ length: 12 }, () => 0);
    formPreviewLeadsOverride = Array.from({ length: 12 }, () => null);
  }

  applyFormDateConstraints({ preserveValues: true });
  values = getFormValues();
  lastPreview = {
    values,
    campaignYear: year,
    visibleMonths,
    monthlyDays,
    percents: percentWeights.slice(),
    manualPercent: manualPercent.slice(),
    monthlyInvestment,
    monthlyLeads,
    monthlyCpl
  };
  renderPreview(monthlyDays, visibleMonths, monthlyInvestment, monthlyLeads, planningTipoAlcance(record.tipo));
  setPercentHint();
  updateCentroCostoSaldoHint();
  editCampaignBaselineDates = {
    start: values.startDateValue,
    end: values.endDateValue
  };
}

function getAutoLockedRowsForEdit(monthlyDays, campaignYear) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  return Array.from({ length: 12 }, (_, i) => {
    if (!(monthlyDays[i] > 0)) return false;
    if (campaignYear < currentYear) return true;
    if (campaignYear > currentYear) return false;
    return i < currentMonth;
  });
}

function updatePreview(options = {}) {
  if (!campaignForm) return;
  const { editedIndex = null, editedValue = null, resetAll = false, syncBudgetFromPreview = false } = options;
  const values = getFormValues();
  const startDate = parseDateInput(values.startDateValue);
  const endDate = parseDateInput(values.endDateValue);
  const datesValid = Boolean(startDate && endDate && startDate <= endDate);
  const year = datesValid ? startDate.getFullYear() : new Date().getFullYear();
  const monthlyDays = datesValid ? countDaysByMonthForRangeInYear(values.startDateValue, values.endDateValue, year) : Array.from({ length: 12 }, () => 0);
  const visibleMonths = datesValid ? getMonthRange(startDate, endDate) : [];
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] <= 0 || !formPreviewRowLocked[i]) continue;
    if (formPreviewInvOverride[i] == null || formPreviewInvOverride[i] === undefined) {
      const prevInv = lastPreview?.monthlyInvestment?.[i];
      formPreviewInvOverride[i] = Number.isFinite(Number(prevInv)) ? Math.max(0, Number(prevInv)) : 0;
    }
    if (formPreviewLeadsOverride[i] == null || formPreviewLeadsOverride[i] === undefined) {
      const prevLeads = lastPreview?.monthlyLeads?.[i];
      formPreviewLeadsOverride[i] = Number.isFinite(Number(prevLeads))
        ? Math.max(0, Math.round(Number(prevLeads)))
        : 0;
    }
  }

  let effectiveResetAll = resetAll;
  if (!effectiveResetAll && editingRecordId && editCampaignBaselineDates) {
    const b = editCampaignBaselineDates;
    if (values.startDateValue !== b.start || values.endDateValue !== b.end) {
      formPreviewInvOverride = formPreviewInvOverride.map((v, i) => (formPreviewRowLocked[i] ? v : null));
      formPreviewLeadsOverride = formPreviewLeadsOverride.map((v, i) => (formPreviewRowLocked[i] ? v : null));
      effectiveResetAll = true;
    }
  }

  if (effectiveResetAll) {
    manualPercent = Array.from({ length: 12 }, () => false);
    percentWeights = autoPercentagesByDays(monthlyDays);
    formPreviewInvOverride = Array.from({ length: 12 }, () => null);
    formPreviewLeadsOverride = Array.from({ length: 12 }, () => null);
    formPreviewRowLocked =
      editingRecordId != null
        ? getAutoLockedRowsForEdit(monthlyDays, year)
        : Array.from({ length: 12 }, () => false);
  } else {
    if (
      editingRecordId == null &&
      editedIndex !== null &&
      editedIndex !== undefined &&
      !Number.isNaN(Number(editedIndex))
    ) {
      formPreviewInvOverride = formPreviewInvOverride.map((v, i) => (formPreviewRowLocked[i] ? v : null));
      formPreviewLeadsOverride = formPreviewLeadsOverride.map((v, i) => (formPreviewRowLocked[i] ? v : null));
    }
    if (percentWeights.reduce((acc, n) => acc + n, 0) === 0 && visibleMonths.length) {
      percentWeights = autoPercentagesByDays(monthlyDays);
    }
    applyManualRedistribution(monthlyDays, editedIndex, editedValue);
  }

  const calc = recalcFromPercents(values, monthlyDays);
  lastPreview = {
    values,
    campaignYear: year,
    visibleMonths,
    monthlyDays,
    percents: percentWeights.slice(),
    manualPercent: manualPercent.slice(),
    monthlyInvestment: calc.monthlyInvestment,
    monthlyLeads: calc.monthlyLeads,
    monthlyCpl: calc.monthlyCpl
  };
  renderPreview(
    monthlyDays,
    visibleMonths,
    calc.monthlyInvestment,
    calc.monthlyLeads,
    planningTipoAlcance(values.programType)
  );
  if (syncBudgetFromPreview && totalBudgetInput) {
    const totalDistribuido = Math.round(
      calc.monthlyInvestment.reduce((acc, n) => acc + (Number(n) || 0), 0)
    );
    totalBudgetInput.value = String(totalDistribuido);
    syncCplFromPresupuestoLeads();
    updateGastoDiarioDisplay();
  }
  setPercentHint();
  applyFormDateConstraints();
  if (lastPreview) {
    lastPreview.values = getFormValues();
  }
  updateGastoDiarioDisplay();
  updateCentroCostoSaldoHint();
  if (editingRecordId != null && effectiveResetAll) {
    const v = getFormValues();
    editCampaignBaselineDates = { start: v.startDateValue, end: v.endDateValue };
  }
}

function getLockedBudgetTotalForDays(monthlyDays) {
  let lockedTotal = 0;
  for (let i = 0; i < 12; i += 1) {
    if (monthlyDays[i] <= 0 || !formPreviewRowLocked[i]) continue;
    const ov = formPreviewInvOverride[i];
    if (ov != null && ov !== undefined && Number.isFinite(Number(ov))) {
      lockedTotal += Math.max(0, Number(ov));
    } else {
      lockedTotal += Math.max(0, Number(lastPreview?.monthlyInvestment?.[i]) || 0);
    }
  }
  return lockedTotal;
}

async function commitTotalBudgetManualEdit() {
  if (!totalBudgetInput) return;
  presupuestoManualMode = false;
  const values = getFormValues();
  const startDate = parseDateInput(values.startDateValue);
  const endDate = parseDateInput(values.endDateValue);
  const datesValid = Boolean(startDate && endDate && startDate <= endDate);
  const year = datesValid ? startDate.getFullYear() : new Date().getFullYear();
  const monthlyDays = datesValid
    ? countDaysByMonthForRangeInYear(values.startDateValue, values.endDateValue, year)
    : Array.from({ length: 12 }, () => 0);
  const lockedTotal = getLockedBudgetTotalForDays(monthlyDays);
  const entered = Math.max(0, Math.round(Number(totalBudgetInput.value) || 0));
  if (entered < lockedTotal - 1e-9) {
    const prev = Math.max(0, Math.round(Number(lastPreview?.values?.totalBudget) || 0));
    totalBudgetInput.value = String(prev);
    syncCplFromPresupuestoLeads();
    setPresupuestoInputReadonly(true);
    updateGastoDiarioDisplay();
    await showAppDialog({
      message: "No se puede aplicar el cambio: el Gasto Total es inferior al monto bloqueado.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false
    });
    return;
  }
  totalBudgetInput.value = String(entered);
  syncCplFromPresupuestoLeads();
  setPresupuestoInputReadonly(true);
  updatePreview();
}

function openModal() {
  refreshPlanningCatalogUi();
  exitProgramEditMode();
  editingRecordId = null;
  editCampaignBaselineDates = null;
  presupuestoManualMode = false;
  setPresupuestoInputReadonly(true);
  campaignModal?.classList.remove("campaign-modal--edit-cc");
  campaignForm?.removeAttribute("novalidate");
  if (modalTitle) modalTitle.textContent = "Registrar nueva campaña";
  showFormError("");
  campaignModal?.classList.remove("hidden");
  if (programTypeSelect) {
    programTypeSelect.disabled = false;
    programTypeSelect.removeAttribute("disabled");
  }
  if (startDateInput) startDateInput.value = "";
  if (endDateInput) {
    endDateInput.value = "";
    endDateInput.disabled = true;
    endDateInput.removeAttribute("min");
  }
  if (programNameInput) {
    programNameInput.disabled = !(programTypeSelect?.value || "");
    renderProgramDropdown(programTypeSelect?.value || "", "");
  }
  if (newProgramBtn) newProgramBtn.disabled = false;
  if (cplTargetInput) cplTargetInput.value = "";
  if (targetLeadsInput) targetLeadsInput.value = "";
  if (totalBudgetInput) totalBudgetInput.value = "";
  if (gastoDiarioInput) gastoDiarioInput.value = "";
  renderCplHistoricoHintEmptyTable();
  formPreviewInvOverride = Array.from({ length: 12 }, () => null);
  formPreviewLeadsOverride = Array.from({ length: 12 }, () => null);
  formPreviewRowLocked = Array.from({ length: 12 }, () => false);
  if (programDropdown) programDropdown.classList.add("hidden");
  populateCentroCostoSelect();
  const selCc = document.getElementById("centroCostoSelect");
  if (selCc) selCc.value = "";
  updateCentroCostoSaldoHint();
  updatePreview({ resetAll: true });
  updateCampaignFormAlcanceMode();
  syncPresupuestoFromLeadsCpl();
}

function openModalForEdit(record) {
  refreshPlanningCatalogUi();
  exitProgramEditMode();
  editingRecordId = record.id;
  presupuestoManualMode = false;
  setPresupuestoInputReadonly(true);
  campaignModal?.classList.add("campaign-modal--edit-cc");
  campaignForm?.setAttribute("novalidate", "novalidate");
  if (modalTitle) modalTitle.textContent = "Centro de costo";
  showFormError("");
  campaignModal?.classList.remove("hidden");
  if (programDropdown) programDropdown.classList.add("hidden");

  populateCentroCostoSelect();
  const selCc = document.getElementById("centroCostoSelect");
  if (selCc) selCc.value = planningRecordCanonicalCentroId(record) || "";
  updateCentroCostoSaldoHint();
}

function closeModal() {
  editingRecordId = null;
  editCampaignBaselineDates = null;
  presupuestoManualMode = false;
  setPresupuestoInputReadonly(true);
  campaignModal?.classList.remove("campaign-modal--edit-cc");
  campaignForm?.removeAttribute("novalidate");
  campaignModal?.classList.add("hidden");
}

newCampaignBtn?.addEventListener("click", () => {
  openModal();
});

document.getElementById("planningExportTableBtn")?.addEventListener("click", () => exportPlanningTableToExcel());

document.getElementById("planningSanitizeDuplicatesBtn")?.addEventListener("click", () => {
  void confirmSanitizePlanningDuplicatesFromToolbar();
});

editRecordBtn?.addEventListener("click", () => {
  if (!selectedRecordId) return;
  const pr = planningDraftRecords();
  const rec = pr.find((r) => samePlanningRecordId(r.id, selectedRecordId));
  if (rec) openModalForEdit(rec);
});

deleteRecordBtn?.addEventListener("click", () => {
  if (!selectedRecordId) return;
  const pr = planningDraftRecords();
  const idx = pr.findIndex((r) => samePlanningRecordId(r.id, selectedRecordId));
  if (idx < 0) return;
  const removed = pr[idx];
  registrarAuditoria({
    modulo: "planning",
    accion: "eliminar",
    campo: "registro",
    valorAnterior: { id: removed?.id, planningKey: planningKeyFromRecord(removed) },
    valorNuevo: null,
    descripcion: `Eliminación planning id ${String(removed?.id ?? "")}`
  });
  pr.splice(idx, 1);
  selectedRecordId = null;
  console.log("Estado actual planning:", appState.dataDraft.planning.records);
  rebuildPlanningTable();
  persistPlanningData();
});

cancelBtn?.addEventListener("click", closeModal);

totalBudgetInput?.addEventListener("dblclick", (e) => {
  e.preventDefault();
  presupuestoManualMode = true;
  setPresupuestoInputReadonly(false);
  totalBudgetInput?.focus();
  totalBudgetInput?.select();
});

totalBudgetInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    totalBudgetInput?.blur();
  }
});

totalBudgetInput?.addEventListener("blur", () => {
  if (!presupuestoManualMode) return;
  void commitTotalBudgetManualEdit();
});

totalBudgetInput?.addEventListener("input", () => {
  if (presupuestoManualMode) syncCplFromPresupuestoLeads();
});

cplTargetInput?.addEventListener("input", () => {
  presupuestoManualMode = false;
  setPresupuestoInputReadonly(true);
  syncPresupuestoFromLeadsCpl();
  updatePreview();
});

targetLeadsInput?.addEventListener("input", () => {
  presupuestoManualMode = false;
  setPresupuestoInputReadonly(true);
  syncPresupuestoFromLeadsCpl();
  updatePreview();
});

function getProgramsByType(tipo) {
  return programs.filter((item) => item.tipo === tipo);
}

function setDropdownVisible(visible) {
  void visible;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let campatrackToastHideTimer = null;
/** Toast breve (import/export); no usa almacenamiento local. */
function showCampatrackToast(message, variant = "success") {
  if (typeof document === "undefined" || !message) return;
  let el = document.getElementById("campatrackToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "campatrackToast";
    el.className = "campatrack-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = String(message);
  el.classList.remove("campatrack-toast--error", "campatrack-toast--success", "campatrack-toast--visible");
  el.classList.add(variant === "error" ? "campatrack-toast--error" : "campatrack-toast--success");
  void el.offsetWidth;
  el.classList.add("campatrack-toast--visible");
  if (campatrackToastHideTimer) window.clearTimeout(campatrackToastHideTimer);
  campatrackToastHideTimer = window.setTimeout(() => {
    el.classList.remove("campatrack-toast--visible");
    campatrackToastHideTimer = null;
  }, 4200);
}

/**
 * Diálogo reutilizable (sin alert ni confirm).
 * Resuelve true si el usuario pulsa el botón primario, false en secundario, overlay o Escape.
 */
function showAppDialog(opts) {
  const overlay = document.getElementById("appDialogOverlay");
  const messageEl = document.getElementById("appDialogMessage");
  const primaryBtn = document.getElementById("appDialogPrimary");
  const secondaryBtn = document.getElementById("appDialogSecondary");
  if (!overlay || !messageEl || !primaryBtn || !secondaryBtn) {
    return Promise.resolve(false);
  }
  const {
    message,
    primaryText = "Aceptar",
    secondaryText = "Cancelar",
    showSecondary = true,
    primaryDanger = false
  } = opts;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      primaryBtn.onclick = null;
      secondaryBtn.onclick = null;
      resolve(value);
    };

    const onOverlayClick = (e) => {
      if (e.target === overlay) finish(false);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };

    messageEl.textContent = message;
    primaryBtn.textContent = primaryText;
    primaryBtn.classList.toggle("app-dialog-btn-danger", Boolean(primaryDanger));
    primaryBtn.classList.toggle("app-dialog-btn-primary", !primaryDanger);

    if (showSecondary) {
      secondaryBtn.textContent = secondaryText;
      secondaryBtn.classList.remove("hidden");
      secondaryBtn.onclick = () => finish(false);
    } else {
      secondaryBtn.classList.add("hidden");
      secondaryBtn.onclick = null;
    }

    primaryBtn.onclick = () => finish(true);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => primaryBtn.focus());
  });
}

/**
 * Segundo paso al eliminar un centro con campañas: elegir otro centro (agrupador).
 * @returns {Promise<string|null>} valor de agrupador del nuevo centro, o null si cancela / sin opciones.
 */
function showCcReassignDialog(excludeCcId) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("ccReassignOverlay");
    const sel = document.getElementById("ccReassignSelect");
    const accept = document.getElementById("ccReassignAccept");
    const cancel = document.getElementById("ccReassignCancel");
    if (!overlay || !sel || !accept || !cancel) {
      resolve(null);
      return;
    }

    const seen = new Set();
    sel.innerHTML = centrosCostos
      .filter((c) => rowBelongsToCurrentTeam(c) && String(c.id) !== String(excludeCcId))
      .map((c) => {
        const id = String(c.id);
        if (!id || seen.has(id)) return "";
        seen.add(id);
        const label = getCentroCostoDisplayName(c) || id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      })
      .filter(Boolean)
      .join("");

    if (!sel.options.length) {
      void showAppDialog({
        message:
          "No hay otro centro de costos disponible. Crea otro centro antes de eliminar y reasignar las campañas.",
        showSecondary: false,
        primaryText: "Entendido"
      });
      resolve(null);
      return;
    }

    sel.value = "";
    accept.disabled = true;

    let settled = false;
    const cleanup = () => {
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      sel.removeEventListener("change", onSelChange);
      accept.onclick = null;
      cancel.onclick = null;
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onOverlayClick = (e) => {
      if (e.target === overlay) finish(null);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    const onSelChange = () => {
      accept.disabled = !sel.value;
    };

    sel.addEventListener("change", onSelChange);
    accept.onclick = () => {
      const v = sel.value || "";
      if (!v) return;
      finish(v);
    };
    cancel.onclick = () => finish(null);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);

    overlay.classList.remove("hidden");
    requestAnimationFrame(() => sel.focus());
  });
}

function finalizeDeleteCentroCostoRow(ccId) {
  const idx = centrosCostos.findIndex((c) => String(c.id) === String(ccId));
  if (idx < 0) return;
  centrosCostos.splice(idx, 1);
  if (String(selectedCcRowId) === String(ccId)) selectedCcRowId = null;
  persistCentrosCostos();
  refreshCentroCostosUI();
}

function renderProgramDropdown(tipo, query) {
  if (!programNameInput) return;
  const selectedValue = String(query ?? programNameInput.value ?? "").trim();
  if (!tipo) {
    programNameInput.innerHTML = `<option value="">Seleccionar programa</option>`;
    programNameInput.value = "";
    programNameInput.disabled = true;
    return;
  }

  const options = collectProgramNamesForPlanningTipo(tipo);
  const hasSelected = selectedValue && options.some((name) => String(name) === selectedValue);
  const extraOption = selectedValue && !hasSelected ? `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>` : "";
  const optionsHtml = options
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  programNameInput.innerHTML = `<option value="">Seleccionar programa</option>${optionsHtml}${extraOption}`;
  programNameInput.disabled = false;
  if (selectedValue) programNameInput.value = selectedValue;
}

let programEditMode = false;

function exitProgramEditMode() {
  if (!programNameInput || !programNameEditInput) return;
  programEditMode = false;
  programNameEditInput.classList.add("hidden");
  programNameInput.classList.remove("hidden");
}

function enterProgramEditMode() {
  if (!programNameInput || !programNameEditInput) return;
  programEditMode = true;
  const current = String(programNameInput.value || "").trim();
  programNameEditInput.value = current;
  programNameInput.classList.add("hidden");
  programNameEditInput.classList.remove("hidden");
  programNameEditInput.focus();
  programNameEditInput.select();
}

function commitProgramDraftFromEditor() {
  if (!programNameEditInput || !programTypeSelect || !programNameInput) return;
  const tipo = String(programTypeSelect.value || "").trim();
  const nombre = String(programNameEditInput.value || "").trim();
  if (!tipo || !nombre) {
    exitProgramEditMode();
    return;
  }
  const exists = programs.some(
    (item) => item.tipo === tipo && item.nombre.toLowerCase() === nombre.toLowerCase()
  );
  if (!exists) {
    programs.push({ tipo, nombre });
    persistProgramas();
  }
  renderProgramDropdown(tipo, nombre);
  programNameInput.value = nombre;
  exitProgramEditMode();
}

programTypeSelect?.addEventListener("change", () => {
  if (editingRecordId != null) return;
  exitProgramEditMode();
  const tipo = programTypeSelect.value;
  if (programNameInput) {
    programNameInput.disabled = !tipo;
    if (editingRecordId == null) {
      programNameInput.value = "";
    }
  }
  if (tipo) renderProgramDropdown(tipo, "");
  updateCampaignFormAlcanceMode();
  if (editingRecordId != null) {
    updatePreview();
  } else {
    updatePreview({ resetAll: true });
  }
  updateCplHistoricoPlanningForm();
});

trackingSelect?.addEventListener("change", () => updateCplHistoricoPlanningForm());
plataformaSelect?.addEventListener("change", () => updateCplHistoricoPlanningForm());

newProgramBtn?.addEventListener("click", () => {
  const tipo = programTypeSelect?.value || "";
  if (!tipo) return;
  if (!programEditMode) {
    enterProgramEditMode();
    return;
  }
  commitProgramDraftFromEditor();
});

programNameInput?.addEventListener("change", () => {
  updateCplHistoricoPlanningForm();
});

programNameEditInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitProgramDraftFromEditor();
  } else if (event.key === "Escape") {
    event.preventDefault();
    exitProgramEditMode();
  }
});

programNameEditInput?.addEventListener("blur", () => {
  commitProgramDraftFromEditor();
});

campaignForm?.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.monthIndex) {
    const monthIdx = Number(target.dataset.monthIndex);
    if (Number.isFinite(monthIdx) && formPreviewRowLocked[monthIdx]) return;
    updatePreview({
      editedIndex: monthIdx,
      editedValue: Number(target.value)
    });
    return;
  }
  /** Edición manual de presupuesto / leads mensual: no recalcular hasta Enter/blur (evita destruir el input al teclear). */
  if (target instanceof HTMLInputElement && target.classList.contains("preview-budget-input")) {
    return;
  }
  if (target instanceof HTMLInputElement && target.classList.contains("preview-leads-input")) {
    return;
  }
  if (target === totalBudgetInput && presupuestoManualMode) {
    return;
  }
  updatePreview();
});

campaignForm?.addEventListener("change", (event) => {
  const t = event.target;
  if (t instanceof HTMLInputElement && t.classList.contains("preview-budget-input")) {
    return;
  }
  if (t instanceof HTMLInputElement && t.classList.contains("preview-leads-input")) {
    return;
  }
  if (t === totalBudgetInput && presupuestoManualMode) {
    return;
  }
  updatePreview();
  updateCplHistoricoPlanningForm();
});

campaignModal?.addEventListener("click", (event) => {
  if (event.target === campaignModal) closeModal();
});

function snapshotPreviewOverridesForRecord() {
  if (!formPreviewInvOverride.some((x) => x != null && x !== undefined)) return undefined;
  return formPreviewInvOverride.map((x) =>
    x != null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : null
  );
}

function snapshotDistribucionMensualFromPreview() {
  if (!lastPreview) return undefined;
  const { monthlyInvestment, monthlyLeads } = lastPreview;
  const out = {};
  DIST_MES_KEYS.forEach((key, i) => {
    out[key] = {
      presupuesto: Number(monthlyInvestment[i]) || 0,
      leads: Math.max(0, Math.round(Number(monthlyLeads[i]) || 0))
    };
  });
  return out;
}

campaignForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    showFormError("");

    if (editingRecordId != null) {
      const pr = planningDraftRecords();
      const idx = pr.findIndex((r) => samePlanningRecordId(r.id, editingRecordId));
      if (idx < 0) return;
      const prev = pr[idx];
      const selCc = document.getElementById("centroCostoSelect");
      const ccVal = normalizeCentroCostoSelectionValue(selCc?.value || "");
      const budget = Number(prev.presupuesto) || 0;

      if (!validateCentroCostoPresupuesto(ccVal, budget, editingRecordId)) return;

      if (!ccVal) {
        const continuar = await showAppDialog({
          message: "No se ha seleccionado un Centro de Costos. ¿Deseas continuar?",
          primaryText: "Continuar",
          secondaryText: "Cancelar",
          showSecondary: true,
          primaryDanger: false
        });
        if (!continuar) return;
      }

      pr[idx] = {
        ...prev,
        centroCosto: ccVal,
        centroCostoId: ccVal
      };
      diffPlanningRecordForAudit(String(editingRecordId), prev, pr[idx]);
      rebuildPlanningTable();
      persistPlanningData();
      closeModal();
      return;
    }

    updatePreview();
    if (!lastPreview) return;

    const { values } = lastPreview;

    if (!values.programType || !values.programName || !values.intake || !values.tracking || !values.plataforma) {
      showFormError("Completa todos los campos obligatorios.");
      return;
    }

    if (planningTipoAlcance(values.programType)) {
      if (!(Number.isFinite(values.totalBudget) && values.totalBudget > 0)) {
        showFormError("Indica un presupuesto total mayor que 0.");
        return;
      }
    }

    const candidate = {
      tipo: values.programType,
      programa: values.programName,
      intake: values.intake,
      fechaInicio: values.startDateValue,
      fechaFin: values.endDateValue,
      tracking: values.tracking,
      plataforma: values.plataforma
    };

    if (!validateCandidateForm(candidate, null)) return;
    if (!validateCentroCostoPresupuesto(values.centroCosto, values.totalBudget, null)) return;

    if (!values.centroCosto) {
      const continuar = await showAppDialog({
        message: "No se ha seleccionado un Centro de Costos. ¿Deseas continuar?",
        primaryText: "Continuar",
        secondaryText: "Cancelar",
        showSecondary: true,
        primaryDanger: false
      });
      if (!continuar) return;
    }

    const ovSnap = snapshotPreviewOverridesForRecord();
    const distSnap = snapshotDistribucionMensualFromPreview();

    const newRecord = {
      id: newPlanningRecordId(),
      teamId: getCurrentTeamId(),
      tipo: candidate.tipo,
      programa: candidate.programa,
      intake: candidate.intake,
      fechaInicio: candidate.fechaInicio,
      fechaFin: candidate.fechaFin,
      tracking: candidate.tracking,
      plataforma: candidate.plataforma,
      centroCosto: normalizeCentroCostoSelectionValue(values.centroCosto || ""),
      centroCostoId: normalizeCentroCostoSelectionValue(values.centroCosto || ""),
      presupuesto: values.totalBudget,
      leads: planningTipoAlcance(candidate.tipo) ? 0 : values.targetLeads,
      metas: {
        leads: "",
        interesados: "",
        postulantes: "",
        matriculados: "",
        cplMeta: ""
      },
      distribucionMensual: distSnap,
      monthlyInvOverride: distSnap ? undefined : ovSnap
    };
    planningDraftRecords().push(newRecord);
    registrarAuditoria({
      modulo: "planning",
      accion: "crear",
      campo: "registro",
      valorAnterior: null,
      valorNuevo: { id: newRecord.id, planningKey: planningKeyFromRecord(newRecord) },
      descripcion: `Nueva fila planning ${planningKeyFromRecord(newRecord)}`
    });
    console.log("Estado actual planning:", appState.dataDraft.planning.records);

    rebuildPlanningTable();
    persistPlanningData();

    campaignForm.reset();
    if (programTypeSelect) programTypeSelect.value = "";
    if (programNameInput) {
      programNameInput.value = "";
      programNameInput.disabled = true;
    }
    if (programNameEditInput) programNameEditInput.value = "";
    exitProgramEditMode();
    setDropdownVisible(false);
    manualPercent = Array.from({ length: 12 }, () => false);
    percentWeights = Array.from({ length: 12 }, () => 0);
    formPreviewRowLocked = Array.from({ length: 12 }, () => false);
    updatePreview({ resetAll: true });
    closeModal();
  })();
});

function initCampaignPreviewBudgetEdit() {
  previewBody?.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest(".preview-row-lock-btn") : null;
    if (!btn || !(btn instanceof HTMLButtonElement)) return;
    e.preventDefault();
    const monthIdx = Number(btn.getAttribute("data-lock-month"));
    if (!Number.isFinite(monthIdx) || !lastPreview) return;
    const next = !formPreviewRowLocked[monthIdx];
    formPreviewRowLocked[monthIdx] = next;
    formPreviewInvOverride[monthIdx] = next ? Number(lastPreview.monthlyInvestment[monthIdx]) || 0 : null;
    formPreviewLeadsOverride[monthIdx] = next ? Math.max(0, Math.round(Number(lastPreview.monthlyLeads[monthIdx]) || 0)) : null;
    updatePreview();
  });

  previewBody?.addEventListener("dblclick", (e) => {
    const td = e.target.closest(".preview-budget-cell");
    if (!td || !(td instanceof HTMLTableCellElement)) return;
    if (td.querySelector("input")) return;
    if (!lastPreview) return;
    const monthIdx = Number(td.getAttribute("data-preview-month"));
    if (!Number.isFinite(monthIdx)) return;
    if (formPreviewRowLocked[monthIdx]) return;
    const budget = lastPreview.monthlyInvestment[monthIdx] ?? 0;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.className = "meta-input preview-budget-input";
    input.value = String(budget);
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    let aborted = false;

    const applyAndRefresh = () => {
      if (done) return;
      const v = input.value.trim();
      done = true;
      const n = limpiarNumero(v);
      const num = v === "" ? null : Math.max(0, Number.isFinite(n) ? n : NaN);
      if (num == null || !Number.isFinite(num)) {
        formPreviewInvOverride[monthIdx] = null;
      } else {
        formPreviewInvOverride[monthIdx] = Math.round(num);
      }
      updatePreview({ syncBudgetFromPreview: true });
    };

    const revert = () => {
      if (done) return;
      done = true;
      aborted = true;
      updatePreview();
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyAndRefresh();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        revert();
      }
    });

    input.addEventListener(
      "blur",
      () => {
        if (aborted) return;
        applyAndRefresh();
      },
      { once: true }
    );
  });

  previewBody?.addEventListener("dblclick", (e) => {
    const td = e.target.closest(".preview-leads-cell");
    if (!td || !(td instanceof HTMLTableCellElement)) return;
    if (planningTipoAlcance(programTypeSelect?.value || "")) return;
    if (td.querySelector("input")) return;
    if (!lastPreview) return;
    const monthIdx = Number(td.getAttribute("data-preview-month-lead"));
    if (!Number.isFinite(monthIdx)) return;
    if (formPreviewRowLocked[monthIdx]) return;
    const leads = lastPreview.monthlyLeads[monthIdx] ?? 0;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.className = "meta-input preview-leads-input";
    input.value = String(leads);
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    let aborted = false;

    const applyAndRefresh = () => {
      if (done) return;
      const v = input.value.trim();
      done = true;
      const n = v === "" ? NaN : Math.round(Number(v));
      if (!Number.isFinite(n)) {
        formPreviewLeadsOverride[monthIdx] = null;
      } else {
        formPreviewLeadsOverride[monthIdx] = Math.max(0, n);
      }
      updatePreview();
    };

    const revert = () => {
      if (done) return;
      done = true;
      aborted = true;
      updatePreview();
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyAndRefresh();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        revert();
      }
    });

    input.addEventListener(
      "blur",
      () => {
        if (aborted) return;
        applyAndRefresh();
      },
      { once: true }
    );
  });
}

planningBody?.addEventListener("click", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLInputElement &&
    (target.classList.contains("meta-input") ||
      target.classList.contains("planning-mes-inv-input") ||
      target.classList.contains("planning-inline-input"))
  ) {
    return;
  }
  const tr = target instanceof HTMLElement ? target.closest("tr[data-record-id]") : null;
  if (!tr) return;
  const idAttr = tr.getAttribute("data-record-id");
  if (idAttr == null || idAttr === "") return;
  if (samePlanningRecordId(selectedRecordId, idAttr)) {
    selectedRecordId = null;
    planningBody.querySelectorAll("tr[data-record-id]").forEach((row) => {
      row.classList.remove("row-selected");
    });
  } else {
    selectedRecordId = idAttr;
    planningBody.querySelectorAll("tr[data-record-id]").forEach((row) => {
      row.classList.remove("row-selected");
    });
    tr.classList.add("row-selected");
  }
  updateActionButtons();
});

filterTipo?.addEventListener("change", () => {
  rebuildPlanningTable();
});

filterIntake?.addEventListener("change", () => {
  rebuildPlanningTable();
});

filterPrograma?.addEventListener("input", () => {
  rebuildPlanningTable();
});

document.getElementById("filterPlataformaPlanning")?.addEventListener("change", () => {
  rebuildPlanningTable();
});
document.getElementById("filterEstadoPlanning")?.addEventListener("change", () => {
  rebuildPlanningTable();
});
document.getElementById("planningToolbarSearch")?.addEventListener("input", () => {
  rebuildPlanningTable();
});

let planningStickyWidthsResizeT = 0;
window.addEventListener(
  "resize",
  () => {
    window.clearTimeout(planningStickyWidthsResizeT);
    planningStickyWidthsResizeT = window.setTimeout(() => {
      const pm = document.getElementById("planningModule");
      if (!pm?.classList.contains("hidden")) refreshPlanningStickyColumnWidths();
    }, 120);
  },
  { passive: true }
);

document.getElementById("planningFiltrosAvanzadosBtn")?.addEventListener("click", () => {
  const panel = document.getElementById("planningAdvFiltersPanel");
  const btn = document.getElementById("planningFiltrosAvanzadosBtn");
  if (!panel || !btn) return;
  panel.classList.toggle("hidden");
  const nowHidden = panel.classList.contains("hidden");
  panel.setAttribute("aria-hidden", nowHidden ? "true" : "false");
  btn.setAttribute("aria-expanded", nowHidden ? "false" : "true");
});

document.getElementById("planningImportTableBtn")?.addEventListener("click", () => {
  document.getElementById("importDataFileInput")?.click();
});

planningBody?.addEventListener("dblclick", (event) => {
  event.stopPropagation();
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const td = target.closest("td");
  if (!td || !planningBody?.contains(td)) return;
  if (td.querySelector("input,textarea,select")) return;

  const recordIdRaw = td.getAttribute("data-record-id");
  if (recordIdRaw == null || recordIdRaw === "") return;
  const pr = planningDraftRecords();
  const record = pr.find((r) => samePlanningRecordId(r.id, recordIdRaw));
  if (!record) return;

  const commitPlanningRecordById = (apply, opts = {}) => {
    const records = ensurePlanningDraftShape().records;
    const idx = records.findIndex((r) => samePlanningRecordId(r?.id, recordIdRaw));
    if (idx < 0) return;
    const rollback = JSON.parse(JSON.stringify(records[idx]));
    apply(records[idx], idx);
    const conflict = getPlanningRecordIntegrityConflictMessage(records[idx], recordIdRaw);
    if (conflict) {
      records[idx] = rollback;
      rebuildPlanningTable();
      showCampatrackToast(conflict, "error");
      return;
    }
    diffPlanningRecordForAudit(recordIdRaw, rollback, JSON.parse(JSON.stringify(records[idx])));
    if (opts.planningRowRefreshRecord) replacePlanningRowElement(records[idx]);
    else rebuildPlanningTable();
    persistPlanningData();
  };

  const bindNumericCommit = (input, apply, opts = {}) => {
    let aborted = false;
    const commit = () => {
      if (aborted) return;
      commitPlanningRecordById((rec) => apply(rec, input.value), opts);
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        aborted = true;
        rebuildPlanningTable();
      }
    });
  };

  if (td.hasAttribute("data-mcol-inv")) {
    const monthIdx = Number(td.getAttribute("data-mcol-inv") || "");
    if (!Number.isFinite(monthIdx)) return;
    const currentValue = td.textContent?.trim().replace(/^\$/, "").replace(/,/g, "") || "";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = "0";
    input.value = currentValue;
    input.className = "meta-input planning-mes-inv-input planning-inline-input";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    bindNumericCommit(input, (rec, raw) => setPlanningMonthlyInvFromCell(rec, monthIdx, raw), {
      planningRowRefreshRecord: record
    });
    return;
  }

  if (td.hasAttribute("data-mcol-lead")) {
    const monthIdx = Number(td.getAttribute("data-mcol-lead") || "");
    if (!Number.isFinite(monthIdx)) return;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    input.min = "0";
    input.value = td.textContent?.trim() || "0";
    input.className = "meta-input planning-inline-input";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    bindNumericCommit(input, (rec, raw) => setPlanningMonthlyLeadFromCell(rec, monthIdx, raw), {
      planningRowRefreshRecord: record
    });
    return;
  }

  const metaKey = td.dataset.metaKey;
  if (metaKey && META_FIELDS.includes(metaKey)) {
    let currentValue = td.textContent?.trim().replace(/^\$/, "") || "";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = currentValue;
    input.className = "meta-input planning-inline-input";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    bindNumericCommit(
      input,
      (rec, raw) => {
        if (!rec.metas) rec.metas = {};
        const nextValue = String(raw ?? "").trim();
        rec.metas[metaKey] = nextValue === "" ? "" : Number(nextValue);
      },
      { planningRowRefreshRecord: record }
    );
    return;
  }

  const field = td.dataset.planningEdit;
  if (!field) return;

  if (field === "fechaInicio" || field === "fechaFin") {
    const input = document.createElement("input");
    input.type = "date";
    input.className = "planning-inline-input";
    const curIso = field === "fechaInicio" ? record.fechaInicio : record.fechaFin;
    input.value = /^\d{4}-\d{2}-\d{2}$/.test(String(curIso || "")) ? String(curIso) : "";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    let aborted = false;
    const commit = () => {
      if (aborted) return;
      const v = input.value.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        rebuildPlanningTable();
        return;
      }
      const live =
        planningDraftRecords().find((r) => samePlanningRecordId(r?.id, recordIdRaw)) ?? record;
      const nextStart =
        field === "fechaInicio" ? v : normalizeDateValueForInput(live.fechaInicio ?? "");
      const nextEnd =
        field === "fechaFin" ? v : normalizeDateValueForInput(live.fechaFin ?? "");
      if (
        nextStart &&
        nextEnd &&
        /^\d{4}-\d{2}-\d{2}$/.test(nextStart) &&
        /^\d{4}-\d{2}-\d{2}$/.test(nextEnd) &&
        nextEnd < nextStart
      ) {
        showCampatrackToast("La fecha Fin no puede ser anterior a la fecha Inicio.", "error");
        rebuildPlanningTable();
        return;
      }
      commitPlanningRecordById((rec) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
        if (field === "fechaInicio") rec.fechaInicio = v;
        else rec.fechaFin = v;
      });
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        aborted = true;
        rebuildPlanningTable();
      }
    });
    return;
  }

  // Presupuesto total, leads total, CPL mensual, tipo/programa/intake/plataforma/tracking:
  // no edición en tabla (solo cálculo / otros flujos).
});

hydratarProgramas();
const planningIdsRepaired = hydratarPlanningData();
hydratarCentrosCostos();
ensureCentrosCostosRowsFromPlanningAssignments();
planningDraftRecords().forEach((r) => {
  const canon = normalizeCentroCostoSelectionValue(planningRecordCentroRefRaw(r));
  r.centroCosto = canon;
  r.centroCostoId = canon;
});
syncCentroCostosYConsumoDesdePlanning();
if (planningIdsRepaired) persistPlanningData({ fromBootstrap: true });
rebuildPlanningTable();

if (programNameInput) programNameInput.disabled = true;
renderCplHistoricoHintEmptyTable();
updateFilterProgramaState();
updatePreview({ resetAll: true });
updateActionButtons();
updateTotalInversion();
syncCatalogosSistemaDesdeMemoria();
refreshPlanningCatalogUi();
initPlanningDateRangePicker();

// =========================
// BITÁCORA module
// =========================

function bitacoraNowDatetimeLocalValue() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function createBitacoraRow() {
  return normalizeBitacoraRow({
    id: `bit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    fecha: bitacoraNowDatetimeLocalValue(),
    tipo: "",
    programa: "",
    cambios: "",
    observaciones: "",
    titulo: "",
    impacto: "",
    importante: false,
    teamId: String(getCurrentTeamId() || "").trim()
  });
}

function normalizeBitacoraRow(row) {
  const rawId = String(row?.id || "").trim();
  const safeId = /^[a-zA-Z0-9_-]+$/.test(rawId)
    ? rawId
    : `bit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const imp = String(row?.impacto || "")
    .trim()
    .toLowerCase();
  const impactoOk = imp === "alto" || imp === "medio" || imp === "bajo" ? imp : "";
  const impFlag = row?.importante;
  const importante =
    impFlag === true ||
    impFlag === 1 ||
    String(impFlag || "")
      .toLowerCase()
      .trim() === "true";
  const tidRaw = row?.teamId != null ? String(row.teamId).trim() : "";
  const teamId = tidRaw ? resolveCampatrackTeamId(tidRaw) || tidRaw : "";
  return {
    id: safeId,
    fecha: String(row?.fecha || ""),
    tipo: String(row?.tipo || ""),
    programa: String(row?.programa || ""),
    cambios: String(row?.cambios || ""),
    observaciones: String(row?.observaciones || ""),
    titulo: String(row?.titulo || "").trim(),
    impacto: impactoOk,
    importante: Boolean(importante),
    teamId
  };
}

function bitacoraRowDateYmd(row) {
  const raw = String(row?.fecha || "").trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function bitacoraDisplayTitulo(row) {
  const t = String(row?.titulo || "").trim();
  if (t) return t;
  const prog = String(row?.programa || "").trim();
  const tipo = String(row?.tipo || "").trim();
  if (prog && tipo) return `${prog} – ${tipo}`;
  return prog || tipo || "Sin título";
}

function bitacoraImpactoLabel(code) {
  const c = String(code || "").toLowerCase();
  if (c === "alto") return "Alto";
  if (c === "medio") return "Medio";
  if (c === "bajo") return "Bajo";
  return "";
}

function sortBitacoraRowsNewestFirst(rows) {
  rows.sort((a, b) => {
    const ta = a.fecha ? Date.parse(a.fecha) : 0;
    const tb = b.fecha ? Date.parse(b.fecha) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return rows;
}

function persistBitacoraData() {
  syncCcBitacoraModeloDraftFromRuntime();
  if (!shouldDeferDiskPersistence()) {
    guardarDebounce();
  }
  registerUnpublishedDraftMutation();
  syncCatalogosSistemaDesdeMemoria();
  refreshPlanningCatalogUi();
}

function hydratarBitacoraData() {
  bitacoraData.length = 0;
  try {
    const fromDraft = appState.dataDraft?.bitacora_data;
    if (Array.isArray(fromDraft)) {
      const rows = fromDraft.map(normalizeBitacoraRow);
      sortBitacoraRowsNewestFirst(rows);
      rows.forEach((row) => bitacoraData.push(row));
      return;
    }
    const raw = appMemoryKV.getItem(LS_BITACORA_DATA);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    const rows = data.map(normalizeBitacoraRow);
    sortBitacoraRowsNewestFirst(rows);
    rows.forEach((row) => bitacoraData.push(row));
  } catch (err) {
    console.warn("No se pudo cargar bitacora_data", err);
  }
}

function getBitacoraProgramOptions() {
  const unique = new Set();
  (catalogosSistema.programas || []).forEach((x) => {
    const value = String(x || "").trim();
    if (value) unique.add(value);
  });
  programs.forEach((p) => {
    const value = String(p?.nombre || "").trim();
    if (value) unique.add(value);
  });
  planningDraftRecords().forEach((r) => {
    const value = String(r?.programa || "").trim();
    if (value) unique.add(value);
  });
  return Array.from(unique).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function getBitacoraTipoOptions() {
  const unique = new Set(BITACORA_TIPO_OPTIONS.map((x) => String(x || "").trim()).filter(Boolean));
  (catalogosSistema.tipos || []).forEach((x) => {
    const value = String(x || "").trim();
    if (value) unique.add(value);
  });
  bitacoraData.forEach((row) => {
    const value = String(row?.tipo || "").trim();
    if (value) unique.add(value);
  });
  return Array.from(unique).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function bitacoraRowPasaFiltros(row) {
  const ct = String(getCurrentTeamId()).trim();
  if (!ct) return false;
  const rt = row?.teamId != null ? String(row.teamId).trim() : "";
  if (!rt) return false;
  if (
    String(resolveCampatrackTeamId(rt) || rt) !== String(resolveCampatrackTeamId(ct) || ct)
  )
    return false;
  if (bitacoraFiltros.tipo && String(row?.tipo || "") !== bitacoraFiltros.tipo) return false;
  const qProg = String(bitacoraFiltros.programa || "").trim().toLowerCase();
  if (qProg && !String(row?.programa || "").toLowerCase().includes(qProg)) return false;
  const ymd = bitacoraRowDateYmd(row);
  const fecha = parseDateInput(ymd);
  if (bitacoraFiltros.fechaInicio) {
    const start = parseDateInput(bitacoraFiltros.fechaInicio);
    if (!fecha || !start || fecha < start) return false;
  }
  if (bitacoraFiltros.fechaFin) {
    const end = parseDateInput(bitacoraFiltros.fechaFin);
    if (!fecha || !end || fecha > end) return false;
  }
  return true;
}

function renderBitacoraTipoSelect() {
  if (!bitacoraFiltroTipoSelect) return;
  const options = getBitacoraTipoOptions();
  const current = bitacoraFiltros.tipo || "";
  bitacoraFiltroTipoSelect.innerHTML =
    `<option value="">Todos</option>${options
      .map((tipo) => `<option value="${escapeHtml(tipo)}">${escapeHtml(tipo)}</option>`)
      .join("")}`;
  bitacoraFiltroTipoSelect.value = options.includes(current) ? current : "";
  refreshBitacoraFormTipoOptions();
}

function initBitacoraDateRangePicker() {
  if (!bitacoraFechaRangoInput || typeof flatpickr !== "function") return;
  if (bitacoraFechaRangoPicker) return;
  const localeEs =
    (flatpickr.l10ns && (flatpickr.l10ns.es || flatpickr.l10ns.es_default)) || "es";
  const applyBitacoraDateRangeFilter = () => {
    if (!bitacoraFechaRangoPicker) return;
    if (bitacoraFechaRangoPicker.selectedDates.length >= 2) {
      const [a, b] = bitacoraFechaRangoPicker.selectedDates;
      const start = a <= b ? a : b;
      const end = a <= b ? b : a;
      bitacoraFiltros.fechaInicio = formatDateInputFromDate(start);
      bitacoraFiltros.fechaFin = formatDateInputFromDate(end);
    } else {
      bitacoraFiltros.fechaInicio = "";
      bitacoraFiltros.fechaFin = "";
    }
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  };
  bitacoraFechaRangoPicker = flatpickr(bitacoraFechaRangoInput, {
    mode: "range",
    dateFormat: "Y-m-d",
    locale: localeEs,
    allowInput: false,
    clickOpens: true,
    conjunction: " → ",
    altInput: true,
    altFormat: "d M Y",
    onClose: applyBitacoraDateRangeFilter,
    onChange(selectedDates) {
      if (selectedDates.length >= 2) applyBitacoraDateRangeFilter();
    }
  });
}

function initPlanningDateRangePicker() {
  const el = document.getElementById("planningFechaRango");
  if (!el || typeof flatpickr !== "function") return;
  if (planningFechaRangoPicker) return;
  const localeEs =
    (flatpickr.l10ns && (flatpickr.l10ns.es || flatpickr.l10ns.es_default)) || "es";
  planningFechaRangoPicker = flatpickr(el, {
    mode: "range",
    dateFormat: "Y-m-d",
    locale: localeEs,
    allowInput: false,
    clickOpens: true,
    conjunction: " → ",
    altInput: true,
    altFormat: "d M Y",
    onClose() {
      if (planningFechaRangoPicker && planningFechaRangoPicker.selectedDates.length >= 2) {
        const [a, b] = planningFechaRangoPicker.selectedDates;
        const start = a <= b ? a : b;
        const end = a <= b ? b : a;
        planningFilterFechaIni = formatDateInputFromDate(start);
        planningFilterFechaFin = formatDateInputFromDate(end);
      } else {
        planningFilterFechaIni = "";
        planningFilterFechaFin = "";
      }
      rebuildPlanningTable();
    }
  });
}

function parseBitacoraRangeInputValue(rawValue) {
  if (bitacoraFechaRangoPicker && bitacoraFechaRangoPicker.selectedDates.length >= 2) {
    const [a, b] = bitacoraFechaRangoPicker.selectedDates;
    const start = a <= b ? a : b;
    const end = a <= b ? b : a;
    return {
      start: formatDateInputFromDate(start),
      end: formatDateInputFromDate(end)
    };
  }
  const raw = String(rawValue || "").trim();
  if (!raw) return { start: "", end: "" };
  const matches = raw.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (matches.length < 2) return { start: "", end: "" };
  const a = parseDateInput(matches[0]);
  const b = parseDateInput(matches[1]);
  if (!a || !b) return { start: "", end: "" };
  const start = a <= b ? a : b;
  const end = a <= b ? b : a;
  return {
    start: formatDateInputFromDate(start),
    end: formatDateInputFromDate(end)
  };
}

function formatBitacoraRangeInputValue(start, end) {
  if (!start || !end) return "";
  return `${start} → ${end}`;
}

function formatearFechaBitacora(fecha) {
  const raw = String(fecha || "").trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})/);
  if (m) {
    const d = parseDateInput(m[1]);
    if (d) {
      const hh = String(m[2]).padStart(2, "0");
      const mm = String(m[3]).padStart(2, "0");
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${hh}:${mm}`;
    }
  }
  const f = parseDateInput(raw);
  if (!f) return raw || "";
  return `${String(f.getDate()).padStart(2, "0")}/${String(f.getMonth() + 1).padStart(2, "0")}/${f.getFullYear()}`;
}

function formatBitacoraCellHtml(value, multiline = false) {
  const text = String(value ?? "");
  if (!text) return "&nbsp;";
  const escaped = escapeHtml(text);
  return multiline ? escaped.replaceAll("\n", "<br>") : escaped;
}

function findBitacoraRowIndex(rowId) {
  return bitacoraData.findIndex((row) => String(row.id) === String(rowId));
}

function refreshBitacoraFormTipoOptions() {
  if (!(bitacoraFormTipo instanceof HTMLSelectElement)) return;
  const current = String(bitacoraFormTipo.value || "").trim();
  const opts = getBitacoraTipoOptions();
  bitacoraFormTipo.innerHTML = `<option value="">Selecciona tipo</option>${opts
    .map((tipo) => `<option value="${escapeHtml(tipo)}">${escapeHtml(tipo)}</option>`)
    .join("")}`;
  bitacoraFormTipo.value = opts.includes(current) ? current : "";
}

function refreshBitacoraFormProgramaOptions() {
  if (!(bitacoraFormPrograma instanceof HTMLSelectElement)) return;
  const current = String(bitacoraFormPrograma.value || "").trim();
  const opts = getBitacoraProgramOptions();
  bitacoraFormPrograma.innerHTML = `<option value="">Selecciona programa</option>${opts
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
    .join("")}`;
  bitacoraFormPrograma.value = opts.includes(current) ? current : "";
}

function updateBitacoraCharCount() {
  if (!(bitacoraFormCambios instanceof HTMLTextAreaElement) || !bitacoraFormCharCount) return;
  const n = bitacoraFormCambios.value.length;
  bitacoraFormCharCount.textContent = `${n} / ${BITACORA_CAMBIOS_MAX}`;
}

function resetBitacoraEntryForm() {
  bitacoraEditingId = null;
  if (bitacoraFormFecha instanceof HTMLInputElement) bitacoraFormFecha.value = bitacoraNowDatetimeLocalValue();
  if (bitacoraFormPrograma instanceof HTMLSelectElement) bitacoraFormPrograma.value = "";
  if (bitacoraFormTipo instanceof HTMLSelectElement) bitacoraFormTipo.value = "";
  if (bitacoraFormImpacto instanceof HTMLSelectElement) bitacoraFormImpacto.value = "";
  if (bitacoraFormCambios instanceof HTMLTextAreaElement) bitacoraFormCambios.value = "";
  if (bitacoraFormImportante instanceof HTMLInputElement) bitacoraFormImportante.checked = false;
  if (bitacoraGuardarEntradaLabel) bitacoraGuardarEntradaLabel.textContent = "Guardar entrada";
  bitacoraCancelarEdicionBtn?.classList.add("hidden");
  bitacoraFormModeLabel?.classList.add("hidden");
  refreshBitacoraFormTipoOptions();
  refreshBitacoraFormProgramaOptions();
  updateBitacoraCharCount();
}

function fillBitacoraEntryFormFromRow(rowId) {
  const idx = findBitacoraRowIndex(rowId);
  if (idx < 0) return;
  const row = bitacoraData[idx];
  bitacoraEditingId = String(row.id);
  const rawFecha = String(row.fecha || "").trim();
  let dtVal = rawFecha;
  if (rawFecha && !rawFecha.includes("T")) {
    const d = parseDateInput(rawFecha);
    if (d) dtVal = `${formatDateInputFromDate(d)}T12:00`;
  }
  if (bitacoraFormFecha instanceof HTMLInputElement) bitacoraFormFecha.value = dtVal.slice(0, 16);
  refreshBitacoraFormProgramaOptions();
  refreshBitacoraFormTipoOptions();
  if (bitacoraFormPrograma instanceof HTMLSelectElement) bitacoraFormPrograma.value = String(row.programa || "");
  if (bitacoraFormTipo instanceof HTMLSelectElement) bitacoraFormTipo.value = String(row.tipo || "");
  if (bitacoraFormImpacto instanceof HTMLSelectElement) bitacoraFormImpacto.value = String(row.impacto || "");
  if (bitacoraFormCambios instanceof HTMLTextAreaElement) bitacoraFormCambios.value = String(row.cambios || "");
  if (bitacoraFormImportante instanceof HTMLInputElement) bitacoraFormImportante.checked = Boolean(row.importante);
  if (bitacoraGuardarEntradaLabel) bitacoraGuardarEntradaLabel.textContent = "Actualizar entrada";
  bitacoraCancelarEdicionBtn?.classList.remove("hidden");
  bitacoraFormModeLabel?.classList.remove("hidden");
  updateBitacoraCharCount();
  bitacoraFormCambios?.focus();
}

function guardarBitacoraDesdeFormulario() {
  if (!(bitacoraFormFecha instanceof HTMLInputElement)) return;
  const sessTeam = String(getCurrentTeamId()).trim();
  if (!sessTeam) {
    void showAppDialog({ message: "No hay equipo de sesión. Inicia sesión de nuevo.", primaryText: "Entendido", showSecondary: false });
    return;
  }
  const fecha = String(bitacoraFormFecha.value || "").trim();
  const programa = bitacoraFormPrograma instanceof HTMLSelectElement ? String(bitacoraFormPrograma.value || "").trim() : "";
  const tipo = bitacoraFormTipo instanceof HTMLSelectElement ? String(bitacoraFormTipo.value || "").trim() : "";
  const impacto = bitacoraFormImpacto instanceof HTMLSelectElement ? String(bitacoraFormImpacto.value || "").trim() : "";
  const cambios = bitacoraFormCambios instanceof HTMLTextAreaElement ? String(bitacoraFormCambios.value || "") : "";
  const importante = bitacoraFormImportante instanceof HTMLInputElement ? Boolean(bitacoraFormImportante.checked) : false;
  if (!fecha) {
    void showAppDialog({ message: "Indica fecha y hora de la entrada.", primaryText: "Entendido", showSecondary: false });
    return;
  }
  if (!tipo) {
    void showAppDialog({ message: "Selecciona el tipo de cambio.", primaryText: "Entendido", showSecondary: false });
    return;
  }
  if (!String(cambios).trim()) {
    void showAppDialog({ message: "Describe el cambio o mejora realizada.", primaryText: "Entendido", showSecondary: false });
    return;
  }
  const titulo = programa && tipo ? `${programa} – ${tipo}` : programa || tipo || "";
  const payload = normalizeBitacoraRow({
    id: bitacoraEditingId || `bit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    fecha,
    tipo,
    programa,
    cambios: cambios.slice(0, BITACORA_CAMBIOS_MAX),
    observaciones: "",
    titulo,
    impacto,
    importante,
    teamId: sessTeam
  });
  if (bitacoraEditingId) {
    const idx = findBitacoraRowIndex(bitacoraEditingId);
    if (idx >= 0) {
      const prev = bitacoraData[idx];
      const mergedTitulo = String(prev.titulo || "").trim() || titulo;
      bitacoraData[idx] = normalizeBitacoraRow({
        ...prev,
        ...payload,
        id: prev.id,
        titulo: mergedTitulo,
        teamId: sessTeam
      });
    }
  } else {
    bitacoraData.unshift(payload);
  }
  sortBitacoraRowsNewestFirst(bitacoraData);
  persistBitacoraData();
  resetBitacoraEntryForm();
  bitacoraPageIndex = 1;
  renderBitacoraTable();
}

function exportarBitacoraJsonFiltrado() {
  const rows = bitacoraData.filter(bitacoraRowPasaFiltros).map((r) => ({ ...r }));
  const blob = new Blob([JSON.stringify({ bitacora_data: rows }, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bitacora_export_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderBitacoraPagination(totalItems, pageSize) {
  if (!bitacoraPaginationInfo || !bitacoraPaginationNav) return;
  if (totalItems === 0) {
    bitacoraPaginationInfo.textContent = "Sin entradas para mostrar";
    bitacoraPaginationNav.innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (bitacoraPageIndex > totalPages) bitacoraPageIndex = totalPages;
  const start = totalItems === 0 ? 0 : (bitacoraPageIndex - 1) * pageSize + 1;
  const end = Math.min(bitacoraPageIndex * pageSize, totalItems);
  bitacoraPaginationInfo.textContent =
    totalItems === 0 ? "Sin entradas para mostrar" : `Mostrando ${start} a ${end} de ${totalItems} entradas`;
  const frag = document.createDocumentFragment();
  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `bitacora-page-btn${p === bitacoraPageIndex ? " is-active" : ""}`;
    btn.textContent = String(p);
    btn.dataset.bitacoraPage = String(p);
    frag.appendChild(btn);
  }
  bitacoraPaginationNav.innerHTML = "";
  bitacoraPaginationNav.appendChild(frag);
}

function ordenarBitacoraRowsParaVista(rows) {
  const asc = bitacoraOrdenSelect instanceof HTMLSelectElement && bitacoraOrdenSelect.value === "antiguos";
  const copy = rows.slice();
  copy.sort((a, b) => {
    const ta = Date.parse(String(a.fecha || "")) || 0;
    const tb = Date.parse(String(b.fecha || "")) || 0;
    return asc ? ta - tb : tb - ta;
  });
  return copy;
}

function renderBitacoraTable() {
  if (!bitacoraTimelineList) return;
  renderBitacoraTipoSelect();
  const filtered = bitacoraData.filter(bitacoraRowPasaFiltros);
  const sorted = ordenarBitacoraRowsParaVista(filtered);
  const pageSize = Math.max(1, Math.min(100, Number(bitacoraPageSizeSelect?.value) || 10));
  const total = sorted.length;
  renderBitacoraPagination(total, pageSize);
  const start = (bitacoraPageIndex - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  if (!bitacoraData.length) {
    bitacoraTimelineList.innerHTML = `<div class="bitacora-timeline-empty">Sin entradas aún. Completa el formulario superior y pulsa <strong>Guardar entrada</strong>.</div>`;
    return;
  }
  if (!filtered.length) {
    bitacoraTimelineList.innerHTML = `<div class="bitacora-timeline-empty">No hay entradas que coincidan con los filtros. Prueba a limpiar filtros o ajustar la búsqueda.</div>`;
    return;
  }

  bitacoraTimelineList.innerHTML = pageRows
    .map((row, i) => {
      const id = escapeHtml(row.id);
      const titulo = escapeHtml(bitacoraDisplayTitulo(row));
      const fechaStr = escapeHtml(formatearFechaBitacora(row.fecha));
      const tipo = escapeHtml(row.tipo || "");
      const prog = escapeHtml(row.programa || "");
      const descRaw = [row.cambios, row.observaciones].filter(Boolean).join("\n\n");
      const descHtml = escapeHtml(descRaw).replaceAll("\n", "<br>");
      const imp = String(row.impacto || "").toLowerCase();
      const impLabel = bitacoraImpactoLabel(imp);
      const impChip =
        imp && impLabel
          ? `<span class="bitacora-chip bitacora-chip--impacto bitacora-chip--impacto-${escapeHtml(imp)}">${escapeHtml(impLabel)}</span>`
          : "";
      const impBadge = row.importante ? `<span class="bitacora-badge-importante"><i class="fa-solid fa-star" aria-hidden="true"></i> Importante</span>` : "";
      const tipoChip = tipo ? `<span class="bitacora-chip bitacora-chip--tipo">${tipo}</span>` : "";
      const progChip = prog ? `<span class="bitacora-chip bitacora-chip--programa">${prog}</span>` : "";
      const delay = Math.min(320, 40 + i * 36);
      return `
      <article class="bitacora-card bitacora-card-enter" style="--bitacora-card-delay:${delay}ms" data-bitacora-card-id="${id}">
        <div class="bitacora-card-track" aria-hidden="true"><span class="bitacora-card-node"></span></div>
        <div class="bitacora-card-time">${fechaStr}</div>
        <div class="bitacora-card-main">
          <div class="bitacora-card-headrow">
            <h4 class="bitacora-card-title">${titulo}</h4>
            <div class="bitacora-card-actions">
              <button type="button" class="bitacora-card-icon-btn" data-bitacora-edit-id="${id}" title="Editar" aria-label="Editar entrada"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
              <button type="button" class="bitacora-card-icon-btn bitacora-card-icon-btn--danger" data-bitacora-delete-id="${id}" title="Eliminar" aria-label="Eliminar entrada"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
            </div>
          </div>
          ${impBadge ? `<div class="bitacora-card-badges-top">${impBadge}</div>` : ""}
          <div class="bitacora-card-desc">${descHtml || "&nbsp;"}</div>
          <div class="bitacora-card-chips">${tipoChip}${progChip}${impChip}</div>
        </div>
      </article>`;
    })
    .join("");
}

try {
  globalThis.__campatrackRenderBitacoraAfterHydrate = () => {
    renderBitacoraTable();
  };
} catch (_) {
  /* ignore */
}

function initBitacoraModule() {
  hydratarBitacoraData();
  initBitacoraDateRangePicker();
  if (bitacoraFiltroProgramaInput) bitacoraFiltroProgramaInput.value = bitacoraFiltros.programa;
  if (bitacoraFechaRangoPicker && bitacoraFiltros.fechaInicio && bitacoraFiltros.fechaFin) {
    bitacoraFechaRangoPicker.setDate([bitacoraFiltros.fechaInicio, bitacoraFiltros.fechaFin], true, "Y-m-d");
  } else if (bitacoraFechaRangoInput) {
    bitacoraFechaRangoInput.value = formatBitacoraRangeInputValue(bitacoraFiltros.fechaInicio, bitacoraFiltros.fechaFin);
  }
  resetBitacoraEntryForm();
  refreshBitacoraFormProgramaOptions();
  renderBitacoraTable();

  bitacoraGuardarEntradaBtn?.addEventListener("click", () => guardarBitacoraDesdeFormulario());
  bitacoraCancelarEdicionBtn?.addEventListener("click", () => resetBitacoraEntryForm());
  bitacoraFormCambios?.addEventListener("input", () => updateBitacoraCharCount());

  bitacoraTimelineList?.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-bitacora-edit-id]");
    if (editBtn) {
      const id = editBtn.getAttribute("data-bitacora-edit-id");
      if (id) fillBitacoraEntryFormFromRow(id);
      return;
    }
    const delBtn = event.target.closest("[data-bitacora-delete-id]");
    if (delBtn) {
      const rowId = delBtn.getAttribute("data-bitacora-delete-id");
      if (!rowId) return;
      const rowIndex = findBitacoraRowIndex(rowId);
      if (rowIndex < 0) return;
      bitacoraData.splice(rowIndex, 1);
      if (String(bitacoraEditingId || "") === String(rowId)) resetBitacoraEntryForm();
      persistBitacoraData();
      renderBitacoraTable();
    }
  });

  bitacoraPaginationNav?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-bitacora-page]");
    if (!btn) return;
    const p = Number(btn.getAttribute("data-bitacora-page"));
    if (!Number.isFinite(p) || p < 1) return;
    bitacoraPageIndex = Math.round(p);
    renderBitacoraTable();
  });

  bitacoraLimpiarFiltrosBtn?.addEventListener("click", () => {
    bitacoraFiltros.tipo = "";
    bitacoraFiltros.programa = "";
    bitacoraFiltros.fechaInicio = "";
    bitacoraFiltros.fechaFin = "";
    if (bitacoraFiltroTipoSelect instanceof HTMLSelectElement) bitacoraFiltroTipoSelect.value = "";
    if (bitacoraFiltroProgramaInput instanceof HTMLInputElement) bitacoraFiltroProgramaInput.value = "";
    if (bitacoraFechaRangoPicker) bitacoraFechaRangoPicker.clear();
    else if (bitacoraFechaRangoInput) bitacoraFechaRangoInput.value = "";
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  });

  bitacoraExportBtn?.addEventListener("click", () => exportarBitacoraJsonFiltrado());

  bitacoraOrdenSelect?.addEventListener("change", () => {
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  });

  bitacoraPageSizeSelect?.addEventListener("change", () => {
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  });

  bitacoraFiltroProgramaInput?.addEventListener("input", (event) => {
    bitacoraFiltros.programa = event.target instanceof HTMLInputElement ? event.target.value : "";
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  });

  bitacoraFiltroTipoSelect?.addEventListener("change", (event) => {
    bitacoraFiltros.tipo = event.target instanceof HTMLSelectElement ? event.target.value : "";
    bitacoraPageIndex = 1;
    renderBitacoraTable();
  });

  syncCatalogosSistemaDesdeMemoria();
  refreshPlanningCatalogUi();
}

// =========================
// DATA module (independiente)
// =========================

let dataReal = [];
/** Sincroniza `dataReal` con el equipo actual desde `appState.dataDraft.data_general` (mismas referencias de objeto). */
function syncDataRealViewFromDraft() {
  dataReal.length = 0;
  ensureDataGeneralDraftShape().forEach((r) => {
    if (rowBelongsToCurrentTeam(r)) dataReal.push(r);
  });
}

/** Sustituye en el draft las filas del equipo actual por `mergedSorted` (p. ej. tras upsert). */
function replaceCurrentTeamDataGeneralFromMerged(mergedSorted) {
  const dg = ensureDataGeneralDraftShape();
  const tid = getCurrentTeamId();
  const full = mergeRowsByTeamId(dg, mergedSorted, tid, normalizeRowTeamId);
  dg.length = 0;
  full.forEach((r) => dg.push(r));
  syncDataRealViewFromDraft();
}

/** Quita del draft todas las filas del equipo actual. */
function clearDataGeneralCurrentTeamInDraft() {
  const dg = ensureDataGeneralDraftShape();
  const tid = getCurrentTeamId();
  const next = dg.filter((r) => String(normalizeRowTeamId(r)) !== String(tid));
  dg.length = 0;
  next.forEach((r) => dg.push(r));
  syncDataRealViewFromDraft();
}

let dataAdsReport = [];
/** Filas DATA → Anuncios (carga solo desde pestaña Anuncios). */
let dataAnuncios = [];
let dataActiveSubtab = "general";

/** Filas de data real que coinciden con programa + tracking + plataforma (nombre de campaña). */
function dataRowMatchesPlanningContext(row, programa, tracking, plataforma) {
  const nombre = normalizarTexto(row.nombre);
  const pProg = normalizarTexto(programa);
  if (!pProg || !nombre) return false;
  if (!nombre.includes(pProg) && !pProg.split(" ").some((w) => w.length > 4 && nombre.includes(w))) return false;

  const tNorm = normalizarTexto(tracking);
  const dTracking = nombre.includes("leadgen") ? "leadgen" : nombre.includes("pixel") ? "pixel" : "";
  if (tNorm.includes("leadgen")) {
    if (dTracking !== "leadgen") return false;
  } else if (tNorm.includes("pixel")) {
    if (dTracking !== "pixel") return false;
  } else {
    return false;
  }

  const pl = normalizarTexto(plataforma);
  if (pl.includes("meta") || pl.includes("facebook")) return nombre.includes("meta") || nombre.includes("facebook");
  if (pl.includes("google")) return nombre.includes("google");
  if (pl.includes("tiktok")) return nombre.includes("tiktok");
  if (pl.includes("linkedin")) return nombre.includes("linkedin");
  return false;
}

/** Claves `planningKey` del formulario Planning para cruzar con RELACIONES (sin usar nombre de campaña en DATA). */
function getPlanningKeysForCplHistoricoForm() {
  const tipo = String(programTypeSelect?.value || "").trim();
  const programa = (programNameInput?.value || "").trim();
  const tracking = (trackingSelect?.value || "").trim();
  const plataforma = (plataformaSelect?.value || "").trim();
  const keys = new Set();
  if (!tipo || !programa || !tracking || !plataforma) return keys;
  for (const r of planningDraftRecords()) {
    if (String(r.tipo || "").trim() !== tipo) continue;
    if (String(r.programa || "").trim() !== programa) continue;
    if (String(r.tracking || "").trim() !== tracking) continue;
    if (String(r.plataforma || "").trim() !== plataforma) continue;
    keys.add(planningKeyFromRecord(r));
  }
  return keys;
}

/** IDs campaña DATA (`idCampania`) vinculados a las claves de planning dadas. */
function getIdCampaniaSetFromRelaciones(planningKeys) {
  const ids = new Set();
  if (!(planningKeys instanceof Set) || planningKeys.size === 0) return ids;
  getRelacionesPlataforma().forEach((rel) => {
    const pk = String(rel.planningKey || "");
    if (!planningKeys.has(pk)) return;
    const id = String(rel.idCampania || "").trim();
    if (id) ids.add(id);
  });
  return ids;
}

function formatCplHistoricoMonthShort(monthKey) {
  const [yearStr, monthStr] = String(monthKey || "").split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return String(monthKey || "");
  }
  const meses = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  return `${meses[month - 1]}${String(year).slice(-2)}`;
}

function renderCplHistoricoHintMessage(msg) {
  void msg;
  renderCplHistoricoHintEmptyTable();
}

function renderCplHistoricoHintEmptyTable() {
  if (!cplHistoricoHint) return;
  cplHistoricoHint.innerHTML = `
    <div class="cpl-historico">
      <table aria-hidden="true">
        <tr class="meses">
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td class="is-prom">&nbsp;</td>
        </tr>
        <tr class="valores">
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td class="is-prom">&nbsp;</td>
        </tr>
      </table>
    </div>
  `;
}

function renderCplHistoricoHintTable(monthLabels, cpls, prom) {
  if (!cplHistoricoHint) return;
  const labels = [...(monthLabels || [])].slice(0, 3);
  const values = [...(cpls || [])].slice(0, 3);
  while (labels.length < 3) labels.push("");
  while (values.length < 3) values.push("");
  const mesesRow = labels.map((m) => `<td>${escapeHtml(String(m || "\u00a0"))}</td>`).join("");
  const valuesRow = values.map((v) => `<td>${escapeHtml(String(v || "\u00a0"))}</td>`).join("");
  const promText = Number.isFinite(Number(prom)) ? String(prom) : "\u00a0";
  cplHistoricoHint.innerHTML = `
    <div class="cpl-historico">
      <table aria-hidden="true">
        <tr class="meses">${mesesRow}<td class="is-prom">Prom</td></tr>
        <tr class="valores">${valuesRow}<td class="is-prom">${escapeHtml(promText)}</td></tr>
      </table>
    </div>
  `;
}

function updateCplHistoricoPlanningForm() {
  if (!cplHistoricoHint) return;
  if (planningTipoAlcance(programTypeSelect?.value || "")) {
    renderCplHistoricoHintMessage("");
    return;
  }
  const tipo = String(programTypeSelect?.value || "").trim();
  const programa = (programNameInput?.value || "").trim();
  const tracking = (trackingSelect?.value || "").trim();
  const plataforma = (plataformaSelect?.value || "").trim();
  if (!tipo || !programa || !tracking || !plataforma) {
    renderCplHistoricoHintMessage("");
    return;
  }
  const planningKeys = getPlanningKeysForCplHistoricoForm();
  if (!planningKeys.size) {
    renderCplHistoricoHintMessage("");
    return;
  }
  const linkedIds = getIdCampaniaSetFromRelaciones(planningKeys);
  if (!linkedIds.size) {
    renderCplHistoricoHintMessage("Campaña sin relación con DATA");
    return;
  }
  const rows = dataReal.filter((r) => {
    if (!(r.fecha instanceof Date)) return false;
    const id = String(r.idCampania || "").trim();
    return id && linkedIds.has(id);
  });
  if (!rows.length) {
    renderCplHistoricoHintMessage("Sin histórico disponible");
    return;
  }
  const byMonth = new Map();
  rows.forEach((r) => {
    const y = r.fecha.getFullYear();
    const m = r.fecha.getMonth() + 1;
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!byMonth.has(key)) byMonth.set(key, { gasto: 0, leads: 0 });
    const o = byMonth.get(key);
    o.gasto += Number(r.gasto) || 0;
    o.leads += Number(r.leads) || 0;
  });
  const monthsWithData = [...byMonth.entries()]
    .map(([monthKey, agg]) => {
      const gasto = Number(agg?.gasto) || 0;
      const leads = Number(agg?.leads) || 0;
      if (!(leads > 0)) return null;
      return { monthKey, cpl: Math.round(gasto / leads) };
    })
    .filter((x) => x != null);
  if (!monthsWithData.length) {
    renderCplHistoricoHintMessage("Sin histórico disponible");
    return;
  }
  const mesesSeleccionados = monthsWithData
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
    .slice(0, 3)
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const monthLabels = mesesSeleccionados.map((m) => formatCplHistoricoMonthShort(m.monthKey));
  const cpls = mesesSeleccionados.map((m) => m.cpl);
  const prom = Math.round(cpls.reduce((a, b) => a + b, 0) / cpls.length);
  renderCplHistoricoHintTable(monthLabels, cpls, prom);
}

let dataFiltrada = [];
let campaniasUnicasData = [];
let historialCargas = [];
let erroresData = [];
/** Último detalle de carga (filas no registradas, avisos) por submódulo DATA. */
let ultimoDetalleCargaGeneral = null;
let dataIdSeq = 1;
let selectedDataIds = new Set();
let selectedAnunciosIds = new Set();
let ultimoDetalleCargaAnuncios = null;
let adsReportFiltrada = [];
let adsReportSort = { field: "leads", dir: "desc" };
let adsThumbModalState = {
  aggregateKey: "",
  existingThumbnail: "",
  existingOriginal: "",
  pendingThumbnail: "",
  pendingOriginal: "",
};
let adsPreviewHoverTimer = null;
let adsPreviewHoverAnchor = null;
/**
 * Vista directa: punteros a las mismas filas que en `appState.dataDraft.relaciones`.
 * Sin filtros ni transformaciones adicionales.
 */
let relaciones = [];
let crmLeads = [];
let relacionesCrm = [];
/** Sincroniza la vista `relaciones` (solo DATA ↔ Planning; nunca CRM). */
function syncRelacionesViewFromDraft() {
  const moved = sanitizeRelacionesDraftChannels();
  relaciones.length = 0;
  ensureRelacionesDraftShape().forEach((r) => {
    if (isRelacionPlataformaRow(r)) relaciones.push(r);
  });
  if (moved > 0 && hasDataGeneralLoaded()) {
    generarModeloAnalitico();
    syncCcBitacoraModeloDraftFromRuntime();
  }
}

/** Relaciones plataforma para modelo, gasto y dashboard marketing. */
function getRelacionesPlataforma() {
  return ensureRelacionesDraftShape().filter(isRelacionPlataformaRow);
}

function syncRelacionesCrmViewFromDraft() {
  const draft = ensureRelacionesCrmDraftShape();
  draft.forEach((r) => {
    if (!r || typeof r !== "object" || r.crmKey == null) return;
    const nk = crmMigrateNormalizedQuarterCrmKey(String(r.crmKey || ""));
    if (nk !== String(r.crmKey || "")) r.crmKey = nk;
  });
  relacionesCrm.length = 0;
  draft.forEach((rel) => relacionesCrm.push(rel));
}

function syncCrmLeadsViewFromDraft() {
  const draft = ensureCrmLeadsDraftShape();
  draft.forEach((r) => {
    if (!r || typeof r !== "object") return;
    const nm = crmNormalizeQuarterTokensToPlanningIntake(String(r.nombreCampania || "").trim());
    const prev = String(r.nombreCampania || "").trim();
    if (nm && nm !== prev) r.nombreCampania = nm;
  });
  crmLeads.length = 0;
  draft.forEach((row) => crmLeads.push(row));
  updateDataKpisFromCrm();
  refreshCrmDataSegmentadoresUI();
  renderCrmDataResumenTable();
}

function replaceCurrentTeamRelacionesFromMerged(mergedSlice) {
  const dg = ensureRelacionesDraftShape();
  dg.length = 0;
  (Array.isArray(mergedSlice) ? mergedSlice : []).forEach((r) => dg.push(r));
  syncRelacionesViewFromDraft();
}

function clearCurrentTeamRelacionesInDraft() {
  const dg = ensureRelacionesDraftShape();
  dg.length = 0;
  syncRelacionesViewFromDraft();
}

let medidas = [];
let selectedPlanningKeys = new Set();
let selectedDataCampaignKeys = new Set();
let sugerenciasRelaciones = [];
let relacionesSearchQuery = "";
let relacionesPlanningListQuery = "";
let relacionesDataListQuery = "";
let relFiltroPlataforma = "";
let relFiltroEstadoRel = "";
let relFiltroTipo = "";
let relActiveSubtab = "meta";
let crmRelPlanningListQuery = "";
let crmRelCrmListQuery = "";
let crmRelacionesSearchQuery = "";
let crmRelFiltroPlataforma = "";
let crmRelFiltroEstadoRel = "";
let crmRelFiltroIntake = "";
let relKpiSessionBaseline = null;
let modeloAnalitico = [];
let estadoFiltros = { tipo: null, programa: null, intake: null, tracking: null };
let segmentadores = ["tipo", "programa", "intake", "tracking"];
let debounceId = null;
let fechaActualData = null;
/** Filtros solo DASHBOARD: toggles en string vacío o valor; fechas yyyy-mm-dd */
let estadoFiltrosDashboard = {
  mes: "",
  fechaInicio: "",
  fechaFin: "",
  tipo: "",
  intake: "",
  tracking: "",
  plataforma: "",
  estado: "",
  busquedaPrograma: ""
};
let programaSeleccionado = null;

function syncDashboardTableRowDomSelectionHighlight() {
  try {
    const sel = String(programaSeleccionado ?? "").trim();
    document.querySelectorAll("#dashTbody tr[data-dash-row]").forEach((row) => {
      row.classList.toggle("dash-row-selected", !!sel && row.getAttribute("data-dash-row") === sel);
    });
    document.querySelectorAll("#dashCrmTbody tr[data-dash-row]").forEach((row) => {
      row.classList.toggle("dash-row-selected", !!sel && row.getAttribute("data-dash-row") === sel);
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Si es false: excluye campañas por nombre heurístico y tipos Charla / Webinar / Alcance.
 * Si es true: incluye gasto y presupuesto de esos tipos; leads/CPL/rendimiento de esos tipos siguen en 0.
 */
let incluirBrandingDashboard = false;
const LS_DASH_MOSTRAR_META_GLOBAL = "dashboard_mostrar_meta_global";
const LS_DASH_ACTIVE_SUBTAB = "dashboard_active_subtab";
/** `"plataforma"` | `"crm"` — vista activa dentro del módulo Dashboard. */
let dashboardActiveSubtab = "plataforma";
/** `"platVsCrm"` | `"fuente"` — panel inferior del dashboard CRM. */
let dashboardCrmBottomMode = "platVsCrm";
/** `"total"` | `"mes"` — alcance temporal solo tabla Intervalo de Gestión (respeta fila seleccionada). */
let dashboardCrmIntervaloPeriodScope = "total";
/** Tab operativa CRM activa (preparado para filtrar motivos de no interés). */
let dashboardCrmOperActiveTab = "gestionados";
let mostrarMetaGlobal = true;
try {
  const rawMostrarMetaGlobal = appMemoryKV.getItem(LS_DASH_MOSTRAR_META_GLOBAL);
  if (rawMostrarMetaGlobal === "false") mostrarMetaGlobal = false;
} catch (err) {
  console.warn("No se pudo leer estado de columnas META GLOBAL", err);
}
const MESES_LARGOS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
let filtrosCache = {
  fecha: { months: [], daysByMonth: new Map() },
  idCampania: [],
  nombre: []
};

/** Paginación pestaña Data — General (1-based). */
let dataGeneralPageIndex = 1;
let dataCrmResumenPageIndex = 1;
/** Opciones únicas Flujo (columna Programa) para autocompletado DATA → CRM */
let crmDataTabProgramasSortedCache = [];
let crmProgramaFilterDebounceId = null;

const LS_KEYS = {
  dataReal: "data_general",
  dataAdsReport: "data_ads_report",
  dataAnuncios: "data_anuncios",
  campaniasUnicasData: "campaniasUnicasData",
  relaciones: "relaciones",
  medidas: "medidas",
  modeloAnalitico: "modeloAnalitico"
};

/** Miniaturas manuales del reporte (clave agregada → data URL, máx. ~50 KB al guardar). */
const LS_ADS_REPORT_THUMBS = "ads_report_thumbs_b64";
const ADS_REPORT_THUMB_MAX_BYTES = 50 * 1024;
const ADS_REPORT_ORIGINAL_MAX_BYTES = 350 * 1024;
const ADS_REPORT_PREVIEW_HOVER_DELAY_MS = 3000;

function guardarEnLocalStorage(clave, data) {
  if (shouldDeferDiskPersistence()) return;
  try {
    appMemoryKV.setItem(clave, JSON.stringify(data));
  } catch (err) {
    console.warn("No se pudo guardar en localStorage:", clave, err);
  }
}

function cargarDesdeLocalStorage(clave) {
  try {
    const raw = appMemoryKV.getItem(clave);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("No se pudo leer/parsing localStorage:", clave, err);
    return null;
  }
}

function resetearSistemaCompleto() {
  const u = typeof getUser === "function" ? getUser() : null;
  if (!resolveCampatrackSessionPermissions(u || {}).canReset) {
    void showAppDialog({
      message: "No tienes permiso para reiniciar el sistema desde la configuración lateral.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false
    });
    return;
  }
  showResetSystemKeyDialog().then((ok) => {
    if (!ok) return;
    try {
      appMemoryKV.clear();
    } catch (err) {
      console.warn("No se pudo limpiar localStorage", err);
    }
    location.reload();
  });
}

const RESET_SYSTEM_PASSWORD = "R1c4rd02010";

function showDataClearSelectionDialog() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("dataClearModalOverlay");
    const generalChk = document.getElementById("dataClearGeneralChk");
    const anunciosChk = document.getElementById("dataClearAnunciosChk");
    const errorEl = document.getElementById("dataClearModalError");
    const confirmBtn = document.getElementById("dataClearConfirmBtn");
    const cancelBtn = document.getElementById("dataClearCancelBtn");
    if (!overlay || !generalChk || !anunciosChk || !errorEl || !confirmBtn || !cancelBtn) {
      resolve(null);
      return;
    }

    generalChk.checked = false;
    anunciosChk.checked = false;
    errorEl.textContent = "";
    errorEl.classList.add("hidden");

    let settled = false;
    const cleanup = () => {
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onOverlayClick = (e) => {
      if (e.target === overlay) finish(null);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };

    confirmBtn.onclick = () => {
      const selection = {
        general: Boolean(generalChk.checked),
        anuncios: Boolean(anunciosChk.checked)
      };
      if (!selection.general && !selection.anuncios) {
        errorEl.textContent = "Debes seleccionar al menos un tipo de data";
        errorEl.classList.remove("hidden");
        return;
      }
      finish(selection);
    };
    cancelBtn.onclick = () => finish(null);

    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => generalChk.focus());
  });
}

function showResetSystemKeyDialog() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("resetSystemModalOverlay");
    const keyInput = document.getElementById("resetSystemKeyInput");
    const errorEl = document.getElementById("resetSystemModalError");
    const confirmBtn = document.getElementById("resetSystemConfirmBtn");
    const cancelBtn = document.getElementById("resetSystemCancelBtn");
    if (!overlay || !keyInput || !errorEl || !confirmBtn || !cancelBtn) {
      resolve(false);
      return;
    }

    keyInput.value = "";
    errorEl.textContent = "";
    errorEl.classList.add("hidden");

    let settled = false;
    const cleanup = () => {
      overlay.classList.add("hidden");
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onOverlayClick = (e) => {
      if (e.target === overlay) finish(false);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      if (e.key === "Enter" && !overlay.classList.contains("hidden")) {
        e.preventDefault();
        confirmBtn.click();
      }
    };

    confirmBtn.onclick = () => {
      if (String(keyInput.value || "") !== RESET_SYSTEM_PASSWORD) {
        errorEl.textContent = "Clave incorrecta";
        errorEl.classList.remove("hidden");
        keyInput.focus();
        keyInput.select();
        return;
      }
      finish(true);
    };
    cancelBtn.onclick = () => finish(false);

    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => keyInput.focus());
  });
}

function limpiarDataSeleccionada(selection) {
  const clearGeneral = Boolean(selection?.general);
  const clearAnuncios = Boolean(selection?.anuncios);
  if (!clearGeneral && !clearAnuncios) return;

  if (clearGeneral) {
    clearDataGeneralCurrentTeamInDraft();
    historialCargas = [];
    selectedDataIds = new Set();
    limpiarFiltrosUiDataGeneral();
    const loadNotice = document.getElementById("dataGeneralLoadNotice");
    if (loadNotice) {
      loadNotice.textContent = "";
      loadNotice.classList.add("hidden");
    }
  }
  if (clearAnuncios) {
    dataAnuncios = [];
    selectedAnunciosIds = new Set();
  }

  erroresData = [];
  campaniasUnicasData = [];
  const allRows = dataReal.concat(dataAdsReport, dataAnuncios);
  dataIdSeq = Math.max(1, ...allRows.map((r) => Number(r._id) || 0)) + 1;

  guardarData();
  actualizarFiltrosCache();
  refreshFechaFiltersUI();
  renderTablaData();
  renderTablaAnuncios();
  renderTablaCampañas();
  renderRelacionesDataList();
  refreshAdsReportFilterOptions();
  renderAdsReportModule();
  try {
    if (dashboardUiInicializado) renderDashboardFromFilters();
  } catch {}
}

/** Solo tablas DATA seleccionadas en memoria y appMemoryKV. No modifica planning ni centros de costos. */
function limpiarSoloModuloData() {
  showDataClearSelectionDialog().then((selection) => {
    if (!selection) return;
    limpiarDataSeleccionada(selection);
  });
}

/** Claves incluidas en backup / importación entre equipos (objeto JSON único). */
const EXPORT_BUNDLE_KEYS = [
  "cc_data",
  "planning_data",
  "catalogos_sistema",
  "programs",
  "bitacora_data",
  "data_general",
  "data_ads_report",
  "data_anuncios",
  "relaciones",
  "relaciones_crm",
  "campatrack_users_db",
  "campatrack_teams_db",
  "auditoria"
];

/** True mientras se obtiene `/api/data` tras el login (shell visible, dashboards en skeleton). */
let campatrackPostLoginHydrationBusy = false;

/** Estado adicional que el dashboard hidrata / persiste fuera del JSON mínimo de export. */
const CLAVES_EXTRA_ESTADO_SISTEMA = ["campaniasUnicasData", "medidas", "modeloAnalitico", "modelo"];

/** Evita POST solapados: una importación tras otra espera la respuesta anterior. */
let guardarDataEnApiCadena = Promise.resolve();

/** Desenvuelve JSON tipo respuesta API { data: { cc_data, ... } } al objeto bundle. */
function normalizarPayloadABundleImport(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const tieneAlgunaClaveBundle = (obj) =>
    EXPORT_BUNDLE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (tieneAlgunaClaveBundle(payload)) return payload;
  const inner = payload.data;
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    tieneAlgunaClaveBundle(inner)
  ) {
    return inner;
  }
  return payload;
}

/** Misma lectura que `exportarDatosSistema` (sin llamar persist*): reflejo de lo guardado tras importar. */
function construirSnapshotDesdeLocalStorageComoExport() {
  syncCcBitacoraModeloDraftFromRuntime();
  const modeloSer = serializeModelo(modeloMergedCache || modeloAnalitico);
  const bitFromDraft = appState.dataDraft?.bitacora_data;
  const bitacoraSnap = Array.isArray(bitFromDraft)
    ? JSON.parse(JSON.stringify(bitFromDraft))
    : leerJsonLocalStorage(LS_BITACORA_DATA) ?? JSON.parse(JSON.stringify(bitacoraData));
  return {
    cc_data: appState.dataDraft?.cc_data ?? leerJsonLocalStorage(LS_CC_DATA, "centros_costos"),
    planning_data: leerJsonLocalStorage(LS_PLANNING_DATA, "planningData"),
    catalogos_sistema: leerJsonLocalStorage(LS_CATALOGOS_SISTEMA),
    programs: JSON.parse(JSON.stringify(programs)),
    bitacora_data: bitacoraSnap,
    data_general: serializeDataReal(ensureDataGeneralDraftShape()),
    data_ads_report: leerJsonLocalStorage(LS_KEYS.dataAdsReport, "dataAdsReport"),
    data_anuncios: leerJsonLocalStorage(LS_KEYS.dataAnuncios, "dataAnuncios"),
    relaciones: JSON.parse(JSON.stringify(ensureRelacionesDraftShape())),
    campatrack_users_db: JSON.parse(JSON.stringify(ensureCampatrackUsersDraftShape())),
    campatrack_teams_db: getCampatrackStoredTeams(),
    campaniasUnicasData: leerJsonLocalStorage(LS_KEYS.campaniasUnicasData),
    medidas: leerJsonLocalStorage(LS_KEYS.medidas),
    modeloAnalitico: appState.dataDraft?.modeloAnalitico ?? appState.dataDraft?.modelo ?? modeloSer,
    modelo: appState.dataDraft?.modelo ?? modeloSer,
    auditoria: JSON.parse(JSON.stringify(ensureAuditoriaDraftShape()))
  };
}

/** Prioriza lo ya volcado en localStorage; completa con el payload del archivo (p. ej. JSON anidado en `data`). */
function obtenerDataCompletaRealParaAPI(payload) {
  const desdeLs = construirSnapshotDesdeLocalStorageComoExport();
  const desdeArchivo = normalizarPayloadABundleImport(payload);
  const todasClaves = EXPORT_BUNDLE_KEYS.concat(CLAVES_EXTRA_ESTADO_SISTEMA);
  const out = {};
  for (const k of todasClaves) {
    const enLs = desdeLs[k];
    const enArchivo =
      desdeArchivo && Object.prototype.hasOwnProperty.call(desdeArchivo, k)
        ? desdeArchivo[k]
        : undefined;
    const v = enLs !== undefined && enLs !== null ? enLs : enArchivo;
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const CAMPATRACK_API_ORIGIN =
  typeof window !== "undefined" && window.CAMPATRACK_API_ORIGIN
    ? String(window.CAMPATRACK_API_ORIGIN).replace(/\/$/, "")
    : "http://localhost:3000";

/** Opciones fetch para GET /api/data — evita 304 / caché HTTP del navegador. */
const CAMPATRACK_FETCH_OPTIONS_GET_API_DATA = Object.freeze({ cache: "no-store" });

/**
 * Modo demo frontend-only: JSON remoto (p. ej. GitHub raw) + localStorage al publicar.
 * Producción Node/SQL: `window.CAMPATRACK_APP_MODE = "full"` o eliminar el flag (defecto full).
 */
function campatrackIsLiteMode() {
  if (typeof window === "undefined") return false;
  const mode = String(window.CAMPATRACK_APP_MODE || "full").trim().toLowerCase();
  if (mode === "lite" || mode === "demo") return true;
  if (window.CAMPATRACK_USE_REMOTE_JSON === true) return true;
  return false;
}

function campatrackDefaultRemoteJsonUrl() {
  return "https://raw.githubusercontent.com/ridigoal/campatrack-data/refs/heads/main/data.json";
}

function campatrackRemoteJsonUrlResolved() {
  if (campatrackIsLiteMode()) {
    const c = loadClientGithubConfig();
    if (c && hasClientGithubConfigComplete()) {
      const u = buildGithubRawDataJsonUrl(c.owner, c.repo, c.branch || "main");
      if (u) return u;
    }
  }
  if (typeof window !== "undefined" && window.CAMPATRACK_REMOTE_JSON_URL) {
    const u = String(window.CAMPATRACK_REMOTE_JSON_URL).trim();
    if (u) return u;
  }
  return campatrackDefaultRemoteJsonUrl();
}

/**
 * Persiste el borrador actual en el backend. Usa snapshot en memoria (no mezcla con LS obsoleto).
 * @returns {Promise<boolean>} true si hubo sesión y el POST terminó bien
 */
async function persistPublishedBundleToBackend() {
  if (typeof isCampatrackAuthenticated !== "function" || !isCampatrackAuthenticated()) {
    console.warn("[CampaTrack publicar] Sin sesión: no se envía bundle al servidor.");
    return false;
  }
  syncCcBitacoraModeloDraftFromRuntime();
  recomputePlanningMergedCacheFromRecords();
  const data = buildMemorySnapshotForPublish();
  return await guardarDataEnAPI(data);
}

async function guardarDataEnAPI(dataCompletaReal) {
  if (
    dataCompletaReal == null ||
    typeof dataCompletaReal !== "object" ||
    Array.isArray(dataCompletaReal) ||
    Object.keys(dataCompletaReal).length === 0
  ) {
    const msg = "[CampaTrack publicar] No se envía: bundle vacío o inválido.";
    console.error(msg);
    throw new Error(msg);
  }

  const rawSes = appMemorySession.getItem(SS_USER_SESSION_JSON);
  const user = rawSes ? JSON.parse(rawSes) : null;

  if (!user || !user.username) {
    const msg = "[CampaTrack publicar] No hay usuario en sesión.";
    console.error(msg);
    throw new Error(msg);
  }

  const partitionKey = campatrackCampaignDataPartitionKeyFromUserLike(user);
  if (!partitionKey) {
    const msg = "[CampaTrack publicar] No hay clave de partición (team_id) para guardar.";
    console.error(msg);
    throw new Error(msg);
  }

  const planRec =
    dataCompletaReal.planning_data && Array.isArray(dataCompletaReal.planning_data.records)
      ? dataCompletaReal.planning_data.records
      : [];
  console.info("[CampaTrack publicar] Enviando POST /api/data:", {
    partitionKey,
    topKeys: Object.keys(dataCompletaReal),
    planningRecords: planRec.length,
    recordIdSeq: dataCompletaReal.planning_data?.recordIdSeq
  });

  if (campatrackIsLiteMode()) {
    console.info("[CampaTrack lite] Publicación: sincronización GitHub (sin localStorage masivo).");
    syncDataOriginalFromPublishedDraft(dataCompletaReal);
    applyPlanningOriginalFromDraft();
    scheduleGithubSyncAfterSuccessfulPublish(dataCompletaReal, user);
    return true;
  }

  const res = await fetch(`${CAMPATRACK_API_ORIGIN}/api/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: partitionKey,
      data: dataCompletaReal
    })
  });

  const bodyText = await res.text();
  let bodyJson = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    /* respuesta no JSON */
  }

  if (!res.ok) {
    console.error("[CampaTrack publicar] Respuesta de error:", res.status, bodyText?.slice(0, 800));
    throw new Error(`Error del servidor (${res.status}). ${bodyText ? bodyText.slice(0, 200) : ""}`);
  }

  console.info("[CampaTrack publicar] Guardado OK. Respuesta:", bodyJson ?? bodyText);

  syncDataOriginalFromPublishedDraft(dataCompletaReal);
  applyPlanningOriginalFromDraft();
  scheduleGithubSyncAfterSuccessfulPublish(dataCompletaReal, user);
  return true;
}

/**
 * Aplica un bundle JSON solo en memoria (borrador). Requiere «Publicar» para persistir en API.
 * @param {{ showToast?: boolean }} opts
 */
function applyJsonBundleToLocalDraftOnly(bundle, opts = {}) {
  const showToast = opts.showToast !== false;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return;
  hydrateAppStateDraftFromApiBundle(bundle);
  try {
    syncRelacionesViewFromDraft();
    syncDataRelacionesModeloConsistency();
  } catch (e) {
    console.warn("applyJsonBundleToLocalDraftOnly modelo/rel", e);
  }
  try {
    hydratarCentrosCostos();
  } catch (e) {
    console.warn("hydratarCentrosCostos", e);
  }
  if (typeof rebuildPlanningTable === "function") rebuildPlanningTable();
  if (typeof rebuildRelacionesTable === "function") rebuildRelacionesTable();
  if (typeof renderDashboard === "function") renderDashboard();
  if (typeof actualizarFiltrosCache === "function") actualizarFiltrosCache();
  if (typeof refreshFechaFiltersUI === "function") refreshFechaFiltersUI();
  if (typeof renderTablaData === "function") renderTablaData();
  if (typeof renderTablaAnuncios === "function") renderTablaAnuncios();
  if (typeof renderTablaCampañas === "function") renderTablaCampañas();
  if (typeof refreshCentroCostosUI === "function") refreshCentroCostosUI();
  if (typeof renderCcKpiStrip === "function") renderCcKpiStrip();
  if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
    try {
      globalThis.__campatrackRebuildAuditoriaAfterHydrate();
    } catch (_) {}
  }
  if (typeof isCampatrackAuthenticated === "function" && isCampatrackAuthenticated()) {
    campatrackMergeSessionProfileFromDraftUsers();
    if (typeof syncCampatrackProfileHeader === "function") syncCampatrackProfileHeader();
  }
  registerUnpublishedDraftMutation();
  if (typeof updatePublishDraftToolbar === "function") updatePublishDraftToolbar();
  if (showToast) {
    showCampatrackToast("Datos cargados correctamente. Recuerda publicar para guardar los cambios.", "success");
  }
}

function ejecutarGuardadoApiTrasImportacionExitosa(payload) {
  const bundle = normalizarPayloadABundleImport(payload);
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    console.warn("ejecutarGuardadoApiTrasImportacionExitosa: payload inválido");
    return;
  }
  applyJsonBundleToLocalDraftOnly(bundle, { showToast: true });
}

let guardarApiAutoTimer = null;
function guardarDebounce() {
  if (guardarApiAutoTimer != null) clearTimeout(guardarApiAutoTimer);
  guardarApiAutoTimer = null;
}

function leerJsonLocalStorage(clave, claveLegacy) {
  const raw = appMemoryKV.getItem(clave) || (claveLegacy ? appMemoryKV.getItem(claveLegacy) : null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn("JSON inválido en localStorage:", clave, err);
    return null;
  }
}

async function exportarDatosSistema() {
  const exportBtn = document.getElementById("exportDataBtn");
  const setBusy = (b) => {
    if (exportBtn instanceof HTMLButtonElement) {
      exportBtn.disabled = b;
      exportBtn.setAttribute("aria-busy", b ? "true" : "false");
    }
  };
  try {
    const user = typeof getUser === "function" ? getUser() : null;
    if (!resolveCampatrackSessionPermissions(user || {}).canExport) {
      void showAppDialog({
        message: "No tienes permiso para exportar datos.",
        primaryText: "Entendido",
        showSecondary: false,
        primaryDanger: false
      });
      return;
    }
    const uname = String(user?.username ?? "").trim();
    if (!uname) {
      void showAppDialog({
        message: "Inicia sesión para exportar la data del servidor.",
        primaryText: "Entendido",
        showSecondary: false,
        primaryDanger: false
      });
      return;
    }
    const partitionKey = campatrackCampaignDataPartitionKeyFromUserLike(user);
    if (!partitionKey) {
      void showAppDialog({
        message: "No hay equipo o usuario válido para exportar desde el servidor.",
        primaryText: "Entendido",
        showSecondary: false,
        primaryDanger: false
      });
      return;
    }
    setBusy(true);
    let json;
    if (campatrackIsLiteMode()) {
      const mem =
        typeof buildMemorySnapshotForPublish === "function" ? buildMemorySnapshotForPublish() : null;
      if (!mem || typeof mem !== "object") throw new Error("No hay datos para exportar en modo demo.");
      json = { data: mem };
    } else {
      const res = await fetch(
        `${CAMPATRACK_API_ORIGIN}/api/data?team_id=${encodeURIComponent(partitionKey)}`,
        CAMPATRACK_FETCH_OPTIONS_GET_API_DATA
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    }
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = String(uname).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "user";
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `campatrack_backup_${safe}_${stamp}.json`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    showCampatrackToast("Backup descargado.", "success");
  } catch (err) {
    console.error("exportarDatosSistema", err);
    showCampatrackToast(String(err?.message || "Error al exportar."), "error");
  } finally {
    setBusy(false);
  }
}

function importarDatosSistemaDesdeArchivo(file) {
  if (!(file instanceof File)) return;
  const importBtn = document.getElementById("importDataBtn");
  const exportBtn = document.getElementById("exportDataBtn");
  const setBusy = (b) => {
    for (const el of [importBtn, exportBtn]) {
      if (el instanceof HTMLButtonElement) {
        el.disabled = b;
        el.setAttribute("aria-busy", b ? "true" : "false");
      }
    }
  };
  void (async () => {
    try {
      const user = typeof getUser === "function" ? getUser() : null;
      if (!resolveCampatrackSessionPermissions(user || {}).canImport) {
        void showAppDialog({
          message: "No tienes permiso para importar datos desde la configuración lateral.",
          primaryText: "Entendido",
          showSecondary: false,
          primaryDanger: false
        });
        return;
      }
      if (!user?.username) {
        void showAppDialog({
          message: "Inicia sesión para importar datos.",
          primaryText: "Entendido",
          showSecondary: false,
          primaryDanger: false
        });
        return;
      }
      const name = String(file.name || "").toLowerCase();
      if (!name.endsWith(".json")) {
        showCampatrackToast("El archivo debe ser .json", "error");
        return;
      }
      setBusy(true);
      const text = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result ?? ""));
        fr.onerror = () => reject(fr.error || new Error("No se pudo leer el archivo"));
        fr.readAsText(file, "UTF-8");
      });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("JSON inválido al importar", e);
        showCampatrackToast("El archivo no es JSON válido.", "error");
        return;
      }
      const bundle =
        typeof normalizarPayloadABundleImport === "function"
          ? normalizarPayloadABundleImport(parsed)
          : null;
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
        showCampatrackToast("El JSON no tiene el formato de backup esperado.", "error");
        return;
      }
      applyJsonBundleToLocalDraftOnly(bundle, { showToast: true });
      console.log("Borrador actualizado desde JSON (pendiente de publicar)");
    } catch (err) {
      console.error("importarDatosSistemaDesdeArchivo", err);
      showCampatrackToast(String(err?.message || "Error al importar."), "error");
    } finally {
      setBusy(false);
    }
  })();
}

function mostrarModalPostImportacion() {
  const modal = document.getElementById("importPostModal");
  const message = document.getElementById("importPostMessage");
  const bar = document.getElementById("importPostProgressBar");
  const acceptBtn = document.getElementById("importPostAcceptBtn");
  if (!modal || !message || !bar || !acceptBtn) {
    campatrackPerformLogoutToIndex();
    return;
  }

  message.textContent = "Actualizando datos...";
  bar.style.width = "0%";
  acceptBtn.classList.add("hidden");
  modal.style.display = "flex";

  const steps = [10, 24, 38, 52, 66, 80, 92, 100];
  const sliceMs = 5000 / steps.length;
  steps.forEach((pct, idx) => {
    setTimeout(() => {
      bar.style.width = `${pct}%`;
      if (pct === 100) {
        message.textContent = "Vuelve a iniciar sesión para ver la data actualizada";
        acceptBtn.classList.remove("hidden");
      }
    }, sliceMs * (idx + 1));
  });

  if (!acceptBtn.dataset.boundClick) {
    acceptBtn.dataset.boundClick = "true";
    acceptBtn.addEventListener("click", () => {
      modal.style.display = "none";
      campatrackPerformLogoutToIndex();
    });
  }
}

/**
 * Convierte `json.data` (objeto o string JSON) en objeto bundle antes de hidratar.
 */
function parseBundleDataFromApiJson(json) {
  if (!json || json.data == null || json.data === "") return null;
  let bundle = json.data;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle);
    } catch (e) {
      console.error("Error parseando data:", e);
      return null;
    }
  }
  if (bundle == null || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  return bundle;
}

/** Acepta tanto `{ data: bundle }` (API) como el archivo raw del repo demo (objeto bundle). */
function normalizeRemoteJsonFileToBundle(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const viaApiEnvelope = parseBundleDataFromApiJson(json);
  if (viaApiEnvelope) return viaApiEnvelope;
  return json;
}

async function fetchCampatrackLiteBundleFromRemote() {
  if (!hasClientGithubConfigComplete()) {
    console.warn("[CampaTrack lite] GitHub no configurado; bundle vacío.");
    return createEmptyCampatrackBundle();
  }
  try {
    return await loadModularBundleFromGithub({ loadAllManifest: true });
  } catch (e) {
    console.warn("[CampaTrack lite] Error cargando desde GitHub; bundle vacío.", e);
    return createEmptyCampatrackBundle();
  }
}

async function campatrackLoadLiteBundleForSession() {
  try {
    const bundle = await loadModularBundleFromGithub({ loadAllManifest: true });
    console.info("[CampaTrack lite] Bundle modular cargado desde GitHub");
    return bundle || createEmptyCampatrackBundle();
  } catch (e) {
    console.warn("[CampaTrack lite] campatrackLoadLiteBundleForSession:", e);
    return createEmptyCampatrackBundle();
  }
}

/**
 * Tras login exitoso: siempre consulta el backend (GET /api/data) con la partición del equipo.
 * No depende de getUser ni de localStorage; debe llamarse con el mismo objeto persistido en sesión.
 */
async function afterLoginSuccess(user) {
  try {
    const uname = String(user?.username ?? "").trim();
    if (!uname) {
      console.warn("afterLoginSuccess: sin username");
      return null;
    }
    const partitionKey = campatrackCampaignDataPartitionKeyFromUserLike(user);
    if (!partitionKey) {
      console.warn("afterLoginSuccess: sin teamId ni username para partición");
      return null;
    }
    if (campatrackIsLiteMode()) {
      let bundle = null;
      if (campatrackLiteLoginBundleCache) {
        bundle = campatrackLiteLoginBundleCache;
        campatrackLiteLoginBundleCache = null;
      } else {
        try {
          bundle = await campatrackLoadLiteBundleForSession();
        } catch (e) {
          console.warn("[CampaTrack lite] Error cargando datos demo; bundle vacío.", e);
          bundle = createEmptyCampatrackBundle();
        }
      }
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
        bundle = createEmptyCampatrackBundle();
      }
      const planSrc = bundle.planning_data ?? bundle.planning;
      const planRecs = Array.isArray(planSrc?.records) ? planSrc.records : Array.isArray(planSrc) ? planSrc : [];
      console.info("[CampaTrack lite] Bundle aplicado tras login", {
        partitionKey,
        topKeys: Object.keys(bundle),
        planningRecords: planRecs.length
      });
      withDraftNotificationsSuppressed(() => {
        hydrateAppStateDraftFromApiBundle(bundle);
        try {
          syncRelacionesViewFromDraft();
          syncDataRelacionesModeloConsistency();
        } catch (e) {
          console.warn("Post-hydrate (login lite): modelo / relaciones", e);
        }
      });
      resetPublishDraftAfterServerHydrate();
      campatrackMergeSessionProfileFromDraftUsers();
      return bundle;
    }
    const res = await fetch(
      `${CAMPATRACK_API_ORIGIN}/api/data?team_id=${encodeURIComponent(partitionKey)}`,
      CAMPATRACK_FETCH_OPTIONS_GET_API_DATA
    );
    if (!res.ok) {
      console.error("Error cargando data:", `HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const bundle = parseBundleDataFromApiJson(json);
    if (!bundle) {
      console.log("No hay data para este usuario");
      return null;
    }
    const planSrc = bundle.planning_data ?? bundle.planning;
    const planRecs = Array.isArray(planSrc?.records) ? planSrc.records : Array.isArray(planSrc) ? planSrc : [];
    console.info("[CampaTrack sesión] GET /api/data aplicado", {
      partitionKey,
      topKeys: Object.keys(bundle),
      planningRecords: planRecs.length
    });
    withDraftNotificationsSuppressed(() => {
      hydrateAppStateDraftFromApiBundle(bundle);
      try {
        syncRelacionesViewFromDraft();
        syncDataRelacionesModeloConsistency();
      } catch (e) {
        console.warn("Post-hydrate (login): modelo / relaciones", e);
      }
    });
    resetPublishDraftAfterServerHydrate();
    campatrackMergeSessionProfileFromDraftUsers();
    return bundle;
  } catch (err) {
    console.error("Error cargando data:", err);
    return null;
  }
}

/** Alias: misma carga que `afterLoginSuccess` (p. ej. importar desde URL). */
async function cargarDataUsuario(user) {
  return afterLoginSuccess(user);
}

/**
 * Cada vez que se muestra el dashboard: GET /api/data con la partición de equipo en sesión.
 */
async function cargarDataDesdeBackend(opts = {}) {
  const force = opts && opts.force === true;
  try {
    const user = getUser();
    if (!user || !user.username) {
      console.warn("Usuario no definido");
      return;
    }
    const partitionKey = campatrackCampaignDataPartitionKeyFromUserLike(user);
    if (!partitionKey) {
      console.warn("Sin clave de partición para cargar campaña");
      return;
    }
    if (appPendingPublishCount > 0 && !force) {
      if (typeof rebuildPlanningTable === "function") rebuildPlanningTable();
      if (typeof renderTablaData === "function") renderTablaData();
      if (typeof setFechaActualData === "function") setFechaActualData();
      if (typeof mostrarFechaActualizacion === "function") mostrarFechaActualizacion();
      if (typeof renderRelacionesTabla === "function") renderRelacionesTabla();
      if (typeof renderRelacionesPlanningList === "function") renderRelacionesPlanningList();
      if (typeof renderRelacionesDataList === "function") renderRelacionesDataList();
      if (typeof renderRelacionesEstado === "function") renderRelacionesEstado();
      if (typeof renderBitacoraTable === "function") renderBitacoraTable();
      if (typeof renderDashboard === "function") renderDashboard();
      if (typeof window.campatrackRefreshUsersListIfVisible === "function") {
        try {
          window.campatrackRefreshUsersListIfVisible();
        } catch (_) {}
      }
      if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
        try {
          globalThis.__campatrackRebuildAuditoriaAfterHydrate();
        } catch (_) {}
      }
      return;
    }
    let bundle;
    if (campatrackIsLiteMode()) {
      try {
        bundle = await campatrackLoadLiteBundleForSession();
      } catch (e) {
        console.warn("[CampaTrack lite] Error refrescando datos demo; bundle vacío.", e);
        bundle = createEmptyCampatrackBundle();
      }
    } else {
      const res = await fetch(
        `${CAMPATRACK_API_ORIGIN}/api/data?team_id=${encodeURIComponent(partitionKey)}`,
        CAMPATRACK_FETCH_OPTIONS_GET_API_DATA
      );
      if (!res.ok) {
        console.error("Error cargando data:", `HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      bundle = parseBundleDataFromApiJson(json);
    }
    if (!bundle) {
      console.log("No hay data para este usuario");
      return;
    }
    const planSrcRefresh = bundle.planning_data ?? bundle.planning;
    const planRecsRefresh =
      Array.isArray(planSrcRefresh?.records) ? planSrcRefresh.records : Array.isArray(planSrcRefresh) ? planSrcRefresh : [];
    console.info(
      campatrackIsLiteMode() ? "[CampaTrack lite] Refresco dashboard (LS o JSON remoto)" : "[CampaTrack sesión] GET /api/data (dashboard)",
      {
        partitionKey,
        planningRecords: planRecsRefresh.length
      }
    );
    withDraftNotificationsSuppressed(() => {
      hydrateAppStateDraftFromApiBundle(bundle);
      try {
        syncRelacionesViewFromDraft();
        syncDataRelacionesModeloConsistency();
      } catch (e) {
        console.warn("Post-hydrate (backend): modelo / relaciones", e);
      }
    });
    campatrackMergeSessionProfileFromDraftUsers();
    if (typeof syncCampatrackProfileHeader === "function") syncCampatrackProfileHeader();
    if (typeof rebuildPlanningTable === "function") rebuildPlanningTable();
    if (typeof renderTablaData === "function") renderTablaData();
    if (typeof setFechaActualData === "function") setFechaActualData();
    if (typeof mostrarFechaActualizacion === "function") mostrarFechaActualizacion();
    if (typeof renderRelacionesTabla === "function") renderRelacionesTabla();
    if (typeof renderRelacionesPlanningList === "function") renderRelacionesPlanningList();
    if (typeof renderRelacionesDataList === "function") renderRelacionesDataList();
    if (typeof renderRelacionesEstado === "function") renderRelacionesEstado();
    if (typeof renderBitacoraTable === "function") renderBitacoraTable();
    if (typeof renderDashboard === "function") renderDashboard();
    if (typeof window.campatrackRefreshUsersListIfVisible === "function") {
      try {
        window.campatrackRefreshUsersListIfVisible();
      } catch (_) {}
    }
    if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
      try {
        globalThis.__campatrackRebuildAuditoriaAfterHydrate();
      } catch (_) {}
    }
    resetPublishDraftAfterServerHydrate();
  } catch (err) {
    console.error("Error cargando data:", err);
  }
}

function campatrackYieldToPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(resolve);
        else resolve();
      });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function campatrackBundleTieneDatosUtiles(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  const claves = EXPORT_BUNDLE_KEYS.concat(CLAVES_EXTRA_ESTADO_SISTEMA);
  for (const clave of claves) {
    if (!Object.prototype.hasOwnProperty.call(bundle, clave)) continue;
    const v = bundle[clave];
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return true;
  }
  return false;
}

/**
 * Vuelca el bundle en `appMemoryKV`, `hydratarDesdeLocalStorage` y pinta el dashboard.
 * Con `deferSecondaryRenders` los módulos Data/Relaciones/Bitácora se repintan en idle.
 */
function campatrackApplyFetchedBundleToRuntime(bundlePayload, opts = {}) {
  const deferSecondaryRenders = opts.deferSecondaryRenders === true;
  if (
    bundlePayload == null ||
    typeof bundlePayload !== "object" ||
    Array.isArray(bundlePayload)
  ) {
    return;
  }
  try {
    appMemoryKV.clear();
  } catch (_) {}
  try {
    const u = getUser();
    if (u && String(u.username ?? "").trim()) {
      appMemoryKV.setItem(LS_CAMPATRACK_AUTH, "true");
      appMemoryKV.setItem(LS_CAMPATRACK_ROLE, normalizeCampatrackRoleKey(u.role));
      appMemoryKV.setItem(LS_CAMPATRACK_USER, String(u.username));
      appMemorySession.setItem(SS_USUARIO_LOGUEADO, "true");
    }
  } catch (_) {}

  for (const clave of EXPORT_BUNDLE_KEYS) {
    if (clave === "campatrack_users_db" || clave === "auditoria") continue;
    if (!Object.prototype.hasOwnProperty.call(bundlePayload, clave)) continue;
    const v = bundlePayload[clave];
    if (v == null || v === undefined) continue;
    try {
      appMemoryKV.setItem(clave, JSON.stringify(v));
    } catch (err) {
      console.warn("No se pudo guardar en almacén en memoria:", clave, err);
    }
  }
  if (Array.isArray(bundlePayload.crm_leads)) {
    try {
      appMemoryKV.setItem("crm_leads", JSON.stringify(bundlePayload.crm_leads));
    } catch (err) {
      console.warn("crm_leads en memoria", err);
    }
  }
  try {
    syncDataOriginalFromPublishedDraft(bundlePayload);
  } catch (_) {}
  try {
    sessionStorage.setItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH, "1");
  } catch (_) {
    /* ignore */
  }
  try {
    hydratarDesdeLocalStorage();
  } catch (e) {
    console.warn("hydratarDesdeLocalStorage tras aplicar bundle API", e);
  }
  campatrackMergeSessionProfileFromDraftUsers();
  if (typeof syncCampatrackProfileHeader === "function") syncCampatrackProfileHeader();
  if (typeof rebuildPlanningTable === "function") rebuildPlanningTable();
  if (typeof setFechaActualData === "function") setFechaActualData();
  if (typeof mostrarFechaActualizacion === "function") mostrarFechaActualizacion();

  const renderDashboardAndAlerts = () => {
    if (typeof renderDashboard === "function") renderDashboard();
    if (typeof scheduleDashEndingSoonAlert === "function") scheduleDashEndingSoonAlert();
  };

  const secondaryRenders = () => {
    if (typeof renderTablaData === "function") renderTablaData();
    if (typeof renderRelacionesTabla === "function") renderRelacionesTabla();
    if (typeof renderRelacionesPlanningList === "function") renderRelacionesPlanningList();
    if (typeof renderRelacionesDataList === "function") renderRelacionesDataList();
    if (typeof renderRelacionesEstado === "function") renderRelacionesEstado();
    if (typeof renderBitacoraTable === "function") renderBitacoraTable();
    if (typeof window.campatrackRefreshUsersListIfVisible === "function") {
      try {
        window.campatrackRefreshUsersListIfVisible();
      } catch (_) {}
    }
    if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
      try {
        globalThis.__campatrackRebuildAuditoriaAfterHydrate();
      } catch (_) {}
    }
  };

  if (deferSecondaryRenders) {
    renderDashboardAndAlerts();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => secondaryRenders(), { timeout: 2000 });
    } else {
      setTimeout(secondaryRenders, 120);
    }
  } else {
    secondaryRenders();
    renderDashboardAndAlerts();
  }
  resetPublishDraftAfterServerHydrate();
}

function campatrackCompletePostLoginPipeline(bundlePayload) {
  if (bundlePayload == null) {
    const emptyBundle = createEmptyCampatrackBundle();
    withDraftNotificationsSuppressed(() => {
      hydrateAppStateDraftFromApiBundle(emptyBundle);
    });
    try {
      sessionStorage.setItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH, "1");
    } catch (_) {}
    clearDashboardSkeletonMode();
    campatrackApplyFetchedBundleToRuntime(emptyBundle, { deferSecondaryRenders: true });
    if (campatrackIsLiteMode()) campatrackGateOnDataReady();
    bootstrapCampatrackAuthShell();
    void showAppDialog({
      message:
        "Repositorio sin datos aún o data.json vacío. Puedes trabajar desde cero y publicar cuando guardes cambios.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false
    });
    return;
  }

  if (!campatrackBundleTieneDatosUtiles(bundlePayload)) {
    void showAppDialog({
      message:
        "La API devolvió datos sin claves reconocidas. La sesión sigue activa; revisa los datos del servidor.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false,
    });
    try {
      sessionStorage.setItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH, "1");
    } catch (_) {}
    clearDashboardSkeletonMode();
    if (typeof renderDashboard === "function") renderDashboard();
    if (typeof scheduleDashEndingSoonAlert === "function") scheduleDashEndingSoonAlert();
    resetPublishDraftAfterServerHydrate();
    if (campatrackIsLiteMode()) campatrackGateOnDataReady();
    return;
  }

  campatrackApplyFetchedBundleToRuntime(bundlePayload, { deferSecondaryRenders: true });
  if (campatrackIsLiteMode()) campatrackGateOnDataReady();
  bootstrapCampatrackAuthShell();
}

/**
 * Obtiene `/api/data` del usuario logueado.
 * - `false` (defecto): devuelve JSON stringido para armar File (botón importar URL).
 * - `true`: aplica las mismas claves que la importación manual (`EXPORT_BUNDLE_KEYS`),
 *   vuelca el bundle en memoria y refresca vistas (post-login / sincronizar desde API).
 */
async function cargarDataDesdeAPI(aplicarYLuegoRecargar = false, opts = {}) {
  const recargarSiPostLogin = () => {
    if (aplicarYLuegoRecargar) window.location.reload();
  };

  try {
    let userRaw;
    try {
      userRaw = appMemorySession.getItem(SS_USER_SESSION_JSON);
    } catch (_) {
      userRaw = null;
    }
    const user = userRaw ? JSON.parse(userRaw) : null;

    if (!user || !user.username) {
      if (!aplicarYLuegoRecargar) {
        console.error("No hay usuario en sesión");
        throw new Error("No hay usuario en sesión");
      }
      recargarSiPostLogin();
      return "";
    }

    if (
      aplicarYLuegoRecargar === true &&
      opts.fetchedFromLogin !== true &&
      !resolveCampatrackSessionPermissions(user).canImport
    ) {
      void showAppDialog({
        message:
          "No tienes permiso para sincronizar y aplicar datos desde la API. Si necesitas el acceso, un administrador puede habilitarlo en el módulo Usuarios.",
        primaryText: "Entendido",
        showSecondary: false,
        primaryDanger: false
      });
      return "";
    }

    const bundlePayload =
      opts.fetchedFromLogin === true ? opts.preloadedBundle : await cargarDataUsuario(user);

    if (bundlePayload == null) {
      console.log("Sin data para este usuario");
      if (aplicarYLuegoRecargar) {
        void showAppDialog({
          message:
            "No hay datos guardados en el servidor para este usuario. La sesión permanece activa; puedes trabajar con datos vacíos o publicar más adelante.",
          primaryText: "Entendido",
          showSecondary: false,
          primaryDanger: false
        });
        return "";
      }
      recargarSiPostLogin();
      return "";
    }

    if (!campatrackBundleTieneDatosUtiles(bundlePayload)) {
      if (aplicarYLuegoRecargar) {
        void showAppDialog({
          message:
            "La API devolvió datos sin claves reconocidas. No se recargará la página; tu sesión sigue activa.",
          primaryText: "Entendido",
          showSecondary: false,
          primaryDanger: false
        });
        return "";
      }
      recargarSiPostLogin();
      return "";
    }

    if (!aplicarYLuegoRecargar) return JSON.stringify(bundlePayload);

    campatrackApplyFetchedBundleToRuntime(bundlePayload, { deferSecondaryRenders: false });
    return "";
  } catch (err) {
    console.error("Error cargando data API", err);
    if (aplicarYLuegoRecargar) {
      void showAppDialog({
        message: String(err?.message || "No se pudo cargar la data desde la API. La sesión permanece activa."),
        primaryText: "Entendido",
        showSecondary: false,
        primaryDanger: false
      });
      return "";
    }
    throw err;
  }
}

let campatrackSidebarFooterDelegationBound = false;

function bindCampatrackSidebarFooterDelegationOnce() {
  const box = document.getElementById("campatrackSidebarToolBtns");
  if (!box || campatrackSidebarFooterDelegationBound) return;
  campatrackSidebarFooterDelegationBound = true;
  box.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target.closest("button") : null;
    if (!t || !box.contains(t)) return;
    const id = t.id;
    if (id === "exportDataBtn") {
      void exportarDatosSistema();
      return;
    }
    if (id === "importDataBtn") {
      document.getElementById("importDataFileInput")?.click();
      return;
    }
    if (id === "resetSystemBtn") {
      void resetearSistemaCompleto();
      return;
    }
    if (id === "btn-importar-url") {
      void (async () => {
        try {
          await cargarDataDesdeAPI(true);
        } catch (err) {
          console.error("Error cargando data desde API", err);
          void showAppDialog({
            message: "No se pudo cargar la data desde la API.",
            primaryText: "Entendido",
            showSecondary: false,
            primaryDanger: false
          });
        }
      })();
    }
  });
}

/** Botones de configuración del sidebar según permisos (solo existen en DOM si aplican). */
function mountCampatrackSidebarFooterTools() {
  const box = document.getElementById("campatrackSidebarToolBtns");
  if (!box) return;
  box.replaceChildren();
  if (typeof isCampatrackAuthenticated === "function" && !isCampatrackAuthenticated()) return;
  const u = typeof getUser === "function" ? getUser() : null;
  const perms = u ? resolveCampatrackSessionPermissions(u) : { canExport: false, canImport: false, canReset: false };
  if (perms.canExport) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = "exportDataBtn";
    b.className = "tab campatrack-side-tool-btn";
    b.innerHTML =
      '<i class="fa-solid fa-file-export campatrack-side-ico" aria-hidden="true"></i><span>Exportar datos</span>';
    box.appendChild(b);
  }
  if (perms.canImport) {
    const bf = document.createElement("button");
    bf.type = "button";
    bf.id = "importDataBtn";
    bf.className = "tab campatrack-side-tool-btn";
    bf.innerHTML =
      '<i class="fa-solid fa-file-import campatrack-side-ico" aria-hidden="true"></i><span>Importar datos</span>';
    box.appendChild(bf);
    const bu = document.createElement("button");
    bu.type = "button";
    bu.id = "btn-importar-url";
    bu.className = "tab campatrack-side-tool-btn btn-importar-url";
    bu.title = "Obtiene el bundle desde el servidor y aplica los datos en esta sesión";
    bu.innerHTML =
      '<i class="fa-solid fa-cloud-arrow-down campatrack-side-ico" aria-hidden="true"></i><span>Sincronizar desde API</span>';
    box.appendChild(bu);
  }
  if (perms.canReset) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = "resetSystemBtn";
    b.className = "tab tab-danger campatrack-side-tool-btn campatrack-side-tool-btn--danger";
    b.innerHTML =
      '<i class="fa-solid fa-triangle-exclamation campatrack-side-ico" aria-hidden="true"></i><span>Resetear sistema</span>';
    box.appendChild(b);
  }
}

function initExportImportDatos() {
  bindCampatrackSidebarFooterDelegationOnce();
  mountCampatrackSidebarFooterTools();
  const fileInput = document.getElementById("importDataFileInput");
  fileInput?.addEventListener("change", (e) => {
    const input = e.target;
    const f = input?.files?.[0];
    if (input) input.value = "";
    if (!f) return;
    importarDatosSistemaDesdeArchivo(f);
  });
}

function serializeDataReal(list) {
  return (list || []).map((r) => ({
    ...r,
    _id: String(r?._id ?? ""),
    fecha: r?.fecha instanceof Date ? formatDateInputFromDate(r.fecha) : String(r?.fecha || "")
  }));
}

function serializeCrmLeads(list) {
  return (list || []).map((r) => ({
    ...r,
    _id: String(r?._id ?? ""),
    fecha: r?.fecha instanceof Date ? formatDateInputFromDate(r.fecha) : String(r?.fecha || ""),
    nombreCampania: String(r?.nombreCampania ?? r?.nombre ?? "").trim(),
    crmTipo: String(r?.crmTipo ?? "").trim(),
    crmPrograma: String(r?.crmPrograma ?? "").trim(),
    crmIntake: String(r?.crmIntake ?? "").trim(),
    crmTrafficType: String(r?.crmTrafficType ?? "").trim(),
    fuenteCrm: String(r?.fuenteCrm ?? "").trim(),
    crmFlujoRaw: String(r?.crmFlujoRaw ?? "").trim(),
    crmHoraIngreso: String(r?.crmHoraIngreso ?? "").trim(),
    crmImportSheetRow: Object.prototype.hasOwnProperty.call(r || {}, "crmImportSheetRow")
      ? Number(r.crmImportSheetRow) || 0
      : undefined,
    crmHoraGestion: String(r?.crmHoraGestion ?? "").trim(),
    crmTiempoTranscurridoMin:
      r?.crmTiempoTranscurridoMin == null || r?.crmTiempoTranscurridoMin === ""
        ? ""
        : Number.isFinite(Number(r.crmTiempoTranscurridoMin))
          ? Number(r.crmTiempoTranscurridoMin)
          : String(r.crmTiempoTranscurridoMin).trim()
  }));
}

function crmHydrateDimensionalFieldsOnRow(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  let tipo = String(r.crmTipo ?? "").trim();
  let programa = String(r.crmPrograma ?? "").trim();
  let intake = crmNormalizeIntakeCellValue(String(r.crmIntake ?? ""));
  let crmTrafficType =
    String(r.crmTrafficType ?? "").trim() || crmNormalizedTrafficFromFuenteVF(String(r.fuenteCrm ?? ""));
  let nombreCampania = crmNormalizeQuarterTokensToPlanningIntake(String(r.nombreCampania ?? r.nombre ?? "").trim());

  const parts = nombreCampania.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 4) {
    const tailT = parts[parts.length - 1];
    const tailI = parts[parts.length - 2];
    const trafficFromNombre = crmNormalizedTrafficFromFuenteVF(tailT);
    if (trafficFromNombre && /\bintake\b/i.test(tailI)) {
      if (!tipo || !programa) {
        tipo = parts.slice(0, -3).join(" | ").trim();
        programa = parts[parts.length - 3] || programa;
      }
      if (!intake) intake = crmNormalizeIntakeCellValue(tailI);
      if (!crmTrafficType) crmTrafficType = trafficFromNombre;
    }
  }

  if (!programa && nombreCampania && !nombreCampania.includes("|")) programa = nombreCampania;

  const composed = crmComposeDisplayDimensional(tipo, programa, intake, crmTrafficType);
  if (composed) nombreCampania = composed;
  else if (!nombreCampania) nombreCampania = "";

  return { tipo, programa, intake, crmTrafficType, nombreCampania };
}

function deserializeCrmLeads(list) {
  return (list || [])
    .map((r) => {
      const merged = crmHydrateDimensionalFieldsOnRow({
        ...r,
        nombreCampania: String(r?.nombreCampania ?? r?.nombre ?? "").trim()
      });
      const rowOut = {
        ...r,
        _id: String(r?._id || generateDataRowId()),
        nombreCampania: merged.nombreCampania,
        crmTipo: merged.tipo,
        crmPrograma: merged.programa,
        crmIntake: merged.intake,
        crmTrafficType: merged.crmTrafficType,
        fecha: (() => {
          const fd = r?.fecha instanceof Date ? r.fecha : parseFechaData(r?.fecha);
          if (!fd || Number.isNaN(fd.getTime())) return fd;
          return crmNormalizeCalendarDateLocalNoon(fd);
        })(),
        leads: (() => {
          const n = Number(r?.leads);
          return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 1;
        })(),
        esInteresado: !!(r?.esInteresado === true || r?.esInteresado === 1 || crmParseBoolish(r?.esInteresado)),
        esPostulante: !!(r?.esPostulante === true || r?.esPostulante === 1 || crmParseBoolish(r?.esPostulante)),
        esMatriculado: !!(r?.esMatriculado === true || r?.esMatriculado === 1 || crmParseBoolish(r?.esMatriculado)),
        intervaloGestion: String(r?.intervaloGestion ?? "").trim(),
        fuenteCrm: String(r?.fuenteCrm ?? "").trim(),
        crmFlujoRaw: String(r?.crmFlujoRaw ?? "").trim(),
        crmHoraIngreso: String(r?.crmHoraIngreso ?? "").trim(),
        crmImportSheetRow: Object.prototype.hasOwnProperty.call(r || {}, "crmImportSheetRow")
          ? Number(r.crmImportSheetRow) || 0
          : undefined,
        crmHoraGestion: String(r?.crmHoraGestion ?? "").trim(),
        crmTiempoTranscurridoMin: (() => {
          const v = r?.crmTiempoTranscurridoMin;
          if (v == null || v === "") return "";
          const n = Number(v);
          return Number.isFinite(n) ? n : String(v).trim();
        })()
      };
      return rowOut;
    })
    .filter((row) => row.nombreCampania && row.fecha instanceof Date && !Number.isNaN(row.fecha.getTime()));
}

function hydrateCrmLeadsFromBundle(bundle) {
  const list = ensureCrmLeadsDraftShape();
  list.length = 0;
  if (!bundle || bundle.crm_leads == null) {
    syncCrmLeadsViewFromDraft();
    return;
  }
  const rows = deserializeCrmLeads(Array.isArray(bundle.crm_leads) ? bundle.crm_leads : []);
  migrateMissingTeamIdOnRows(rows);
  rows.forEach((r) => list.push(r));
  syncCrmLeadsViewFromDraft();
}

try {
  globalThis.__campatrackHydrateCrmFromBundle = hydrateCrmLeadsFromBundle;
  globalThis.__campatrackSyncRelacionesCrmFromDraft = syncRelacionesCrmViewFromDraft;
} catch (_) {
  /* ignore */
}

function deserializeDataReal(list) {
  return (list || []).map((r) => ({
    ...r,
    _id: String(r?._id || generateDataRowId()),
    fecha: r?.fecha instanceof Date ? r.fecha : parseFechaData(r?.fecha)
  })).filter((r) => r.fecha instanceof Date && !Number.isNaN(r.fecha.getTime()));
}

/** Rellena `appState.dataDraft.data_general` desde el bundle API (GET /api/data). */
function hydrateDataGeneralFromApiBundle(bundle) {
  const dg = ensureDataGeneralDraftShape();
  dg.length = 0;
  if (!bundle || bundle.data_general == null) {
    syncDataRealViewFromDraft();
    return;
  }
  const raw = normalizarArrayPersistido(bundle.data_general) ?? bundle.data_general;
  const rows = deserializeDataReal(Array.isArray(raw) ? raw : []);
  migrateMissingTeamIdOnRows(rows);
  const distinctTeams = new Set(rows.map(normalizeRowTeamId));
  const merged =
    distinctTeams.size > 1 ? rows : mergeRowsByTeamId([], rows, getCurrentTeamId(), normalizeRowTeamId);
  merged.forEach((r) => dg.push(r));
  syncDataRealViewFromDraft();
}

try {
  globalThis.__campatrackHydrateDataGeneralFromBundle = hydrateDataGeneralFromApiBundle;
} catch (_) {
  /* ignore */
}

/** Repinta módulo Relaciones desde `appState.dataDraft.relaciones` (misma idea que Planning/Data tras hidratar). */
function rebuildRelacionesTable() {
  console.log("Relaciones:", appState.dataDraft.relaciones);
  syncRelacionesViewFromDraft();
  renderRelacionesTabla();
  renderRelacionesPlanningList();
  renderRelacionesDataList();
  renderRelacionesEstado();
}

try {
  globalThis.__campatrackSyncRelacionesViewFromDraft = syncRelacionesViewFromDraft;
  globalThis.__campatrackRebuildRelacionesTable = rebuildRelacionesTable;
} catch (_) {
  /* ignore */
}

function serializeDataAnuncios(list) {
  return (list || []).map((r) => {
    const { fecha: _omitFecha, "Link Anuncio": _omitLinkLabel, link_anuncio: _omitLinkSnake, ...rest } = r || {};
    return {
      ...rest,
      _id: String(r?._id ?? ""),
      linkAnuncio: readLinkAnuncioFromRow(r)
    };
  });
}

/** Lee enlace desde fila DATA (camelCase, export con espacio, snake). */
function readLinkAnuncioFromRow(obj) {
  if (!obj || typeof obj !== "object") return "";
  const v =
    obj.linkAnuncio ??
    obj["Link Anuncio"] ??
    obj["link anuncio"] ??
    obj.link_anuncio;
  return String(v ?? "").trim();
}

function deserializeDataAnuncios(list) {
  return (list || []).map((r) => {
    return {
      _id: String(r?._id || generateDataRowId()),
      idCampania: String(r?.idCampania ?? "").trim(),
      nombreCampana: String(r?.nombreCampana ?? "").trim(),
      nombreAnuncio: String(r?.nombreAnuncio ?? "").trim(),
      leads: Number(r?.leads) || 0,
      gasto: Number(r?.gasto) || 0,
      impresiones: Number(r?.impresiones) || 0,
      alcance: Number(r?.alcance) || 0,
      clics: Number(r?.clics) || 0,
      linkAnuncio: readLinkAnuncioFromRow(r),
      tipoAnuncio: normalizeTipoAnuncioData(String(r?.tipoAnuncio ?? "")),
      estado: normalizarEstadoAnuncio(r?.estado)
    };
  });
}

function normalizeTipoAnuncioData(s) {
  const t = String(s || "").trim().toLowerCase();
  if (t === "carousel") return "carrusel";
  if (t === "ppl" || t === "ppv" || t === "carrusel") return t;
  return "";
}

/** Activo / Inactivo para DATA → Anuncios (vacío = Activo). */
function normalizarEstadoAnuncio(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return "Activo";
  return normalizarEstado(t);
}

/**
 * Tras las columnas fijas hasta clics: columna opcional Estado (si no es URL ni tipo de anuncio).
 * @returns {{ estado: string, linkStart: number }}
 */
function splitEstadoOpcionalYTailAnuncios(cols, optStart) {
  const cell = cols[optStart];
  if (cell === undefined || String(cell).trim() === "") {
    return { estado: "Activo", linkStart: optStart };
  }
  const cStr = String(cell).trim();
  if (/^https?:\/\//i.test(cStr)) return { estado: "Activo", linkStart: optStart };
  if (adsReportCoerceHttpUrl(cStr)) return { estado: "Activo", linkStart: optStart };
  if (normalizeTipoAnuncioData(cStr)) return { estado: "Activo", linkStart: optStart };
  return { estado: normalizarEstadoAnuncio(cStr), linkStart: optStart + 1 };
}

function dataAnunciosUpsertKey(r) {
  return `${String(r.idCampania || "").trim()}||${String(r.nombreAnuncio || "").trim()}`;
}

function mergeDataAnuncioPreservingId(existing, incoming) {
  const id = existing._id;
  const { fecha: _omitFecha, ...prev } = existing || {};
  const inc = normalizeRowTeamId(incoming);
  const exc = normalizeRowTeamId(existing);
  const ct = String(getCurrentTeamId()).trim();
  const teamKeep = inc || exc || ct;
  return { ...prev, ...incoming, _id: id, teamId: teamKeep || ct };
}

/**
 * UPSERT por clave ID Campaña + Nombre Anuncio (última carga reemplaza).
 * @returns {{ data: Array, insertadas: number, actualizadas: number, registrosInsertados: Array }}
 */
function upsertDataAnunciosLote(newRows, dataActual) {
  const keyFn = dataAnunciosUpsertKey;
  const lastByKey = new Map();
  newRows.forEach((r) => lastByKey.set(keyFn(r), r));
  const uniqueIncoming = Array.from(lastByKey.values());
  const keyToIndex = new Map();
  dataActual.forEach((r, i) => keyToIndex.set(keyFn(r), i));
  const result = dataActual.slice();
  let insertadas = 0;
  let actualizadas = 0;
  const registrosInsertados = [];
  uniqueIncoming.forEach((incoming) => {
    const k = keyFn(incoming);
    if (keyToIndex.has(k)) {
      const idx = keyToIndex.get(k);
      result[idx] = mergeDataAnuncioPreservingId(result[idx], incoming);
      actualizadas += 1;
    } else {
      const row = { ...incoming, teamId: getCurrentTeamId() };
      result.push(row);
      keyToIndex.set(k, result.length - 1);
      insertadas += 1;
      registrosInsertados.push(row);
    }
  });
  return { data: result, insertadas, actualizadas, registrosInsertados };
}

function isHeaderRowDataAnuncios(cols) {
  if (!cols?.length) return false;
  const joined = cols.map((c) => String(c || "").toLowerCase()).join(" ");
  return joined.includes("id") && (joined.includes("campaña") || joined.includes("campana")) && joined.includes("anuncio");
}

function parseOptionalLinkTipoAnuncios(cols, startIdx) {
  const rest = cols.slice(startIdx).map((c) => String(c ?? "").trim());
  let linkAnuncio = "";
  let tipoAnuncio = "";
  if (!rest.length) return { linkAnuncio, tipoAnuncio };
  if (rest.length === 1) {
    tipoAnuncio = normalizeTipoAnuncioData(rest[0]);
    if (tipoAnuncio) return { linkAnuncio, tipoAnuncio };
    linkAnuncio = adsReportCoerceHttpUrl(rest[0]) || "";
    return { linkAnuncio, tipoAnuncio };
  }
  linkAnuncio = adsReportCoerceHttpUrl(rest[0]) || "";
  tipoAnuncio = normalizeTipoAnuncioData(rest[1]);
  return { linkAnuncio, tipoAnuncio };
}

function parseDataAnunciosConReporte(texto) {
  const lines = String(texto ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const vacio = { filasLeidas: 0, validas: [], ignoradas: 0, erroresDetalle: [], advertenciasDetalle: [] };
  if (!lines.length) return vacio;
  const rows = lines.map((line) => line.split("\t").map((c) => String(c ?? "").trim()));
  const startIndex = isHeaderRowDataAnuncios(rows[0]) ? 1 : 0;
  let filasLeidas = 0;
  let ignoradas = 0;
  const validas = [];
  const erroresDetalle = [];
  const advertenciasDetalle = [];

  for (let i = startIndex; i < rows.length; i += 1) {
    filasLeidas += 1;
    const cols = rows[i];
    const filaNum = i + 1;
    const dataPreview = (cols || []).join(" | ").slice(0, 400);
    const firstDate = cols?.length ? parseFechaData(cols[0]) : null;
    /** Primera columna fecha (pegados antiguos): se ignora al guardar. */
    const skipLeadingFecha = Boolean(firstDate) && cols.length >= 9;
    const minLen = skipLeadingFecha ? 9 : 8;
    if (!cols || cols.length < minLen) {
      ignoradas += 1;
      erroresDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: [
          `Se esperan al menos 8 columnas (ID campaña, nombre campaña, nombre anuncio, leads, gastos, impresiones, alcance, clics; opcional después: estado Activo/Inactivo, link, tipo). Si la primera columna es una fecha reconocible, hacen falta 9 columnas en total (fecha + núcleo). Tiene ${cols?.length ?? 0}.`
        ],
        tipo: "error"
      });
      continue;
    }

    let idCampania;
    let nombreCampana;
    let nombreAnuncio;
    let leadsIdx;
    let gastoIdx;
    let impIdx;
    let alcIdx;
    let clicIdx;
    let optStart;

    if (skipLeadingFecha) {
      idCampania = String(cols[1] ?? "").trim();
      nombreCampana = String(cols[2] ?? "").trim();
      nombreAnuncio = String(cols[3] ?? "").trim();
      leadsIdx = 4;
      gastoIdx = 5;
      impIdx = 6;
      alcIdx = 7;
      clicIdx = 8;
      optStart = 9;
    } else {
      idCampania = String(cols[0] ?? "").trim();
      nombreCampana = String(cols[1] ?? "").trim();
      nombreAnuncio = String(cols[2] ?? "").trim();
      leadsIdx = 3;
      gastoIdx = 4;
      impIdx = 5;
      alcIdx = 6;
      clicIdx = 7;
      optStart = 8;
    }

    const errores = [];
    if (!idCampania) errores.push("ID Campaña vacío.");
    if (!nombreCampana) errores.push("Nombre Campaña vacío.");
    if (!nombreAnuncio) errores.push("Nombre Anuncio vacío.");
    let leads = limpiarNumero(cols[leadsIdx]);
    let gasto = limpiarNumero(cols[gastoIdx]);
    let impresiones = limpiarNumero(cols[impIdx]);
    let alcance = limpiarNumero(cols[alcIdx]);
    let clics = limpiarNumero(cols[clicIdx]);
    if (!Number.isFinite(leads)) {
      advertenciasDetalle.push({ fila: filaNum, data: dataPreview, errores: ["Leads no numérico: se registró 0."], tipo: "aviso" });
      leads = 0;
    }
    if (!Number.isFinite(gasto)) {
      advertenciasDetalle.push({ fila: filaNum, data: dataPreview, errores: ["Gastos no numérico: se registró 0."], tipo: "aviso" });
      gasto = 0;
    }
    if (!Number.isFinite(impresiones)) {
      advertenciasDetalle.push({ fila: filaNum, data: dataPreview, errores: ["Impresiones no numérico: se registró 0."], tipo: "aviso" });
      impresiones = 0;
    }
    if (!Number.isFinite(alcance)) {
      advertenciasDetalle.push({ fila: filaNum, data: dataPreview, errores: ["Alcance no numérico: se registró 0."], tipo: "aviso" });
      alcance = 0;
    }
    if (!Number.isFinite(clics)) {
      advertenciasDetalle.push({ fila: filaNum, data: dataPreview, errores: ["Clics no numérico: se registró 0."], tipo: "aviso" });
      clics = 0;
    }
    if (errores.length) {
      ignoradas += 1;
      erroresDetalle.push({ fila: filaNum, data: dataPreview, errores, tipo: "error" });
      continue;
    }
    const { estado, linkStart } = splitEstadoOpcionalYTailAnuncios(cols, optStart);
    const { linkAnuncio, tipoAnuncio } = parseOptionalLinkTipoAnuncios(cols, linkStart);
    validas.push({
      idCampania,
      nombreCampana,
      nombreAnuncio,
      leads,
      gasto,
      impresiones,
      alcance,
      clics,
      estado,
      linkAnuncio,
      tipoAnuncio
    });
  }
  return { filasLeidas, validas, ignoradas, erroresDetalle, advertenciasDetalle };
}

function legacyStableCampaignIdFromPrograma(programa) {
  const p = String(programa || "").trim() || "sin_programa";
  let h = 2166136261 >>> 0;
  for (let j = 0; j < p.length; j += 1) {
    h ^= p.charCodeAt(j);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `LEG_${h.toString(16)}`;
}

/** Migra `data_ads_report` antiguo a `dataAnuncios` (una sola vez al hidratar si hay legacy y no hay anuncios). */
function migrateLegacyDataAdsReportToAnuncios(legacy) {
  const out = [];
  if (!Array.isArray(legacy)) return out;
  legacy.forEach((row) => {
    if (!row || !(row.fecha instanceof Date)) return;
    const programa = String(row.programa || "").trim();
    const nombreAnuncio = String(row.nombreAnuncio || "").trim();
    if (!nombreAnuncio) return;
    const impresiones = Number(row.impresiones) || 0;
    const frec = Number(row.frecuencia) || 0;
    const alcance = frec > 0 && impresiones > 0 ? impresiones / frec : 0;
    out.push({
      _id: generateDataRowId(),
      idCampania: legacyStableCampaignIdFromPrograma(programa),
      nombreCampana: programa || "Sin programa",
      nombreAnuncio,
      leads: Number(row.leads) || 0,
      gasto: Number(row.gasto) || 0,
      impresiones,
      alcance: Number.isFinite(alcance) ? alcance : 0,
      clics: Number(row.clics) || 0,
      linkAnuncio: adsReportCoerceHttpUrl(row.linkAnuncio) || "",
      tipoAnuncio: normalizeTipoAnuncioData(String(row.tipo || "")),
      estado: "Activo"
    });
  });
  return out;
}

/** Acepta array JSON o string con JSON anidado (doble serialización). */
function normalizarArrayPersistido(valor) {
  if (Array.isArray(valor)) return valor;
  if (typeof valor === "string") {
    try {
      const inner = JSON.parse(valor);
      return Array.isArray(inner) ? inner : null;
    } catch {
      return null;
    }
  }
  return null;
}

function generateDataRowId() {
  return String(Date.now() + Math.random());
}

function guardarData() {
  persistDataState();
}

function serializeModelo(list) {
  return (list || []).map((r) => ({
    ...r,
    fecha: r?.fecha instanceof Date ? formatDateInputFromDate(r.fecha) : String(r?.fecha || "")
  }));
}

function deserializeModelo(list) {
  return (list || []).map((r) => ({
    ...r,
    fecha: r?.fecha instanceof Date ? r.fecha : parseFechaData(r?.fecha)
  })).filter((r) => r.fecha instanceof Date);
}

/**
 * Persiste snapshot coherente en appMemoryKV.
 * @param {{ incluirTablasData?: boolean }} [opts] — Si `incluirTablasData === false`, no sobrescribe data_general / data_anuncios (evita borrar DATA en disco cuando el estado en memoria aún no hidrató bien).
 */
function guardarTodo(opts = {}) {
  if (shouldDeferDiskPersistence()) return;
  const incluirTablasData = opts.incluirTablasData !== false;
  try {
    recomputePlanningMergedCacheFromRecords();
    const mergedPlan = planningMergedRecordsCache || planningDraftRecords().slice();
    appMemoryKV.setItem("planning", JSON.stringify(mergedPlan));
    appMemoryKV.setItem(LS_PLANNING_DATA, JSON.stringify({ records: mergedPlan, recordIdSeq: getPlanningRecordIdSeq() }));
    if (incluirTablasData) {
      refreshTeamScopedDataCachesForSnapshot();
      appMemoryKV.setItem("data_anuncios", JSON.stringify(serializeDataAnuncios(dataAnunciosMergedCache || dataAnuncios)));
    }
    refreshTeamScopedDataCachesForSnapshot();
  } catch (err) {
    console.warn("No se pudo ejecutar guardarTodo()", err);
  }
}

function hasDataGeneralLoaded() {
  return ensureDataGeneralDraftShape().some((r) => rowBelongsToCurrentTeam(r));
}

function hasAnyDataLoaded() {
  return (Array.isArray(dataReal) && dataReal.length > 0) ||
    (Array.isArray(dataAnuncios) && dataAnuncios.length > 0);
}

function pruneRelacionesWithoutData() {
  sanitizeRelacionesDraftChannels();
  syncRelacionesViewFromDraft();
  const planningKeys = new Set(planningDraftRecords().map((r) => planningKeyFromRecord(r)));
  const latestNameById = getLatestCampaignNameMap(getAllCampaignRows());
  const campaignIds = new Set(Array.from(latestNameById.keys()));
  const seen = new Set();
  const next = [];
  getRelacionesPlataforma().forEach((rel) => {
    const planningKey = String(rel.planningKey || "");
    const idCampania = String(rel.idCampania || "").trim();
    const latestName = latestNameById.get(idCampania) || String(rel.nombre || "").trim();
    if (!planningKeys.has(planningKey)) return;
    if (!campaignIds.has(idCampania)) return;
    const uniq = `${planningKey}||${idCampania}`;
    if (seen.has(uniq)) return;
    seen.add(uniq);
    next.push({ planningKey, idCampania, nombre: latestName });
  });
  const changed = next.length !== relaciones.length ||
    next.some((x, i) =>
      String(x.planningKey) !== String(relaciones[i]?.planningKey) ||
      String(x.idCampania) !== String(relaciones[i]?.idCampania) ||
      String(x.nombre) !== String(relaciones[i]?.nombre)
    );
  if (changed) replaceCurrentTeamRelacionesFromMerged(next);
  return changed;
}

function persistRelacionesAndModeloCleared() {
  const tid = getCurrentTeamId();
  clearCurrentTeamRelacionesInDraft();
  modeloAnalitico = [];
  modeloMergedCache = mergeRowsByTeamId(
    Array.isArray(modeloMergedCache) && modeloMergedCache.length ? modeloMergedCache : readFullModeloFromDisk(),
    modeloAnalitico,
    tid,
    normalizeRowTeamId
  );
  syncCcBitacoraModeloDraftFromRuntime();
  guardarTodo();
  if (!shouldDeferDiskPersistence()) guardarDebounce();
  registerUnpublishedDraftMutation();
}

function syncDataRelacionesModeloConsistency() {
  sanitizeRelacionesDraftChannels();
  syncRelacionesViewFromDraft();
  if (!hasDataGeneralLoaded()) {
    persistRelacionesAndModeloCleared();
    try {
      renderRelacionesPlanningList();
      renderRelacionesDataList();
      renderRelacionesTabla();
      renderRelacionesEstado();
      if (dashboardUiInicializado) renderDashboardFromFilters();
    } catch {}
    return;
  }

  const relChanged = pruneRelacionesWithoutData();
  if (relChanged) {
    guardarTodo();
  }
  REGENERAR_MODELO();
  try {
    renderRelacionesPlanningList();
    renderRelacionesDataList();
    renderRelacionesTabla();
    renderRelacionesEstado();
  } catch {}
}

function readFullDataRealRowsFromDisk() {
  /** DATA general vive en `appState.dataDraft.data_general`; ya no se lee desde almacén clave-valor. */
  return [];
}

function readFullDataAdsRowsFromDisk() {
  const rawAds = cargarDesdeLocalStorage("data_ads_report") ?? cargarDesdeLocalStorage(LS_KEYS.dataAdsReport) ?? cargarDesdeLocalStorage("dataAdsReport");
  const storedAds = normalizarArrayPersistido(rawAds);
  const rows = storedAds ? deserializeDataReal(storedAds) : [];
  migrateMissingTeamIdOnRows(rows);
  return rows;
}

function readFullDataAnunciosRowsFromDisk() {
  const rawAnuncios = cargarDesdeLocalStorage("data_anuncios") ?? cargarDesdeLocalStorage(LS_KEYS.dataAnuncios) ?? cargarDesdeLocalStorage("dataAnuncios");
  const storedAnuncios = normalizarArrayPersistido(rawAnuncios);
  const rows = storedAnuncios ? deserializeDataAnuncios(storedAnuncios) : [];
  migrateMissingTeamIdOnRows(rows);
  return rows;
}

function readFullCampaniasUnicasFromDisk() {
  const storedUnique = cargarDesdeLocalStorage(LS_KEYS.campaniasUnicasData);
  const rows = Array.isArray(storedUnique) ? storedUnique.map((x) => (typeof x === "object" && x ? { ...x } : x)) : [];
  migrateMissingTeamIdOnRows(rows);
  return rows;
}

function readFullRelacionesFromDisk() {
  return [];
}

function readFullMedidasFromDisk() {
  const storedMed = cargarDesdeLocalStorage(LS_KEYS.medidas);
  const rows = Array.isArray(storedMed) ? storedMed.map((x) => ({ ...x })) : [];
  migrateMissingTeamIdOnRows(rows);
  return rows;
}

/** Solo memoria clave-valor (sin `dataDraft`), para bases de merge al aplicar bundles. */
function readFullModeloFromLegacyStorage() {
  const storedModelo = cargarDesdeLocalStorage("modelo") ?? cargarDesdeLocalStorage(LS_KEYS.modeloAnalitico);
  const rows = Array.isArray(storedModelo) ? deserializeModelo(storedModelo) : [];
  migrateMissingTeamIdOnRows(rows);
  return rows;
}

function readFullModeloFromDisk() {
  const draftModelo = appState.dataDraft?.modelo ?? appState.dataDraft?.modeloAnalitico;
  if (Array.isArray(draftModelo) && draftModelo.length) {
    const rows = deserializeModelo(draftModelo);
    migrateMissingTeamIdOnRows(rows);
    return rows;
  }
  return readFullModeloFromLegacyStorage();
}

function refreshTeamScopedDataCachesForSnapshot() {
  const tid = getCurrentTeamId();
  syncDataRealViewFromDraft();
  dataAdsReportMergedCache = mergeRowsByTeamId(
    Array.isArray(dataAdsReportMergedCache) && dataAdsReportMergedCache.length ? dataAdsReportMergedCache : readFullDataAdsRowsFromDisk(),
    dataAdsReport,
    tid,
    normalizeRowTeamId
  );
  dataAnunciosMergedCache = mergeRowsByTeamId(
    Array.isArray(dataAnunciosMergedCache) && dataAnunciosMergedCache.length ? dataAnunciosMergedCache : readFullDataAnunciosRowsFromDisk(),
    dataAnuncios,
    tid,
    normalizeRowTeamId
  );
  campaniasUnicasMergedCache = mergeRowsByTeamId(
    Array.isArray(campaniasUnicasMergedCache) && campaniasUnicasMergedCache.length ? campaniasUnicasMergedCache : readFullCampaniasUnicasFromDisk(),
    campaniasUnicasData.map((r) => (typeof r === "object" && r ? { ...r, teamId: tid } : r)),
    tid,
    normalizeRowTeamId
  );
  syncRelacionesViewFromDraft();
  medidasMergedCache = mergeRowsByTeamId(
    Array.isArray(medidasMergedCache) && medidasMergedCache.length ? medidasMergedCache : readFullMedidasFromDisk(),
    medidas,
    tid,
    normalizeRowTeamId
  );
  modeloMergedCache = mergeRowsByTeamId(
    Array.isArray(modeloMergedCache) && modeloMergedCache.length ? modeloMergedCache : readFullModeloFromDisk(),
    modeloAnalitico,
    tid,
    normalizeRowTeamId
  );
}

function persistDataState() {
  const tid = getCurrentTeamId();
  syncDataRealViewFromDraft();
  dataAdsReportMergedCache = mergeRowsByTeamId(
    Array.isArray(dataAdsReportMergedCache) && dataAdsReportMergedCache.length ? dataAdsReportMergedCache : readFullDataAdsRowsFromDisk(),
    dataAdsReport,
    tid,
    normalizeRowTeamId
  );
  dataAnunciosMergedCache = mergeRowsByTeamId(
    Array.isArray(dataAnunciosMergedCache) && dataAnunciosMergedCache.length ? dataAnunciosMergedCache : readFullDataAnunciosRowsFromDisk(),
    dataAnuncios,
    tid,
    normalizeRowTeamId
  );
  campaniasUnicasMergedCache = mergeRowsByTeamId(
    Array.isArray(campaniasUnicasMergedCache) && campaniasUnicasMergedCache.length ? campaniasUnicasMergedCache : readFullCampaniasUnicasFromDisk(),
    campaniasUnicasData.map((r) => (typeof r === "object" && r ? { ...r, teamId: tid } : r)),
    tid,
    normalizeRowTeamId
  );
  guardarEnLocalStorage(LS_KEYS.dataAdsReport, serializeDataReal(dataAdsReportMergedCache));
  guardarEnLocalStorage(LS_KEYS.dataAnuncios, serializeDataAnuncios(dataAnunciosMergedCache));
  guardarEnLocalStorage(LS_KEYS.campaniasUnicasData, campaniasUnicasMergedCache);
  guardarTodo();
  syncDataRelacionesModeloConsistency();
  if (!shouldDeferDiskPersistence()) guardarDebounce();
  registerUnpublishedDraftMutation();
}

function persistRelacionesState() {
  syncRelacionesViewFromDraft();
  REGENERAR_MODELO();
  guardarTodo();
  if (!shouldDeferDiskPersistence()) guardarDebounce();
  registerUnpublishedDraftMutation();
}

function persistMedidasState() {
  const tid = getCurrentTeamId();
  medidasMergedCache = mergeRowsByTeamId(
    Array.isArray(medidasMergedCache) && medidasMergedCache.length ? medidasMergedCache : readFullMedidasFromDisk(),
    medidas,
    tid,
    normalizeRowTeamId
  );
  guardarEnLocalStorage(LS_KEYS.medidas, medidasMergedCache);
  if (!shouldDeferDiskPersistence()) guardarDebounce();
  registerUnpublishedDraftMutation();
}

function persistModeloState() {
  const tid = getCurrentTeamId();
  modeloMergedCache = mergeRowsByTeamId(
    Array.isArray(modeloMergedCache) && modeloMergedCache.length ? modeloMergedCache : readFullModeloFromDisk(),
    modeloAnalitico,
    tid,
    normalizeRowTeamId
  );
  syncCcBitacoraModeloDraftFromRuntime();
  guardarTodo();
  if (!shouldDeferDiskPersistence()) guardarDebounce();
  registerUnpublishedDraftMutation();
}

function hydratarDesdeLocalStorage() {
  ensureDataGeneralDraftShape();
  const dg = ensureDataGeneralDraftShape();
  if (!dg.length) {
    try {
      const raw = appMemoryKV.getItem("data_general") ?? appMemoryKV.getItem(LS_KEYS.dataReal) ?? appMemoryKV.getItem("dataReal");
      if (raw) {
        const parsed = JSON.parse(raw);
        const stored = normalizarArrayPersistido(parsed) ?? parsed;
        const rows = deserializeDataReal(Array.isArray(stored) ? stored : []);
        migrateMissingTeamIdOnRows(rows);
        rows.forEach((r) => dg.push(r));
      }
    } catch (err) {
      console.warn("Migración one-shot data_general desde memoria", err);
    }
  }
  syncDataRealViewFromDraft();
  let dAds = readFullDataAdsRowsFromDisk();
  let dAnu = readFullDataAnunciosRowsFromDisk();
  if (!dAnu.length && dAds.length) {
    dAnu = migrateLegacyDataAdsReportToAnuncios(dAds);
    dAds = [];
    migrateMissingTeamIdOnRows(dAnu);
    try {
      appMemoryKV.setItem(LS_KEYS.dataAdsReport, JSON.stringify(serializeDataReal(dAds)));
      appMemoryKV.setItem(LS_KEYS.dataAnuncios, JSON.stringify(serializeDataAnuncios(dAnu)));
    } catch (err) {
      console.warn("No se pudo persistir migración data anuncios", err);
    }
  }
  dataAdsReportMergedCache = dAds;
  dataAnunciosMergedCache = dAnu;
  dataAdsReport = dAds.filter(rowBelongsToCurrentTeam);
  dataAnuncios = dAnu.filter(rowBelongsToCurrentTeam);
  console.log("General:", dataReal.length);
  console.log("Anuncios:", dataAnuncios.length);

  campaniasUnicasMergedCache = readFullCampaniasUnicasFromDisk();
  const tidCu = getCurrentTeamId();
  const allCampaignRows = getAllCampaignRows();
  if (allCampaignRows.length) {
    campaniasUnicasData = generarCampañasUnicas(allCampaignRows);
  } else {
    const fallback = campaniasUnicasMergedCache.filter(rowBelongsToCurrentTeam);
    campaniasUnicasData = generarCampañasUnicas(fallback.length ? fallback : []);
  }
  campaniasUnicasData = campaniasUnicasData.map((r) => (r && typeof r === "object" ? { ...r, teamId: tidCu } : r));
  guardarEnLocalStorage(LS_KEYS.campaniasUnicasData, campaniasUnicasMergedCache);

  ensureRelacionesDraftShape();
  const drRel = ensureRelacionesDraftShape();
  if (!drRel.length) {
    try {
      const raw = appMemoryKV.getItem("relaciones") ?? appMemoryKV.getItem(LS_KEYS.relaciones);
      if (raw) {
        const parsed = JSON.parse(raw);
        const stored = normalizarArrayPersistido(parsed) ?? (Array.isArray(parsed) ? parsed : []);
        const arr = Array.isArray(stored) ? stored.map((x) => (typeof x === "object" && x ? { ...x } : x)) : [];
        arr.forEach((r) => drRel.push(r));
      }
    } catch (err) {
      console.warn("Migración one-shot relaciones desde memoria", err);
    }
  }
  syncRelacionesViewFromDraft();

  medidasMergedCache = readFullMedidasFromDisk();
  medidas = medidasMergedCache.filter(rowBelongsToCurrentTeam);

  modeloMergedCache = readFullModeloFromDisk();
  modeloAnalitico = modeloMergedCache.filter(rowBelongsToCurrentTeam);

  if (!hasDataGeneralLoaded()) {
    clearCurrentTeamRelacionesInDraft();
    modeloAnalitico = [];
    modeloMergedCache = mergeRowsByTeamId(modeloMergedCache, [], getCurrentTeamId(), normalizeRowTeamId);
    syncCcBitacoraModeloDraftFromRuntime();
  } else {
    pruneRelacionesWithoutData();
  }
  const allRows = dataReal.concat(dataAdsReport, dataAnuncios);
  dataIdSeq = Math.max(1, ...allRows.map((r) => Number(r._id) || 0)) + 1;
}

function debounce(fn, wait = 300) {
  return (...args) => {
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(() => fn(...args), wait);
  };
}

function limpiarNumero(valor) {
  const raw = String(valor ?? "").trim();
  if (!raw) return NaN;
  const normalized = raw.replaceAll("$", "").replaceAll(",", "").replaceAll(" ", "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function parseFechaData(valor) {
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor;
  }
  const v = String(valor ?? "").trim();
  if (!v) return null;
  const isoPrefix = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]\d|$)/);
  if (isoPrefix) {
    const y = Number(isoPrefix[1]); const m = Number(isoPrefix[2]); const d = Number(isoPrefix[3]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt;
    return null;
  }
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]); const m = Number(dmy[2]); const y = Number(dmy[3]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt;
  }
  return null;
}

function normalizarEstado(estado) {
  const v = String(estado ?? "").trim().toLowerCase();
  return (v === "active" || v === "activo") ? "Activo" : "Inactivo";
}

function isHeaderRowData(cols) {
  if (!cols?.length) return false;
  const first = String(cols[0] ?? "").trim().toLowerCase();
  const second = String(cols[1] ?? "").trim().toLowerCase();
  const third = String(cols[2] ?? "").trim().toLowerCase();
  return first.includes("fecha") || second.includes("id") || third.includes("nombre");
}

function dataFechaIsoKey(r) {
  if (r.fecha instanceof Date && !Number.isNaN(r.fecha.getTime())) return formatDateInputFromDate(r.fecha);
  return String(r.fecha ?? "").trim();
}

/** Clave única DATA general: Fecha + ID campaña. */
function dataUpsertKeyGeneral(r) {
  return `${dataFechaIsoKey(r)}||${String(r.idCampania ?? "").trim()}`;
}

function mergeDataRowPreservingId(existing, incoming) {
  const id = existing._id;
  const inc = normalizeRowTeamId(incoming);
  const exc = normalizeRowTeamId(existing);
  const ct = String(getCurrentTeamId()).trim();
  const teamKeep = inc || exc || ct;
  return { ...existing, ...incoming, _id: id, teamId: teamKeep || ct };
}

/**
 * UPSERT: misma clave → sobrescribe métricas (última fila del lote gana); clave nueva → inserta.
 * @returns {{ data: Array, insertadas: number, actualizadas: number, registrosInsertados: Array }}
 */
function upsertDataRowsLote(newRows, dataActual) {
  const keyFn = dataUpsertKeyGeneral;

  const lastByKey = new Map();
  newRows.forEach((r) => lastByKey.set(keyFn(r), r));
  const uniqueIncoming = Array.from(lastByKey.values());

  const keyToIndex = new Map();
  dataActual.forEach((r, i) => keyToIndex.set(keyFn(r), i));

  const result = dataActual.slice();
  let insertadas = 0;
  let actualizadas = 0;
  const registrosInsertados = [];

  uniqueIncoming.forEach((incoming) => {
    const k = keyFn(incoming);
    if (keyToIndex.has(k)) {
      const idx = keyToIndex.get(k);
      result[idx] = mergeDataRowPreservingId(result[idx], incoming);
      actualizadas += 1;
    } else {
      const row = { ...incoming, teamId: getCurrentTeamId() };
      result.push(row);
      keyToIndex.set(k, result.length - 1);
      insertadas += 1;
      registrosInsertados.push(row);
    }
  });

  return { data: result, insertadas, actualizadas, registrosInsertados };
}

function ordenarPorFecha(data) {
  data.sort((a, b) => {
    const ta = a.fecha?.getTime?.() ?? 0;
    const tb = b.fecha?.getTime?.() ?? 0;
    if (ta !== tb) return ta - tb;
    return String(a.idCampania).localeCompare(String(b.idCampania), "es");
  });
  return data;
}

function parseDataConReporte(texto) {
  const lines = String(texto ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const vacio = { filasLeidas: 0, validas: [], ignoradas: 0, erroresDetalle: [], advertenciasDetalle: [] };
  if (!lines.length) return vacio;
  const rows = lines.map((line) => line.split("\t").map((c) => String(c ?? "").trim()));
  const startIndex = isHeaderRowData(rows[0]) ? 1 : 0;
  let filasLeidas = 0;
  let ignoradas = 0;
  const validas = [];
  const erroresDetalle = [];
  const advertenciasDetalle = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    filasLeidas += 1;
    const cols = rows[i];
    const filaNum = i + 1;
    const dataPreview = (cols || []).join(" | ").slice(0, 400);
    if (!cols || cols.length < 8) {
      ignoradas += 1;
      erroresDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: [
          `Se esperan 8 columnas separadas por tabulador (fecha, ID campaña, nombre, gasto, leads, estado, impresiones, clics). Esta fila tiene ${cols?.length ?? 0}.`
        ],
        tipo: "error"
      });
      continue;
    }
    const fecha = parseFechaData(cols[0]);
    if (!fecha) {
      ignoradas += 1;
      erroresDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: [
          `Fecha no válida en columna 1: "${String(cols[0] ?? "").slice(0, 80)}". Use YYYY-MM-DD, DD/MM/YYYY o fecha con hora ISO.`
        ],
        tipo: "error"
      });
      continue;
    }
    const idCampania = String(cols[1] ?? "").trim();
    const nombre = String(cols[2] ?? "").trim();
    if (!idCampania) {
      ignoradas += 1;
      erroresDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: ["ID de campaña vacío (columna 2)."],
        tipo: "error"
      });
      continue;
    }
    if (!nombre) {
      ignoradas += 1;
      erroresDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: ["Nombre de campaña vacío (columna 3)."],
        tipo: "error"
      });
      continue;
    }
    const avisosFila = [];
    let gasto = limpiarNumero(cols[3]);
    if (!Number.isFinite(gasto)) {
      avisosFila.push("Gasto no numérico o vacío: se registró 0.");
      gasto = 0;
    }
    let leads = limpiarNumero(cols[4]);
    if (!Number.isFinite(leads)) {
      avisosFila.push("Leads no numérico o vacío: se registró 0.");
      leads = 0;
    }
    let impresiones = limpiarNumero(cols[6]);
    if (!Number.isFinite(impresiones)) {
      avisosFila.push("Impresiones no numérico o vacío: se registró 0.");
      impresiones = 0;
    }
    let clics = limpiarNumero(cols[7]);
    if (!Number.isFinite(clics)) {
      avisosFila.push("Clics no numérico o vacío: se registró 0.");
      clics = 0;
    }
    if (avisosFila.length) {
      advertenciasDetalle.push({
        fila: filaNum,
        data: dataPreview,
        errores: avisosFila,
        tipo: "aviso"
      });
    }
    validas.push({ fecha, idCampania, nombre, gasto, leads, estado: normalizarEstado(cols[5]), impresiones, clics });
  }
  return { filasLeidas, validas, ignoradas, erroresDetalle, advertenciasDetalle };
}

function formatFechaDdMmmData(date) {
  const day = String(date.getDate()).padStart(2, "0");
  return `${day}-${MONTHS_EN_SHORT[date.getMonth()] || ""}`;
}

/** Fecha corta tipo 14/05/2026 — misma línea temporal local que DATA general. */
function formatFechaDdMmSlashData(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${day}/${m}/${y}`;
}

function formatMonthYearData(date) {
  return `${MONTHS_EN_SHORT[date.getMonth()] || ""}-${date.getFullYear()}`;
}

function formatNumberSmartData(n) {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return String(Number(n.toFixed(2)));
}

function formatNumberWithCommasDataCard(n) {
  if (!Number.isFinite(n)) return "";
  const normalized = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : Number(n.toFixed(2));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(normalized);
}

function isDataCampaignAlcanceLike(name) {
  return String(name || "").toLowerCase().includes("alcance");
}

function formatCurrencyUSDData(n) {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function actualizarFiltrosCache() {
  const ids = new Set(); const nombres = new Set(); const days = new Map();
  dataReal.forEach((r) => {
    ids.add(String(r.idCampania));
    nombres.add(String(r.nombre));
    const monthKey = formatMonthYearData(r.fecha);
    const dayKey = formatDateInputFromDate(r.fecha);
    if (!days.has(monthKey)) days.set(monthKey, new Set());
    days.get(monthKey).add(dayKey);
  });
  filtrosCache = {
    fecha: { months: Array.from(days.keys()).sort(), daysByMonth: new Map(Array.from(days.entries()).map(([k, set]) => [k, Array.from(set).sort()])) },
    idCampania: Array.from(ids).sort((a, b) => a.localeCompare(b, "es")),
    nombre: Array.from(nombres).sort((a, b) => a.localeCompare(b, "es"))
  };
}

function refreshFechaFiltersUI() {
  const selMes = document.getElementById("dataFilterFechaMes");
  const selDia = document.getElementById("dataFilterFechaDia");
  if (!selMes || !selDia) return;
  const currentMes = (selMes.value || "").trim();
  const currentDia = (selDia.value || "").trim();
  selMes.innerHTML = `<option value="">Todos</option>` + filtrosCache.fecha.months.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  const mesOk = filtrosCache.fecha.months.includes(currentMes) ? currentMes : "";
  selMes.value = mesOk;
  const days = mesOk ? (filtrosCache.fecha.daysByMonth.get(mesOk) || []) : [];
  selDia.innerHTML = `<option value="">Todos</option>` + days.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  if (days.includes(currentDia)) selDia.value = currentDia;
}

function limpiarFiltrosUiDataGeneral() {
  const selMes = document.getElementById("dataFilterFechaMes");
  const selDia = document.getElementById("dataFilterFechaDia");
  const idIn = document.getElementById("dataFilterIdInput");
  const nomIn = document.getElementById("dataFilterNombreInput");
  if (selMes) selMes.value = "";
  if (selDia) selDia.value = "";
  if (idIn) idIn.value = "";
  if (nomIn) nomIn.value = "";
  dataGeneralPageIndex = 1;
}

function clampDataGeneralPage(totalRows, pageSize, page) {
  const size = Math.max(1, pageSize || 50);
  const maxPage = totalRows <= 0 ? 1 : Math.max(1, Math.ceil(totalRows / size));
  const p = Number(page) || 1;
  return Math.min(Math.max(1, p), maxPage);
}

function inferPlataformaNombreDataGeneral(nombre) {
  const n = String(nombre || "").toLowerCase();
  if (/\b(meta|facebook|fb|instagram|ig)\b/.test(n) || n.includes("meta ads")) return "meta";
  if (/\b(google|adwords|pmax|dsa|youtube ads)\b/.test(n) || n.includes("google ads")) return "google";
  return "";
}

function dataCampaignNameCellHtml(nombre) {
  const plat = inferPlataformaNombreDataGeneral(nombre);
  const nameEsc = escapeHtml(String(nombre || ""));
  if (plat === "meta") {
    return `<div class="data-name-cell"><span class="data-plat-ico data-plat-ico--meta" title="Meta"><i class="fa-brands fa-facebook-f" aria-hidden="true"></i></span><span class="data-name-text">${nameEsc}</span></div>`;
  }
  if (plat === "google") {
    return `<div class="data-name-cell"><span class="data-plat-ico data-plat-ico--google" title="Google Ads"><i class="fa-brands fa-google" aria-hidden="true"></i></span><span class="data-name-text">${nameEsc}</span></div>`;
  }
  return `<div class="data-name-cell"><span class="data-plat-ico data-plat-ico--neutral" title=""><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span><span class="data-name-text">${nameEsc}</span></div>`;
}

function dataEstadoBadgeHtml(estado) {
  const e = String(estado ?? "").trim();
  const low = e.toLowerCase();
  let mod = "--muted";
  if (low === "activo") mod = "--ok";
  else if (low === "inactivo") mod = "--off";
  else if (low === "error" || low.includes("error")) mod = "--err";
  const label = e || "—";
  return `<span class="data-general-estado-badge data-general-estado-badge${mod}">${escapeHtml(label)}</span>`;
}

function refreshDataGeneralStatusBar() {
  const el = document.getElementById("dataStatus");
  if (!el) return;
  el.textContent = `${selectedDataIds.size} filas seleccionadas | Total acumulado: ${dataReal.length}`;
}

function updateDataKpisFromGeneral() {
  const uniq = new Set();
  let gasto = 0;
  let leadsPerf = 0;
  let impPerf = 0;
  let clicsPerf = 0;
  dataReal.forEach((r) => {
    const idc = String(r.idCampania ?? "").trim();
    if (idc) uniq.add(idc);
    gasto += Number(r.gasto) || 0;
    if (!isDataCampaignAlcanceLike(r.nombre)) {
      leadsPerf += Number(r.leads) || 0;
      impPerf += Number(r.impresiones) || 0;
      clicsPerf += Number(r.clics) || 0;
    }
  });
  const setText = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setText("dataKpiRegistros", formatNumberWithCommasDataCard(dataReal.length));
  setText("dataKpiCampanas", formatNumberWithCommasDataCard(uniq.size));
  setText("dataKpiGasto", formatCurrencyUSDData(gasto));
  setText("dataKpiLeads", formatNumberWithCommasDataCard(leadsPerf));
  setText("dataKpiImpresiones", formatNumberWithCommasDataCard(impPerf));
  setText("dataKpiClics", formatNumberWithCommasDataCard(clicsPerf));
}

/** Clave resumen CRM: Flujo (tipo | programa) + intake + FuenteVF cruda del archivo. */
function crmDataSummaryUniqueCombinationKey(row) {
  const h = crmHydrateDimensionalFieldsOnRow(row);
  const tipo = String(h.tipo || "").trim();
  const programa = String(h.programa || "").trim();
  const intake = String(h.intake || "").trim();
  const fuenteVf = String(row.fuenteCrm ?? "").trim();
  let flujo = "";
  if (tipo && programa) flujo = `${tipo} | ${programa}`;
  else flujo = programa || tipo || String(h.nombreCampania || "").trim();
  return normalizarTexto(`${flujo}|${intake}|${fuenteVf}`);
}

function updateDataKpisFromCrm() {
  const list = crmLeads;
  const uniq = new Set();
  let sumLeads = 0;
  let sumInt = 0;
  let sumPost = 0;
  let sumMat = 0;
  list.forEach((r) => {
    uniq.add(crmDataSummaryUniqueCombinationKey(r));
    sumLeads += Number(r.leads) || 0;
    if (r.esInteresado) sumInt += 1;
    if (r.esPostulante) sumPost += 1;
    if (r.esMatriculado) sumMat += 1;
  });
  const setText = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setText("crmDataKpiRegistros", formatNumberWithCommasDataCard(list.length));
  setText("crmDataKpiCampanas", formatNumberWithCommasDataCard(uniq.size));
  setText("crmDataKpiLeads", formatNumberWithCommasDataCard(sumLeads));
  setText("crmDataKpiInteresados", formatNumberWithCommasDataCard(sumInt));
  setText("crmDataKpiPostulantes", formatNumberWithCommasDataCard(sumPost));
  setText("crmDataKpiMatriculados", formatNumberWithCommasDataCard(sumMat));
}

/** Texto Flujo para vista DATA→CRM (columna Programa / agrupación). */
function crmFlujoDisplayForDataRow(r) {
  const raw = String(r?.crmFlujoRaw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (raw) return raw;
  const h = crmHydrateDimensionalFieldsOnRow(r);
  const tipo = String(h.tipo ?? "").trim();
  const programa = String(h.programa ?? "").trim();
  if (tipo && programa) return `${tipo} | ${programa}`;
  return String(programa || tipo || h.nombreCampania || "").trim();
}

/** Valor segmentador Programa (derivado del Flujo). */
function crmProgramaSegmentValueFromRow(r) {
  const h = crmHydrateDimensionalFieldsOnRow(r);
  const programa = String(h.programa ?? "").trim();
  if (programa) return programa;
  const tipo = String(h.tipo ?? "").trim();
  if (tipo) return tipo;
  return crmFlujoDisplayForDataRow(r);
}

/** Agrupa por fecha de ingreso + Flujo + FuenteVF + intake; suma leads. */
function aggregateCrmLeadsRowsForDataTab(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!(r.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) continue;
    const h = crmHydrateDimensionalFieldsOnRow(r);
    const fechaKey = formatDateInputFromDate(r.fecha);
    const flujo = crmFlujoDisplayForDataRow(r);
    const fuente = String(r.fuenteCrm ?? "").trim();
    const intake = String(h.intake ?? "").trim();
    const key = `${fechaKey}|${flujo}|${fuente}|${intake}`;
    const add = Number(r.leads) || 0;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { fechaKey, fecha: r.fecha, flujo, fuente, intake, sumLeads: add });
    } else {
      prev.sumLeads += add;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const dc = String(a.fechaKey).localeCompare(String(b.fechaKey));
    if (dc !== 0) return dc;
    const fc = String(a.flujo).localeCompare(String(b.flujo), "es");
    if (fc !== 0) return fc;
    const uc = String(a.fuente).localeCompare(String(b.fuente), "es");
    if (uc !== 0) return uc;
    return String(a.intake).localeCompare(String(b.intake), "es");
  });
}

function crmProgramaAutocompleteHideList() {
  const lb = document.getElementById("crmDataFilterProgramaListbox");
  const inp = document.getElementById("crmDataFilterProgramaInput");
  if (lb) {
    lb.classList.add("hidden");
    lb.innerHTML = "";
  }
  if (inp) inp.setAttribute("aria-expanded", "false");
}

function crmToggleProgramaClearBtn() {
  const inp = document.getElementById("crmDataFilterProgramaInput");
  const btn = document.getElementById("crmDataFilterProgramaClear");
  if (!inp || !btn) return;
  btn.classList.toggle("hidden", !inp.value.trim());
}

function crmProgramaAutocompleteShowSuggestions() {
  const inp = document.getElementById("crmDataFilterProgramaInput");
  const lb = document.getElementById("crmDataFilterProgramaListbox");
  if (!inp || !lb) return;
  const q = inp.value.trim().toLowerCase();
  const max = 80;
  const src = crmDataTabProgramasSortedCache;
  const matches = !q
    ? src.slice(0, max)
    : src.filter((x) => String(x).toLowerCase().includes(q)).slice(0, max);
  lb.innerHTML = "";
  matches.forEach((text) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.textContent = text;
    li.addEventListener("mousedown", (e) => e.preventDefault());
    li.addEventListener("click", () => {
      inp.value = text;
      crmProgramaAutocompleteHideList();
      crmToggleProgramaClearBtn();
      dataCrmResumenPageIndex = 1;
      renderCrmDataResumenTable();
    });
    lb.appendChild(li);
  });
  if (matches.length) {
    lb.classList.remove("hidden");
    inp.setAttribute("aria-expanded", "true");
  } else {
    lb.classList.add("hidden");
    inp.setAttribute("aria-expanded", "false");
  }
}

function scheduleCrmProgramaFilterTable() {
  if (crmProgramaFilterDebounceId) clearTimeout(crmProgramaFilterDebounceId);
  crmProgramaFilterDebounceId = setTimeout(() => {
    crmProgramaFilterDebounceId = null;
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  }, 200);
}

function getCrmLeadsFilteredForDataTab() {
  const selMes = document.getElementById("crmDataFilterMes");
  const selDia = document.getElementById("crmDataFilterFechaDia");
  const progIn = document.getElementById("crmDataFilterProgramaInput");
  const selFuente = document.getElementById("crmDataFilterFuente");
  const selIntake = document.getElementById("crmDataFilterIntake");
  const mes = (selMes?.value || "").trim();
  const dia = (selDia?.value || "").trim();
  const progQ = (progIn?.value || "").trim().toLowerCase();
  const fuente = (selFuente?.value || "").trim();
  const intake = (selIntake?.value || "").trim();
  return crmLeads.filter((r) => {
    if (!(r.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
    if (mes && formatMonthYearData(r.fecha) !== mes) return false;
    if (dia && formatDateInputFromDate(r.fecha) !== dia) return false;
    if (progQ) {
      const fl = crmFlujoDisplayForDataRow(r).toLowerCase();
      const ps = crmProgramaSegmentValueFromRow(r).toLowerCase();
      if (!fl.includes(progQ) && !ps.includes(progQ)) return false;
    }
    if (fuente && String(r.fuenteCrm ?? "").trim() !== fuente) return false;
    if (intake) {
      const h = crmHydrateDimensionalFieldsOnRow(r);
      if (String(h.intake ?? "").trim() !== intake) return false;
    }
    return true;
  });
}

function refreshCrmDataSegmentadoresUI() {
  const selMes = document.getElementById("crmDataFilterMes");
  const selDia = document.getElementById("crmDataFilterFechaDia");
  const selFuente = document.getElementById("crmDataFilterFuente");
  const selIntake = document.getElementById("crmDataFilterIntake");
  const progIn = document.getElementById("crmDataFilterProgramaInput");
  if (!selMes || !selDia || !selFuente || !selIntake || !progIn) return;
  const months = new Set();
  const daysByMonth = new Map();
  const programasFlujo = new Set();
  const fuentes = new Set();
  const intakes = new Set();
  crmLeads.forEach((r) => {
    if (!(r.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return;
    const mk = formatMonthYearData(r.fecha);
    const dk = formatDateInputFromDate(r.fecha);
    months.add(mk);
    if (!daysByMonth.has(mk)) daysByMonth.set(mk, new Set());
    daysByMonth.get(mk).add(dk);
    const disp = crmFlujoDisplayForDataRow(r);
    if (disp) programasFlujo.add(disp);
    const fv = String(r.fuenteCrm ?? "").trim();
    if (fv) fuentes.add(fv);
    const h = crmHydrateDimensionalFieldsOnRow(r);
    const ink = String(h.intake ?? "").trim();
    if (ink) intakes.add(ink);
  });
  crmDataTabProgramasSortedCache = Array.from(programasFlujo).sort((a, b) => a.localeCompare(b, "es"));
  const sortedMonths = Array.from(months).sort();
  const curMes = selMes.value.trim();
  const curDia = selDia.value.trim();
  const curFuente = selFuente.value.trim();
  const curIntake = selIntake.value.trim();
  selMes.innerHTML =
    `<option value="">Todos</option>` +
    sortedMonths.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  selMes.value = sortedMonths.includes(curMes) ? curMes : "";
  const mesOk = selMes.value.trim();
  const days = mesOk ? Array.from(daysByMonth.get(mesOk) || []).sort() : [];
  selDia.innerHTML =
    `<option value="">Todos</option>` +
    days.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  selDia.value = days.includes(curDia) ? curDia : "";
  const sortedFuente = Array.from(fuentes).sort((a, b) => a.localeCompare(b, "es"));
  selFuente.innerHTML =
    `<option value="">Todos</option>` +
    sortedFuente.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
  selFuente.value = sortedFuente.includes(curFuente) ? curFuente : "";
  const sortedIntake = Array.from(intakes).sort((a, b) => a.localeCompare(b, "es"));
  selIntake.innerHTML =
    `<option value="">Todos</option>` +
    sortedIntake.map((it) => `<option value="${escapeHtml(it)}">${escapeHtml(it)}</option>`).join("");
  selIntake.value = sortedIntake.includes(curIntake) ? curIntake : "";
  crmProgramaAutocompleteHideList();
  crmToggleProgramaClearBtn();
}

function renderCrmDataResumenTable() {
  const tbody = document.getElementById("crmDataResumenTbody");
  if (!tbody) return;
  const filtered = getCrmLeadsFilteredForDataTab();
  const aggregated = aggregateCrmLeadsRowsForDataTab(filtered);
  const pageSizeEl = document.getElementById("crmDataPageSize");
  const pageSize = Math.max(1, parseInt(String(pageSizeEl?.value || "50"), 10) || 50);
  const totalAgg = aggregated.length;
  dataCrmResumenPageIndex = clampDataGeneralPage(totalAgg, pageSize, dataCrmResumenPageIndex);
  const start = (dataCrmResumenPageIndex - 1) * pageSize;
  const slice = aggregated.slice(start, start + pageSize);
  let totalLeadsVis = 0;
  aggregated.forEach((row) => {
    totalLeadsVis += row.sumLeads;
  });
  const sinDatosGlobales = crmLeads.length === 0;
  if (!slice.length) {
    tbody.innerHTML = sinDatosGlobales
      ? `<tr><td colspan="5" class="data-crm-resumen-empty">Sin datos CRM. Importa un archivo CSV o XLSX.</td></tr>`
      : `<tr><td colspan="5" class="data-crm-resumen-empty">Sin filas en este filtro. Ajusta segmentadores.</td></tr>`;
  } else {
    tbody.innerHTML = slice
      .map((row) => {
        const fechaDisp =
          row.fecha instanceof Date ? formatFechaDdMmSlashData(row.fecha) : String(row.fechaKey || "");
        return `<tr>
      <td>${escapeHtml(fechaDisp)}</td>
      <td class="data-td-name">${escapeHtml(row.flujo)}</td>
      <td>${escapeHtml(row.fuente)}</td>
      <td>${escapeHtml(row.intake)}</td>
      <td class="data-td-leads">${formatNumberSmartData(row.sumLeads)}</td>
    </tr>`;
      })
      .join("");
  }
  const tl = document.getElementById("crmDataTotalLeads");
  if (tl) tl.textContent = formatNumberSmartData(totalLeadsVis);

  const infoEl = document.getElementById("crmDataPaginationInfo");
  const indicator = document.getElementById("crmDataPageIndicator");
  const maxPage = totalAgg <= 0 ? 1 : Math.ceil(totalAgg / pageSize);
  if (indicator) {
    indicator.textContent =
      maxPage <= 1 ? String(dataCrmResumenPageIndex) : `${dataCrmResumenPageIndex} / ${maxPage}`;
    indicator.title = `Página ${dataCrmResumenPageIndex} de ${maxPage}`;
  }
  if (infoEl) {
    if (totalAgg === 0) infoEl.textContent = "Sin filas resumen";
    else {
      const endRow = Math.min(start + slice.length, totalAgg);
      infoEl.textContent = `Mostrando ${start + 1} a ${endRow} de ${formatNumberSmartData(totalAgg)} filas resumen`;
    }
  }
  const prevBtn = document.getElementById("crmDataPagePrev");
  const nextBtn = document.getElementById("crmDataPageNext");
  const canPrev = dataCrmResumenPageIndex > 1;
  const canNext = dataCrmResumenPageIndex < maxPage;
  if (prevBtn) {
    prevBtn.disabled = !canPrev;
    prevBtn.classList.toggle("is-disabled", !canPrev);
  }
  if (nextBtn) {
    nextBtn.disabled = !canNext;
    nextBtn.classList.toggle("is-disabled", !canNext);
  }
}

function initCrmDataResumenFilters() {
  document.getElementById("crmDataFilterMes")?.addEventListener("change", () => {
    refreshCrmDataSegmentadoresUI();
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  document.getElementById("crmDataFilterFechaDia")?.addEventListener("change", () => {
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  const progInput = document.getElementById("crmDataFilterProgramaInput");
  const progWrap = document.getElementById("crmDataFilterProgramaWrap");
  progInput?.addEventListener("focus", () => {
    crmProgramaAutocompleteShowSuggestions();
  });
  progInput?.addEventListener("input", () => {
    crmToggleProgramaClearBtn();
    crmProgramaAutocompleteShowSuggestions();
    scheduleCrmProgramaFilterTable();
  });
  progInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      crmProgramaAutocompleteHideList();
    }
  });
  document.getElementById("crmDataFilterProgramaClear")?.addEventListener("click", () => {
    if (!progInput) return;
    progInput.value = "";
    crmToggleProgramaClearBtn();
    crmProgramaAutocompleteHideList();
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  document.addEventListener(
    "click",
    (e) => {
      if (!(e.target instanceof HTMLElement) || !progWrap) return;
      if (!progWrap.contains(e.target)) crmProgramaAutocompleteHideList();
    },
    true
  );

  document.getElementById("crmDataFilterFuente")?.addEventListener("change", () => {
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  document.getElementById("crmDataFilterIntake")?.addEventListener("change", () => {
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  document.getElementById("crmDataPageSize")?.addEventListener("change", () => {
    dataCrmResumenPageIndex = 1;
    renderCrmDataResumenTable();
  });
  document.getElementById("crmDataPagePrev")?.addEventListener("click", () => {
    dataCrmResumenPageIndex = Math.max(1, dataCrmResumenPageIndex - 1);
    renderCrmDataResumenTable();
  });
  document.getElementById("crmDataPageNext")?.addEventListener("click", () => {
    dataCrmResumenPageIndex += 1;
    renderCrmDataResumenTable();
  });
}

function filtrarData() {
  const selMes = document.getElementById("dataFilterFechaMes");
  const selDia = document.getElementById("dataFilterFechaDia");
  const idIn = document.getElementById("dataFilterIdInput");
  const nomIn = document.getElementById("dataFilterNombreInput");
  let mes = (selMes?.value || "").trim();
  let dia = (selDia?.value || "").trim();
  let idQ = (idIn?.value || "").trim().toLowerCase();
  let nombreQ = (nomIn?.value || "").trim().toLowerCase();

  const aplicarFiltros = () =>
    dataReal.filter((r) => {
      if (mes && formatMonthYearData(r.fecha) !== mes) return false;
      if (dia && formatDateInputFromDate(r.fecha) !== dia) return false;
      if (idQ && !String(r.idCampania).toLowerCase().includes(idQ)) return false;
      if (nombreQ && !String(r.nombre).toLowerCase().includes(nombreQ)) return false;
      return true;
    });

  dataFiltrada = aplicarFiltros();
  if (dataReal.length > 0 && dataFiltrada.length === 0 && (mes || dia || idQ || nombreQ)) {
    limpiarFiltrosUiDataGeneral();
    refreshFechaFiltersUI();
    mes = dia = idQ = nombreQ = "";
    dataFiltrada = aplicarFiltros();
  }
}

function renderTablaData() {
  console.log("DATA módulo:", appState.dataDraft.data_general);
  syncDataRealViewFromDraft();
  const tbody = document.getElementById("dataTbody");
  if (!tbody) return;
  const regCount = document.getElementById("dataGeneralRegistrosCount");
  if (regCount) regCount.textContent = String(dataReal.length);
  filtrarData();
  updateDataKpisFromGeneral();

  const pageSizeEl = document.getElementById("dataPageSize");
  const pageSize = Math.max(1, parseInt(String(pageSizeEl?.value || "50"), 10) || 50);
  const totalFiltered = dataFiltrada.length;
  dataGeneralPageIndex = clampDataGeneralPage(totalFiltered, pageSize, dataGeneralPageIndex);
  const start = (dataGeneralPageIndex - 1) * pageSize;
  const slice = dataFiltrada.slice(start, start + pageSize);

  tbody.innerHTML = "";
  let totalGasto = 0;
  let totalLeads = 0;
  let totalImpresiones = 0;
  let totalClics = 0;
  dataFiltrada.forEach((row) => {
    totalGasto += Number(row.gasto) || 0;
    totalLeads += Number(row.leads) || 0;
    totalImpresiones += Number(row.impresiones) || 0;
    totalClics += Number(row.clics) || 0;
  });
  slice.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.dataId = String(row._id);
    if (selectedDataIds.has(String(row._id))) tr.classList.add("data-row-selected");
    const rid = escapeHtml(String(row._id));
    const checked = selectedDataIds.has(String(row._id)) ? "checked" : "";
    tr.innerHTML = `
      <td class="data-td-check"><label class="data-check-wrap"><input type="checkbox" class="data-check-native" data-data-check="${rid}" ${checked} /><span class="data-check-ui" aria-hidden="true"></span></label></td>
      <td>${formatFechaDdMmmData(row.fecha)}</td>
      <td>${escapeHtml(row.idCampania)}</td>
      <td class="data-td-name">${dataCampaignNameCellHtml(row.nombre)}</td>
      <td class="data-td-gasto">${formatCurrencyUSDData(row.gasto)}</td>
      <td class="data-td-leads">${formatNumberSmartData(row.leads)}</td>
      <td class="data-td-estado">${dataEstadoBadgeHtml(row.estado)}</td>
      <td>${formatNumberSmartData(row.impresiones)}</td>
      <td>${formatNumberSmartData(row.clics)}</td>
      <td class="data-td-actions"><button type="button" class="data-row-actions-btn" aria-label="Acciones de fila"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button></td>
    `;
    tbody.appendChild(tr);
  });
  const tg = document.getElementById("dataTotalGasto");
  const tl = document.getElementById("dataTotalLeads");
  const ti = document.getElementById("dataTotalImpresiones");
  const tc = document.getElementById("dataTotalClics");
  if (tg) tg.textContent = formatCurrencyUSDData(totalGasto);
  if (tl) tl.textContent = formatNumberSmartData(totalLeads);
  if (ti) ti.textContent = formatNumberSmartData(totalImpresiones);
  if (tc) tc.textContent = formatNumberSmartData(totalClics);

  const infoEl = document.getElementById("dataPaginationInfo");
  const indicator = document.getElementById("dataPageIndicator");
  const maxPage = totalFiltered <= 0 ? 1 : Math.ceil(totalFiltered / pageSize);
  if (indicator) {
    indicator.textContent = maxPage <= 1 ? String(dataGeneralPageIndex) : `${dataGeneralPageIndex} / ${maxPage}`;
    indicator.title = `Página ${dataGeneralPageIndex} de ${maxPage}`;
  }
  if (infoEl) {
    if (totalFiltered === 0) infoEl.textContent = "Sin registros";
    else {
      const endRow = Math.min(start + slice.length, totalFiltered);
      infoEl.textContent = `Mostrando ${start + 1} a ${endRow} de ${formatNumberSmartData(totalFiltered)} registros`;
    }
  }
  const prevBtn = document.getElementById("dataPagePrev");
  const nextBtn = document.getElementById("dataPageNext");
  const canPrev = dataGeneralPageIndex > 1;
  const canNext = dataGeneralPageIndex < maxPage;
  if (prevBtn) {
    prevBtn.disabled = !canPrev;
    prevBtn.classList.toggle("is-disabled", !canPrev);
  }
  if (nextBtn) {
    nextBtn.disabled = !canNext;
    nextBtn.classList.toggle("is-disabled", !canNext);
  }
  refreshDataGeneralStatusBar();
}

function generarCampañasUnicas(data) {
  const map = new Map();
  (Array.isArray(data) ? data : []).forEach((r) => {
    const idCampania = String(r?.idCampania ?? "").trim();
    if (!idCampania) return;
    const nombre = String(r?.nombre ?? r?.nombreCampana ?? "").trim();
    if (!map.has(idCampania)) {
      map.set(idCampania, { idCampania, nombre });
      return;
    }
    // El último registro leído tiene prioridad para el nombre.
    const prev = map.get(idCampania);
    map.set(idCampania, { idCampania, nombre: nombre || String(prev?.nombre || "") });
  });
  return Array.from(map.values()).sort((a, b) =>
    String(a.nombre || a.idCampania).localeCompare(String(b.nombre || b.idCampania), "es")
  );
}

function getLatestCampaignNameMap(data) {
  const map = new Map();
  generarCampañasUnicas(data).forEach((row) => {
    map.set(String(row.idCampania), String(row.nombre || ""));
  });
  return map;
}

function getAllCampaignRows() {
  const fromAnuncios = dataAnuncios
    .filter((r) => String(r.idCampania || "").trim() && String(r.nombreCampana || "").trim())
    .map((r) => ({
      idCampania: String(r.idCampania).trim(),
      nombre: String(r.nombreCampana).trim()
    }));
  const fromGeneral = ensureDataGeneralDraftShape()
    .filter((r) => rowBelongsToCurrentTeam(r))
    .map((r) => ({
      idCampania: String(r.idCampania || "").trim(),
      nombre: String(r.nombre || "").trim()
    }))
    .filter((r) => r.idCampania && r.nombre);
  return fromGeneral.concat(fromAnuncios);
}

function renderTablaCampañas() {
  const tbody = document.getElementById("uniqueTbody");
  const count = document.getElementById("uniqueCount");
  if (!tbody || !count) return;
  const q = (document.getElementById("uniqueSearch")?.value || "").trim().toLowerCase();
  const sourceRows = getAllCampaignRows();
  const allUnique = generarCampañasUnicas(sourceRows);
  const unique = allUnique.filter((c) => !q || c.nombre.toLowerCase().includes(q) || c.idCampania.toLowerCase().includes(q));
  campaniasUnicasData = allUnique;
  count.textContent = String(unique.length);
  tbody.innerHTML = "";
  unique.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(c.idCampania)}</td><td>${escapeHtml(c.nombre)}</td>`;
    tbody.appendChild(tr);
  });
}

function deshacerUltimaCarga() {
  const last = historialCargas.pop();
  if (!last) return;
  const ids = new Set(last.registros.map((r) => String(r._id)));
  const dg = ensureDataGeneralDraftShape();
  registrarAuditoria({
    modulo: "data",
    accion: "eliminar",
    campo: "deshacer_carga",
    valorAnterior: { ids: Array.from(ids) },
    valorNuevo: null,
    descripcion: `Deshacer última carga DATA (${ids.size} registros)`
  });
  for (let i = dg.length - 1; i >= 0; i -= 1) {
    const r = dg[i];
    if (rowBelongsToCurrentTeam(r) && ids.has(String(r._id))) dg.splice(i, 1);
  }
  syncDataRealViewFromDraft();
  ids.forEach((id) => selectedDataIds.delete(String(id)));
  persistDataState();
  actualizarFiltrosCache(); refreshFechaFiltersUI(); renderTablaData(); renderTablaCampañas(); renderRelacionesDataList();
}

async function eliminarFilasSeleccionadas() {
  if (!selectedDataIds.size) return;
  const ok = await showAppDialog({
    message: `¿Eliminar ${selectedDataIds.size} registros?`,
    primaryText: "Confirmar",
    secondaryText: "Cancelar",
    primaryDanger: true
  });
  if (!ok) return;
  const ids = new Set(Array.from(selectedDataIds).map((x) => String(x)));
  registrarAuditoria({
    modulo: "data",
    accion: "eliminar",
    campo: "registros_seleccionados",
    valorAnterior: { ids: Array.from(ids), count: ids.size },
    valorNuevo: null,
    descripcion: `Eliminación DATA general: ${ids.size} registros`
  });
  const dg = ensureDataGeneralDraftShape();
  for (let i = dg.length - 1; i >= 0; i -= 1) {
    const r = dg[i];
    if (rowBelongsToCurrentTeam(r) && ids.has(String(r._id))) dg.splice(i, 1);
  }
  syncDataRealViewFromDraft();
  historialCargas = historialCargas
    .map((b) => ({ ...b, registros: b.registros.filter((r) => !ids.has(String(r._id))) }))
    .filter((b) => b.registros.length > 0);
  selectedDataIds = new Set();
  guardarData();
  actualizarFiltrosCache(); refreshFechaFiltersUI(); renderTablaData(); renderTablaCampañas(); renderRelacionesDataList();
}

function initDataSubTabs() {
  const tabLoad = document.getElementById("dataTabGeneral");
  const tabAnuncios = document.getElementById("dataTabAnuncios");
  const tabCrm = document.getElementById("dataTabCrm");
  const tabUnique = document.getElementById("dataTabUnique");
  const panelLoad = document.getElementById("dataPanelGeneral");
  const panelAnuncios = document.getElementById("dataPanelAnuncios");
  const panelCrm = document.getElementById("dataPanelCrm");
  const panelUnique = document.getElementById("dataPanelUnique");
  if (!tabLoad || !tabAnuncios || !tabUnique || !panelLoad || !panelAnuncios || !panelUnique) return;
  const set = (which) => {
    dataActiveSubtab = which;
    const isGeneral = which === "general";
    const isAnuncios = which === "anuncios";
    const isCrm = which === "crm";
    const isUnique = which === "unique";
    tabLoad.classList.toggle("data-subtab-active", isGeneral);
    tabAnuncios.classList.toggle("data-subtab-active", isAnuncios);
    tabCrm?.classList.toggle("data-subtab-active", isCrm);
    tabUnique.classList.toggle("data-subtab-active", isUnique);
    tabLoad.setAttribute("aria-selected", isGeneral ? "true" : "false");
    tabAnuncios.setAttribute("aria-selected", isAnuncios ? "true" : "false");
    tabCrm?.setAttribute("aria-selected", isCrm ? "true" : "false");
    tabUnique.setAttribute("aria-selected", isUnique ? "true" : "false");
    panelLoad.classList.toggle("hidden", !isGeneral);
    panelAnuncios.classList.toggle("hidden", !isAnuncios);
    panelCrm?.classList.toggle("hidden", !isCrm);
    panelUnique.classList.toggle("hidden", !isUnique);
    if (isCrm) {
      syncCrmLeadsViewFromDraft();
    }
  };
  tabLoad.addEventListener("click", () => set("general"));
  tabAnuncios.addEventListener("click", () => set("anuncios"));
  tabCrm?.addEventListener("click", () => set("crm"));
  tabUnique.addEventListener("click", () => set("unique"));
  set("general");
  initCrmDataResumenFilters();
}

function applyRelacionesHeaderSubtabsNavVisibility() {
  const wrap = document.getElementById("campatrackRelHeaderSubtabsWrap");
  const rel = document.getElementById("relacionesModule");
  const onRel = !!(rel && !rel.classList.contains("hidden"));
  if (!(wrap instanceof HTMLElement)) return;
  wrap.setAttribute("aria-hidden", onRel ? "false" : "true");
}

function refreshRelacionesModuleView() {
  if (relActiveSubtab === "crm") {
    refreshCrmRelFilterSelects();
    renderCrmRelPlanningList();
    renderCrmRelCrmList();
    renderCrmRelacionesTabla();
    return;
  }
  refreshRelacionesFilterSelects();
  renderRelacionesPlanningList();
  renderRelacionesDataList();
  renderRelacionesTabla();
  renderRelacionesEstado();
}

function initRelSubTabs() {
  const tabMeta = document.getElementById("relTabMeta");
  const tabCrm = document.getElementById("relTabCrm");
  const panelMeta = document.getElementById("relPanelMeta");
  const panelCrm = document.getElementById("relPanelCrm");
  if (!tabMeta || !tabCrm || !panelMeta || !panelCrm) return;
  const set = (which) => {
    relActiveSubtab = which;
    const isMeta = which === "meta";
    const isCrm = which === "crm";
    tabMeta.classList.toggle("data-subtab-active", isMeta);
    tabCrm.classList.toggle("data-subtab-active", isCrm);
    tabMeta.setAttribute("aria-selected", isMeta ? "true" : "false");
    tabCrm.setAttribute("aria-selected", isCrm ? "true" : "false");
    panelMeta.classList.toggle("hidden", !isMeta);
    panelCrm.classList.toggle("hidden", !isCrm);
    refreshRelacionesModuleView();
  };
  tabMeta.addEventListener("click", () => set("meta"));
  tabCrm.addEventListener("click", () => set("crm"));
  set("meta");
  applyRelacionesHeaderSubtabsNavVisibility();
}

function initDataLoadModal() {
  const openBtn = document.getElementById("openDataLoadBtn");
  const openAnunciosBtn = document.getElementById("openAnunciosLoadBtn");
  const modal = document.getElementById("dataLoadModal");
  const closeBtn = document.getElementById("closeDataLoadBtn");
  const processBtn = document.getElementById("processDataBtn");
  const titleEl = document.getElementById("dataLoadTitle");
  const input = document.getElementById("dataInput");
  if (!openBtn || !openAnunciosBtn || !modal || !closeBtn || !processBtn || !input || !titleEl) return;
  const open = (which) => {
    dataActiveSubtab = which;
    titleEl.textContent =
      which === "anuncios" ? "Carga de Data Anuncios" : "Carga de Data General";
    input.placeholder =
      which === "anuncios"
        ? "ID campaña[TAB]Nombre campaña[TAB]Nombre anuncio[TAB]Leads[TAB]Gastos[TAB]Impresiones[TAB]Alcance[TAB]Clics[TAB]Estado Activo|Inactivo (opc.)[TAB]Link (opc.)[TAB]Tipo ppl|ppv|carrusel (opc.). Tras «Clics», si la siguiente celda no es URL ni tipo, se interpreta como estado."
        : "Pega aquí tu data desde Excel...";
    modal.classList.remove("hidden");
  };
  const close = () => modal.classList.add("hidden");
  openBtn.addEventListener("click", () => open("general"));
  openAnunciosBtn.addEventListener("click", () => open("anuncios"));
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  processBtn.addEventListener("click", () => {
    if (dataActiveSubtab === "anuncios") {
      const report = parseDataAnunciosConReporte(input.value);
      const newRows = report.validas.map((r) => ({ ...r, _id: generateDataRowId() }));
      const { data: merged, insertadas, actualizadas } = upsertDataAnunciosLote(newRows, dataAnuncios);
      dataAnuncios = ordenarDataAnuncios(merged);
      registrarAuditoria({
        modulo: "data",
        accion: insertadas > 0 && actualizadas === 0 ? "crear" : "editar",
        campo: "carga_anuncios",
        valorAnterior: null,
        valorNuevo: { insertadas, actualizadas, ignoradas: report.ignoradas },
        descripcion: `DATA anuncios: ${insertadas} insertadas, ${actualizadas} actualizadas`
      });
      input.value = "";
      close();
      const statusAn = document.getElementById("dataAnunciosStatus");
      const detailBtnAn = document.getElementById("openDataErrorDetailAnunciosBtn");
      ultimoDetalleCargaAnuncios = combinarDetalleCargaReport(report, []);
      const tieneDetalle = ultimoDetalleCargaAnuncios.length > 0;
      const statusTxt = `${report.filasLeidas} filas leídas | ${insertadas} insertadas | ${actualizadas} actualizadas | ${report.ignoradas} ignoradas.${tieneDetalle ? " Pulsa «Ver detalle de carga» para el motivo de cada fila." : ""} Se vincula a campañas únicas por ID Campaña.`;
      if (statusAn) statusAn.textContent = statusTxt;
      detailBtnAn?.classList.toggle("hidden", !tieneDetalle);
      persistDataState();
      renderTablaAnuncios();
      renderTablaCampañas();
      renderRelacionesDataList();
      refreshAdsReportFilterOptions();
      renderAdsReportModule();
      return;
    }

    const report = parseDataConReporte(input.value);
    const newRows = report.validas.map((r) => ({ ...r, _id: generateDataRowId() }));
    const { data: merged, insertadas, actualizadas, registrosInsertados } = upsertDataRowsLote(newRows, dataReal);
    const mergedSorted = ordenarPorFecha(merged);
    replaceCurrentTeamDataGeneralFromMerged(mergedSorted);
    const accionData =
      insertadas > 0 && actualizadas === 0 ? "crear" : actualizadas > 0 && insertadas === 0 ? "editar" : "editar";
    registrarAuditoria({
      modulo: "data",
      accion: accionData,
      campo: "carga_general",
      valorAnterior: null,
      valorNuevo: { insertadas, actualizadas, ignoradas: report.ignoradas },
      descripcion: `DATA general: ${insertadas} insertadas, ${actualizadas} actualizadas`
    });
    if (registrosInsertados.length) historialCargas.push({ registros: registrosInsertados, timestamp: new Date() });
    input.value = "";
    close();
    const detailBtnGen = document.getElementById("openDataErrorDetailGeneralBtn");
    const detalleCombinado = combinarDetalleCargaReport(report, []);
    ultimoDetalleCargaGeneral = detalleCombinado;
    const tieneDetalle = detalleCombinado.length > 0;
    const statusTxt = `${report.filasLeidas} filas leídas | ${insertadas} insertadas | ${actualizadas} actualizadas | ${report.ignoradas} ignoradas.${tieneDetalle ? " Pulsa «Ver detalle de carga» para el motivo de cada fila." : ""} Las campañas podrán vincularse desde el módulo RELACIONES.`;
    const notice = document.getElementById("dataGeneralLoadNotice");
    if (notice) {
      notice.textContent = statusTxt;
      notice.classList.toggle("hidden", !statusTxt.trim());
    }
    detailBtnGen?.classList.toggle("hidden", !tieneDetalle);
    refreshDataGeneralStatusBar();
    persistDataState();
    actualizarFiltrosCache();
    refreshFechaFiltersUI();
    renderTablaData();
    renderTablaCampañas();
    renderRelacionesDataList();
  });
}

function etiquetaTipoDetalleCarga(tipo) {
  if (tipo === "aviso") return "Aviso (sí se guardó)";
  if (tipo === "duplicado") return "Duplicado (histórico; ya no aplica con upsert)";
  return "No registrada";
}

function combinarDetalleCargaReport(report, duplicadosDetalle) {
  const out = [];
  (report.erroresDetalle || []).forEach((x) => out.push({ ...x, tipo: x.tipo || "error" }));
  (report.advertenciasDetalle || []).forEach((x) => out.push({ ...x, tipo: x.tipo || "aviso" }));
  (duplicadosDetalle || []).forEach((x) => out.push({ ...x, tipo: x.tipo || "duplicado" }));
  return out;
}

function showDataErrorModal(entries, opts = {}) {
  const modal = document.getElementById("dataErrorModal");
  const tbody = document.getElementById("dataErrorTbody");
  const titleEl = document.getElementById("dataErrorTitle");
  const introEl = document.getElementById("dataErrorIntro");
  if (!modal || !tbody) return;
  const title = opts.title || "Detalle de carga";
  if (titleEl) titleEl.textContent = title;
  const list = Array.isArray(entries) ? entries : [];
  if (introEl) {
    if (list.length) {
      introEl.classList.remove("hidden");
      introEl.textContent =
        "«No registrada»: la fila no se guardó. «Aviso»: se guardó corrigiendo valores (p. ej. 0 en numéricos). Las filas válidas con la misma clave (fecha + ID, etc.) se actualizan sin duplicar.";
    } else {
      introEl.classList.add("hidden");
      introEl.textContent = "";
    }
  }
  tbody.innerHTML = list.length
    ? list.map((err) => {
      const tipo = err.tipo || "error";
      const motivo = `${etiquetaTipoDetalleCarga(tipo)}: ${(err.errores || []).join(" ")}`;
      return `
    <tr>
      <td>${escapeHtml(String(err.fila ?? "—"))}</td>
      <td>${escapeHtml(motivo)}</td>
      <td>${escapeHtml(String(err.data ?? ""))}</td>
    </tr>
  `;
    }).join("")
    : `<tr><td colspan="3" class="dash-empty-mini">No hay filas con incidencias en la última carga.</td></tr>`;
  modal.classList.remove("hidden");
}

function initDataErrorModal() {
  const modal = document.getElementById("dataErrorModal");
  const closeBtn = document.getElementById("closeDataErrorBtn");
  if (!modal || !closeBtn) return;
  const close = () => modal.classList.add("hidden");
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.getElementById("openDataErrorDetailGeneralBtn")?.addEventListener("click", () => {
    showDataErrorModal(ultimoDetalleCargaGeneral || [], { title: "Detalle — Data general" });
  });
  document.getElementById("openDataErrorDetailAnunciosBtn")?.addEventListener("click", () => {
    showDataErrorModal(ultimoDetalleCargaAnuncios || [], { title: "Detalle — Data anuncios" });
  });
}

function ordenarDataAnuncios(rows) {
  return rows.slice().sort((a, b) => {
    const idCmp = String(a.idCampania || "").localeCompare(String(b.idCampania || ""), "es");
    if (idCmp !== 0) return idCmp;
    return String(a.nombreAnuncio || "").localeCompare(String(b.nombreAnuncio || ""), "es");
  });
}

/** HTML interno (solo vista) de la celda Link Anuncio. */
function getAnuncioLinkViewInnerHtml(row) {
  const linkRaw = readLinkAnuncioFromRow(row);
  const linkSafe = linkRaw ? adsReportCoerceHttpUrl(linkRaw) : "";
  const short = linkRaw.length > 48 ? `${linkRaw.slice(0, 48)}…` : linkRaw;
  if (linkSafe) {
    return `<a href="${escapeHtml(linkSafe)}" target="_blank" rel="noopener noreferrer" class="data-anuncio-link-a">${escapeHtml(short)}</a>`;
  }
  if (linkRaw) {
    return `<span class="data-anuncio-link-invalid" title="http o https no válido">${escapeHtml(short)}</span>`;
  }
  return `<span class="data-anuncio-link-empty">—</span>`;
}

function finishEditAnuncioLinkCell(td, rawValue, commit) {
  const id = td?.getAttribute("data-anuncio-link") || "";
  const row = dataAnuncios.find((r) => String(r._id) === id);
  if (!row) return;
  if (commit) {
    const trimmed = String(rawValue ?? "").trim();
    const coerced = adsReportCoerceHttpUrl(trimmed);
    row.linkAnuncio = coerced || trimmed;
    guardarData();
    try {
      refreshAdsReportFilterOptions();
      renderAdsReportModule();
    } catch (err) {
      console.warn(err);
    }
  }
  td.innerHTML = `<div class="data-anuncio-link-view">${getAnuncioLinkViewInnerHtml(row)}</div>`;
}

function beginEditAnuncioLinkCell(td) {
  if (!td || td.querySelector(".data-anuncio-link-input")) return;
  const id = td.getAttribute("data-anuncio-link") || "";
  const row = dataAnuncios.find((r) => String(r._id) === id);
  if (!row) return;
  const cur = String(row.linkAnuncio || "").trim();
  td.innerHTML =
    '<input type="text" class="data-anuncio-link-input" spellcheck="false" autocomplete="url" aria-label="Editar enlace del anuncio" placeholder="https://..." />';
  const inp = td.querySelector(".data-anuncio-link-input");
  if (!(inp instanceof HTMLInputElement)) return;
  inp.value = cur;
  inp.focus();
  inp.select();
  let finished = false;
  const cleanup = () => {
    inp.removeEventListener("keydown", onKey);
    inp.removeEventListener("blur", onBlur);
  };
  const onKey = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (finished) return;
      finished = true;
      cleanup();
      finishEditAnuncioLinkCell(td, inp.value, true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      if (finished) return;
      finished = true;
      cleanup();
      finishEditAnuncioLinkCell(td, cur, false);
    }
  };
  const onBlur = () => {
    if (finished) return;
    finished = true;
    cleanup();
    finishEditAnuncioLinkCell(td, cur, false);
  };
  inp.addEventListener("keydown", onKey);
  inp.addEventListener("blur", onBlur);
}

function renderTablaAnuncios() {
  const tbody = document.getElementById("dataAnunciosTbody");
  if (!tbody) return;
  const regCount = document.getElementById("dataAnunciosRegistrosCount");
  if (regCount) regCount.textContent = String(dataAnuncios.length);
  tbody.innerHTML = dataAnuncios.map((row) => {
    const linkCell = `<td class="data-anuncio-link-td" data-anuncio-link="${escapeHtml(String(row._id))}" title="Doble clic para editar el enlace"><div class="data-anuncio-link-view">${getAnuncioLinkViewInnerHtml(row)}</div></td>`;
    const est = normalizarEstadoAnuncio(row.estado);
    const rid = escapeHtml(String(row._id));
    const estadoCell = `<select class="data-anuncio-estado-select" data-anuncio-estado="${rid}" aria-label="Estado del anuncio">
      <option value="Activo"${est === "Activo" ? " selected" : ""}>Activo</option>
      <option value="Inactivo"${est === "Inactivo" ? " selected" : ""}>Inactivo</option>
    </select>`;
    return `
    <tr data-anuncio-id="${rid}" class="${selectedAnunciosIds.has(String(row._id)) ? "data-row-selected" : ""}">
      <td><input type="checkbox" data-anuncio-check="${rid}" ${selectedAnunciosIds.has(String(row._id)) ? "checked" : ""} /></td>
      <td>${escapeHtml(row.idCampania)}</td>
      <td>${escapeHtml(row.nombreCampana)}</td>
      <td>${escapeHtml(row.nombreAnuncio)}</td>
      <td>${formatNumberSmartData(Number(row.leads) || 0)}</td>
      <td>${formatCurrencyUSDData(Number(row.gasto) || 0)}</td>
      <td>${formatNumberSmartData(Number(row.impresiones) || 0)}</td>
      <td>${formatNumberSmartData(Number(row.alcance) || 0)}</td>
      <td>${formatNumberSmartData(Number(row.clics) || 0)}</td>
      <td>${estadoCell}</td>
      ${linkCell}
    </tr>
  `;
  }).join("");
}

async function eliminarFilasSeleccionadasAnuncios() {
  if (!selectedAnunciosIds.size) return;
  const ok = await showAppDialog({
    message: `¿Eliminar ${selectedAnunciosIds.size} registros de Anuncios?`,
    primaryText: "Confirmar",
    secondaryText: "Cancelar",
    primaryDanger: true
  });
  if (!ok) return;
  const ids = new Set(Array.from(selectedAnunciosIds).map((x) => String(x)));
  dataAnuncios = dataAnuncios.filter((r) => !ids.has(String(r._id)));
  selectedAnunciosIds = new Set();
  guardarData();
  renderTablaAnuncios();
  renderTablaCampañas();
  renderRelacionesDataList();
  refreshAdsReportFilterOptions();
  renderAdsReportModule();
}

function initDataFilters() {
  document.getElementById("uniqueSearch")?.addEventListener("input", () => renderTablaCampañas());
  document.getElementById("undoLastLoadBtn")?.addEventListener("click", deshacerUltimaCarga);
  document.getElementById("deleteSelectedDataBtn")?.addEventListener("click", eliminarFilasSeleccionadas);
  document.getElementById("deleteSelectedAnunciosBtn")?.addEventListener("click", eliminarFilasSeleccionadasAnuncios);
  document.getElementById("clearStorageBtn")?.addEventListener("click", limpiarSoloModuloData);
  document.getElementById("dataFiltersAdvancedBtn")?.addEventListener("click", () => {
    const wrap = document.getElementById("dataAdvFiltersWrap");
    const btn = document.getElementById("dataFiltersAdvancedBtn");
    if (!wrap || !btn) return;
    wrap.classList.toggle("hidden");
    const hid = wrap.classList.contains("hidden");
    wrap.setAttribute("aria-hidden", hid ? "true" : "false");
    btn.setAttribute("aria-expanded", hid ? "false" : "true");
  });

  const delayedFilter = debounce(() => renderTablaData(), 300);
  document.getElementById("dataFilterFechaMes")?.addEventListener("change", () => {
    dataGeneralPageIndex = 1;
    const mes = document.getElementById("dataFilterFechaMes")?.value || "";
    const daySel = document.getElementById("dataFilterFechaDia");
    if (!daySel) return;
    const days = mes ? (filtrosCache.fecha.daysByMonth.get(mes) || []) : [];
    daySel.innerHTML = `<option value="">Todos</option>` + days.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    renderTablaData();
  });
  document.getElementById("dataFilterFechaDia")?.addEventListener("change", () => {
    dataGeneralPageIndex = 1;
    renderTablaData();
  });
  document.getElementById("dataFilterIdInput")?.addEventListener("input", () => {
    dataGeneralPageIndex = 1;
    delayedFilter();
  });
  document.getElementById("dataFilterNombreInput")?.addEventListener("input", () => {
    dataGeneralPageIndex = 1;
    delayedFilter();
  });
  document.getElementById("dataPageSize")?.addEventListener("change", () => {
    dataGeneralPageIndex = 1;
    renderTablaData();
  });
  document.getElementById("dataPagePrev")?.addEventListener("click", () => {
    dataGeneralPageIndex -= 1;
    renderTablaData();
  });
  document.getElementById("dataPageNext")?.addEventListener("click", () => {
    dataGeneralPageIndex += 1;
    renderTablaData();
  });
  document.getElementById("dataTbody")?.addEventListener("change", (e) => {
    const input = e.target instanceof HTMLElement ? e.target.closest("input[data-data-check]") : null;
    if (!(input instanceof HTMLInputElement)) return;
    const id = input.getAttribute("data-data-check") || "";
    if (!id) return;
    if (input.checked) selectedDataIds.add(String(id));
    else selectedDataIds.delete(String(id));
    const tr = input.closest("tr");
    if (tr) tr.classList.toggle("data-row-selected", input.checked);
    refreshDataGeneralStatusBar();
  });
  document.getElementById("dataAnunciosTbody")?.addEventListener("change", (e) => {
    const sel = e.target;
    if (sel instanceof HTMLSelectElement && sel.matches("select[data-anuncio-estado]")) {
      const id = sel.getAttribute("data-anuncio-estado") || "";
      const row = dataAnuncios.find((r) => String(r._id) === id);
      if (row) {
        row.estado = sel.value === "Inactivo" ? "Inactivo" : "Activo";
        guardarData();
      }
      return;
    }
    const input = e.target instanceof HTMLElement ? e.target.closest("input[data-anuncio-check]") : null;
    if (!(input instanceof HTMLInputElement)) return;
    const id = input.getAttribute("data-anuncio-check") || "";
    if (!id) return;
    if (input.checked) selectedAnunciosIds.add(String(id));
    else selectedAnunciosIds.delete(String(id));
    const tr = input.closest("tr");
    if (tr) tr.classList.toggle("data-row-selected", input.checked);
  });
  const anunciosLinkTbody = document.getElementById("dataAnunciosTbody");
  if (anunciosLinkTbody && !anunciosLinkTbody.dataset.anuncioLinkDbl) {
    anunciosLinkTbody.dataset.anuncioLinkDbl = "1";
    anunciosLinkTbody.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td.data-anuncio-link-td");
      if (!td || td.querySelector(".data-anuncio-link-input")) return;
      if (e.target.closest("a.data-anuncio-link-a")) e.preventDefault();
      beginEditAnuncioLinkCell(td);
    });
  }
}

// REPORTE DE ANUNCIOS module
function adsReportSafeHttpUrl(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.href;
  } catch {
    return "";
  }
}

/**
 * Acepta URLs http(s) válidas y, si falta el esquema, prueba con https://
 * (p. ej. www.facebook.com/... o facebook.com/ads/...).
 */
function adsReportCoerceHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = adsReportSafeHttpUrl(raw);
  if (direct) return direct;
  if (/^(javascript|data|vbscript):/i.test(raw)) return "";
  if (!/^\S+$/.test(raw)) return "";
  let candidate = raw.replace(/^\/+/, "");
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  return adsReportSafeHttpUrl(candidate) || "";
}

/** Evita que `&` y otros caracteres en URLs largas corrompan el valor al leer `data-link`. */
function adsReportEncodeDataLinkAttr(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  return encodeURIComponent(u);
}

function adsReportDecodeDataLinkAttr(encoded) {
  const s = String(encoded ?? "").trim();
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeAdsThumbEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    const legacy = String(rawEntry || "").trim();
    return { thumbnail: legacy, original: legacy };
  }
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return { thumbnail: "", original: "" };
  }
  const thumbnail = String(rawEntry.thumbnail || "").trim();
  const original = String(rawEntry.original || "").trim() || thumbnail;
  return { thumbnail, original };
}

function loadAdsReportThumbsMap() {
  try {
    const raw = appMemoryKV.getItem(LS_ADS_REPORT_THUMBS);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const normalized = {};
    Object.entries(obj).forEach(([k, v]) => {
      normalized[k] = normalizeAdsThumbEntry(v);
    });
    return normalized;
  } catch {
    return {};
  }
}

function saveAdsReportThumbsMap(map) {
  try {
    const normalized = {};
    Object.entries(map || {}).forEach(([k, v]) => {
      normalized[k] = normalizeAdsThumbEntry(v);
    });
    appMemoryKV.setItem(LS_ADS_REPORT_THUMBS, JSON.stringify(normalized));
  } catch (err) {
    console.warn("No se pudo guardar miniaturas del reporte de anuncios", err);
  }
}

function getAdsThumbPlaceholderHtml() {
  return `
    <span class="ads-preview-placeholder ads-preview-placeholder-icon" aria-hidden="true">🖼️</span>
    <span class="ads-preview-placeholder ads-preview-placeholder-text">Sin imagen</span>
  `;
}

function renderAdsThumbModalPreview(dataUrl) {
  const preview = document.getElementById("adsThumbModalPreview");
  if (!preview) return;
  if (dataUrl) {
    preview.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="Vista previa del anuncio" loading="lazy" decoding="async" />`;
    return;
  }
  preview.innerHTML = getAdsThumbPlaceholderHtml();
}

function closeAdsThumbModal() {
  const modal = document.getElementById("adsThumbModal");
  const fileInput = document.getElementById("adsThumbFileInput");
  const saveBtn = document.getElementById("adsThumbModalSaveBtn");
  modal?.classList.add("hidden");
  if (fileInput instanceof HTMLInputElement) fileInput.value = "";
  if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
  adsThumbModalState = {
    aggregateKey: "",
    existingThumbnail: "",
    existingOriginal: "",
    pendingThumbnail: "",
    pendingOriginal: "",
  };
}

function openAdsThumbModal(aggregateKey) {
  const modal = document.getElementById("adsThumbModal");
  const fileInput = document.getElementById("adsThumbFileInput");
  const saveBtn = document.getElementById("adsThumbModalSaveBtn");
  if (!modal) return;
  const key = String(aggregateKey || "").trim();
  if (!key) return;
  const thumbs = loadAdsReportThumbsMap();
  const existingEntry = normalizeAdsThumbEntry(thumbs[key]);
  adsThumbModalState = {
    aggregateKey: key,
    existingThumbnail: existingEntry.thumbnail,
    existingOriginal: existingEntry.original,
    pendingThumbnail: "",
    pendingOriginal: "",
  };
  renderAdsThumbModalPreview(existingEntry.original || existingEntry.thumbnail);
  if (fileInput instanceof HTMLInputElement) fileInput.value = "";
  if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
  modal.classList.remove("hidden");
}

function getAdsPreviewHoverEl() {
  let el = document.getElementById("adsPreviewHover");
  if (el) return el;
  el = document.createElement("div");
  el.id = "adsPreviewHover";
  el.className = "preview-hover hidden";
  document.body.appendChild(el);
  return el;
}

function hideAdsPreviewHover() {
  const hover = document.getElementById("adsPreviewHover");
  if (hover) {
    hover.classList.add("hidden");
    hover.innerHTML = "";
  }
}

function cancelAdsPreviewHoverTimer() {
  if (adsPreviewHoverTimer != null) {
    clearTimeout(adsPreviewHoverTimer);
    adsPreviewHoverTimer = null;
  }
}

function scheduleAdsPreviewHover(anchor) {
  cancelAdsPreviewHoverTimer();
  hideAdsPreviewHover();
  const src = String(anchor?.getAttribute("data-preview-src") || anchor?.getAttribute("data-thumb-src") || "").trim();
  if (!src) return;
  adsPreviewHoverAnchor = anchor;
  adsPreviewHoverTimer = setTimeout(() => {
    if (adsPreviewHoverAnchor !== anchor) return;
    const safeSrc = String(anchor.getAttribute("data-preview-src") || anchor.getAttribute("data-thumb-src") || "").trim();
    if (!safeSrc) return;
    const hover = getAdsPreviewHoverEl();
    hover.innerHTML = `<img src="${escapeHtml(safeSrc)}" alt="Vista ampliada del anuncio" loading="lazy" decoding="async" />`;
    hover.classList.remove("hidden");
    const rect = anchor.getBoundingClientRect();
    const pageLeft = window.scrollX + rect.left;
    const pageTop = window.scrollY + rect.top;
    hover.style.left = `${pageLeft + rect.width + 12}px`;
    hover.style.top = `${Math.max(window.scrollY + 10, pageTop - 8)}px`;
  }, ADS_REPORT_PREVIEW_HOVER_DELAY_MS);
}

function initAdsThumbModal() {
  const modal = document.getElementById("adsThumbModal");
  const fileInput = document.getElementById("adsThumbFileInput");
  const cancelBtn = document.getElementById("adsThumbModalCancelBtn");
  const saveBtn = document.getElementById("adsThumbModalSaveBtn");
  if (!modal || !(fileInput instanceof HTMLInputElement) || !(saveBtn instanceof HTMLButtonElement)) return;
  if (modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  cancelBtn?.addEventListener("click", closeAdsThumbModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeAdsThumbModal();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const thumbnail = await compressImageFileToDataUrlMaxBytes(file, ADS_REPORT_THUMB_MAX_BYTES, 120);
      const original = await compressImageFileToDataUrlMaxBytes(file, ADS_REPORT_ORIGINAL_MAX_BYTES, 1400);
      adsThumbModalState.pendingThumbnail = thumbnail;
      adsThumbModalState.pendingOriginal = original;
      renderAdsThumbModalPreview(original);
      saveBtn.disabled = false;
    } catch (err) {
      void showAppDialog({
        message: err?.message || "No se pudo procesar la imagen.",
        primaryText: "Entendido",
        showSecondary: false
      });
    }
    fileInput.value = "";
  });

  saveBtn.addEventListener("click", () => {
    const key = String(adsThumbModalState.aggregateKey || "").trim();
    const thumbnail = String(adsThumbModalState.pendingThumbnail || "").trim();
    const original = String(adsThumbModalState.pendingOriginal || "").trim();
    if (!key || !thumbnail || !original) {
      void showAppDialog({
        message: "Selecciona una imagen antes de guardar.",
        primaryText: "Entendido",
        showSecondary: false
      });
      return;
    }
    const map = loadAdsReportThumbsMap();
    map[key] = { thumbnail, original };
    saveAdsReportThumbsMap(map);
    closeAdsThumbModal();
    renderAdsReportModule();
  });
}

function compressImageFileToDataUrlMaxBytes(file, maxBytes = ADS_REPORT_THUMB_MAX_BYTES, initialMaxSide = 120) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("img"));
      img.onload = () => {
        let maxSide = Math.max(20, Number(initialMaxSide) || 120);
        for (let attempt = 0; attempt < 22; attempt += 1) {
          const largestSide = Math.max(img.naturalWidth, img.naturalHeight, 1);
          const scale = maxSide / largestSide;
          const w = Math.max(1, Math.round(img.naturalWidth * Math.min(1, scale)));
          const h = Math.max(1, Math.round(img.naturalHeight * Math.min(1, scale)));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("canvas"));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          let q = 0.9 - attempt * 0.035;
          if (q < 0.12) q = 0.12;
          const dataUrl = canvas.toDataURL("image/jpeg", q);
          const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
          if (approxBytes <= maxBytes) {
            resolve(dataUrl);
            return;
          }
          maxSide = Math.round(maxSide * 0.8);
          if (maxSide < 20) {
            reject(new Error("size"));
            return;
          }
        }
        reject(new Error("size"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function resolveProgramaForAnuncio(r) {
  const id = String(r?.idCampania || "").trim();
  if (id && Array.isArray(relaciones) && relaciones.length) {
    const hit = relaciones.find((x) => String(x.idCampania || "").trim() === id);
    if (hit) {
      const rec = planningDraftRecords().find((x) => planningKeyFromRecord(x) === hit.planningKey);
      const p = String(rec?.programa || "").trim();
      if (p) return p;
    }
  }
  const nombreCampana = String(r?.nombreCampana || "");
  for (const rec of planningDraftRecords()) {
    if (
      dataRowMatchesPlanningContext({ nombre: nombreCampana }, rec.programa, rec.tracking, rec.plataforma)
    ) {
      return String(rec.programa || "").trim();
    }
  }
  return "";
}

function aggregateAdsReportFromDataAnuncios() {
  const tipoF = (document.getElementById("adsReportFilterTipo")?.value || "").trim().toLowerCase();
  const progF = (document.getElementById("adsReportFilterPrograma")?.value || "").trim();
  const map = new Map();
  const filas = (dataAnuncios || []).map((a) => ({
    ...a,
    linkAnuncio: readLinkAnuncioFromRow(a)
  }));
  filas.forEach((r) => {
    const programa = resolveProgramaForAnuncio(r);
    if (progF && String(programa || "") !== progF) return;
    const tipoRow = String(r.tipoAnuncio || "").trim().toLowerCase();
    if (tipoF && tipoRow !== tipoF) return;
    const key = `${String(r.idCampania || "").trim()}||${String(r.nombreAnuncio || "").trim()}||${tipoRow}`;
    if (!map.has(key)) {
      map.set(key, {
        aggregateKey: key,
        nombreAnuncio: String(r.nombreAnuncio || "").trim(),
        programa: String(programa || "").trim(),
        nombreCampana: String(r.nombreCampana || "").trim(),
        gasto: 0,
        leads: 0,
        impresiones: 0,
        alcance: 0,
        clics: 0,
        linkAnuncio: ""
      });
    }
    const a = map.get(key);
    if (programa && !a.programa) a.programa = String(programa).trim();
    a.gasto += Number(r.gasto) || 0;
    a.leads += Number(r.leads) || 0;
    a.impresiones += Number(r.impresiones) || 0;
    a.alcance += Number(r.alcance) || 0;
    a.clics += Number(r.clics) || 0;
    const raw = String(r.linkAnuncio || "").trim();
    if (raw && !String(a.linkAnuncio || "").trim()) {
      const resolved = adsReportCoerceHttpUrl(raw) || raw;
      a.linkAnuncio = resolved;
    }
  });
  return Array.from(map.values()).map((a) => {
    const imp = Number(a.impresiones) || 0;
    const cli = Number(a.clics) || 0;
    const alc = Number(a.alcance) || 0;
    const leads = Number(a.leads) || 0;
    const gasto = Number(a.gasto) || 0;
    const ctr = imp > 0 ? (cli / imp) * 100 : 0;
    const cpl = leads > 0 ? gasto / leads : Number.POSITIVE_INFINITY;
    const freq = alc > 0 ? imp / alc : 0;
    return { ...a, ctr, cpl, freq };
  });
}

function adsReportGetSortedAggregates(rows) {
  const dir = adsReportSort.dir === "asc" ? 1 : -1;
  const arr = rows.slice();
  arr.sort((a, b) => {
    let va;
    let vb;
    if (adsReportSort.field === "leads") {
      va = a.leads;
      vb = b.leads;
    } else if (adsReportSort.field === "gasto") {
      va = a.gasto;
      vb = b.gasto;
    } else if (adsReportSort.field === "ctr") {
      va = a.ctr;
      vb = b.ctr;
    } else {
      va = a.cpl;
      vb = b.cpl;
    }
    if (va === vb) return String(a.nombreAnuncio || "").localeCompare(String(b.nombreAnuncio || ""), "es");
    return (va - vb) * dir;
  });
  return arr;
}

function adsReportFormatPct(n) {
  if (!Number.isFinite(n)) return "0%";
  return `${Number(n.toFixed(2))}%`;
}

function refreshAdsReportFilterOptions() {
  const selPrograma = document.getElementById("adsReportFilterPrograma");
  if (!selPrograma) return;
  const progCurrent = selPrograma.value;
  const programas = Array.from(new Set(planningDraftRecords().map((r) => String(r.programa || "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
  selPrograma.innerHTML = `<option value="">Todos</option>${programas.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}`;
  if (programas.includes(progCurrent)) selPrograma.value = progCurrent;
}

function adsReportGetCplClass(cpl, rows) {
  if (!Number.isFinite(cpl)) return "";
  const values = (rows || [])
    .map((r) => ((Number(r.leads) || 0) > 0 ? (Number(r.gasto) || 0) / (Number(r.leads) || 0) : null))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length >= 3) {
    const low = values[Math.floor((values.length - 1) * 0.33)];
    const high = values[Math.floor((values.length - 1) * 0.66)];
    if (cpl <= low) return "ads-cpl-low";
    if (cpl <= high) return "ads-cpl-medium";
    return "ads-cpl-high";
  }
  if (cpl <= 15) return "ads-cpl-low";
  if (cpl <= 35) return "ads-cpl-medium";
  return "ads-cpl-high";
}

function renderAdsReportTabla(rows) {
  const tbody = document.getElementById("adsReportTbody");
  if (!tbody) return;
  const thumbs = loadAdsReportThumbsMap();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="ads-empty-row"><td colspan="10">No hay datos. Carga desde DATA → Anuncios o ajusta los filtros.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const cpl = Number.isFinite(row.cpl) && row.cpl !== Number.POSITIVE_INFINITY ? row.cpl : 0;
    const cplClass = adsReportGetCplClass(cpl, rows);
    const thumbEntry = normalizeAdsThumbEntry(thumbs[row.aggregateKey]);
    const thumbnail = thumbEntry.thumbnail;
    const previewOriginal = thumbEntry.original || thumbnail;
    const linkRaw = readLinkAnuncioFromRow(row) || String(row.linkAnuncio || "").trim();
    console.log("[Reporte anuncios] row.linkAnuncio", row.nombreAnuncio, linkRaw);
    const linkUrl = adsReportCoerceHttpUrl(linkRaw) || linkRaw;
    const linkAttr = adsReportEncodeDataLinkAttr(linkUrl);
    const thumbBlock = thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="Miniatura del anuncio" loading="lazy" decoding="async" />` : getAdsThumbPlaceholderHtml();
    const aggKeyAttr = escapeHtml(row.aggregateKey);
    const thumbAttr = escapeHtml(thumbnail || "");
    const previewAttr = escapeHtml(previewOriginal || "");
    return `
      <tr data-ads-agg="${aggKeyAttr}">
        <td class="col-anuncio">
          <div class="ads-report-anuncio-cell">
            <div class="preview-anuncio ads-thumb-trigger" data-ads-agg="${aggKeyAttr}" data-thumb-src="${thumbAttr}" data-preview-src="${previewAttr}">${thumbBlock}</div>
            <button type="button" class="ads-ver-anuncio-btn" data-link="${linkAttr}">Ver anuncio</button>
            <div class="data-subtitle nombre-anuncio" style="margin:0;font-size:0.72rem;">${escapeHtml(row.nombreAnuncio || "")}</div>
          </div>
        </td>
        <td>${escapeHtml(row.programa || "—")}</td>
        <td>${formatCurrencyUSDData(Number(row.gasto) || 0) || "$0"}</td>
        <td class="${cplClass}">${Number(row.leads) > 0 ? formatCurrencyUSDData(cpl) : "—"}</td>
        <td>${formatNumberSmartData(Number(row.leads) || 0)}</td>
        <td>${formatNumberSmartData(Number(row.impresiones) || 0)}</td>
        <td>${formatNumberSmartData(Number(row.alcance) || 0)}</td>
        <td>${formatNumberSmartData(Number(row.clics) || 0)}</td>
        <td>${adsReportFormatPct(row.ctr)}</td>
        <td>${Number(row.alcance) > 0 ? formatNumberSmartData(row.freq) : "—"}</td>
      </tr>
    `;
  }).join("");
}

function renderAdsReportModule() {
  const agg = aggregateAdsReportFromDataAnuncios();
  adsReportFiltrada = adsReportGetSortedAggregates(agg);
  renderAdsReportTabla(adsReportFiltrada);
}

function setAdsSort(field) {
  if (adsReportSort.field === field) {
    adsReportSort.dir = adsReportSort.dir === "asc" ? "desc" : "asc";
  } else {
    adsReportSort.field = field;
    adsReportSort.dir = field === "cpl" ? "asc" : "desc";
  }
  renderAdsReportModule();
}

function initAdsReportModule() {
  document.getElementById("adsReportFilterTipo")?.addEventListener("change", () => renderAdsReportModule());
  document.getElementById("adsReportFilterPrograma")?.addEventListener("change", () => renderAdsReportModule());
  initAdsThumbModal();

  const tbody = document.getElementById("adsReportTbody");
  if (tbody && !tbody.dataset.adsDelegated) {
    tbody.dataset.adsDelegated = "1";
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest(".ads-ver-anuncio-btn");
      if (!btn) return;
      const url = adsReportDecodeDataLinkAttr(btn.getAttribute("data-link")).trim();
      console.log("[Reporte anuncios] Ver anuncio click linkAnuncio", url);
      if (url) {
        const toOpen = adsReportCoerceHttpUrl(url) || adsReportSafeHttpUrl(url);
        if (toOpen) window.open(toOpen, "_blank", "noopener,noreferrer");
        else void showAppDialog({ message: "No hay link disponible", primaryText: "Entendido", showSecondary: false });
      } else {
        void showAppDialog({ message: "No hay link disponible", primaryText: "Entendido", showSecondary: false });
      }
    });

    tbody.addEventListener("dblclick", (e) => {
      const trigger = e.target instanceof Element ? e.target.closest(".ads-thumb-trigger") : null;
      if (!trigger) return;
      const key = String(trigger.getAttribute("data-ads-agg") || "").trim();
      if (!key) return;
      openAdsThumbModal(key);
    });

    tbody.addEventListener("mouseover", (e) => {
      const trigger = e.target instanceof Element ? e.target.closest(".ads-thumb-trigger") : null;
      if (!trigger) return;
      const related = e.relatedTarget;
      if (related instanceof Node && trigger.contains(related)) return;
      scheduleAdsPreviewHover(trigger);
    });

    tbody.addEventListener("mouseout", (e) => {
      const trigger = e.target instanceof Element ? e.target.closest(".ads-thumb-trigger") : null;
      if (!trigger) return;
      const related = e.relatedTarget;
      if (related instanceof Node && trigger.contains(related)) return;
      cancelAdsPreviewHoverTimer();
      adsPreviewHoverAnchor = null;
      hideAdsPreviewHover();
    });

    window.addEventListener("scroll", hideAdsPreviewHover, true);
    window.addEventListener("resize", hideAdsPreviewHover);
  }

  document.getElementById("adsSortLeads")?.addEventListener("click", () => setAdsSort("leads"));
  document.getElementById("adsSortCpl")?.addEventListener("click", () => setAdsSort("cpl"));
  document.getElementById("adsSortCtr")?.addEventListener("click", () => setAdsSort("ctr"));
  document.getElementById("adsSortGasto")?.addEventListener("click", () => setAdsSort("gasto"));

  refreshAdsReportFilterOptions();
  renderAdsReportModule();
}

// —— CRM Import ——
function crmNormalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Texto visible o de campaña: convierte Q1…Q4 (y variantes) a Intake 1…4 como en Planning.
 */
function crmNormalizeQuarterTokensToPlanningIntake(text) {
  let s = String(text ?? "");
  s = s.replace(/\bQ\s*([1-4])\b/gi, (_, n) => `Intake ${n}`);
  s = s.replace(/\bQuarter\s*([1-4])\b/gi, (_, n) => `Intake ${n}`);
  s = s.replace(/\bTrim(?:estre)?\s*([1-4])\b/gi, (_, n) => `Intake ${n}`);
  return s.trim();
}

/**
 * Celda intake aislada (p. ej. "Q1", "q 2") → "Intake 1"…"Intake 4".
 */
function crmNormalizeIntakeCellValue(val) {
  const t = String(val ?? "").trim();
  if (!t) return "";
  const tl = t.toLowerCase().replace(/\s+/g, " ").trim();
  const m = tl.match(/^q\s*([1-4])$/i);
  if (m) return `Intake ${m[1]}`;
  const m2 = tl.match(/^quarter\s*([1-4])$/i);
  if (m2) return `Intake ${m2[1]}`;
  const m3 = tl.match(/^trim(?:estre)?\s*([1-4])$/i);
  if (m3) return `Intake ${m3[1]}`;
  return t;
}

/** Columna FuenteVF del Excel → mismo tracking que Planning (Leadgen | Pixel | Google). */
function crmNormalizedTrafficFromFuenteVF(raw) {
  const n = normalizarTexto(String(raw ?? ""));
  if (!n) return "";
  if (n.includes("link") && n.includes("ads")) return "Pixel";
  if (
    (n.includes("lead") && n.includes("ads")) ||
    (n.includes("lead") && n.includes("gen")) ||
    (n.includes("meta") && n.includes("lead") && !n.includes("link"))
  )
    return "Leadgen";
  if (n.includes("google") || n.includes("search")) return "Google";
  return "";
}

/** Divide columna Flujo "DI | Nombre programa" como en Planning. */
function crmSplitFlujoTipoPrograma(flujoRaw) {
  const s = crmNormalizeQuarterTokensToPlanningIntake(String(flujoRaw ?? "").trim());
  if (!s) return { tipo: "", programa: "" };
  const ix = s.indexOf("|");
  if (ix < 0) return { tipo: "", programa: s };
  return { tipo: s.slice(0, ix).trim(), programa: s.slice(ix + 1).trim() };
}

/** Línea legible tipo Planning: TIPO | PROGRAMA | Intake X | Tracking */
function crmComposeDisplayDimensional(tipo, programa, intake, crmTrafficType) {
  const bits = [tipo, programa, intake, crmTrafficType].map((x) => String(x ?? "").trim()).filter(Boolean);
  return bits.join(" | ");
}

/**
 * Migra `crmKey` históricas (`normalizarTexto` con " q1 " / "q1") hacia "intake 1" alineado con Planning.
 */
function crmMigrateNormalizedQuarterCrmKey(normKey) {
  const s = String(normKey || "").trim();
  if (!s) return s;
  return s.replace(/\bq\s*([1-4])\b/g, (_, n) => `intake ${n}`).replace(/\s+/g, " ").trim();
}

/** Cantidad de la columna Lead del Excel CRM (entero ≥ 0; sin columna → 1 por fila). */
function crmParseLeadCountFromCell(val, hasLeadCol) {
  if (!hasLeadCol) return 1;
  if (val === null || val === undefined) return 0;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 0 ? Math.round(val) : 0;
  }
  const s = String(val).trim();
  if (!s) return 0;
  const n = limpiarNumero(val);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  if (crmParseBoolish(val)) return 1;
  return 0;
}

/** Valores tipo checkbox / binarios en import CRM. */
function crmParseBoolish(val) {
  if (val === true || val === 1) return true;
  if (typeof val === "number" && Number.isFinite(val)) return val !== 0;
  const s = String(val ?? "").trim().toLowerCase();
  if (!s) return false;
  if (
    s === "1" ||
    s === "s" ||
    s === "si" ||
    s === "sí" ||
    s === "yes" ||
    s === "y" ||
    s === "true" ||
    s === "x" ||
    s === "verdadero"
  )
    return true;
  return false;
}

/** Puntúa cada columna; gana la de mayor score por campo. */
function crmDetectColumnMap(headers) {
  const map = {
    nombre: -1,
    fecha: -1,
    email: -1,
    telefono: -1,
    lead: -1,
    interesado: -1,
    postulante: -1,
    matriculado: -1,
    intervaloGestion: -1,
    fuente: -1,
    intakeCol: -1,
    horaIngreso: -1,
    horaGestion: -1,
    tiempoTranscurrido: -1
  };
  const nombreScore = new Array(headers.length).fill(0);
  const fechaScore = new Array(headers.length).fill(0);
  const emailScore = new Array(headers.length).fill(0);
  const telScore = new Array(headers.length).fill(0);
  const leadScore = new Array(headers.length).fill(0);
  const interesadoScore = new Array(headers.length).fill(0);
  const postulanteScore = new Array(headers.length).fill(0);
  const matriculadoScore = new Array(headers.length).fill(0);
  const intervaloScore = new Array(headers.length).fill(0);
  const fuenteScore = new Array(headers.length).fill(0);
  const intakeColScore = new Array(headers.length).fill(0);
  const horaIngresoScore = new Array(headers.length).fill(0);
  const horaGestionScore = new Array(headers.length).fill(0);
  const tiempoScore = new Array(headers.length).fill(0);

  headers.forEach((h, i) => {
    const n = crmNormalizeHeader(h);
    if (!n) return;
    if (n === "flujo") nombreScore[i] = Math.max(nombreScore[i], 100);
    else if (n.includes("flujo")) nombreScore[i] = Math.max(nombreScore[i], 95);
    else if (n === "utm camp" || n === "utm campana" || n === "utm campaign") nombreScore[i] = Math.max(nombreScore[i], 88);
    else if (n.includes("utm camp") || n.includes("utm campana")) nombreScore[i] = Math.max(nombreScore[i], 85);
    else if (n.includes("campana") || n.includes("campaign")) nombreScore[i] = Math.max(nombreScore[i], 80);
    else if (n === "programa" || n.includes("programa")) nombreScore[i] = Math.max(nombreScore[i], 75);
    else if (n === "nombre" || n.includes("nombre campana")) nombreScore[i] = Math.max(nombreScore[i], 70);
    else if (n.includes("fuente") && !n.includes("vf")) nombreScore[i] = Math.max(nombreScore[i], 55);

    if (n === "fecha ingreso") fechaScore[i] = Math.max(fechaScore[i], 110);
    else if (n.includes("fecha ingreso")) fechaScore[i] = Math.max(fechaScore[i], 100);
    else if (n.includes("fecha")) fechaScore[i] = Math.max(fechaScore[i], 85);
    else if (n.includes("ingreso") && !n.includes("interesado")) fechaScore[i] = Math.max(fechaScore[i], 70);
    else if (n.includes("date") || n.includes("created")) fechaScore[i] = Math.max(fechaScore[i], 65);

    if (n.includes("email") || n.includes("correo")) emailScore[i] = Math.max(emailScore[i], 90);
    else if (n === "lead" || n.includes("lead")) emailScore[i] = Math.max(emailScore[i], 40);

    if (n.includes("telefono") || n.includes("phone") || n.includes("celular") || n.includes("movil")) {
      telScore[i] = Math.max(telScore[i], 90);
    }

    if (n === "lead") leadScore[i] = Math.max(leadScore[i], 100);
    else if (n.startsWith("lead ")) leadScore[i] = Math.max(leadScore[i], 85);

    if (n === "interesado" || n.includes("interesado")) interesadoScore[i] = Math.max(interesadoScore[i], 100);
    if (n === "postulante" || n.includes("postulante")) postulanteScore[i] = Math.max(postulanteScore[i], 100);
    if (n === "ganado" || n.includes("ganado")) matriculadoScore[i] = Math.max(matriculadoScore[i], 100);
    else if ((n === "matriculado" || n.includes("matricul")) && !n.includes("meta")) {
      matriculadoScore[i] = Math.max(matriculadoScore[i], 95);
    }

    if (n.includes("intervalo") && n.includes("gestion")) intervaloScore[i] = Math.max(intervaloScore[i], 100);
    else if (n === "intervalo_gestion" || n.includes("intervalo gestion")) intervaloScore[i] = Math.max(intervaloScore[i], 95);

    if (n === "fuentevf" || n.includes("fuentevf")) fuenteScore[i] = Math.max(fuenteScore[i], 100);
    else if (n.includes("fuente vf")) fuenteScore[i] = Math.max(fuenteScore[i], 95);
    else if (n === "fuente" || n.startsWith("fuente ")) fuenteScore[i] = Math.max(fuenteScore[i], 70);

    if (n === "intake") intakeColScore[i] = Math.max(intakeColScore[i], 100);
    else if (n.includes("intake")) intakeColScore[i] = Math.max(intakeColScore[i], 90);
    else if (n.includes("trimestre")) intakeColScore[i] = Math.max(intakeColScore[i], 85);
    else if (n.includes("quarter")) intakeColScore[i] = Math.max(intakeColScore[i], 85);

    if (n === "hora ingreso" || (n.includes("hora") && n.includes("ingreso") && !n.includes("fecha"))) {
      horaIngresoScore[i] = Math.max(horaIngresoScore[i], n === "hora ingreso" ? 100 : 90);
    }
    if (n.includes("grestion") || n.includes("grestión") || (n.includes("hora") && n.includes("gestion") && !n.includes("ingreso"))) {
      horaGestionScore[i] = Math.max(horaGestionScore[i], 100);
    }
    if ((n.includes("tiempo") && n.includes("transcurr")) || (n.includes("minutos") && n.includes("transcurr"))) {
      tiempoScore[i] = Math.max(tiempoScore[i], 100);
    } else if (n.includes("tiempo transcurr") || n === "minutos") {
      tiempoScore[i] = Math.max(tiempoScore[i], 85);
    }
  });

  const pickBest = (scores) => {
    let best = -1;
    let bestScore = 0;
    scores.forEach((s, i) => {
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    return bestScore > 0 ? best : -1;
  };

  map.nombre = pickBest(nombreScore);
  map.fecha = pickBest(fechaScore);
  map.email = pickBest(emailScore);
  map.telefono = pickBest(telScore);
  map.lead = pickBest(leadScore);
  map.interesado = pickBest(interesadoScore);
  map.postulante = pickBest(postulanteScore);
  map.matriculado = pickBest(matriculadoScore);
  map.intervaloGestion = pickBest(intervaloScore);
  map.fuente = pickBest(fuenteScore);
  map.intakeCol = pickBest(intakeColScore);
  map.horaIngreso = pickBest(horaIngresoScore);
  map.horaGestion = pickBest(horaGestionScore);
  map.tiempoTranscurrido = pickBest(tiempoScore);

  if (map.nombre < 0) {
    let fallback = nombreScore.findIndex((s) => s > 0);
    if (fallback < 0 && headers.length) {
      const skipDateLike = headers.findIndex((h, i) => {
        const nn = crmNormalizeHeader(h);
        return nn && !nn.includes("fecha") && !nn.includes("date");
      });
      fallback = skipDateLike >= 0 ? skipDateLike : 0;
    }
    map.nombre = fallback;
  }
  return map;
}

function crmFindHeaderRowIndex(matrix) {
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i];
    if (!row?.length) continue;
    const norms = row.map((c) => crmNormalizeHeader(c));
    const hasFlujo = norms.some((n) => n === "flujo" || n.includes("flujo"));
    const hasFecha = norms.some((n) => n.includes("fecha") || n.includes("ingreso"));
    const hasCamp = norms.some(
      (n) => n.includes("camp") || n.includes("utm") || n.includes("programa") || n.includes("flujo")
    );
    if (hasFlujo || (hasFecha && hasCamp)) return i;
    if (norms.filter(Boolean).length >= 3 && (hasFecha || hasCamp)) return i;
  }
  return 0;
}

/** Excel / CSV: tiempo en minutos (número o texto). */
function crmParseTiempoMinutosCell(val) {
  if (val == null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const raw = String(val).trim().replace(",", ".");
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return String(val).trim();
}

/**
 * Hora en celda (fracción Excel del día, Date, "HH:MM", número < 1 como string) → "HH:MM" para claves y persistencia.
 */
function crmFormatTimeCellToHhMm(val) {
  if (val == null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val)) {
    if (val > 0 && val < 1) {
      const totalMin = Math.round(val * 24 * 60);
      const h = Math.floor(totalMin / 60) % 24;
      const m = ((totalMin % 60) + 60) % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return `${String(val.getHours()).padStart(2, "0")}:${String(val.getMinutes()).padStart(2, "0")}`;
  }
  const s = String(val).trim();
  const num = Number(s.replace(",", "."));
  if (Number.isFinite(num) && num > 0 && num < 1) {
    const totalMin = Math.round(num * 24 * 60);
    const h = Math.floor(totalMin / 60) % 24;
    const m = ((totalMin % 60) + 60) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const hm = s.match(/\b(\d{1,2})[.:](\d{2})\b/);
  if (hm) {
    const hh = Math.min(23, Math.max(0, Number(hm[1])));
    const mm = Math.min(59, Math.max(0, Number(hm[2])));
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return s.replace(/\s+/g, " ").trim();
}

/** CRM/Excel: día civil estable en hora local (mediodía evita cruces UTC/DST al filtrar o agrupar). */
function crmNormalizeCalendarDateLocalNoon(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
}

/**
 * Serial Excel (días 1899-12-30, entero) → mismo día civil que el número almacenado,
 * como mediodía local. Evita `new Date(ms)` directo sobre el epoch serial (desfase por TZ).
 */
function crmExcelSerialToCalendarDateLocalNoon(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const dayIndex = Math.floor(n);
  if (dayIndex < 20000 || dayIndex > 80000) return null;
  const utcMs = Math.round((dayIndex - 25569) * 86400 * 1000);
  const probe = new Date(utcMs);
  if (Number.isNaN(probe.getTime())) return null;
  const y = probe.getUTCFullYear();
  const mo = probe.getUTCMonth();
  const da = probe.getUTCDate();
  return new Date(y, mo, da, 12, 0, 0);
}

/** Primer día del mes local (clave repo `yyyy/mm`) como mediodía — solo respaldo si falta fecha en fila. */
function crmDateFromMonthKeyDay1(mk) {
  const parts = String(mk ?? "")
    .trim()
    .split("/");
  if (parts.length !== 2) return null;
  const y = Number(parts[0]);
  const mo = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  return crmNormalizeCalendarDateLocalNoon(new Date(y, mo - 1, 1));
}

/** Parte fraccional de un serial JS/Excel estable en [0,1). */
function crmFractionalDayClamp(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  let f = n - Math.floor(n);
  if (f < 0) f += 1;
  if (f >= 1 - 1e-12 || f <= 1e-12) return 0;
  return f;
}

/** Hora desde fracción de día con redondeo a minuto ("HH:mm" o ""). */
function crmHhMmFromFractionOfDay(fr) {
  const frac = crmFractionalDayClamp(fr);
  if (frac == null || frac <= 0) return "";
  const totalMin = Math.round((frac <= 1 ? frac : frac % 1) * 24 * 60);
  if (!Number.isFinite(totalMin) || totalMin <= 0) return "";
  const h = Math.floor(totalMin / 60) % 24;
  const m = ((totalMin % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * DD/MM/Y[Y] opcionalmente con HH:mm (o DD-MM, etc.) desde string.
 * @returns {{ d: Date, hhmm?: string } | null}
 */
function crmTryParseDdMmYyAndOptionalHm(s0) {
  const sRaw = String(s0 ?? "").trim().replace(/\s+/g, " ");
  let s = sRaw;
  let hmFromTail = "";
  const tailHm = s.match(/\s+(\d{1,2})[:.](\d{2})\s*$/);
  if (tailHm) {
    const hh = Math.min(23, Math.max(0, Number(tailHm[1])));
    const mm = Math.min(59, Math.max(0, Number(tailHm[2])));
    hmFromTail = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    s = s.slice(0, s.length - tailHm[0].length).trimEnd();
  }
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!dmy) return null;
  let da = Number(dmy[1]);
  let mo = Number(dmy[2]);
  let y = Number(dmy[3]);
  if (y < 100) y += 2000;
  if (mo > 12 && da <= 12) {
    const tmp = da;
    da = mo;
    mo = tmp;
  }
  const dtNoon = new Date(y, mo - 1, da, 12, 0, 0);
  if (dtNoon.getFullYear() !== y || dtNoon.getMonth() !== mo - 1 || dtNoon.getDate() !== da) return null;
  return { d: crmNormalizeCalendarDateLocalNoon(dtNoon), hhmm: hmFromTail || undefined };
}

/**
 * fecha a mediodía local + HH:mm efectiva de ingreso (columna y/o fecha con hora/fracción).
 * Si no hay hora reconocible, devuelve crmImportSheetRow (>0) para desambiguar leads del mismo día.
 */
function crmResolveIngressoMiddayAndHora(fechaRaw, horaCell, sheetRowAbs, colHasHoraColumn) {
  let fechaMid = null;
  let hhmmCell = "";
  if (colHasHoraColumn) {
    const rawH = horaCell;
    if (!(rawH == null || String(rawH ?? "").trim() === "")) {
      hhmmCell = crmFormatTimeCellToHhMm(rawH).trim();
    }
  }

  /** Hora sólo fecha (Excel Date con wall clock no medianoche sería creíble). */
  let hhmmEmbedded = "";

  if (fechaRaw instanceof Date && !Number.isNaN(fechaRaw.getTime())) {
    fechaMid = crmNormalizeCalendarDateLocalNoon(fechaRaw);
    const h = fechaRaw.getHours();
    const m = fechaRaw.getMinutes();
    const sec = fechaRaw.getSeconds();
    const ms = fechaRaw.getMilliseconds();
    if (h !== 0 || m !== 0 || sec !== 0 || ms !== 0) {
      hhmmEmbedded = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    const effective = hhmmCell || hhmmEmbedded;
    return {
      fecha: fechaMid,
      crmHoraIngreso: effective || "",
      crmImportSheetRow: effective ? 0 : sheetRowAbs
    };
  }

  if (typeof fechaRaw === "number" && Number.isFinite(fechaRaw)) {
    const nv = fechaRaw;
    if (nv > 20000 && nv < 80000 + 2) {
      const dayFlo = Math.floor(nv);
      const fracPart = nv - dayFlo;
      fechaMid = crmExcelSerialToCalendarDateLocalNoon(dayFlo);
      hhmmEmbedded = crmHhMmFromFractionOfDay(fracPart);
      const effective = hhmmCell || hhmmEmbedded;
      return {
        fecha: fechaMid,
        crmHoraIngreso: effective || "",
        crmImportSheetRow: effective ? 0 : sheetRowAbs
      };
    }
  }

  const dmyHm = typeof fechaRaw === "string" ? crmTryParseDdMmYyAndOptionalHm(fechaRaw) : null;
  if (dmyHm) {
    fechaMid = dmyHm.d;
    hhmmEmbedded = String(dmyHm.hhmm ?? "").trim();
    const effective = hhmmCell || hhmmEmbedded;
    return {
      fecha: fechaMid,
      crmHoraIngreso: effective || "",
      crmImportSheetRow: effective ? 0 : sheetRowAbs
    };
  }

  const sCand = typeof fechaRaw === "string" ? String(fechaRaw).trim().replace(/\s+/g, " ") : "";
  if (sCand) {
    const isoHm = sCand.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2})[:.](\d{2}))/);
    if (isoHm) {
      const y = Number(isoHm[1]);
      const mo = Number(isoHm[2]);
      const da = Number(isoHm[3]);
      const hh = Math.min(23, Math.max(0, Number(isoHm[4])));
      const mi = Math.min(59, Math.max(0, Number(isoHm[5])));
      const dtMid = crmNormalizeCalendarDateLocalNoon(new Date(y, mo - 1, da));
      if (dtMid.getFullYear() !== y || dtMid.getMonth() !== mo - 1 || dtMid.getDate() !== da) {
        fechaMid = null;
      } else {
        fechaMid = dtMid;
        hhmmEmbedded = `${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
        const effective = hhmmCell || hhmmEmbedded;
        return {
          fecha: fechaMid,
          crmHoraIngreso: effective || "",
          crmImportSheetRow: effective ? 0 : sheetRowAbs
        };
      }
    }

    const p = parseFechaData(sCand);
    if (p && !Number.isNaN(p.getTime())) {
      fechaMid = crmNormalizeCalendarDateLocalNoon(p);
      const tailHm3 = sCand.match(/\s(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s|$)/);
      if (tailHm3) {
        const hh = Math.min(23, Math.max(0, Number(tailHm3[1])));
        const mm = Math.min(59, Math.max(0, Number(tailHm3[2])));
        hhmmEmbedded = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      }
      const effective = hhmmCell || hhmmEmbedded;
      return {
        fecha: fechaMid,
        crmHoraIngreso: effective || "",
        crmImportSheetRow: effective ? 0 : sheetRowAbs
      };
    }
  }

  fechaMid = crmParseDateFromCell(fechaRaw);
  const effective = hhmmCell || hhmmEmbedded;
  return {
    fecha: fechaMid,
    crmHoraIngreso: effective || "",
    crmImportSheetRow: effective ? 0 : sheetRowAbs
  };
}

function crmIngressoKeyPartFromRow(r) {
  let h = String(r?.crmHoraIngreso ?? "").trim();
  let rowFb = Number(r?.crmImportSheetRow);
  const hasImportedSheetMarker =
    r && typeof r === "object" && Object.prototype.hasOwnProperty.call(r, "crmImportSheetRow");
  if (
    (!Number.isFinite(rowFb) || rowFb <= 0) &&
    typeof r?.crmImportSheetRow === "string" &&
    String(r.crmImportSheetRow).trim() !== ""
  ) {
    rowFb = Number(String(r.crmImportSheetRow).trim());
  }
  const filaDedup =
    Number.isFinite(rowFb) && rowFb > 0 ? rowFb : 0;

  if (!h && filaDedup > 0) {
    h = `\u00a7fila:${filaDedup}`;
  } else if (!h && !hasImportedSheetMarker && String(r?._id ?? "").trim()) {
    /** Persistencia anterior sin métricas de hora/fila por importación: aislar sólo registros legacy. */
    h = `\u00a7legacy:${String(r._id)}`;
  }
  return h.replace(/\s+/g, " ").trim();
}

/**
 * fecha_ingreso desde celda Excel/CSV: solo construcción local `new Date(y,m-1,d)`;
 * sin Date.parse ni new Date(string). DD/MM latino por defecto en barras/puntos/guiones.
 */
function crmParseDateFromCell(val) {
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return new Date(val.getFullYear(), val.getMonth(), val.getDate(), 12, 0, 0);
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    if (val > 20000 && val < 80000) {
      const fromSerial = crmExcelSerialToCalendarDateLocalNoon(val);
      if (fromSerial) return fromSerial;
    }
  }
  let s = String(val ?? "").trim();
  if (!s) return null;
  s = s.replace(/\s+/g, " ");
  const fromIso = parseFechaData(s);
  if (fromIso) return crmNormalizeCalendarDateLocalNoon(fromIso);
  const dmySpace = s.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})(?:\s|$)/);
  if (dmySpace) {
    let d = Number(dmySpace[1]);
    let m = Number(dmySpace[2]);
    let y = Number(dmySpace[3]);
    if (y < 100) y += 2000;
    if (m > 12 && d <= 12) {
      const tmp = d;
      d = m;
      m = tmp;
    }
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt;
  }
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:\s|T|$)/);
  if (dmy) {
    let d = Number(dmy[1]);
    let m = Number(dmy[2]);
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    if (m > 12 && d <= 12) {
      const tmp = d;
      d = m;
      m = tmp;
    }
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt;
  }
  const isoTime = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoTime) {
    const p = parseFechaData(s);
    if (p) return crmNormalizeCalendarDateLocalNoon(p);
  }
  return null;
}

function crmColumnLabels(headers, col) {
  const label = (i) => (i >= 0 && headers[i] != null ? String(headers[i]).trim() : "—");
  return {
    campania: label(col.nombre),
    intake: col.intakeCol >= 0 ? label(col.intakeCol) : "—",
    fecha: label(col.fecha),
    email: col.email >= 0 ? label(col.email) : "—",
    telefono: col.telefono >= 0 ? label(col.telefono) : "—",
    lead: col.lead >= 0 ? label(col.lead) : "—",
    interesado: col.interesado >= 0 ? label(col.interesado) : "—",
    postulante: col.postulante >= 0 ? label(col.postulante) : "—",
    matriculado: col.matriculado >= 0 ? label(col.matriculado) : "—",
    intervaloGestion: col.intervaloGestion >= 0 ? label(col.intervaloGestion) : "—",
    fuente: col.fuente >= 0 ? label(col.fuente) : "—",
    horaIngreso: col.horaIngreso >= 0 ? label(col.horaIngreso) : "—",
    horaGestion: col.horaGestion >= 0 ? label(col.horaGestion) : "—",
    tiempoTranscurrido: col.tiempoTranscurrido >= 0 ? label(col.tiempoTranscurrido) : "—"
  };
}

function crmRowsFromSheetMatrix(matrix, options = {}) {
  const allowMissingFecha = !!options.allowMissingFecha;
  const fallbackMonthKey = String(options.fallbackMonthKey ?? "").trim();
  const emptyStats = {
    totalFilasExcelCuerpo: 0,
    totalFilasLeidas: 0,
    filasValidas: 0,
    omitidasSinCampania: 0,
    omitidasSinFecha: 0,
    omitidasSinLeadExplicito: 0,
    omitidasSinIntake: 0,
    omitidasSinFuenteNormalized: 0,
    campaniasUnicas: 0,
    columnas: {
      campania: "—",
      intake: "—",
      fecha: "—",
      email: "—",
      telefono: "—",
      lead: "—",
      interesado: "—",
      postulante: "—",
      matriculado: "—",
      intervaloGestion: "—",
      fuente: "—",
      horaIngreso: "—",
      horaGestion: "—",
      tiempoTranscurrido: "—"
    },
    omitidasParseTotal: 0,
    diferenciaFilasVaciasVsTotal: 0
  };
  if (!matrix?.length) return { rows: [], stats: emptyStats };

  const headerIdx = crmFindHeaderRowIndex(matrix);
  const headers = (matrix[headerIdx] || []).map((c) => String(c ?? ""));
  const col = crmDetectColumnMap(headers);
  const colLabels = crmColumnLabels(headers, col);
  const out = [];
  const teamId = getCurrentTeamId();
  let omitidasSinCampania = 0;
  let omitidasSinFecha = 0;
  let omitidasSinLeadExplicito = 0;
  let omitidasSinIntake = 0;
  let omitidasSinFuenteNormalized = 0;
  let totalFilasLeidas = 0;
  const totalFilasExcelCuerpo = Math.max(0, matrix.length - headerIdx - 1);

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    totalFilasLeidas += 1;
    const flujoRaw =
      col.nombre >= 0 ? String(row[col.nombre] ?? "").trim() : "";
    const { tipo, programa } = crmSplitFlujoTipoPrograma(flujoRaw);
    const intakeSrc = col.intakeCol >= 0 ? String(row[col.intakeCol] ?? "").trim() : "";
    const intake = intakeSrc ? crmNormalizeIntakeCellValue(row[col.intakeCol]) : "";
    const fuenteCrmRaw =
      col.fuente >= 0 ? String(row[col.fuente] ?? "").trim() : "";
    const crmTrafficType = fuenteCrmRaw ? crmNormalizedTrafficFromFuenteVF(fuenteCrmRaw) : "";
    const nombreParaValidar = String(programa || tipo || "").trim();

    if (!nombreParaValidar || /^#?(ref|num)!?$/i.test(String(flujoRaw).trim())) {
      omitidasSinCampania += 1;
      continue;
    }
    if (!intake) {
      omitidasSinIntake += 1;
      continue;
    }
    if (!crmTrafficType) {
      omitidasSinFuenteNormalized += 1;
      continue;
    }
    const tieneColLead = col.lead >= 0;
    const leadCount = crmParseLeadCountFromCell(tieneColLead ? row[col.lead] : null, tieneColLead);
    if (tieneColLead && leadCount <= 0) {
      omitidasSinLeadExplicito += 1;
      continue;
    }
    const fechaRaw = col.fecha >= 0 ? row[col.fecha] : undefined;
    const excelRowIndex = i + 1;
    const colHasHora = col.horaIngreso >= 0;
    const horaIngresoCell = colHasHora ? row[col.horaIngreso] : undefined;

    let fecha = null;
    let crmHoraIngreso = "";
    let crmImportSheetRow = 0;
    if (col.fecha >= 0) {
      const ingressoRes = crmResolveIngressoMiddayAndHora(
        fechaRaw,
        horaIngresoCell,
        excelRowIndex,
        colHasHora
      );
      fecha = ingressoRes.fecha;
      crmHoraIngreso = ingressoRes.crmHoraIngreso;
      crmImportSheetRow = ingressoRes.crmImportSheetRow;
    }

    if (!fecha && allowMissingFecha && fallbackMonthKey) {
      const fb = crmDateFromMonthKeyDay1(fallbackMonthKey);
      if (fb) {
        fecha = fb;
        const hhCol = colHasHora ? crmFormatTimeCellToHhMm(horaIngresoCell).trim() : "";
        crmHoraIngreso = hhCol;
        crmImportSheetRow = hhCol ? 0 : excelRowIndex;
      }
    }

    if (!fecha) {
      omitidasSinFecha += 1;
      continue;
    }
    const crmHoraGestion = col.horaGestion >= 0 ? crmFormatTimeCellToHhMm(row[col.horaGestion]) : "";
    const crmTiempoTranscurridoMin =
      col.tiempoTranscurrido >= 0 ? crmParseTiempoMinutosCell(row[col.tiempoTranscurrido]) : "";
    const esInteresado = col.interesado >= 0 ? crmParseBoolish(row[col.interesado]) : false;
    const esPostulante = col.postulante >= 0 ? crmParseBoolish(row[col.postulante]) : false;
    const esMatriculado = col.matriculado >= 0 ? crmParseBoolish(row[col.matriculado]) : false;
    const intervaloGestion =
      col.intervaloGestion >= 0 ? String(row[col.intervaloGestion] ?? "").trim() : "";
    const nombreCampaniaFinal = crmComposeDisplayDimensional(tipo, programa, intake, crmTrafficType);
    out.push({
      _id: generateDataRowId(),
      nombreCampania: nombreCampaniaFinal,
      crmTipo: tipo,
      crmPrograma: programa,
      crmIntake: intake,
      crmTrafficType,
      crmFlujoRaw: String(flujoRaw ?? "").trim(),
      crmHoraIngreso,
      crmImportSheetRow,
      crmHoraGestion,
      crmTiempoTranscurridoMin,
      fecha,
      leads: leadCount,
      email: col.email >= 0 ? String(row[col.email] ?? "").trim() : "",
      telefono: col.telefono >= 0 ? String(row[col.telefono] ?? "").trim() : "",
      esInteresado,
      esPostulante,
      esMatriculado,
      intervaloGestion,
      fuenteCrm: fuenteCrmRaw,
      teamId
    });
  }

  const campaniasUnicas = new Set(out.map((r) => crmCampaignKeyFromRow(r))).size;
  return {
    rows: out,
    stats: {
      totalFilasExcelCuerpo,
      totalFilasLeidas,
      filasValidas: out.length,
      omitidasSinCampania,
      omitidasSinFecha,
      omitidasSinLeadExplicito,
      omitidasSinIntake,
      omitidasSinFuenteNormalized,
      campaniasUnicas,
      columnas: colLabels,
      omitidasParseTotal:
        omitidasSinCampania +
        omitidasSinFecha +
        omitidasSinLeadExplicito +
        omitidasSinIntake +
        omitidasSinFuenteNormalized,
      diferenciaFilasVaciasVsTotal: Math.max(0, totalFilasExcelCuerpo - totalFilasLeidas)
    }
  };
}

async function parseCrmUploadFile(file, options = {}) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const matrix = lines.map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, "")));
    return crmRowsFromSheetMatrix(matrix, options);
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    if (typeof XLSX === "undefined") throw new Error("Lector XLSX no disponible.");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    return crmRowsFromSheetMatrix(matrix, options);
  }
  throw new Error("Formato no soportado. Usa CSV o XLSX.");
}

/**
 * Intenta escribir shards CRM en el repo configurado (modo lite).
 * @returns {{ ok: true, skipped?: boolean } | { ok: false, error: string }}
 */
async function persistCrmLeadsToGithubByMonth(rows) {
  if (!campatrackIsLiteMode() || !hasClientGithubConfigComplete()) return { ok: true, skipped: true };
  try {
    const serialized = serializeCrmLeads(rows);
    await replaceCrmGithubSnapshotFromSerializedRows(serialized);
    return { ok: true };
  } catch (e) {
    console.warn("persistCrmLeadsToGithubByMonth", e);
    const msg =
      typeof e?.message === "string" ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function prepareCrmImportRowsFromFile(file, monthSel) {
  const forcedMk = monthSel instanceof HTMLSelectElement ? String(monthSel.value || "").trim() : "";
  let parsed = await parseCrmUploadFile(file, { allowMissingFecha: false });
  if (!parsed.rows.length && (parsed.stats?.omitidasSinFecha ?? 0) > 0 && forcedMk) {
    parsed = await parseCrmUploadFile(file, {
      allowMissingFecha: true,
      fallbackMonthKey: forcedMk
    });
  }
  return parsed;
}

/** Texto «Flujo» del Excel (clave upsert); retrocompatible si solo existen tipo/programa. */
function crmFlujoRawForUpsertKey(r) {
  const raw = String(r?.crmFlujoRaw ?? "").trim();
  if (raw) return raw.replace(/\s+/g, " ");
  const tipo = String(r?.crmTipo ?? "").trim();
  const prog = String(r?.crmPrograma ?? "").trim();
  if (tipo && prog) return `${tipo} | ${prog}`.replace(/\s+/g, " ");
  return String(r?.crmPrograma || r?.crmTipo || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Clave única lead: fecha_ingreso + Flujo + FuenteVF + intake + hora_ingreso.
 * @returns {string|null}
 */
function crmLeadUpsertKeyFromRow(r) {
  if (!r || !(r.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return null;
  const fechaKey = formatDateInputFromDate(r.fecha);
  const flujo = crmFlujoRawForUpsertKey(r);
  const fuente = String(r.fuenteCrm ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const intake = String(r.crmIntake ?? "").trim();
  const hora = crmIngressoKeyPartFromRow(r);
  return `${fechaKey}|${flujo}|${fuente}|${intake}|${hora}`;
}

/**
 * Misma fecha+flujo+fuente+intake+hora (clave upsert exacta dentro del mismo archivo).
 * Une leads y flags booleanos antes de fusionar contra el borrador persistente.
 */
function consolidateCrmIncomingByUpsertKey(rows) {
  const map = new Map();
  for (const inc of rows) {
    const k = crmLeadUpsertKeyFromRow(inc);
    if (!k) continue;
    const cur = map.get(k);
    if (!cur) {
      map.set(k, inc);
      continue;
    }
    cur.leads = (Number(cur.leads) || 0) + (Number(inc.leads) || 0);
    cur.esInteresado = !!(cur.esInteresado || inc.esInteresado);
    cur.esPostulante = !!(cur.esPostulante || inc.esPostulante);
    cur.esMatriculado = !!(cur.esMatriculado || inc.esMatriculado);
    if (!String(cur.email || "").trim() && String(inc.email || "").trim()) cur.email = inc.email;
    if (!String(cur.telefono || "").trim() && String(inc.telefono || "").trim()) cur.telefono = inc.telefono;
    if (!String(cur.intervaloGestion || "").trim() && String(inc.intervaloGestion || "").trim())
      cur.intervaloGestion = inc.intervaloGestion;
    if (!String(cur.crmHoraGestion || "").trim() && String(inc.crmHoraGestion || "").trim())
      cur.crmHoraGestion = inc.crmHoraGestion;
    if (
      cur.crmTiempoTranscurridoMin == null ||
      cur.crmTiempoTranscurridoMin === "" ||
      !Number.isFinite(Number(cur.crmTiempoTranscurridoMin))
    ) {
      if (inc.crmTiempoTranscurridoMin != null && inc.crmTiempoTranscurridoMin !== "")
        cur.crmTiempoTranscurridoMin = inc.crmTiempoTranscurridoMin;
    }
  }
  return Array.from(map.values());
}

/**
 * Import acumulativo: conserva histórico y relaciones; deduplica por clave; actualiza métricas.
 * @returns {{ inserted: number, updated: number, skipped: number, total: number, totalAntesMerge: number }}
 */
function mergeCrmLeadsImportUpsert(incomingRows) {
  const draft = ensureCrmLeadsDraftShape();
  const totalAntesMerge = draft.length;
  const indexByKey = new Map();
  for (let i = 0; i < draft.length; i += 1) {
    const k = crmLeadUpsertKeyFromRow(draft[i]);
    if (k) indexByKey.set(k, i);
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const inc of incomingRows) {
    const k = crmLeadUpsertKeyFromRow(inc);
    if (!k) {
      skipped += 1;
      continue;
    }
    const idx = indexByKey.get(k);
    if (idx !== undefined) {
      const cur = draft[idx];
      draft[idx] = {
        ...cur,
        leads: inc.leads,
        esInteresado: inc.esInteresado,
        esPostulante: inc.esPostulante,
        esMatriculado: inc.esMatriculado,
        intervaloGestion: inc.intervaloGestion,
        crmHoraGestion: inc.crmHoraGestion,
        crmTiempoTranscurridoMin: inc.crmTiempoTranscurridoMin,
        crmHoraIngreso: inc.crmHoraIngreso ?? cur.crmHoraIngreso,
        crmImportSheetRow:
          Number(inc.crmImportSheetRow) > 0 ? inc.crmImportSheetRow : cur.crmImportSheetRow,
        nombreCampania: String(inc.nombreCampania ?? cur.nombreCampania ?? ""),
        fuenteCrm: String(inc.fuenteCrm ?? cur.fuenteCrm ?? ""),
        crmFlujoRaw: String(inc.crmFlujoRaw ?? cur.crmFlujoRaw ?? "")
      };
      updated += 1;
    } else {
      draft.push(inc);
      indexByKey.set(k, draft.length - 1);
      inserted += 1;
    }
  }
  syncCrmLeadsViewFromDraft();
  return { inserted, updated, skipped, total: draft.length, totalAntesMerge };
}

function initCrmImportModule() {
  const input = document.getElementById("crmImportFile");
  const btn = document.getElementById("crmImportBtn");
  const monthSel = document.getElementById("crmImportTargetMonth");
  if (!input || !btn) return;
  const now = new Date();
  if (monthSel instanceof HTMLSelectElement) {
    const opts = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mk = campatrackMonthKeyFromFecha(d);
      if (mk) opts.push(`<option value="${mk}">${mk}</option>`);
    }
    monthSel.innerHTML = `<option value="">— Sin mes de respaldo (usar solo fecha del archivo) —</option>${opts.join("")}`;
  }
  btn.addEventListener("click", async () => {
    const file = input.files?.[0];
    if (!file) {
      showCampatrackToast("Selecciona un archivo CSV o XLSX.", "error");
      return;
    }
    btn.disabled = true;
    try {
      const parsed = await prepareCrmImportRowsFromFile(file, monthSel);
      const rowsFromFile = parsed.rows || [];
      if (!rowsFromFile.length) {
        const col = parsed.stats?.columnas?.campania || "Flujo";
        showCampatrackToast(
          `No hay filas válidas para importar. ¿Columna «${col}», intake, FuenteVF reconocible y fecha de ingreso?`,
          "error"
        );
        return;
      }
      const st = parsed.stats || {};
      const consolidatedIncoming = consolidateCrmIncomingByUpsertKey(rowsFromFile);
      const colapsadasMismaClaveEnExcel =
        rowsFromFile.length > consolidatedIncoming.length
          ? rowsFromFile.length - consolidatedIncoming.length
          : 0;
      const omitidasParseTotal = Number(st.omitidasParseTotal ?? 0) || 0;
      console.info("[CRM import — diagnóstico]", {
        totalFilasExcel: st.totalFilasExcelCuerpo ?? "—",
        filasFilasVaciasSinContarParse: st.diferenciaFilasVaciasVsTotal ?? 0,
        filasDatosNoVaciasExcel: st.totalFilasLeidas ?? rowsFromFile.length,
        totalFilasProcesadasValidas: rowsFromFile.length,
        omitidasEnParsePorReglasCRM: omitidasParseTotal,
        detalle_omitidas: {
          sin_campania: st.omitidasSinCampania,
          sin_fecha: st.omitidasSinFecha,
          sin_lead_explicito_col: st.omitidasSinLeadExplicito,
          sin_intake: st.omitidasSinIntake,
          fuente_sin_normalizar: st.omitidasSinFuenteNormalized
        },
        dupExactasFusionadasAntesUpsertPersistente: colapsadasMismaClaveEnExcel
      });

      const merge = mergeCrmLeadsImportUpsert(consolidatedIncoming);

      console.info("[CRM import — resultado upsert borrador]", {
        total_filas_archivo_original: rowsFromFile.length,
        filas_entraron_a_upsert: consolidatedIncoming.length,
        nuevas_insertadas_merge: merge.inserted,
        existentes_actualizadas_merge: merge.updated,
        clave_nula_o_invalida_skip: merge.skipped,
        total_antiguo_borrador: merge.totalAntesMerge,
        total_final_tras_import: merge.total
      });

      const draft = ensureCrmLeadsDraftShape();
      if (campatrackIsLiteMode() && hasClientGithubConfigComplete()) {
        const gh = await persistCrmLeadsToGithubByMonth(draft);
        if (gh.ok) {
          showCampatrackToast(
            `CRM guardado en GitHub: ${merge.inserted} nuevo(s), ${merge.updated} actualizado(s).`,
            "success"
          );
        } else {
          registerUnpublishedDraftMutation();
          const hint = gh.error.includes("403")
            ? `${gh.error.slice(0, 220)} Revisa reglas del repo en GitHub, permisos del token o bloqueos CORS desde localhost.`
            : `${gh.error.slice(0, 280)}`;
          showCampatrackToast(
            `CRM importado en la app (borrador actualizado). No se pudo subir a GitHub: ${hint}`,
            "error"
          );
        }
      } else {
        registerUnpublishedDraftMutation();
        showCampatrackToast(
          `CRM fusionado: ${merge.inserted} nuevo(s), ${merge.updated} actualizado(s). Publica para persistir.`,
          "success"
        );
      }
      renderRelacionesEstado();
      if (relActiveSubtab === "crm") {
        renderCrmRelCrmList();
      }
      input.value = "";
    } catch (e) {
      console.error("CRM import", e);
      showCampatrackToast(String(e?.message || "Error al importar CRM."), "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// —— Relación CRM (Planning ↔ CRM) ——
/** Clave estable: tipo + programa + intake + tracking normalizado (Leadgen/Pixel/Google). */
function crmCampaignKeyFromRow(r) {
  const h = crmHydrateDimensionalFieldsOnRow(r);
  const tipo = String(h.tipo ?? "").trim();
  const programa = String(h.programa ?? "").trim();
  const intake = String(h.intake ?? "").trim();
  const traff = String(h.crmTrafficType ?? "").trim();
  if (programa && intake && traff) {
    return normalizarTexto(crmMigrateNormalizedQuarterCrmKey(`${tipo} ${programa} ${intake} ${traff}`));
  }
  return normalizarTexto(crmMigrateNormalizedQuarterCrmKey(String(h.nombreCampania ?? r?.nombreCampania ?? "")));
}

function getCrmUniqueCampaignList() {
  const map = new Map();
  crmLeads.forEach((r) => {
    const k = crmCampaignKeyFromRow(r);
    if (!k) return;
    const h = crmHydrateDimensionalFieldsOnRow(r);
    const display = String(h.nombreCampania || "").trim() || crmComposeDisplayDimensional(h.tipo, h.programa, h.intake, h.crmTrafficType);
    if (!map.has(k)) {
      map.set(k, {
        crmKey: k,
        nombre: display,
        leads: 0,
        intake: String(h.intake || "").trim()
      });
    }
    map.get(k).leads += Number(r.leads) || 1;
  });
  return Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

let selectedCrmRelPlanningKeys = new Set();
let selectedCrmRelCrmKeys = new Set();

function getCrmRelLinkedPlanningSet() {
  return new Set(relacionesCrm.map((r) => r.planningKey));
}

function getCrmRelLinkedCrmSet() {
  return new Set(relacionesCrm.map((r) => r.crmKey));
}

function crmRelMatchesIntakeFilter(intakeVal, intakeNorm) {
  if (!intakeNorm) return true;
  const n = normalizarTexto(intakeVal);
  return n === intakeNorm || n.includes(intakeNorm);
}

function getFilteredCrmRelPlanningKeys() {
  const linked = getCrmRelLinkedPlanningSet();
  const gq = normalizarTexto(crmRelacionesSearchQuery);
  const pq = normalizarTexto(crmRelPlanningListQuery);
  const plat = normalizarTexto(crmRelFiltroPlataforma);
  const est = crmRelFiltroEstadoRel;
  const intakeF = normalizarTexto(crmRelFiltroIntake);
  return getPlanningGroups()
    .map((x) => x.key)
    .filter((k) => {
      if (gq && !normalizarTexto(k).includes(gq)) return false;
      if (pq && !normalizarTexto(k).includes(pq)) return false;
      const parsed = parsePlanningKey(k);
      if (plat && normalizarTexto(parsed.plataforma) !== plat && !normalizarTexto(parsed.plataforma).includes(plat)) return false;
      if (!crmRelMatchesIntakeFilter(parsed.intake, intakeF)) return false;
      if (est === "con" && !linked.has(k)) return false;
      if (est === "sin" && linked.has(k)) return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b, "es"));
}

function getFilteredCrmRelCampaignList() {
  const linked = getCrmRelLinkedCrmSet();
  const gq = normalizarTexto(crmRelacionesSearchQuery);
  const cq = normalizarTexto(crmRelCrmListQuery);
  const plat = normalizarTexto(crmRelFiltroPlataforma);
  const est = crmRelFiltroEstadoRel;
  const intakeF = normalizarTexto(crmRelFiltroIntake);
  return getCrmUniqueCampaignList().filter((u) => {
    const text = `${u.crmKey} ${u.nombre}`;
    if (gq && !normalizarTexto(text).includes(gq)) return false;
    if (cq && !normalizarTexto(text).includes(cq)) return false;
    if (plat && !relDataMatchesPlataformaFilter({ nombre: u.nombre, idCampania: u.crmKey }, plat)) return false;
    if (!crmRelMatchesIntakeFilter(u.intake, intakeF)) return false;
    if (est === "con" && !linked.has(String(u.crmKey))) return false;
    if (est === "sin" && linked.has(String(u.crmKey))) return false;
    return true;
  });
}

function refreshCrmRelFilterSelects() {
  const selPlat = document.getElementById("crmRelFiltroPlataforma");
  const selIntake = document.getElementById("crmRelFiltroIntake");
  if (!selPlat || !selIntake) return;
  const plats = new Set();
  const intakes = new Set();
  planningDraftRecords().forEach((r) => {
    const p = String(r.plataforma || "").trim();
    const i = String(r.intake || "").trim();
    if (p) plats.add(p);
    if (i) intakes.add(i);
  });
  crmLeads.forEach((r) => {
    const h = crmHydrateDimensionalFieldsOnRow(r);
    if (h.intake) intakes.add(String(h.intake).trim());
  });
  const curP = selPlat.value;
  const curI = selIntake.value;
  const platArr = Array.from(plats).sort((a, b) => a.localeCompare(b, "es"));
  const intakeArr = Array.from(intakes).sort((a, b) => a.localeCompare(b, "es"));
  selPlat.innerHTML = `<option value="">Todos</option>${platArr.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("")}`;
  selIntake.innerHTML = `<option value="">Todos</option>${intakeArr.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("")}`;
  if (platArr.includes(curP)) selPlat.value = curP;
  if (intakeArr.includes(curI)) selIntake.value = curI;
}

function refreshCrmRelVincularButton() {
  const btn = document.getElementById("crmRelVincularBtn");
  if (!btn || !(btn instanceof HTMLButtonElement)) return;
  const ready = selectedCrmRelPlanningKeys.size === 1 && selectedCrmRelCrmKeys.size === 1;
  btn.disabled = !ready;
  btn.setAttribute("aria-disabled", ready ? "false" : "true");
  btn.classList.toggle("rel-vincular-btn--ready", ready);
}

function renderCrmRelPlanningList() {
  syncRelacionesCrmViewFromDraft();
  const host = document.getElementById("crmRelPlanningList");
  if (!host) return;
  const linked = getCrmRelLinkedPlanningSet();
  const keys = getFilteredCrmRelPlanningKeys();
  const totalPlanning = getPlanningGroups().length;
  const selCount = document.getElementById("crmRelPlanningSelectedCount");
  const badge = document.getElementById("crmRelPlanningBadgeTotal");
  if (selCount) selCount.textContent = String(selectedCrmRelPlanningKeys.size);
  if (badge) badge.textContent = String(totalPlanning);
  host.innerHTML = keys
    .map((k) => {
      const parsed = parsePlanningKey(k);
      const metaBits = [parsed.tipo, parsed.intake, parsed.tracking].filter(Boolean);
      const meta = metaBits.length ? metaBits.join(" · ") : "—";
      const platLabel = String(parsed.plataforma || "—").trim() || "—";
      const cls = [
        "rel-item",
        selectedCrmRelPlanningKeys.has(k) ? "rel-selected" : "",
        linked.has(k) ? "rel-linked-planning" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const badgeClass = relPlataformaBadgeClass(parsed.plataforma);
      return `<div class="${cls}" data-crm-rel-planning="${escapeHtml(k)}" role="option" aria-selected="${selectedCrmRelPlanningKeys.has(k) ? "true" : "false"}">
      <span class="${badgeClass}">${escapeHtml(platLabel)}</span>
      <div class="rel-item-body">
        <div class="rel-item-title">${escapeHtml(k)}</div>
        <div class="rel-item-meta">${escapeHtml(meta)}</div>
      </div>
    </div>`;
    })
    .join("");
  refreshCrmRelVincularButton();
}

function renderCrmRelCrmList() {
  syncRelacionesCrmViewFromDraft();
  const host = document.getElementById("crmRelCrmList");
  if (!host) return;
  const linked = getCrmRelLinkedCrmSet();
  const items = getFilteredCrmRelCampaignList();
  const totalCrm = getCrmUniqueCampaignList().length;
  const selCount = document.getElementById("crmRelCrmSelectedCount");
  const badge = document.getElementById("crmRelCrmBadgeTotal");
  if (selCount) selCount.textContent = String(selectedCrmRelCrmKeys.size);
  if (badge) badge.textContent = String(totalCrm);
  host.innerHTML = items
    .map((u) => {
      const key = String(u.crmKey);
      const cls = [
        "rel-item",
        selectedCrmRelCrmKeys.has(key) ? "rel-selected" : "",
        linked.has(key) ? "rel-linked-data" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const bits = String(u.nombre || "")
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      let meta = "—";
      if (bits.length >= 4) {
        meta = [bits[0], bits[2], bits[bits.length - 1]].filter(Boolean).join(" · ");
      } else if (bits.length) {
        meta = bits.join(" · ");
      }
      return `<div class="${cls}" data-crm-rel-crm="${escapeHtml(key)}" role="option" aria-selected="${selectedCrmRelCrmKeys.has(key) ? "true" : "false"}">
      <div class="rel-item-body rel-item-body--data">
        <div class="rel-item-title">${escapeHtml(u.nombre || "")}</div>
        <div class="rel-item-meta">${escapeHtml(meta)}</div>
        <div class="rel-item-meta rel-item-meta--id"><span class="rel-data-id">${escapeHtml(String(u.leads))} leads</span></div>
      </div>
    </div>`;
    })
    .join("");
  refreshCrmRelVincularButton();
}

function renderCrmRelacionesTabla() {
  const tbody = document.getElementById("crmRelacionesTbody");
  const count = document.getElementById("crmRelTablaCount");
  if (!tbody) return;
  const q = normalizarTexto(crmRelacionesSearchQuery);
  const platF = normalizarTexto(crmRelFiltroPlataforma);
  const intakeF = normalizarTexto(crmRelFiltroIntake);
  const estF = crmRelFiltroEstadoRel;
  const allRows = ensureRelacionesCrmDraftShape();
  const rows = allRows
    .map((rel, idx) => ({ rel, idx }))
    .filter(({ rel }) => {
      if (estF === "sin") return false;
      if (q) {
        const planningTxt = normalizarTexto(String(rel.planningKey ?? ""));
        const crmTxt = normalizarTexto(String(rel.nombre ?? ""));
        const keyTxt = normalizarTexto(String(rel.crmKey ?? ""));
        if (!planningTxt.includes(q) && !crmTxt.includes(q) && !keyTxt.includes(q)) return false;
      }
      const parsed = parsePlanningKey(rel.planningKey);
      if (platF && !normalizarTexto(parsed.plataforma).includes(platF) && normalizarTexto(parsed.plataforma) !== platF) return false;
      if (!crmRelMatchesIntakeFilter(parsed.intake, intakeF)) return false;
      return true;
    });
  if (count) count.textContent = String(rows.length);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="dash-empty-mini">${allRows.length ? "Sin relaciones CRM para la búsqueda actual" : "Sin relaciones CRM creadas"}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(({ rel: r, idx }) => {
      const parsed = parsePlanningKey(r.planningKey);
      const platLabel = String(parsed.plataforma || "CRM").trim() || "CRM";
      const badgePlat = relPlataformaBadgeClass(parsed.plataforma);
      const estadoRaw = String(r.estado || "activa").toLowerCase();
      const estado = estadoRaw === "inactiva" || estadoRaw === "inactivo" ? "Inactivo" : "Activo";
      const estadoCls =
        estado === "Activo" ? "rel-estado-badge rel-estado-badge--on" : "rel-estado-badge rel-estado-badge--off";
      return `<tr>
        <td class="rel-td-planning">${escapeHtml(r.planningKey)}</td>
        <td class="rel-td-data">${escapeHtml(r.nombre || r.crmKey)}</td>
        <td class="rel-td-plat"><span class="${badgePlat}">${escapeHtml(platLabel)}</span></td>
        <td class="rel-td-estado"><span class="${estadoCls}">${escapeHtml(estado)}</span></td>
        <td class="rel-td-actions">
          <div class="rel-row-actions">
            <button type="button" class="rel-icon-btn" data-crm-rel-preselect="${idx}" title="Seleccionar en listas" aria-label="Seleccionar en listas"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
            <button type="button" class="rel-icon-btn rel-icon-btn--danger" data-crm-rel-del="${escapeHtml(r.planningKey)}" title="Eliminar" aria-label="Eliminar relación CRM"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function vincularCrmPlanning() {
  if (selectedCrmRelPlanningKeys.size !== 1 || selectedCrmRelCrmKeys.size !== 1) return;
  const planningKey = [...selectedCrmRelPlanningKeys][0];
  const crmKey = [...selectedCrmRelCrmKeys][0];
  const crmItem = getCrmUniqueCampaignList().find((u) => u.crmKey === crmKey);
  const row = {
    planningKey,
    crmKey,
    nombre: crmItem?.nombre || crmKey,
    fechaRelacion: new Date().toISOString().slice(0, 10),
    estado: "activa"
  };
  const list = ensureRelacionesCrmDraftShape();
  if (list.some((x) => x.planningKey === row.planningKey)) {
    showCampatrackToast("Ese Planning ya tiene relación CRM.", "error");
    return;
  }
  list.push(row);
  syncRelacionesCrmViewFromDraft();
  selectedCrmRelPlanningKeys = new Set();
  selectedCrmRelCrmKeys = new Set();
  registerUnpublishedDraftMutation();
  renderCrmRelPlanningList();
  renderCrmRelCrmList();
  renderCrmRelacionesTabla();
  renderRelacionesEstado();
  showCampatrackToast("Relación CRM creada.", "success");
}

function initCrmRelacionesModule() {
  const crmRelacionesSearchInput = document.getElementById("crmRelacionesSearch");
  crmRelacionesSearchInput?.addEventListener("input", () => {
    crmRelacionesSearchQuery = String(crmRelacionesSearchInput.value || "").trim();
    renderCrmRelPlanningList();
    renderCrmRelCrmList();
    renderCrmRelacionesTabla();
  });
  const onCrmBarFilterChange = () => {
    const p = document.getElementById("crmRelFiltroPlataforma");
    const e = document.getElementById("crmRelFiltroEstadoRel");
    const i = document.getElementById("crmRelFiltroIntake");
    crmRelFiltroPlataforma = p instanceof HTMLSelectElement ? String(p.value || "").trim() : "";
    crmRelFiltroEstadoRel = e instanceof HTMLSelectElement ? String(e.value || "").trim() : "";
    crmRelFiltroIntake = i instanceof HTMLSelectElement ? String(i.value || "").trim() : "";
    renderCrmRelPlanningList();
    renderCrmRelCrmList();
    renderCrmRelacionesTabla();
  };
  document.getElementById("crmRelFiltroPlataforma")?.addEventListener("change", onCrmBarFilterChange);
  document.getElementById("crmRelFiltroEstadoRel")?.addEventListener("change", onCrmBarFilterChange);
  document.getElementById("crmRelFiltroIntake")?.addEventListener("change", onCrmBarFilterChange);
  document.getElementById("crmRelLimpiarFiltrosBtn")?.addEventListener("click", () => {
    crmRelacionesSearchQuery = "";
    crmRelPlanningListQuery = "";
    crmRelCrmListQuery = "";
    crmRelFiltroPlataforma = "";
    crmRelFiltroEstadoRel = "";
    crmRelFiltroIntake = "";
    if (crmRelacionesSearchInput instanceof HTMLInputElement) crmRelacionesSearchInput.value = "";
    const ps = document.getElementById("crmRelPlanningSearch");
    const cs = document.getElementById("crmRelCrmSearch");
    if (ps instanceof HTMLInputElement) ps.value = "";
    if (cs instanceof HTMLInputElement) cs.value = "";
    const p = document.getElementById("crmRelFiltroPlataforma");
    const e = document.getElementById("crmRelFiltroEstadoRel");
    const i = document.getElementById("crmRelFiltroIntake");
    if (p instanceof HTMLSelectElement) p.value = "";
    if (e instanceof HTMLSelectElement) e.value = "";
    if (i instanceof HTMLSelectElement) i.value = "";
    renderCrmRelPlanningList();
    renderCrmRelCrmList();
    renderCrmRelacionesTabla();
  });
  document.getElementById("crmRelPlanningSearch")?.addEventListener("input", (ev) => {
    const t = ev.target;
    crmRelPlanningListQuery = t instanceof HTMLInputElement ? String(t.value || "").trim() : "";
    renderCrmRelPlanningList();
  });
  document.getElementById("crmRelCrmSearch")?.addEventListener("input", (ev) => {
    const t = ev.target;
    crmRelCrmListQuery = t instanceof HTMLInputElement ? String(t.value || "").trim() : "";
    renderCrmRelCrmList();
  });
  document.getElementById("crmRelSelectAllPlanningBtn")?.addEventListener("click", () => {
    selectedCrmRelPlanningKeys = new Set(getFilteredCrmRelPlanningKeys());
    renderCrmRelPlanningList();
  });
  document.getElementById("crmRelSelectAllCrmBtn")?.addEventListener("click", () => {
    selectedCrmRelCrmKeys = new Set(getFilteredCrmRelCampaignList().map((u) => String(u.crmKey)));
    renderCrmRelCrmList();
  });
  document.getElementById("crmRelPlanningList")?.addEventListener("click", (e) => {
    const el = e.target instanceof HTMLElement ? e.target.closest("[data-crm-rel-planning]") : null;
    if (!el) return;
    const k = el.getAttribute("data-crm-rel-planning");
    if (!k) return;
    if (selectedCrmRelPlanningKeys.has(k)) selectedCrmRelPlanningKeys.delete(k);
    else selectedCrmRelPlanningKeys.add(k);
    renderCrmRelPlanningList();
  });
  document.getElementById("crmRelCrmList")?.addEventListener("click", (e) => {
    const el = e.target instanceof HTMLElement ? e.target.closest("[data-crm-rel-crm]") : null;
    if (!el) return;
    const key = el.getAttribute("data-crm-rel-crm");
    if (!key) return;
    if (selectedCrmRelCrmKeys.has(key)) selectedCrmRelCrmKeys.delete(key);
    else selectedCrmRelCrmKeys.add(key);
    renderCrmRelCrmList();
  });
  document.getElementById("crmRelVincularBtn")?.addEventListener("click", vincularCrmPlanning);
  document.getElementById("crmRelacionesTbody")?.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const pre = t?.closest("[data-crm-rel-preselect]");
    if (pre) {
      const idx = Number(pre.getAttribute("data-crm-rel-preselect"));
      const rel = Number.isFinite(idx) ? ensureRelacionesCrmDraftShape()[idx] : null;
      if (rel) {
        selectedCrmRelPlanningKeys = new Set([rel.planningKey]);
        selectedCrmRelCrmKeys = new Set([rel.crmKey]);
        renderCrmRelPlanningList();
        renderCrmRelCrmList();
      }
      return;
    }
    const btn = t?.closest("[data-crm-rel-del]");
    if (!btn) return;
    const pk = btn.getAttribute("data-crm-rel-del");
    const list = ensureRelacionesCrmDraftShape();
    const idx = list.findIndex((r) => r.planningKey === pk);
    if (idx >= 0) {
      list.splice(idx, 1);
      syncRelacionesCrmViewFromDraft();
      registerUnpublishedDraftMutation();
      renderCrmRelPlanningList();
      renderCrmRelCrmList();
      renderCrmRelacionesTabla();
      renderRelacionesEstado();
    }
  });
  syncRelacionesCrmViewFromDraft();
  refreshCrmRelFilterSelects();
  renderCrmRelPlanningList();
  renderCrmRelCrmList();
  renderCrmRelacionesTabla();
  refreshCrmRelVincularButton();
}

/** Preparado para dashboard CRM vs Meta: métricas por planningKey unificado. */
function campatrackCrmMetaMetricsByPlanning() {
  const out = new Map();
  planningDraftRecords().forEach((rec) => {
    const pk = planningKeyFromRecord(rec);
    out.set(pk, { planningKey: pk, metaLeads: 0, crmLeads: 0, planningLabel: rec.programa || pk });
  });
  getRelacionesPlataforma().forEach((rel) => {
    const slot = out.get(rel.planningKey);
    if (!slot) return;
    const campRows = getAllCampaignRows().filter((r) => String(r.idCampania) === String(rel.idCampania));
    slot.metaLeads += campRows.reduce((s, r) => s + (Number(r.leads) || 0), 0);
  });
  relacionesCrm.forEach((rel) => {
    const slot = out.get(rel.planningKey);
    if (!slot) return;
    const crmRows = crmLeads.filter((r) => crmCampaignKeyFromRow(r) === rel.crmKey);
    slot.crmLeads += crmRows.reduce((s, r) => s + (Number(r.leads) || 0), 0);
  });
  return out;
}

// RELACIONES module
function planningKeyFromRecord(r) {
  return `${r.tipo} | ${r.programa} | ${r.intake} | ${r.plataforma} | ${r.tracking}`;
}

function parsePlanningKey(key) {
  const parts = String(key).split(" | ");
  return {
    tipo: parts[0] || "",
    programa: parts[1] || "",
    intake: parts[2] || "",
    plataforma: parts[3] || "",
    tracking: parts[4] || ""
  };
}

function normalizeRelacionesPlanningKeys() {
  // Relaciones ahora se hidrata y conserva de forma directa (sin transformaciones).
  syncRelacionesViewFromDraft();
}

function normalizarTexto(texto) {
  return String(texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-|]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIntakeCode(texto) {
  const t = normalizarTexto(texto);
  const m = t.match(/intake\s*(\d)/) || t.match(/intake(\d)/) || t.match(/\b(\d)\b/);
  return m ? Number(m[1]) : null;
}

function calcularScore(planning, data) {
  const pPrograma = normalizarTexto(planning.programa);
  const dNombre = normalizarTexto(data.nombre);
  const pTracking = normalizarTexto(planning.tracking);
  const dTracking = dNombre.includes("leadgen") ? "leadgen" : (dNombre.includes("pixel") ? "pixel" : "");
  const pIntake = extractIntakeCode(planning.intake);
  const dIntake = extractIntakeCode(data.nombre);

  let score = 0;
  if (pPrograma && (dNombre.includes(pPrograma) || pPrograma.split(" ").some((w) => w.length > 4 && dNombre.includes(w)))) score += 50;
  if (pTracking && dTracking && pTracking.includes(dTracking)) score += 30;
  if (pIntake && dIntake && pIntake === dIntake) score += 20;
  return score;
}

function getPlanningGroups() {
  const map = new Map();
  planningDraftRecords().forEach((r) => {
    const key = planningKeyFromRecord(r);
    if (!map.has(key)) map.set(key, r);
  });
  return Array.from(map.entries()).map(([key, rec]) => ({ key, rec }));
}

function getDataUniqueList() {
  return generarCampañasUnicas(getAllCampaignRows()).map((d) => ({ ...d, key: String(d.idCampania) }));
}

function relDataMatchesPlataformaFilter(u, platNorm) {
  if (!platNorm) return true;
  const n = normalizarTexto(`${u.nombre} ${u.idCampania}`);
  const p = platNorm;
  if (p.includes("meta") || p === "facebook") return n.includes("meta") || n.includes("facebook") || n.includes("ig");
  if (p.includes("google")) return n.includes("google") || n.includes("youtube") || n.includes("ads");
  if (p.includes("tiktok")) return n.includes("tiktok");
  if (p.includes("linkedin")) return n.includes("linkedin");
  return n.includes(p) || normalizarTexto(String(u.nombre || "")).includes(p);
}

function relDataMatchesTipoFilter(u, tipoNorm) {
  if (!tipoNorm) return true;
  return normalizarTexto(String(u.nombre || "")).includes(tipoNorm);
}

function getRelLinkedPlanningSet() {
  return new Set(relaciones.map((r) => r.planningKey));
}

function getRelLinkedDataSet() {
  return new Set(relaciones.map((r) => String(r.idCampania || "").trim()));
}

function getFilteredPlanningKeys() {
  const linked = getRelLinkedPlanningSet();
  const gq = normalizarTexto(relacionesSearchQuery);
  const pq = normalizarTexto(relacionesPlanningListQuery);
  const plat = normalizarTexto(relFiltroPlataforma);
  const est = relFiltroEstadoRel;
  const tipoF = normalizarTexto(relFiltroTipo);
  return getPlanningGroups()
    .map((x) => x.key)
    .filter((k) => {
      if (gq && !normalizarTexto(k).includes(gq)) return false;
      if (pq && !normalizarTexto(k).includes(pq)) return false;
      const parsed = parsePlanningKey(k);
      if (plat && normalizarTexto(parsed.plataforma) !== plat && !normalizarTexto(parsed.plataforma).includes(plat)) return false;
      if (tipoF && normalizarTexto(parsed.tipo) !== tipoF) return false;
      if (est === "con" && !linked.has(k)) return false;
      if (est === "sin" && linked.has(k)) return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b, "es"));
}

function getFilteredDataUniqueList() {
  const linked = getRelLinkedDataSet();
  const gq = normalizarTexto(relacionesSearchQuery);
  const dq = normalizarTexto(relacionesDataListQuery);
  const plat = normalizarTexto(relFiltroPlataforma);
  const est = relFiltroEstadoRel;
  const tipoF = normalizarTexto(relFiltroTipo);
  return getDataUniqueList().filter((u) => {
    const text = `${u.idCampania} ${u.nombre}`;
    if (gq && !normalizarTexto(text).includes(gq)) return false;
    if (dq && !normalizarTexto(text).includes(dq)) return false;
    if (plat && !relDataMatchesPlataformaFilter(u, plat)) return false;
    if (tipoF && !relDataMatchesTipoFilter(u, tipoF)) return false;
    if (est === "con" && !linked.has(String(u.idCampania))) return false;
    if (est === "sin" && linked.has(String(u.idCampania))) return false;
    return true;
  });
}

function refreshRelacionesFilterSelects() {
  const selPlat = document.getElementById("relFiltroPlataforma");
  const selTipo = document.getElementById("relFiltroTipo");
  if (!selPlat || !selTipo) return;
  const plats = new Set();
  const tipos = new Set();
  planningDraftRecords().forEach((r) => {
    const p = String(r.plataforma || "").trim();
    const t = String(r.tipo || "").trim();
    if (p) plats.add(p);
    if (t) tipos.add(t);
  });
  const curP = selPlat.value;
  const curT = selTipo.value;
  const platArr = Array.from(plats).sort((a, b) => a.localeCompare(b, "es"));
  const tipoArr = Array.from(tipos).sort((a, b) => a.localeCompare(b, "es"));
  selPlat.innerHTML = `<option value="">Todos</option>${platArr.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("")}`;
  selTipo.innerHTML = `<option value="">Todos</option>${tipoArr.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("")}`;
  if (platArr.includes(curP)) selPlat.value = curP;
  if (tipoArr.includes(curT)) selTipo.value = curT;
}

function relPlataformaBadgeClass(plat) {
  const p = normalizarTexto(String(plat || ""));
  if (p.includes("meta") || p.includes("facebook") || p.includes("instagram")) return "rel-plat-badge rel-plat-badge--meta";
  if (p.includes("google")) return "rel-plat-badge rel-plat-badge--google";
  if (p.includes("tiktok")) return "rel-plat-badge rel-plat-badge--tiktok";
  if (p.includes("linkedin")) return "rel-plat-badge rel-plat-badge--linkedin";
  return "rel-plat-badge rel-plat-badge--default";
}

function relTipoBadgeClass(tipo) {
  const t = normalizarTexto(String(tipo || ""));
  if (t.includes("alcance")) return "rel-tipo-badge rel-tipo-badge--alcance";
  if (t.includes("conversion") || t.includes("conv")) return "rel-tipo-badge rel-tipo-badge--conv";
  if (t.includes("trafico") || t.includes("tráfico")) return "rel-tipo-badge rel-tipo-badge--trafico";
  if (t.includes("di") || t.includes("demanda")) return "rel-tipo-badge rel-tipo-badge--di";
  return "rel-tipo-badge rel-tipo-badge--default";
}

function formatRelFechaRelDisplay(val) {
  const d = val && parseDateInput(val);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const day = d.getDate();
  const mon = MONTHS[d.getMonth()] || "";
  const y = d.getFullYear();
  return `${day} ${mon} ${y}`;
}

function relSetTrendLine(elId, prev, cur, opts = {}) {
  const { invert, suffix = "", unit = "" } = opts;
  const el = document.getElementById(elId);
  if (!el) return;
  const delta = Number(cur) - Number(prev);
  if (!Number.isFinite(delta) || delta === 0) {
    el.innerHTML = `<span class="rel-kpi-trend rel-kpi-trend--flat"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Estable vs. inicio de sesión</span>`;
    return;
  }
  const good = invert ? delta < 0 : delta > 0;
  const sign = delta > 0 ? "+" : "";
  const cls = good ? "rel-kpi-trend--up" : "rel-kpi-trend--down";
  const icon = delta > 0 ? "fa-arrow-trend-up" : "fa-arrow-trend-down";
  el.innerHTML = `<span class="rel-kpi-trend ${cls}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${sign}${delta}${unit}${suffix} vs. inicio de sesión</span>`;
}

function exportRelacionesJsonFile() {
  void showAppDialog({
    message: "La exportación a JSON está deshabilitada. Usa Publicar para persistir en el servidor.",
    primaryText: "Entendido",
    showSecondary: false,
    primaryDanger: false
  });
}

function renderRelacionesEstado() {
  syncRelacionesViewFromDraft();
  const planningGroups = getPlanningGroups();
  const dataUnique = getDataUniqueList();
  const totalPlanning = planningGroups.length;
  const totalData = dataUnique.length;
  const totalCrm = getCrmUniqueCampaignList().length;

  const planningIdsRelacionados = new Set(relaciones.map((r) => r.planningKey));
  const planningVinculadas = planningGroups.filter((p) => planningIdsRelacionados.has(p.key)).length;
  const planningSinRelacion = totalPlanning - planningVinculadas;

  const dataIdsRelacionados = new Set(relaciones.map((r) => String(r.idCampania || "").trim()));
  const dataVinculadas = dataUnique.filter((d) => dataIdsRelacionados.has(d.key)).length;
  const dataSinRelacion = totalData - dataVinculadas;

  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  setText("relPlanningVinculadas", planningVinculadas);
  setText("relPlanningSinRelacion", planningSinRelacion);
  setText("relDataVinculadas", dataVinculadas);
  setText("relDataSinRelacion", dataSinRelacion);

  const creadas = relaciones.length;
  const coberturaPct = totalPlanning > 0 ? Math.round((planningVinculadas / totalPlanning) * 1000) / 10 : 0;

  setText("relKpiCreadas", creadas);
  setText("relKpiSinRel", planningSinRelacion);
  setText("relKpiTotalPlanning", totalPlanning);
  setText("relKpiTotalData", totalData);
  setText("relKpiTotalCrm", totalCrm);
  setText("relTablaCount", creadas);
  setText("relPlanningBadgeTotal", totalPlanning);
  setText("relDataBadgeTotal", totalData);

  const pctEl = document.getElementById("relKpiCoberturaPct");
  if (pctEl) pctEl.textContent = String(Math.round(coberturaPct));
  const leadCob = document.getElementById("relKpiCoberturaLead");
  if (leadCob) leadCob.textContent = `${coberturaPct}%`;

  const donut = document.getElementById("relKpiDonutRing");
  if (donut) {
    const p = Math.max(0, Math.min(100, coberturaPct));
    donut.style.setProperty("--rel-pct", String(p / 100));
  }

  if (relKpiSessionBaseline == null) {
    relKpiSessionBaseline = {
      creadas,
      sinRel: planningSinRelacion,
      cobertura: coberturaPct,
      totalPlanning,
      totalData,
      totalCrm,
    };
  }
  const b = relKpiSessionBaseline;
  relSetTrendLine("relKpiTrendCreadas", b.creadas, creadas, {});
  relSetTrendLine("relKpiTrendSinRel", b.sinRel, planningSinRelacion, { invert: true });
  relSetTrendLine("relKpiTrendCobertura", b.cobertura, coberturaPct, { suffix: " pts cobertura" });
  relSetTrendLine("relKpiTrendPlanning", b.totalPlanning, totalPlanning, {});
  relSetTrendLine("relKpiTrendData", b.totalData, totalData, {});
  relSetTrendLine("relKpiTrendCrm", b.totalCrm ?? 0, totalCrm, {});
}

function refreshRelVincularCampaniasButton() {
  const btn = document.getElementById("relVincularCampaniasBtn");
  if (!btn || !(btn instanceof HTMLButtonElement)) return;
  const ready = selectedPlanningKeys.size === 1 && selectedDataCampaignKeys.size === 1;
  btn.disabled = !ready;
  btn.setAttribute("aria-disabled", ready ? "false" : "true");
  btn.classList.toggle("rel-vincular-btn--ready", ready);
}

function renderRelacionesPlanningList() {
  syncRelacionesViewFromDraft();
  const container = document.getElementById("relPlanningList");
  if (!container) return;
  const linked = getRelLinkedPlanningSet();
  const keys = getFilteredPlanningKeys();
  const selCount = document.getElementById("relPlanningSelectedCount");
  if (selCount) selCount.textContent = String(selectedPlanningKeys.size);
  container.innerHTML = keys.map((k) => {
    const parsed = parsePlanningKey(k);
    const metaBits = [parsed.tipo, parsed.intake, parsed.tracking].filter(Boolean);
    const meta = metaBits.length ? metaBits.join(" · ") : "—";
    const platLabel = String(parsed.plataforma || "—").trim() || "—";
    const cls = [
      "rel-item",
      selectedPlanningKeys.has(k) ? "rel-selected" : "",
      linked.has(k) ? "rel-linked-planning" : ""
    ].filter(Boolean).join(" ");
    const badgeClass = relPlataformaBadgeClass(parsed.plataforma);
    return `<div class="${cls}" data-rel-planning="${escapeHtml(k)}" role="option" aria-selected="${selectedPlanningKeys.has(k) ? "true" : "false"}">
      <span class="${badgeClass}">${escapeHtml(platLabel)}</span>
      <div class="rel-item-body">
        <div class="rel-item-title">${escapeHtml(k)}</div>
        <div class="rel-item-meta">${escapeHtml(meta)}</div>
      </div>
    </div>`;
  }).join("");
  refreshRelVincularCampaniasButton();
}

function renderRelacionesDataList() {
  syncRelacionesViewFromDraft();
  const container = document.getElementById("relDataList");
  if (!container) return;
  const linked = getRelLinkedDataSet();
  const unique = getFilteredDataUniqueList();
  const selCount = document.getElementById("relDataSelectedCount");
  if (selCount) selCount.textContent = String(selectedDataCampaignKeys.size);
  container.innerHTML = unique.map((u) => {
    const key = String(u.idCampania);
    const cls = [
      "rel-item",
      selectedDataCampaignKeys.has(key) ? "rel-selected" : "",
      linked.has(key) ? "rel-linked-data" : ""
    ].filter(Boolean).join(" ");
    return `<div class="${cls}" data-rel-data="${escapeHtml(key)}" role="option" aria-selected="${selectedDataCampaignKeys.has(key) ? "true" : "false"}">
      <div class="rel-item-body rel-item-body--data">
        <div class="rel-item-title">${escapeHtml(u.nombre || "")}</div>
        <div class="rel-item-meta rel-item-meta--id"><span class="rel-data-id">${escapeHtml(String(u.idCampania))}</span></div>
      </div>
    </div>`;
  }).join("");
  refreshRelVincularCampaniasButton();
}

function renderRelacionesTabla() {
  syncRelacionesViewFromDraft();
  const tbody = document.getElementById("relacionesTbody");
  if (!tbody) return;
  const q = normalizarTexto(relacionesSearchQuery);
  const platF = normalizarTexto(relFiltroPlataforma);
  const tipoF = normalizarTexto(relFiltroTipo);
  const estF = relFiltroEstadoRel;
  const rows = relaciones
    .map((rel, idx) => ({ rel, idx }))
    .filter(({ rel }) => {
      if (estF === "sin") return false;
      if (!q) {
        /* ok */
      } else {
        const planningTxt = normalizarTexto(String(rel.planningKey ?? ""));
        const dataTxt = normalizarTexto(String(rel.nombre ?? ""));
        const idTxt = normalizarTexto(String(rel.idCampania ?? ""));
        if (!planningTxt.includes(q) && !dataTxt.includes(q) && !idTxt.includes(q)) return false;
      }
      const parsed = parsePlanningKey(rel.planningKey);
      if (platF && !normalizarTexto(parsed.plataforma).includes(platF) && normalizarTexto(parsed.plataforma) !== platF) return false;
      if (tipoF && normalizarTexto(parsed.tipo) !== tipoF) return false;
      return true;
    });
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="dash-empty-mini">Sin relaciones para la búsqueda actual</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(({ rel, idx }) => {
    const parsed = parsePlanningKey(rel.planningKey);
    const platLabel = String(parsed.plataforma || "—").trim() || "—";
    const badgePlat = relPlataformaBadgeClass(parsed.plataforma);
    const estado = String(rel.estado || "activo").toLowerCase() === "inactivo" ? "Inactivo" : "Activo";
    const estadoCls = estado === "Activo" ? "rel-estado-badge rel-estado-badge--on" : "rel-estado-badge rel-estado-badge--off";
    return `<tr>
      <td class="rel-td-planning">${escapeHtml(rel.planningKey)}</td>
      <td class="rel-td-data">${escapeHtml(rel.nombre || "")}</td>
      <td class="rel-td-plat"><span class="${badgePlat}">${escapeHtml(platLabel)}</span></td>
      <td class="rel-td-estado"><span class="${estadoCls}">${escapeHtml(estado)}</span></td>
      <td class="rel-td-actions">
        <div class="rel-row-actions">
          <button type="button" class="rel-icon-btn" data-rel-preselect="${idx}" title="Seleccionar en listas" aria-label="Seleccionar en listas"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button type="button" class="rel-icon-btn rel-icon-btn--danger" data-rel-del="${idx}" title="Eliminar" aria-label="Eliminar relación"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function generarModeloAnalitico() {
  const out = [];
  const seen = new Set();
  const dataByCampaignId = new Map();
  ensureDataGeneralDraftShape()
    .filter((d) => rowBelongsToCurrentTeam(d))
    .forEach((d) => {
      const id = String(d.idCampania || "").trim();
      if (!id) return;
      if (!dataByCampaignId.has(id)) dataByCampaignId.set(id, []);
      dataByCampaignId.get(id).push(d);
    });

  planningDraftRecords().forEach((planning) => {
    const planningKey = planningKeyFromRecord(planning);
    const planningStart = parseDateInput(planning.fechaInicio);
    const planningEnd = parseDateInput(planning.fechaFin);
    if (!planningStart || !planningEnd || planningStart > planningEnd) return;

    const rels = getRelacionesPlataforma().filter((rel) => rel.planningKey === planningKey);
    rels.forEach((rel) => {
      const relId = String(rel.idCampania || "").trim();
      if (!relId) return;
      const campaignRows = dataByCampaignId.get(relId) || [];
      campaignRows.forEach((d) => {
        if (!(d.fecha instanceof Date)) return;
        if (d.fecha < planningStart || d.fecha > planningEnd) return;
        const rowKey = [
          planning.tipo, planning.programa, planning.intake, planning.plataforma, planning.tracking,
          formatDateInputFromDate(d.fecha), d.gasto, d.leads, d.clics, d.impresiones, relId
        ].join("||");
        if (seen.has(rowKey)) return;
        seen.add(rowKey);
        out.push({
          teamId: getCurrentTeamId(),
          tipo: planning.tipo,
          programa: planning.programa,
          intake: planning.intake,
          plataforma: planning.plataforma,
          tracking: planning.tracking,
          planningKey,
          nombre: rel.nombre || d.nombre,
          idCampania: relId,
          fecha: d.fecha,
          gasto: d.gasto,
          leads: d.leads,
          clics: d.clics,
          impresiones: d.impresiones
        });
      });
    });
  });

  modeloAnalitico = out;
}

function REGENERAR_MODELO() {
  modeloAnalitico = [];
  persistModeloState();
  generarModeloAnalitico();
  persistModeloState();
  renderModeloTabla();
  refreshSegmentadoresValues();
  refreshMedidasFiltros();
}

function aplicarFiltros(modelo, filtros) {
  return modelo.filter((r) => {
    return Object.entries(filtros || {}).every(([k, selected]) => {
      const val = k === "fechaMes" ? formatMonthYearData(r.fecha) : String(r[k] ?? "");
      if (selected instanceof Set) {
        if (selected.size === 0) return true;
        return selected.has(val);
      }
      if (selected == null || selected === "") return true;
      return String(selected) === val;
    });
  });
}

function renderModeloTabla() {
  const tbody = document.getElementById("modeloTbody");
  if (!tbody) return;
  const data = aplicarFiltros(modeloAnalitico, estadoFiltros);
  const totalReg = data.length;
  const campKeys = new Set(
    data.map((r) => [r.tipo, r.programa, r.intake, r.plataforma, r.tracking].join("||"))
  );
  const totalCampanas = campKeys.size;
  const totalInv = data.reduce((a, r) => a + (Number(r.gasto) || 0), 0);
  tbody.innerHTML = `
    <tr>
      <td>${String(totalReg)}</td>
      <td>${String(totalCampanas)}</td>
      <td>${formatCurrencyUSDData(totalInv) || "$0.00"}</td>
    </tr>
  `;
}

function uniqueVals(field) {
  const set = new Set(
    modeloAnalitico.map((r) => field === "fechaMes" ? formatMonthYearData(r.fecha) : String(r[field] ?? ""))
  );
  return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, "es"));
}

function refreshSegmentadoresValues() {
  const container = document.getElementById("segmentadoresContainer");
  if (!container) return;
  container.innerHTML = segmentadores.map((field) => {
    const values = uniqueVals(field);
    const active = estadoFiltros[field] || null;
    const title = field.charAt(0).toUpperCase() + field.slice(1);
    return `
      <div class="seg-block">
        <div class="seg-block-title">${escapeHtml(title)}</div>
        <div class="seg-block-btns">
          ${values.map((v) => `
            <button
              type="button"
              class="btn-toolbar seg-filter-btn ${active === v ? "btn-primary" : ""}"
              data-seg-field="${escapeHtml(field)}"
              data-seg-val="${escapeHtml(v)}"
            >${escapeHtml(v)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function setFechaActualData() {
  if (!dataReal.length) {
    fechaActualData = null;
    return;
  }
  fechaActualData = dataReal.reduce((max, row) => {
    if (!(row.fecha instanceof Date)) return max;
    if (!max) return row.fecha;
    return row.fecha.getTime() > max.getTime() ? row.fecha : max;
  }, null);
}

function renderFechaActualDataInfo() {
  const el = document.getElementById("fechaActualDataInfo");
  if (!el) return;
  if (!fechaActualData) {
    el.textContent = "📅 Data actualizada hasta: Sin data";
    return;
  }
  el.textContent = `📅 Data actualizada hasta: ${formatDateInputFromDate(fechaActualData)}`;
}

function computeDashboardFechaActualizacionTexto() {
  const data = ensureDataGeneralDraftShape();
  if (!data.length) return "";
  const fechas = [];
  for (const d of data) {
    if (!d || typeof d !== "object") continue;
    const dt = d.fecha instanceof Date ? d.fecha : parseFechaData(d.fecha);
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) fechas.push(dt.getTime());
  }
  if (!fechas.length) return "";
  const maxFecha = new Date(Math.max(...fechas));
  const fechaFormateada = maxFecha.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  return `Actualizado al ${fechaFormateada}`;
}

function syncDashboardCrmHeaderBadges() {
  const dash = document.getElementById("dashboardModule");
  const onDash = !!(dash && !dash.classList.contains("hidden"));
  const crmOn = onDash && getDashboardEffectiveSubtab() === "crm";
  const teamEl = document.getElementById("appTeamHeaderBadge");
  const headerFechaEl = document.getElementById("dashCrmActualizadoHeader");
  const toolbarEnd = document.querySelector("#dashboardModule .dash-toolbar-end-group");
  const operWrap = document.getElementById("dashCrmOperCardsWrap");
  const headerFechaText = headerFechaEl instanceof HTMLElement ? String(headerFechaEl.textContent || "").trim() : "";

  toolbarEnd?.classList.toggle("hidden", crmOn);
  operWrap?.classList.toggle("hidden", !crmOn);
  operWrap?.setAttribute("aria-hidden", crmOn ? "false" : "true");

  if (crmOn) {
    teamEl?.classList.add("hidden");
    if (headerFechaText) headerFechaEl?.classList.remove("hidden");
    else headerFechaEl?.classList.add("hidden");
  } else {
    headerFechaEl?.classList.add("hidden");
    if (onDash) refreshCampatrackTeamHeader();
  }
}

const DASH_CRM_OPER_TAB_LABELS = {
  gestionados: "Gestionados",
  "no-gestionados": "No gestionados",
  "no-gestionables": "No gestionables",
  contactados: "Contactados",
  "no-interesados": "No interesados",
  "en-proceso": "En proceso",
  "prom-llamadas": "Prom llamadas",
  "prom-chats": "Prom chats"
};

function applyDashboardCrmOperTabsUi() {
  document.querySelectorAll("#dashCrmOperCardsWrap .dash-crm-oper-kpi").forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    const tab = String(btn.getAttribute("data-crm-oper-tab") || "");
    const active = tab === dashboardCrmOperActiveTab;
    btn.classList.toggle("dash-crm-oper-kpi--active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function renderDashboardCrmMotivosTabla() {
  const tbody = document.getElementById("dashCrmMotivosTbody");
  const titleEl = document.getElementById("dashCrmMotivosTitle");
  if (!tbody) return;
  applyDashboardCrmIntervaloPeriodScopeUi();
  const tabLabel = DASH_CRM_OPER_TAB_LABELS[dashboardCrmOperActiveTab] || dashboardCrmOperActiveTab;
  if (titleEl) titleEl.textContent = tabLabel;
  tbody.innerHTML = `<tr><td colspan="3" class="dash-crm-motivos-empty">Vista «${escapeHtml(tabLabel)}» — datos en preparación</td></tr>`;
}

function initDashboardCrmOperTabs() {
  document.getElementById("dashCrmOperCardsWrap")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest("[data-crm-oper-tab]") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const tab = String(btn.getAttribute("data-crm-oper-tab") || "").trim();
    if (!tab || tab === dashboardCrmOperActiveTab) return;
    dashboardCrmOperActiveTab = tab;
    applyDashboardCrmOperTabsUi();
    renderDashboardCrmMotivosTabla();
  });
  applyDashboardCrmOperTabsUi();
  renderDashboardCrmMotivosTabla();
}

/** Última fecha en `appState.dataDraft.data_general` (módulo DATA). */
function mostrarFechaActualizacion() {
  const el = document.getElementById("fecha-actualizacion");
  const headerEl = document.getElementById("dashCrmActualizadoHeader");
  const text = computeDashboardFechaActualizacionTexto();
  const vaciar = () => {
    if (el) {
      el.innerText = "";
      el.classList.add("hidden");
    }
    if (headerEl) {
      headerEl.textContent = "";
      headerEl.classList.add("hidden");
    }
  };
  if (!text) {
    vaciar();
    syncDashboardCrmHeaderBadges();
    return;
  }
  const crmOn =
    (() => {
      const dash = document.getElementById("dashboardModule");
      return !!(dash && !dash.classList.contains("hidden") && getDashboardEffectiveSubtab() === "crm");
    })();
  if (el) {
    el.innerText = text;
    if (crmOn) el.classList.add("hidden");
    else el.classList.remove("hidden");
  }
  if (headerEl) {
    headerEl.textContent = text;
  }
  syncDashboardCrmHeaderBadges();
}

function ensureMedidasDefaults() {
  const autoMedidas = [
    { id: "auto_01_cpl", nombre: "CPL", formula: "div(gasto, leads)", descripcion: "Costo por lead" },
    { id: "auto_02_cpc", nombre: "CPC", formula: "div(gasto, clics)", descripcion: "Costo por clic" },
    { id: "auto_03_ctr", nombre: "CTR", formula: "div(clics, impresiones)", descripcion: "Click through rate" },
    { id: "auto_04_cvr", nombre: "CVR", formula: "div(leads, clics)", descripcion: "Conversion rate" },
    { id: "auto_05_gasto_real", nombre: "Gasto Real", formula: "gasto_real", descripcion: "Suma de gasto real" },
    { id: "auto_06_leads_real", nombre: "Leads Real", formula: "leads_real", descripcion: "Suma de leads reales" },
    { id: "auto_07_clicks", nombre: "Clicks", formula: "clicks", descripcion: "Suma de clics" },
    { id: "auto_08_impresiones", nombre: "Impresiones", formula: "impresiones_real", descripcion: "Suma de impresiones" },
    { id: "auto_09_meta_leads", nombre: "Meta Leads", formula: "meta_leads", descripcion: "Meta total de leads (planning)" },
    { id: "auto_10_presupuesto", nombre: "Presupuesto", formula: "presupuesto", descripcion: "Presupuesto total (planning)" },
    { id: "auto_11_meta_cpl", nombre: "Meta CPL", formula: "div(presupuesto, meta_leads)", descripcion: "CPL objetivo" },
    { id: "auto_12_dias_totales", nombre: "Dias Totales", formula: "dias_totales", descripcion: "Dias totales de las campañas filtradas" },
    { id: "auto_13_dias_transcurridos", nombre: "Dias Transcurridos", formula: "dias_transcurridos", descripcion: "Dias transcurridos usando fechaActualData" },
    { id: "auto_14_meta_gasto_diario", nombre: "Meta Gasto Diario", formula: "div(presupuesto, dias_totales)", descripcion: "Meta de gasto por dia" },
    { id: "auto_15_meta_leads_diario", nombre: "Meta Leads Diario", formula: "div(meta_leads, dias_totales)", descripcion: "Meta de leads por dia" },
    { id: "auto_16_gasto_diario_real", nombre: "Gasto Diario Real", formula: "div(gasto_real, dias_gasto_diario_real)", descripcion: "Con filtro de mes: gasto del mes entre dias del mes (desde inicio de campana o del mes); sin mes: gasto entre dias transcurridos de campana" },
    { id: "auto_17_leads_diario_real", nombre: "Leads Diario Real", formula: "div(leads_real, dias_leads_diario_real)", descripcion: "Con filtro de mes: leads del mes entre dias del mes (desde inicio de campana o del mes); sin mes: leads entre dias transcurridos de campana" },
    { id: "auto_18_meta_gasto_fecha", nombre: "Meta Gasto a la Fecha", formula: "meta_gasto_fecha", descripcion: "Meta acumulada de gasto a la fecha" },
    { id: "auto_19_meta_leads_fecha", nombre: "Meta Leads a la Fecha", formula: "meta_leads_fecha", descripcion: "Meta acumulada de leads a la fecha" },
    { id: "auto_20_avance_esperado_gasto", nombre: "Avance Esperado Gasto", formula: "div(meta_gasto_fecha, presupuesto)", descripcion: "Avance esperado de gasto" },
    { id: "auto_21_avance_real_gasto", nombre: "Avance Real Gasto", formula: "div(gasto_real, presupuesto)", descripcion: "Avance real de gasto" },
    { id: "auto_22_avance_leads", nombre: "Avance Leads", formula: "div(leads_real, meta_leads)", descripcion: "Avance real de leads" },
    { id: "auto_23_desviacion_gasto", nombre: "Desviacion Gasto", formula: "gasto_real - meta_gasto_fecha", descripcion: "Desviacion de gasto vs meta" },
    { id: "auto_24_leads_pendientes", nombre: "Leads Pendientes", formula: "meta_leads - leads_real", descripcion: "Leads faltantes para meta" },
    { id: "auto_25_saldo", nombre: "Saldo", formula: "presupuesto - gasto_real", descripcion: "Presupuesto restante" }
  ];

  const byId = new Map(medidas.map((m) => [m.id, m]));
  autoMedidas.forEach((m) => {
    if (!byId.has(m.id)) medidas.push(m);
  });
  const gdrMig = medidas.find((m) => m.id === "auto_16_gasto_diario_real");
  if (gdrMig && gdrMig.formula === "div(gasto_real, dias_transcurridos)") {
    const refGdr = autoMedidas.find((m) => m.id === "auto_16_gasto_diario_real");
    gdrMig.formula = refGdr?.formula || "div(gasto_real, dias_gasto_diario_real)";
    if (refGdr?.descripcion) gdrMig.descripcion = refGdr.descripcion;
  }
  const ldrMig = medidas.find((m) => m.id === "auto_17_leads_diario_real");
  if (ldrMig && ldrMig.formula === "div(leads_real, dias_transcurridos)") {
    const refLdr = autoMedidas.find((m) => m.id === "auto_17_leads_diario_real");
    ldrMig.formula = refLdr?.formula || "div(leads_real, dias_leads_diario_real)";
    if (refLdr?.descripcion) ldrMig.descripcion = refLdr.descripcion;
  }
  persistMedidasState();
}

function parseMonthYearData(value) {
  const v = String(value || "").trim();
  const m = v.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const monthIndex = MONTHS_EN_SHORT.findIndex((x) => x === m[1]);
  const year = Number(m[2]);
  if (monthIndex < 0 || !Number.isFinite(year)) return null;
  return { year, monthIndex };
}

function getDaysTotalInclusive(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date) || start > end) return 0;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12, 0, 0);
  return Math.floor((e - s) / 86400000) + 1;
}

function getDaysElapsedInclusive(start, end, currentDate) {
  if (!(start instanceof Date) || !(end instanceof Date) || start > end || !(currentDate instanceof Date)) return 0;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12, 0, 0);
  const c = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 12, 0, 0);
  if (c < s) return 0;
  if (c > e) return getDaysTotalInclusive(s, e);
  return Math.floor((c - s) / 86400000) + 1;
}

function buildDataAgrupadaConTiempo(rows, mesFiltro) {
  const grouped = rows.reduce((acc, r) => {
    acc.gasto += Number(r.gasto) || 0;
    acc.leads += Number(r.leads) || 0;
    acc.clics += Number(r.clics) || 0;
    acc.impresiones += Number(r.impresiones) || 0;
    return acc;
  }, { gasto: 0, leads: 0, clics: 0, impresiones: 0 });

  const planningKeys = new Set(
    rows.map((r) => [r.tipo, r.programa, r.intake, r.plataforma, r.tracking].join("||"))
  );

  let presupuesto = 0;
  let metaLeads = 0;
  let diasTotalesAcum = 0;
  let diasTranscurridosAcum = 0;
  let fechaInicioMin = null;
  let fechaFinMax = null;
  let metaGastoFecha = 0;
  let metaLeadsFecha = 0;
  let metaGastoMesFecha = 0;
  let metaLeadsMesFecha = 0;
  const parsedMes = parseMonthYearData(mesFiltro);
  let fechaInicioRealMinGastoMes = null;

  planningKeys.forEach((key) => {
    const [tipo, programa, intake, plataforma, tracking] = key.split("||");
    const rec = planningDraftRecords().find((r) =>
      String(r.tipo) === tipo &&
      String(r.programa) === programa &&
      String(r.intake) === intake &&
      String(r.plataforma) === plataforma &&
      String(r.tracking) === tracking
    );
    if (!rec) return;

    const start = parseDateInput(rec.fechaInicio);
    const end = parseDateInput(rec.fechaFin);
    const diasTotales = getDaysTotalInclusive(start, end);
    if (!diasTotales) return;

    const recPresupuesto = Number(rec.presupuesto) || 0;
    const recMetaLeads = Number(rec.leads) || 0;
    const diasTranscurridos = getDaysElapsedInclusive(start, end, fechaActualData);
    diasTotalesAcum += diasTotales;
    diasTranscurridosAcum += diasTranscurridos;
    if (!fechaInicioMin || start < fechaInicioMin) fechaInicioMin = start;
    if (!fechaFinMax || end > fechaFinMax) fechaFinMax = end;

    presupuesto += recPresupuesto;
    metaLeads += recMetaLeads;
    metaGastoFecha += (recPresupuesto / diasTotales) * diasTranscurridos;
    metaLeadsFecha += (recMetaLeads / diasTotales) * diasTranscurridos;

    if (parsedMes) {
      const diasMes = countDaysInMonthIntersection(start, end, parsedMes.year, parsedMes.monthIndex);
      if (diasMes > 0) {
        const mesStart = new Date(parsedMes.year, parsedMes.monthIndex, 1);
        const mesEnd = new Date(parsedMes.year, parsedMes.monthIndex + 1, 0);
        const mesStartNoon = new Date(parsedMes.year, parsedMes.monthIndex, 1, 12, 0, 0);
        const sNoon = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0);
        const fechaInicioRealCamp = sNoon > mesStartNoon ? sNoon : mesStartNoon;
        if (fechaInicioRealMinGastoMes === null || fechaInicioRealCamp < fechaInicioRealMinGastoMes) {
          fechaInicioRealMinGastoMes = fechaInicioRealCamp;
        }
        const cappedEnd = fechaActualData && fechaActualData < mesEnd ? fechaActualData : mesEnd;
        const diasTransMes = getDaysElapsedInclusive(mesStart, mesEnd, cappedEnd);
        const diasTranscurridosMes = Math.max(0, Math.min(diasMes, diasTransMes));
        const metaGastoMes = (recPresupuesto / diasTotales) * diasMes;
        const metaLeadsMes = (recMetaLeads / diasTotales) * diasMes;
        metaGastoMesFecha += diasMes ? (metaGastoMes / diasMes) * diasTranscurridosMes : 0;
        metaLeadsMesFecha += diasMes ? (metaLeadsMes / diasMes) * diasTranscurridosMes : 0;
      }
    }
  });

  let diasGastoDiarioReal = diasTranscurridosAcum;
  if (parsedMes) {
    const mesStartAll = new Date(parsedMes.year, parsedMes.monthIndex, 1, 12, 0, 0);
    const mesEndAll = new Date(parsedMes.year, parsedMes.monthIndex + 1, 0, 12, 0, 0);
    let fechaUltimaData = mesEndAll;
    if (fechaActualData instanceof Date) {
      const u = new Date(fechaActualData.getFullYear(), fechaActualData.getMonth(), fechaActualData.getDate(), 12, 0, 0);
      fechaUltimaData = u < mesStartAll ? mesStartAll : (u > mesEndAll ? mesEndAll : u);
    }
    const fechaInicioReal = fechaInicioRealMinGastoMes != null ? fechaInicioRealMinGastoMes : mesStartAll;
    diasGastoDiarioReal =
      fechaInicioReal > fechaUltimaData ? 1 : Math.max(1, getDaysTotalInclusive(fechaInicioReal, fechaUltimaData));
  }

  const avanceEsperadoGasto = presupuesto > 0 ? (metaGastoFecha / presupuesto) : 0;
  const avanceRealGasto = presupuesto > 0 ? (grouped.gasto / presupuesto) : 0;
  const desviacionGasto = grouped.gasto - metaGastoFecha;
  const gastoDiarioReal = diasGastoDiarioReal > 0 ? grouped.gasto / diasGastoDiarioReal : 0;
  const diasLeadsDiarioReal = diasGastoDiarioReal;
  const leadsDiarioReal = diasLeadsDiarioReal > 0 ? grouped.leads / diasLeadsDiarioReal : 0;
  const metaGastoDiario = diasTotalesAcum > 0 ? presupuesto / diasTotalesAcum : 0;
  const metaLeadsDiario = diasTotalesAcum > 0 ? metaLeads / diasTotalesAcum : 0;

  return {
    ...grouped,
    gasto_real: grouped.gasto,
    leads_real: grouped.leads,
    clicks: grouped.clics,
    impresiones_real: grouped.impresiones,
    presupuesto,
    meta_leads: metaLeads,
    fecha_inicio: fechaInicioMin ? formatDateInputFromDate(fechaInicioMin) : "",
    fecha_fin: fechaFinMax ? formatDateInputFromDate(fechaFinMax) : "",
    dias_totales: diasTotalesAcum,
    dias_transcurridos: diasTranscurridosAcum,
    dias_gasto_diario_real: diasGastoDiarioReal,
    dias_leads_diario_real: diasLeadsDiarioReal,
    meta_gasto_diario: metaGastoDiario,
    meta_leads_diario: metaLeadsDiario,
    gasto_diario_real: gastoDiarioReal,
    leads_diario_real: leadsDiarioReal,
    meta_gasto_fecha: metaGastoFecha,
    meta_leads_fecha: metaLeadsFecha,
    avance_esperado_gasto: avanceEsperadoGasto,
    avance_real_gasto: avanceRealGasto,
    desviacion_gasto: desviacionGasto,
    meta_gasto_mes_fecha: metaGastoMesFecha,
    meta_leads_mes_fecha: metaLeadsMesFecha
  };
}

function evaluarMedida(formula, data) {
  try {
    const div = (a, b) => {
      const na = Number(a) || 0;
      const nb = Number(b) || 0;
      return nb === 0 ? 0 : na / nb;
    };
    const fn = new Function(
      "div",
      "gasto",
      "leads",
      "clics",
      "impresiones",
      "gasto_real",
      "leads_real",
      "clicks",
      "impresiones_real",
      "presupuesto",
      "meta_leads",
      "fecha_inicio",
      "fecha_fin",
      "dias_totales",
      "dias_transcurridos",
      "dias_gasto_diario_real",
      "dias_leads_diario_real",
      "meta_gasto_diario",
      "meta_leads_diario",
      "gasto_diario_real",
      "leads_diario_real",
      "meta_gasto_fecha",
      "meta_leads_fecha",
      "avance_esperado_gasto",
      "avance_real_gasto",
      "desviacion_gasto",
      "meta_gasto_mes_fecha",
      "meta_leads_mes_fecha",
      `"use strict"; return (${formula});`
    );
    const res = fn(
      div,
      Number(data.gasto) || 0,
      Number(data.leads) || 0,
      Number(data.clics) || 0,
      Number(data.impresiones) || 0,
      Number(data.gasto_real) || 0,
      Number(data.leads_real) || 0,
      Number(data.clicks) || 0,
      Number(data.impresiones_real) || 0,
      Number(data.presupuesto) || 0,
      Number(data.meta_leads) || 0,
      String(data.fecha_inicio || ""),
      String(data.fecha_fin || ""),
      Number(data.dias_totales) || 0,
      Number(data.dias_transcurridos) || 0,
      Number(data.dias_gasto_diario_real) || 0,
      Number(data.dias_leads_diario_real) || 0,
      Number(data.meta_gasto_diario) || 0,
      Number(data.meta_leads_diario) || 0,
      Number(data.gasto_diario_real) || 0,
      Number(data.leads_diario_real) || 0,
      Number(data.meta_gasto_fecha) || 0,
      Number(data.meta_leads_fecha) || 0,
      Number(data.avance_esperado_gasto) || 0,
      Number(data.avance_real_gasto) || 0,
      Number(data.desviacion_gasto) || 0,
      Number(data.meta_gasto_mes_fecha) || 0,
      Number(data.meta_leads_mes_fecha) || 0
    );
    return Number.isFinite(res) ? res : 0;
  } catch {
    throw new Error("Error evaluando fórmula");
  }
}

function refreshMedidasFiltros() {
  ensureMedidasDefaults();
  setFechaActualData();
  renderFechaActualDataInfo();

  const selMed = document.getElementById("medidaSelect");
  if (selMed) {
    const current = selMed.value;
    selMed.innerHTML = medidas
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.nombre)} = ${escapeHtml(m.formula)}</option>`)
      .join("");
    if (medidas.some((m) => m.id === current)) selMed.value = current;
  }

  const fill = (id, vals) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = `<option value="">Todos</option>` + vals.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    if (vals.includes(cur)) el.value = cur;
  };
  fill("medidaFiltroTipo", uniqueVals("tipo"));
  fill("medidaFiltroPrograma", uniqueVals("programa"));
  fill("medidaFiltroIntake", uniqueVals("intake"));
  fill("medidaFiltroMes", uniqueVals("fechaMes"));
}

function renderMedidasTabla() {
  const tbody = document.getElementById("medidasTbody");
  if (!tbody) return;
  ensureMedidasDefaults();
  tbody.innerHTML = medidas
    .map((m) => `
      <tr>
        <td>${escapeHtml(m.nombre)}</td>
        <td>${escapeHtml(m.formula)}</td>
        <td>${escapeHtml(m.descripcion || "")}</td>
        <td>
          <button type="button" class="btn-toolbar" data-med-edit="${escapeHtml(m.id)}">Editar</button>
          <button type="button" class="btn-toolbar btn-danger" data-med-del="${escapeHtml(m.id)}">Eliminar</button>
        </td>
      </tr>
    `)
    .join("");
}

function initMedidasModule() {
  const form = document.getElementById("medidaForm");
  const modal = document.getElementById("medidaModal");
  const openBtn = document.getElementById("addMedidaBtn");
  const cancelBtn = document.getElementById("cancelMedidaBtn");
  const errorEl = document.getElementById("medidaFormError");
  const nombreInput = document.getElementById("medidaNombre");
  const formulaInput = document.getElementById("medidaFormula");
  const descInput = document.getElementById("medidaDescripcion");
  const idInput = document.getElementById("medidaId");

  function openModal(medida) {
    if (!modal || !form) return;
    const editing = Boolean(medida);
    const title = document.getElementById("medidaModalTitle");
    if (title) title.textContent = editing ? "Editar medida" : "Crear medida";
    idInput.value = editing ? medida.id : "";
    nombreInput.value = editing ? medida.nombre : "";
    formulaInput.value = editing ? medida.formula : "";
    descInput.value = editing ? (medida.descripcion || "") : "";
    errorEl.classList.add("hidden");
    modal.classList.remove("hidden");
  }

  function closeModal() {
    if (!modal || !form) return;
    form.reset();
    errorEl.classList.add("hidden");
    modal.classList.add("hidden");
  }

  openBtn?.addEventListener("click", () => openModal(null));
  cancelBtn?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const nombre = nombreInput.value.trim();
    const formula = formulaInput.value.trim();
    const descripcion = descInput.value.trim();
    if (!nombre || !formula) {
      errorEl.textContent = "Nombre y fórmula son obligatorios.";
      errorEl.classList.remove("hidden");
      return;
    }
    try {
      evaluarMedida(formula, {
        gasto: 1, leads: 1, clics: 1, impresiones: 1, presupuesto: 1, meta_leads: 1,
        gasto_real: 1, leads_real: 1, clicks: 1, impresiones_real: 1,
        fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31", dias_totales: 365, dias_transcurridos: 1,
        dias_gasto_diario_real: 1,
        dias_leads_diario_real: 1,
        meta_gasto_diario: 1, meta_leads_diario: 1, gasto_diario_real: 1, leads_diario_real: 1,
        meta_gasto_fecha: 1, meta_leads_fecha: 1, avance_esperado_gasto: 1, avance_real_gasto: 1,
        desviacion_gasto: 0, meta_gasto_mes_fecha: 1, meta_leads_mes_fecha: 1
      });
    } catch {
      errorEl.textContent = "Error en la fórmula. Revisa la sintaxis.";
      errorEl.classList.remove("hidden");
      return;
    }
    const existingId = idInput.value;
    if (existingId) {
      const idx = medidas.findIndex((m) => m.id === existingId);
      if (idx >= 0) medidas[idx] = { ...medidas[idx], nombre, formula, descripcion, teamId: getCurrentTeamId() };
    } else {
      const id = `med_${Date.now()}_${medidas.length}`;
      medidas.push({ id, nombre, formula, descripcion, teamId: getCurrentTeamId() });
    }
    persistMedidasState();
    closeModal();
    renderMedidasTabla();
    refreshMedidasFiltros();
  });

  document.getElementById("medidasTbody")?.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const editBtn = t.closest("[data-med-edit]");
    const delBtn = t.closest("[data-med-del]");
    if (editBtn) {
      const id = editBtn.getAttribute("data-med-edit");
      const m = medidas.find((mm) => mm.id === id);
      if (m) openModal(m);
      return;
    }
    if (delBtn) {
      const id = delBtn.getAttribute("data-med-del");
      medidas = medidas.filter((m) => m.id !== id);
      persistMedidasState();
      renderMedidasTabla();
      refreshMedidasFiltros();
    }
  });

  refreshMedidasFiltros();
  renderMedidasTabla();

  document.getElementById("calcMedidaBtn")?.addEventListener("click", () => {
    setFechaActualData();
    renderFechaActualDataInfo();

    const medidaId = document.getElementById("medidaSelect")?.value || "";
    const medida = medidas.find((m) => m.id === medidaId);
    const formula = medida?.formula || "gasto / leads";
    const mesFiltro = document.getElementById("medidaFiltroMes")?.value || "";

    const filtros = {
      tipo: new Set((document.getElementById("medidaFiltroTipo")?.value || "") ? [document.getElementById("medidaFiltroTipo").value] : []),
      programa: new Set((document.getElementById("medidaFiltroPrograma")?.value || "") ? [document.getElementById("medidaFiltroPrograma").value] : []),
      intake: new Set((document.getElementById("medidaFiltroIntake")?.value || "") ? [document.getElementById("medidaFiltroIntake").value] : []),
      fechaMes: new Set(mesFiltro ? [mesFiltro] : [])
    };

    const data = aplicarFiltros(modeloAnalitico, filtros);
    const dataAgrupada = buildDataAgrupadaConTiempo(data, mesFiltro);

    const resultEl = document.getElementById("medidaResult");
    const errEl = document.getElementById("medidaError");
    if (!resultEl || !errEl) return;
    try {
      const result = evaluarMedida(formula, dataAgrupada);
      errEl.classList.add("hidden");
      resultEl.textContent = formatNumberSmartData(result);
    } catch {
      resultEl.textContent = "0";
      errEl.textContent = "Error en fórmula";
      errEl.classList.remove("hidden");
    }
  });
}

function vincularCampanias() {
  if (!selectedPlanningKeys.size || !selectedDataCampaignKeys.size) return;
  const latestNameById = getLatestCampaignNameMap(getAllCampaignRows());
  const fechaRelacion = formatDateInputFromDate(new Date());
  selectedPlanningKeys.forEach((planningKey) => {
    selectedDataCampaignKeys.forEach((key) => {
      const idCampania = String(key || "").trim();
      if (!idCampania) return;
      const nombre = latestNameById.get(idCampania) || "";
      const exists = ensureRelacionesDraftShape().some(
        (r) =>
          r.planningKey === planningKey &&
          String(r.idCampania || "").trim() === idCampania
      );
      if (exists) return;
      const planningRec = getPlanningGroups().find((g) => g.key === planningKey)?.rec;
      const dataRow = getDataUniqueList().find((d) => String(d.idCampania) === idCampania);
      const coincidencia = planningRec && dataRow ? calcularScore(planningRec, dataRow) : null;
      ensureRelacionesDraftShape().push({
        planningKey,
        idCampania,
        nombre,
        fechaRelacion,
        estado: "activo",
        ...(coincidencia != null ? { coincidencia } : {}),
      });
    });
  });
  selectedDataCampaignKeys = new Set();
  selectedPlanningKeys = new Set();
  persistRelacionesState();
  renderRelacionesDataList();
  renderRelacionesTabla();
  renderRelacionesPlanningList();
  renderRelacionesEstado();
}

function sugerirRelaciones() {
  const planningGroups = getPlanningGroups();
  const dataUnique = getDataUniqueList();

  sugerenciasRelaciones = planningGroups.map((p) => {
    const planning = parsePlanningKey(p.key);
    const matches = dataUnique
      .map((d) => ({ ...d, score: calcularScore(planning, d) }))
      .filter((d) => d.score >= 70)
      .sort((a, b) => b.score - a.score);
    return { planningKey: p.key, matches };
  }).filter((x) => x.matches.length > 0);

  renderSugerencias();
}

function renderSugerencias() {
  const box = document.getElementById("relSuggestBox");
  const tbody = document.getElementById("relSuggestTbody");
  if (!box || !tbody) return;
  if (!sugerenciasRelaciones.length) {
    box.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  tbody.innerHTML = sugerenciasRelaciones.map((s, idx) => `
    <tr>
      <td>${escapeHtml(s.planningKey)}</td>
      <td>
        <div class="rel-suggest-list">
          ${s.matches.map((m) => `
            <label class="rel-suggest-pill">
              <input type="checkbox" data-sug-idx="${idx}" data-sug-data="${escapeHtml(m.key)}" checked />
              ${escapeHtml(m.idCampania)} (${m.score})
            </label>
          `).join("")}
        </div>
      </td>
      <td><button class="btn-toolbar btn-primary" type="button" data-sug-apply="${idx}">Aplicar sugerencia</button></td>
    </tr>
  `).join("");
}

function aplicarSugerencia(idx) {
  const sug = sugerenciasRelaciones[idx];
  if (!sug) return;
  const tbody = document.getElementById("relSuggestTbody");
  if (!tbody) return;
  const checks = tbody.querySelectorAll(`input[data-sug-idx="${idx}"][data-sug-data]:checked`);
  const latestNameById = getLatestCampaignNameMap(getAllCampaignRows());
  const fechaRelacion = formatDateInputFromDate(new Date());
  const planningRec = getPlanningGroups().find((g) => g.key === sug.planningKey)?.rec;
  checks.forEach((c) => {
    const key = c.getAttribute("data-sug-data");
    if (!key) return;
    const idCampania = String(key || "").trim();
    if (!idCampania) return;
    const nombre = latestNameById.get(idCampania) || "";
    const exists = ensureRelacionesDraftShape().some(
      (r) =>
        r.planningKey === sug.planningKey &&
        String(r.idCampania || "").trim() === idCampania
    );
    if (!exists) {
      const dataRow = getDataUniqueList().find((d) => String(d.idCampania) === idCampania);
      const coincidencia = planningRec && dataRow ? calcularScore(planningRec, dataRow) : null;
      ensureRelacionesDraftShape().push({
        planningKey: sug.planningKey,
        idCampania,
        nombre,
        fechaRelacion,
        estado: "activo",
        ...(coincidencia != null ? { coincidencia } : {}),
      });
    }
  });
  persistRelacionesState();
  renderRelacionesPlanningList();
  renderRelacionesDataList();
  renderRelacionesTabla();
  renderRelacionesEstado();
}

function initRelacionesModule() {
  const relacionesSearchInput = document.getElementById("relacionesSearch");
  relacionesSearchInput?.addEventListener("input", () => {
    relacionesSearchQuery = String(relacionesSearchInput.value || "").trim();
    renderRelacionesPlanningList();
    renderRelacionesDataList();
    renderRelacionesTabla();
  });
  document.getElementById("relPlanningSearch")?.addEventListener("input", (ev) => {
    const t = ev.target;
    relacionesPlanningListQuery = t instanceof HTMLInputElement ? String(t.value || "").trim() : "";
    renderRelacionesPlanningList();
  });
  document.getElementById("relDataSearch")?.addEventListener("input", (ev) => {
    const t = ev.target;
    relacionesDataListQuery = t instanceof HTMLInputElement ? String(t.value || "").trim() : "";
    renderRelacionesDataList();
  });
  const onBarFilterChange = () => {
    const p = document.getElementById("relFiltroPlataforma");
    const e = document.getElementById("relFiltroEstadoRel");
    const t = document.getElementById("relFiltroTipo");
    relFiltroPlataforma = p instanceof HTMLSelectElement ? String(p.value || "").trim() : "";
    relFiltroEstadoRel = e instanceof HTMLSelectElement ? String(e.value || "").trim() : "";
    relFiltroTipo = t instanceof HTMLSelectElement ? String(t.value || "").trim() : "";
    renderRelacionesPlanningList();
    renderRelacionesDataList();
    renderRelacionesTabla();
  };
  document.getElementById("relFiltroPlataforma")?.addEventListener("change", onBarFilterChange);
  document.getElementById("relFiltroEstadoRel")?.addEventListener("change", onBarFilterChange);
  document.getElementById("relFiltroTipo")?.addEventListener("change", onBarFilterChange);

  document.getElementById("relLimpiarFiltrosBtn")?.addEventListener("click", () => {
    relacionesSearchQuery = "";
    relacionesPlanningListQuery = "";
    relacionesDataListQuery = "";
    relFiltroPlataforma = "";
    relFiltroEstadoRel = "";
    relFiltroTipo = "";
    if (relacionesSearchInput instanceof HTMLInputElement) relacionesSearchInput.value = "";
    const ps = document.getElementById("relPlanningSearch");
    const ds = document.getElementById("relDataSearch");
    if (ps instanceof HTMLInputElement) ps.value = "";
    if (ds instanceof HTMLInputElement) ds.value = "";
    const p = document.getElementById("relFiltroPlataforma");
    const e = document.getElementById("relFiltroEstadoRel");
    const t = document.getElementById("relFiltroTipo");
    if (p instanceof HTMLSelectElement) p.value = "";
    if (e instanceof HTMLSelectElement) e.value = "";
    if (t instanceof HTMLSelectElement) t.value = "";
    renderRelacionesPlanningList();
    renderRelacionesDataList();
    renderRelacionesTabla();
  });

  document.getElementById("relFiltrosAvanzadosBtn")?.addEventListener("click", () => {
    const panel = document.getElementById("relFiltrosAvanzadosPanel");
    const btn = document.getElementById("relFiltrosAvanzadosBtn");
    if (!panel) return;
    panel.classList.toggle("hidden");
    const nowHidden = panel.classList.contains("hidden");
    panel.setAttribute("aria-hidden", nowHidden ? "true" : "false");
    if (btn) btn.setAttribute("aria-expanded", nowHidden ? "false" : "true");
  });

  document.getElementById("relSelectAllPlanningBtn")?.addEventListener("click", () => {
    selectedPlanningKeys = new Set(getFilteredPlanningKeys());
    renderRelacionesPlanningList();
  });
  document.getElementById("relSelectAllDataBtn")?.addEventListener("click", () => {
    selectedDataCampaignKeys = new Set(getFilteredDataUniqueList().map((u) => String(u.idCampania)));
    renderRelacionesDataList();
  });

  document.getElementById("relPlanningList")?.addEventListener("click", (e) => {
    const el = e.target instanceof HTMLElement ? e.target.closest("[data-rel-planning]") : null;
    if (!el) return;
    const k = el.getAttribute("data-rel-planning");
    if (!k) return;
    if (selectedPlanningKeys.has(k)) selectedPlanningKeys.delete(k);
    else selectedPlanningKeys.add(k);
    renderRelacionesPlanningList();
  });
  document.getElementById("relDataList")?.addEventListener("click", (e) => {
    const el = e.target instanceof HTMLElement ? e.target.closest("[data-rel-data]") : null;
    if (!el) return;
    const key = el.getAttribute("data-rel-data");
    if (!key) return;
    if (selectedDataCampaignKeys.has(key)) selectedDataCampaignKeys.delete(key);
    else selectedDataCampaignKeys.add(key);
    renderRelacionesDataList();
  });
  document.getElementById("relVincularCampaniasBtn")?.addEventListener("click", () => {
    if (selectedPlanningKeys.size !== 1 || selectedDataCampaignKeys.size !== 1) return;
    vincularCampanias();
  });
  document.getElementById("relacionesTbody")?.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const pre = t?.closest("[data-rel-preselect]");
    if (pre) {
      const idx = Number(pre.getAttribute("data-rel-preselect"));
      const rel = Number.isFinite(idx) ? relaciones[idx] : null;
      if (rel) {
        selectedPlanningKeys = new Set([rel.planningKey]);
        selectedDataCampaignKeys = new Set([String(rel.idCampania || "").trim()]);
        renderRelacionesPlanningList();
        renderRelacionesDataList();
      }
      return;
    }
    const btn = t?.closest("[data-rel-del]");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-rel-del"));
    if (Number.isFinite(idx)) {
      const rel = relaciones[idx];
      if (rel) {
        const dg = ensureRelacionesDraftShape();
        const j = dg.indexOf(rel);
        if (j >= 0) dg.splice(j, 1);
      }
      syncRelacionesViewFromDraft();
      persistRelacionesState();
      renderRelacionesTabla();
      renderRelacionesPlanningList();
      renderRelacionesDataList();
      renderRelacionesEstado();
    }
  });
  document.getElementById("relSuggestTbody")?.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest("[data-sug-apply]") : null;
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-sug-apply"));
    if (Number.isFinite(idx)) aplicarSugerencia(idx);
  });
  refreshRelVincularCampaniasButton();
  initRelSubTabs();
}

function dashboardMonthKeyToLabel(key) {
  if (!key) return "Todos";
  const parts = String(key).split("-");
  if (parts.length < 2) return key;
  const mi = MONTHS_EN_SHORT.indexOf(parts[0]);
  const y = parts[1];
  const nombre = mi >= 0 ? MESES_LARGOS_ES[mi] : parts[0];
  return `${nombre} ${y}`;
}

function dashboardMonthKeyBounds(key) {
  if (!key) return null;
  const parts = String(key).split("-");
  if (parts.length < 2) return null;
  const mi = MONTHS_EN_SHORT.indexOf(parts[0]);
  const y = Number(parts[1]);
  if (mi < 0 || !Number.isFinite(y)) return null;
  const first = new Date(y, mi, 1);
  const last = new Date(y, mi + 1, 0);
  return { min: formatDateInputFromDate(first), max: formatDateInputFromDate(last) };
}

function formatFechaDdMmmEsFromDate(d) {
  if (!(d instanceof Date)) return "";
  const day = String(d.getDate()).padStart(2, "0");
  return `${day}-${MONTHS[d.getMonth()] || ""}`;
}

function dashFmt2(n) {
  if (!Number.isFinite(Number(n))) return "0";
  return String(Math.round(Number(n)));
}

function dashFmtLeads(n) {
  return String(Math.round(Number(n) || 0));
}

function dashFmtPct(n) {
  if (!Number.isFinite(Number(n))) return "0%";
  return `${Math.round(Number(n) * 100)}%`;
}

function dashFmtPctFromRatio(n) {
  if (!Number.isFinite(Number(n))) return "—";
  return dashFmtPct(n);
}

function dashFmtMoney(n) {
  const value = Math.round(Number(n) || 0);
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

/** Tarjeta KPI Presupuesto: moneda con 2 decimales (ej. $39,425.00). */
function dashFmtMoneyKpiMain(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** Tarjeta KPI Leads: entero con separador de miles. */
function dashFmtLeadsKpiMain(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-US");
}

/** Valor numérico con 2 decimales fijos (CPL KPI, etc.). */
function dashFmtDecimalFixed2(n) {
  if (!Number.isFinite(Number(n))) return "0.00";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Ratio 0–1 → porcentaje con 2 decimales (CTR, CVR en KPI). */
function dashFmtPctFixed2FromRatio(n) {
  if (!Number.isFinite(Number(n))) return "0.00%";
  const pct = Number(n) * 100;
  return `${pct.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/** CPC u otro importe pequeño en USD con 2 decimales (ej. $0.66). */
function dashFmtMoneyFixed2(n) {
  if (!Number.isFinite(Number(n))) return "$0.00";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dashFmtSignedMoneyFixed2(n) {
  if (!Number.isFinite(Number(n))) return "$0.00";
  const value = Number(n);
  const absFmt = dashFmtMoneyFixed2(Math.abs(value));
  if (value > 0) return `+${absFmt}`;
  if (value < 0) return `-${absFmt}`;
  return absFmt;
}

function dashFmtSignedMoney(n) {
  if (!Number.isFinite(Number(n))) return "$0";
  const value = Number(n);
  const absFmt = dashFmtMoney(Math.abs(value));
  if (value > 0) return `+${absFmt}`;
  if (value < 0) return `-${absFmt}`;
  return absFmt;
}

function dashCplRealColorClass(metaCpl, cplReal) {
  if (!(metaCpl > 0) || !Number.isFinite(cplReal)) return "";
  const pct = ((cplReal - metaCpl) / metaCpl) * 100;
  if (pct <= 5) return "dash-cpl-green";
  if (pct <= 30) return "dash-cpl-orange";
  return "dash-cpl-red";
}

/** CPL Real del grupo LEADS (periodo): fondo según meta CPL del periodo. */
function dashCplRealLeadsPeriodClass(metaCpl, cplReal) {
  const meta = Number(metaCpl);
  const real = Number(cplReal);
  if (!Number.isFinite(meta) || meta === 0 || !Number.isFinite(real)) return "";
  if (real <= meta) return "dash-cpl-real-mes-ok";
  if (real <= meta * 1.3) return "dash-cpl-real-mes-warn";
  return "dash-cpl-real-mes-bad";
}

/**
 * Semáforo texto/fondo para % Avance Real vs % ideal (Planning en fecha).
 * Leads: misma regla que muestra la tabla — `dashFmtPct` redondea puntos porcentuales con `Math.round(ratio * 100)`;
 * verde si el entero mostrado de real ≥ el de ideal (16 % vs 16 % → cumplido).
 * Gasto: verde si no sobrepaso material vs ideal (margen histórico 2 %) sobre ratios.
 */
function dashPctPointsFromDashboardRatio(r) {
  return Math.round(Number(r) * 100);
}

function dashSemMetaG1(pctIdeal, pctReal, kind) {
  if (!Number.isFinite(pctIdeal) || !Number.isFinite(pctReal)) return "";
  if (kind === "leads") {
    const idealPts = dashPctPointsFromDashboardRatio(pctIdeal);
    const realPts = dashPctPointsFromDashboardRatio(pctReal);
    return realPts >= idealPts ? "dash-sem-good" : "dash-sem-bad";
  }
  return pctReal <= pctIdeal * 1.02 ? "dash-sem-good" : "dash-sem-bad";
}

function ensureDashboardInitialMonth() {
  if (dashboardFiltrosInicializados) return;
  setFechaActualData();
  const ref = fechaActualData instanceof Date ? fechaActualData : new Date();
  const key = formatMonthYearData(ref);
  estadoFiltrosDashboard.mes = key;
  const b = dashboardMonthKeyBounds(key);
  if (b) {
    estadoFiltrosDashboard.fechaInicio = b.min;
    estadoFiltrosDashboard.fechaFin = b.max;
  }
  dashboardFiltrosInicializados = true;
}

function getPlanningByPrograma(programa) {
  return planningDraftRecords().filter((r) => String(r.programa) === String(programa));
}

function toShortIntakeLabel(v) {
  const s = String(v ?? "").trim();
  const m = s.match(/(\d+)/);
  if (m) return `I${m[1]}`;
  return s;
}

function getPlanningUniqueIntakes() {
  const vals = Array.from(
    new Set(planningDraftRecords().map((r) => String(r.intake ?? "").trim()).filter(Boolean))
  );
  return vals.sort((a, b) => {
    const na = Number((a.match(/(\d+)/) || [])[1]);
    const nb = Number((b.match(/(\d+)/) || [])[1]);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b, "es");
  });
}

function dashboardRowKeyFromModelo(r) {
  return `${String(r.tipo ?? "")}|||${String(r.programa ?? "")}|||${String(r.intake ?? "")}|||${String(r.tracking ?? "")}|||${String(r.plataforma ?? "")}`;
}

function parseDashboardRowKey(key) {
  const parts = String(key).split("|||");
  return {
    tipo: parts[0] || "",
    programa: parts[1] || "",
    intake: parts[2] || "",
    tracking: parts[3] || "",
    plataforma: parts[4] || ""
  };
}

/** Alinea la clave de planning (`tipo | programa | intake | plataforma | tracking`) con la del dashboard. */
function planningKeyToDashboardRowKey(planningKey) {
  const p = parsePlanningKey(planningKey);
  return `${String(p.tipo ?? "")}|||${String(p.programa ?? "")}|||${String(p.intake ?? "")}|||${String(p.tracking ?? "")}|||${String(p.plataforma ?? "")}`;
}

/** Texto para búsqueda en toolbar (incluye programa, tracking, intake y plataforma). */
function dashboardRowSearchHaystackFromKey(key) {
  const row = parseDashboardRowKey(key);
  return [row.tipo, row.programa, row.tracking, row.intake, row.plataforma].filter(Boolean).join(" ").toLowerCase();
}

/** Columna Programa del dashboard: "Programa - Tracking". */
function dashboardRowProgramaNombreFromKey(key) {
  const row = parseDashboardRowKey(key);
  const programa = String(row.programa ?? "").trim();
  const tracking = String(row.tracking ?? "").trim();
  if (!programa && !tracking) return "—";
  if (!tracking) return programa;
  if (!programa) return tracking;
  return `${programa} - ${tracking}`;
}

function dashboardRowIntakeDisplayFromKey(key) {
  const row = parseDashboardRowKey(key);
  const intake = String(row.intake ?? "").trim();
  if (!intake) return "";
  const digits = intake.replace(/[^0-9]/g, "");
  if (!digits) return "—";
  return `I${digits}`;
}

/** Badge compacto de plataforma (solo HTML seguro; sin inyectar texto crudo). */
function formatearPlataforma(plataforma) {
  const raw = String(plataforma ?? "").trim();
  if (!raw || raw === "—") {
    return `<span class="plat plat-empty" title="—" role="img" aria-label="Sin plataforma">—</span>`;
  }
  const p = raw.toLowerCase();
  const title = escapeHtml(raw);
  if (p.includes("linkedin")) {
    return `<span class="plat plat-linkedin" title="${title}" role="img" aria-label="${title}">L</span>`;
  }
  if (p.includes("google")) {
    return `<span class="plat plat-google" title="${title}" role="img" aria-label="${title}">G</span>`;
  }
  if (p.includes("tiktok")) {
    return `<span class="plat plat-tiktok" title="${title}" role="img" aria-label="${title}">T</span>`;
  }
  if (p.includes("meta") || p.includes("facebook") || p.includes("instagram")) {
    return `<span class="plat plat-meta" title="${title}" role="img" aria-label="${title}">M</span>`;
  }
  return `<span class="plat plat-unknown" title="${title}" role="img" aria-label="${title}">?</span>`;
}

function getPlanningByProgIntakeTrackPlat(programa, intake, tracking, plataforma, tipo = "") {
  return planningDraftRecords().filter(
    (r) =>
      (!tipo || String(r.tipo) === String(tipo)) &&
      String(r.programa) === String(programa) &&
      String(r.intake) === String(intake) &&
      String(r.tracking) === String(tracking) &&
      String(r.plataforma) === String(plataforma)
  );
}

/** Rango del filtro dashboard (mes / fechas). */
function getDashboardPlanningPeriodBounds() {
  const a = parseDateInput(estadoFiltrosDashboard.fechaInicio);
  const c = parseDateInput(estadoFiltrosDashboard.fechaFin);
  if (a && c) return { startD: a, endD: c };
  if (estadoFiltrosDashboard.mes) {
    const b = dashboardMonthKeyBounds(estadoFiltrosDashboard.mes);
    if (b) return { startD: parseDateInput(b.min), endD: parseDateInput(b.max) };
  }
  return null;
}

/**
 * Días del mes para métricas diarias reales (GASTO y LEADS, vista mensual): desde max(inicio campaña,
 * inicio del mes efectivo) hasta la última fecha con data, mínimo 1. No usa fecha fin de campaña como tope.
 */
function computeDashboardDiasGastoDiarioRealMes(planningRowsOperativas, monthKey, fechaHoy) {
  const parsed = parseMonthYearData(monthKey);
  if (!parsed || !(fechaHoy instanceof Date)) return 1;
  const monthStart0 = new Date(parsed.year, parsed.monthIndex, 1);
  const monthEnd0 = new Date(parsed.year, parsed.monthIndex + 1, 0);
  const monthStart = new Date(monthStart0.getFullYear(), monthStart0.getMonth(), monthStart0.getDate(), 12, 0, 0);
  const monthEnd = new Date(monthEnd0.getFullYear(), monthEnd0.getMonth(), monthEnd0.getDate(), 12, 0, 0);

  let effectiveMonthStart = monthStart;
  let effectiveUltima = new Date(fechaHoy.getFullYear(), fechaHoy.getMonth(), fechaHoy.getDate(), 12, 0, 0);
  if (effectiveUltima > monthEnd) effectiveUltima = monthEnd;
  if (effectiveUltima < monthStart) effectiveUltima = monthStart;

  const bounds = getDashboardPlanningPeriodBounds();
  if (bounds?.startD instanceof Date && bounds?.endD instanceof Date && bounds.startD <= bounds.endD) {
    const seg0 = new Date(bounds.startD.getFullYear(), bounds.startD.getMonth(), bounds.startD.getDate(), 12, 0, 0);
    const seg1 = new Date(bounds.endD.getFullYear(), bounds.endD.getMonth(), bounds.endD.getDate(), 12, 0, 0);
    const w0 = seg0 > monthStart ? seg0 : monthStart;
    const w1 = seg1 < monthEnd ? seg1 : monthEnd;
    if (w0 <= w1) {
      effectiveMonthStart = w0;
      if (effectiveUltima > w1) effectiveUltima = w1;
      if (effectiveUltima < w0) effectiveUltima = w0;
    }
  }

  let minInicioReal = null;
  planningRowsOperativas.forEach((rec) => {
    const campStart = parseDateInput(rec.fechaInicio);
    if (!(campStart instanceof Date)) return;
    const cs = new Date(campStart.getFullYear(), campStart.getMonth(), campStart.getDate(), 12, 0, 0);
    const fechaInicioReal = cs > effectiveMonthStart ? cs : effectiveMonthStart;
    if (minInicioReal === null || fechaInicioReal < minInicioReal) minInicioReal = fechaInicioReal;
  });

  const inicioReal = minInicioReal != null ? minInicioReal : effectiveMonthStart;
  if (inicioReal > effectiveUltima) return 1;
  return Math.max(1, getDaysTotalInclusive(inicioReal, effectiveUltima));
}

/**
 * Suma meta leads y gasto del planning por periodo usando la distribución mensual
 * (computeMonthlyArraysForRecordWithOverrides). Valores mensuales = celdas del planning;
 * solo se prorratea dentro del mes calendario si el rango no cubre el mes entero.
 */
function accumulatePlanningPeriodMetaFromMonthly(
  rec,
  F0,
  F1,
  fechaHoy,
  acc
) {
  const campStart = parseDateInput(rec.fechaInicio);
  const campEnd = parseDateInput(rec.fechaFin);
  if (!campStart || !campEnd || campStart > campEnd) return;

  const segStart = campStart > F0 ? campStart : F0;
  const segEnd = campEnd < F1 ? campEnd : F1;
  if (segStart > segEnd) return;

  let endHoy = segEnd;
  if (fechaHoy instanceof Date) {
    const t = new Date(fechaHoy.getFullYear(), fechaHoy.getMonth(), fechaHoy.getDate(), 12, 0, 0);
    if (t < segStart) endHoy = segStart;
    else if (t < endHoy) endHoy = t;
  }

  const y0 = campStart.getFullYear();
  const y1 = campEnd.getFullYear();
  for (let year = y0; year <= y1; year += 1) {
    const { monthlyInvestment, monthlyLeads } = computeMonthlyArraysForRecordWithOverrides(rec, year);
    const monthlyDays = countDaysByMonthForRangeInYear(rec.fechaInicio, rec.fechaFin, year);

    for (let m = 0; m < 12; m += 1) {
      if (monthlyDays[m] <= 0) continue;
      const dim = daysInCalendarMonth(year, m);
      if (dim <= 0) continue;

      const daysInRange = countDaysInMonthIntersection(segStart, segEnd, year, m);
      if (daysInRange <= 0) continue;

      const frac = daysInRange / dim;
      acc.metaLeadsPeriod += monthlyLeads[m] * frac;
      acc.presupuestoPeriod += monthlyInvestment[m] * frac;

      const daysHastaHoy = countDaysInMonthIntersection(segStart, endHoy, year, m);
      acc.metaLeadsHoyPeriod += monthlyLeads[m] * (daysHastaHoy / dim);
      acc.metaGastoHoyPeriod += monthlyInvestment[m] * (daysHastaHoy / dim);
    }
  }
}

/**
 * Metas del grupo LEADS / gasto de periodo desde la tabla planning (distribución mensual).
 * Sin rango válido: coincide con totales globales de campaña (comportamiento previo).
 */
function computeDashboardPlanningSelectedMonthMetaExact(planningRows, monthKey) {
  const parsed = parseMonthYearData(monthKey);
  if (!parsed) return null;
  setFechaActualData();
  const monthStart = new Date(parsed.year, parsed.monthIndex, 1);
  const monthEnd = new Date(parsed.year, parsed.monthIndex + 1, 0);

  const bounds = getDashboardPlanningPeriodBounds();
  let windowEndCap = monthEnd;
  if (bounds?.startD instanceof Date && bounds?.endD instanceof Date && bounds.startD <= bounds.endD) {
    const w1 = bounds.endD < monthEnd ? bounds.endD : monthEnd;
    const w0 = bounds.startD > monthStart ? bounds.startD : monthStart;
    if (w0 <= w1) windowEndCap = new Date(w1.getFullYear(), w1.getMonth(), w1.getDate(), 12, 0, 0);
  }

  const rawToday = fechaActualData instanceof Date ? fechaActualData : monthEnd;
  const effectiveToday =
    rawToday < monthStart ? monthStart : rawToday > monthEnd ? monthEnd : rawToday;
  const tHoy = new Date(
    effectiveToday.getFullYear(),
    effectiveToday.getMonth(),
    effectiveToday.getDate(),
    12,
    0,
    0
  );
  const tRef = tHoy.getTime() > windowEndCap.getTime() ? windowEndCap : tHoy;

  let metaLeadsPeriod = 0;
  let presupuestoPeriod = 0;
  let metaLeadsHoyPeriod = 0;
  let metaGastoHoyPeriod = 0;
  let sumDiasPautaMes = 0;

  planningRows.forEach((rec) => {
    const campStart = parseDateInput(rec.fechaInicio);
    const campEnd = parseDateInput(rec.fechaFin);
    if (!campStart || !campEnd || campStart > campEnd) return;
    if (campEnd < monthStart || campStart > monthEnd) return;

    const { monthlyInvestment, monthlyLeads } = computeMonthlyArraysForRecordWithOverrides(rec, parsed.year);
    const metaM = Number(monthlyLeads[parsed.monthIndex]) || 0;
    const metaG = Number(monthlyInvestment[parsed.monthIndex]) || 0;
    metaLeadsPeriod += metaM;
    presupuestoPeriod += metaG;

    const cs = new Date(campStart.getFullYear(), campStart.getMonth(), campStart.getDate(), 12, 0, 0);
    const ce = new Date(campEnd.getFullYear(), campEnd.getMonth(), campEnd.getDate(), 12, 0, 0);
    const ms = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate(), 12, 0, 0);
    const me = new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate(), 12, 0, 0);

    const p0 = cs > ms ? cs : ms;
    const p1 = ce < me ? ce : me;
    if (p0 > p1) return;

    const diasTotalesPautaMes = getDaysTotalInclusive(p0, p1);
    if (diasTotalesPautaMes > 0) sumDiasPautaMes += diasTotalesPautaMes;

    const metaLeadsDiario = diasTotalesPautaMes > 0 ? metaM / diasTotalesPautaMes : 0;
    const metaGastoDiario = diasTotalesPautaMes > 0 ? metaG / diasTotalesPautaMes : 0;

    if (tRef < cs) return;

    const endCapTime = Math.min(tRef.getTime(), ce.getTime(), me.getTime(), windowEndCap.getTime());
    const endCap = new Date(endCapTime);
    const endCapN = new Date(endCap.getFullYear(), endCap.getMonth(), endCap.getDate(), 12, 0, 0);
    if (endCapN < p0) return;

    const diasTranscurridos = getDaysTotalInclusive(p0, endCapN);
    metaLeadsHoyPeriod += metaLeadsDiario * diasTranscurridos;
    metaGastoHoyPeriod += metaGastoDiario * diasTranscurridos;
  });

  const metaLeadsDiarioPeriod = sumDiasPautaMes > 0 ? metaLeadsPeriod / sumDiasPautaMes : 0;
  const metaGastoDiarioPeriod = sumDiasPautaMes > 0 ? presupuestoPeriod / sumDiasPautaMes : 0;
  const metaCplPeriod = metaLeadsPeriod > 0 ? presupuestoPeriod / metaLeadsPeriod : 0;

  return {
    metaLeadsPeriod,
    presupuestoPeriod,
    metaLeadsHoyPeriod,
    metaLeadsDiarioPeriod,
    metaCplPeriod,
    metaGastoHoyPeriod,
    metaGastoDiarioPeriod
  };
}

function computeDashboardPlanningPeriodMeta(planningRows) {
  if (estadoFiltrosDashboard.mes) {
    const exact = computeDashboardPlanningSelectedMonthMetaExact(planningRows, estadoFiltrosDashboard.mes);
    if (exact) return exact;
  }
  setFechaActualData();
  const bounds = getDashboardPlanningPeriodBounds();
  const F0 = bounds?.startD;
  const F1 = bounds?.endD;

  const metaLeadsGlobal = planningRows.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const presupuestoGlobal = planningRows.reduce((a, r) => a + (Number(r.presupuesto) || 0), 0);

  let metaLeadsHoyGlobal = 0;
  let metaGastoHoyGlobal = 0;
  planningRows.forEach((rec) => {
    const s = parseDateInput(rec.fechaInicio);
    const e = parseDateInput(rec.fechaFin);
    const ml = Number(rec.leads) || 0;
    const pr = Number(rec.presupuesto) || 0;
    const dt = getDaysTotalInclusive(s, e);
    const dtr = getDaysElapsedInclusive(s, e, fechaActualData);
    if (dt > 0) {
      metaLeadsHoyGlobal += (ml / dt) * dtr;
      metaGastoHoyGlobal += (pr / dt) * dtr;
    }
  });
  const diasTotalesCamp = planningRows.reduce((a, r) => {
    const s = parseDateInput(r.fechaInicio);
    const e = parseDateInput(r.fechaFin);
    return a + getDaysTotalInclusive(s, e);
  }, 0);
  const metaLeadsDiarioGlobal = diasTotalesCamp > 0 ? metaLeadsGlobal / diasTotalesCamp : 0;
  const metaGastoDiarioGlobal = diasTotalesCamp > 0 ? presupuestoGlobal / diasTotalesCamp : 0;
  const metaCplGlobal = metaLeadsGlobal > 0 ? presupuestoGlobal / metaLeadsGlobal : 0;

  if (!F0 || !F1) {
    return {
      metaLeadsPeriod: metaLeadsGlobal,
      presupuestoPeriod: presupuestoGlobal,
      metaLeadsHoyPeriod: metaLeadsHoyGlobal,
      metaLeadsDiarioPeriod: metaLeadsDiarioGlobal,
      metaCplPeriod: metaCplGlobal,
      metaGastoHoyPeriod: metaGastoHoyGlobal,
      metaGastoDiarioPeriod: metaGastoDiarioGlobal
    };
  }

  const acc = {
    metaLeadsPeriod: 0,
    presupuestoPeriod: 0,
    metaLeadsHoyPeriod: 0,
    metaGastoHoyPeriod: 0
  };
  planningRows.forEach((rec) => {
    accumulatePlanningPeriodMetaFromMonthly(rec, F0, F1, fechaActualData, acc);
  });

  const diasTotalesPeriod = getDaysTotalInclusive(F0, F1);
  const metaLeadsDiarioPeriod =
    diasTotalesPeriod > 0 ? acc.metaLeadsPeriod / diasTotalesPeriod : 0;
  const metaGastoDiarioPeriod =
    diasTotalesPeriod > 0 ? acc.presupuestoPeriod / diasTotalesPeriod : 0;
  const metaCplPeriod =
    acc.metaLeadsPeriod > 0 ? acc.presupuestoPeriod / acc.metaLeadsPeriod : 0;

  return {
    metaLeadsPeriod: acc.metaLeadsPeriod,
    presupuestoPeriod: acc.presupuestoPeriod,
    metaLeadsHoyPeriod: acc.metaLeadsHoyPeriod,
    metaLeadsDiarioPeriod,
    metaCplPeriod,
    metaGastoHoyPeriod: acc.metaGastoHoyPeriod,
    metaGastoDiarioPeriod
  };
}

/**
 * Metas de funnel en el periodo del dashboard (interesados, postulantes, matriculados),
 * prorrateadas con la misma lógica que meta leads vs totales del planning.
 */
function computeDashboardPlanningFunnelMetaPeriod(planningRowsOperativas, pmMes) {
  const z = { metaInteresados: 0, metaPostulantes: 0, metaMatriculados: 0 };
  if (!planningRowsOperativas?.length || !pmMes) return z;
  const leadsGlobal = planningRowsOperativas.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const mlPeriod = Number(pmMes.metaLeadsPeriod) || 0;
  const ratio = leadsGlobal > 0 ? mlPeriod / leadsGlobal : 0;
  planningRowsOperativas.forEach((rec) => {
    const m = rec.metas || {};
    z.metaInteresados += (Number(m.interesados) || 0) * ratio;
    z.metaPostulantes += (Number(m.postulantes) || 0) * ratio;
    z.metaMatriculados += (Number(m.matriculados) || 0) * ratio;
  });
  return z;
}

/**
 * Días restantes de campaña: MAX(0, fechaFin − fechaHoy), en días calendario.
 * fechaHoy se acota al rango [fechaInicio, fechaFin] para no contar fuera de pauta.
 */
function getDashboardDiasRestantesMetaGlobal(fechaInicio, fechaFin, fechaHoy) {
  if (!(fechaFin instanceof Date) || !(fechaHoy instanceof Date)) return 0;
  const f = new Date(fechaFin.getFullYear(), fechaFin.getMonth(), fechaFin.getDate(), 12, 0, 0);
  let h = new Date(fechaHoy.getFullYear(), fechaHoy.getMonth(), fechaHoy.getDate(), 12, 0, 0);
  if (fechaInicio instanceof Date) {
    const s = new Date(fechaInicio.getFullYear(), fechaInicio.getMonth(), fechaInicio.getDate(), 12, 0, 0);
    if (h < s) h = s;
  }
  if (h > f) return 0;
  return Math.max(0, Math.floor((f - h) / 86400000));
}

/**
 * Meta diaria dinámica (META GLOBAL): pendiente / días restantes; sin filtro de mes.
 */
function computeDashboardMetaGlobalDynamicDiaria(opts) {
  const metaLeadsTotal = Number(opts.metaLeadsTotal) || 0;
  const metaGastoTotal = Number(opts.metaGastoTotal) || 0;
  const leadsReal = Number(opts.leadsReal) || 0;
  const gastoReal = Number(opts.gastoReal) || 0;
  const fechaInicio = opts.fechaInicio;
  const fechaFin = opts.fechaFin;
  setFechaActualData();
  const fechaHoy = fechaActualData instanceof Date ? fechaActualData : new Date();
  if (!(fechaInicio instanceof Date) || !(fechaFin instanceof Date)) {
    return { metaLeadsDiario: 0, metaGastoDiario: 0, diasRestantes: 0 };
  }
  const diasRestantes = getDashboardDiasRestantesMetaGlobal(fechaInicio, fechaFin, fechaHoy);
  const leadsPendiente = Math.max(0, metaLeadsTotal - leadsReal);
  const gastoPendiente = Math.max(0, metaGastoTotal - gastoReal);
  const metaLeadsDiario = diasRestantes > 0 ? leadsPendiente / diasRestantes : 0;
  const metaGastoDiario = diasRestantes > 0 ? gastoPendiente / diasRestantes : 0;
  return { metaLeadsDiario, metaGastoDiario, diasRestantes };
}

function computeDashboardPlanningGlobalMeta(planningRows) {
  setFechaActualData();
  const metaLeadsGlobal = planningRows.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const presupuestoGlobal = planningRows.reduce((a, r) => a + (Number(r.presupuesto) || 0), 0);
  let metaLeadsHoyGlobal = 0;
  let metaGastoHoyGlobal = 0;
  let diasTotalesGlobal = 0;
  let diasTranscurridosGlobal = 0;

  planningRows.forEach((rec) => {
    const s = parseDateInput(rec.fechaInicio);
    const e = parseDateInput(rec.fechaFin);
    const ml = Number(rec.leads) || 0;
    const pr = Number(rec.presupuesto) || 0;
    const dt = getDaysTotalInclusive(s, e);
    const dtr = getDaysElapsedInclusive(s, e, fechaActualData);
    diasTotalesGlobal += dt;
    diasTranscurridosGlobal += dtr;
    if (dt > 0) {
      metaLeadsHoyGlobal += (ml / dt) * dtr;
      metaGastoHoyGlobal += (pr / dt) * dtr;
    }
  });

  const metaLeadsDiarioGlobal = diasTotalesGlobal > 0 ? metaLeadsGlobal / diasTotalesGlobal : 0;
  const metaGastoDiarioGlobal = diasTotalesGlobal > 0 ? presupuestoGlobal / diasTotalesGlobal : 0;
  const metaCplGlobal = metaLeadsGlobal > 0 ? presupuestoGlobal / metaLeadsGlobal : 0;

  return {
    metaLeadsPeriod: metaLeadsGlobal,
    presupuestoPeriod: presupuestoGlobal,
    metaLeadsHoyPeriod: metaLeadsHoyGlobal,
    metaLeadsDiarioPeriod: metaLeadsDiarioGlobal,
    metaCplPeriod: metaCplGlobal,
    metaGastoHoyPeriod: metaGastoHoyGlobal,
    metaGastoDiarioPeriod: metaGastoDiarioGlobal,
    diasTotalesPeriod: diasTotalesGlobal,
    diasTranscurridosPeriod: diasTranscurridosGlobal
  };
}

function sortDashboardMonthKeysChrono(keys) {
  return [...keys].filter(Boolean).sort((a, b) => {
    const pa = parseMonthYearData(a);
    const pb = parseMonthYearData(b);
    if (!pa && !pb) return String(a).localeCompare(String(b), "es");
    if (!pa) return 1;
    if (!pb) return -1;
    if (pa.year !== pb.year) return pa.year - pb.year;
    return pa.monthIndex - pb.monthIndex;
  });
}

function getDashboardDataDateBoundsFromModelo() {
  const dates = modeloAnalitico.map((r) => r.fecha).filter((d) => d instanceof Date);
  if (!dates.length) return null;
  let minT = Infinity;
  let maxT = -Infinity;
  dates.forEach((d) => {
    const t = d.getTime();
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  });
  return {
    min: formatDateInputFromDate(new Date(minT)),
    max: formatDateInputFromDate(new Date(maxT))
  };
}

function applyDashboardTodosRango() {
  const bounds = getDashboardDataDateBoundsFromModelo();
  if (bounds) {
    estadoFiltrosDashboard.fechaInicio = bounds.min;
    estadoFiltrosDashboard.fechaFin = bounds.max;
  }
}

function esNombreCampaniaBranding(nombre) {
  const n = String(nombre ?? "").toLowerCase();
  return n.includes("alcance") || n.includes("webinar") || n.includes("charla");
}

/** Tipos convocatoria / awareness: nunca aparecen en el segmentador TIPO. */
function esTipoBrandingConvocatoriaDashboard(tipo) {
  const t = String(tipo ?? "").trim();
  return t === "Charla" || t === "Webinar" || t === "Alcance";
}

function filtrarDashboardSinBranding(rows) {
  if (!rows || !rows.length) return [];
  return rows.filter((r) => !esNombreCampaniaBranding(r.nombre) && !esTipoBrandingConvocatoriaDashboard(r.tipo));
}

function aplicarFiltroBrandingTarjetas(rows) {
  if (!rows || !rows.length) return [];
  if (incluirBrandingDashboard) return rows.slice();
  return filtrarDashboardSinBranding(rows);
}

function getDashboardSegmentTiposComerciales() {
  return uniqueVals("tipo").filter((t) => !esTipoBrandingConvocatoriaDashboard(t));
}

/** Dataset para gasto y totales de inversión (incluye C/W/A si el check está activo). */
function aplicarFiltroBrandingModeloGasto(rows) {
  if (!rows || !rows.length) return [];
  if (incluirBrandingDashboard) return rows.slice();
  return rows.filter((r) => !esNombreCampaniaBranding(r.nombre) && !esTipoBrandingConvocatoriaDashboard(r.tipo));
}

/**
 * Dataset para leads, CPL, CTR, demográficos, etc.
 * Con check activo: filas tipo C/W/A mantienen gasto pero leads/clics/impresiones en 0.
 */
function aplicarFiltroBrandingModeloPerformance(rows) {
  if (!rows || !rows.length) return [];
  if (!incluirBrandingDashboard) {
    return rows.filter((r) => !esNombreCampaniaBranding(r.nombre) && !esTipoBrandingConvocatoriaDashboard(r.tipo));
  }
  return rows.map((r) => {
    if (esTipoBrandingConvocatoriaDashboard(r.tipo)) {
      return { ...r, leads: 0, clics: 0, impresiones: 0 };
    }
    return r;
  });
}

function dashPlanningMetaOcultarLeadsSiTipoBranding(pm, planningRows) {
  if (!pm || !planningRows?.length) return pm;
  if (!esTipoBrandingConvocatoriaDashboard(planningRows[0].tipo)) return pm;
  return {
    ...pm,
    metaLeadsPeriod: 0,
    metaLeadsHoyPeriod: 0,
    metaLeadsDiarioPeriod: 0,
    metaCplPeriod: 0
  };
}

function getDashboardMetaTriplet() {
  if (programaSeleccionado) {
    const row = parseDashboardRowKey(programaSeleccionado);
    const planningRows = getPlanningByProgIntakeTrackPlat(
      row.programa,
      row.intake,
      row.tracking,
      row.plataforma,
      row.tipo
    );
    const pm = dashPlanningMetaOcultarLeadsSiTipoBranding(
      computeDashboardPlanningPeriodMeta(planningRows),
      planningRows
    );
    return {
      metaPresupuesto: pm.presupuestoPeriod,
      metaLeads: pm.metaLeadsPeriod,
      metaCpl: pm.metaCplPeriod
    };
  }
  const keys = new Set(
    filtrarDashboardSinBranding(getDashboardFilteredData()).map((r) => dashboardRowKeyFromModelo(r))
  );
  let metaPresupuesto = 0;
  let metaLeads = 0;
  keys.forEach((k) => {
    const row = parseDashboardRowKey(k);
    const planningRows = getPlanningByProgIntakeTrackPlat(
      row.programa,
      row.intake,
      row.tracking,
      row.plataforma,
      row.tipo
    );
    const pm = dashPlanningMetaOcultarLeadsSiTipoBranding(
      computeDashboardPlanningPeriodMeta(planningRows),
      planningRows
    );
    metaPresupuesto += pm.presupuestoPeriod;
    metaLeads += pm.metaLeadsPeriod;
  });
  const metaCpl = metaLeads > 0 ? metaPresupuesto / metaLeads : 0;
  return { metaPresupuesto, metaLeads, metaCpl };
}

/** Solo lectura: encaja fila del modelo con estado en data vinculada (no modifica otros módulos). */
function dashboardModeloCumpleEstado(r) {
  const filtro = estadoFiltrosDashboard.estado;
  if (!filtro) return true;
  const rowKey = dashboardRowKeyFromModelo(r);
  return getDashboardRowDeliveryEstado(rowKey) === filtro;
}

function getDashboardUniqueEstados() {
  return ["Activo", "Inactivo"];
}

/**
 * Indicador estilo Ads Manager:
 * toma SOLO la data más reciente (sin filtros de planning/mes/rango) y devuelve:
 * "Activo" | "Inactivo" | "Sin data".
 */
function getUltimaDataCampania(campaignId) {
  let ultimaData = null;
  dataReal.forEach((d) => {
    if (String(d.idCampania) !== String(campaignId)) return;
    if (!(d.fecha instanceof Date)) return;
    if (!ultimaData || d.fecha > ultimaData.fecha) ultimaData = d;
  });
  return ultimaData;
}

function getEstadoCampania(campaignId) {
  const ultimaData = getUltimaDataCampania(campaignId);
  if (!ultimaData) return "Sin data";
  return normalizarEstado(ultimaData.estado) === "Activo" ? "Activo" : "Inactivo";
}

function getDashboardRowDeliveryEstado(rowKey) {
  const row = parseDashboardRowKey(rowKey);
  const planningRows = getPlanningByProgIntakeTrackPlat(row.programa, row.intake, row.tracking, row.plataforma, row.tipo);
  if (!planningRows.length) return "Sin data";
  const campaignIds = new Set();
  planningRows.forEach((rec) => {
    const pk = planningKeyFromRecord(rec);
    getRelacionesPlataforma().forEach((rel) => {
      if (rel.planningKey !== pk) return;
      campaignIds.add(String(rel.idCampania));
    });
  });
  if (!campaignIds.size) return "Sin data";
  let latestCampaignId = "";
  let latestCampaignData = null;
  for (const campaignId of campaignIds) {
    const ultimaDataCampania = getUltimaDataCampania(campaignId);
    if (!ultimaDataCampania) continue;
    if (!latestCampaignData || ultimaDataCampania.fecha > latestCampaignData.fecha) {
      latestCampaignData = ultimaDataCampania;
      latestCampaignId = campaignId;
    }
  }
  if (!latestCampaignData) return "Sin data";
  return getEstadoCampania(latestCampaignId);
}

function dashboardModeloFiltroSegmentos(r) {
  // 1) Estado (sobre última data), 2) demás segmentadores.
  if (!dashboardModeloCumpleEstado(r)) return false;
  if (estadoFiltrosDashboard.tipo && String(r.tipo) !== estadoFiltrosDashboard.tipo) return false;
  if (estadoFiltrosDashboard.intake && String(r.intake) !== estadoFiltrosDashboard.intake) return false;
  if (estadoFiltrosDashboard.tracking && String(r.tracking) !== estadoFiltrosDashboard.tracking) return false;
  if (estadoFiltrosDashboard.plataforma && String(r.plataforma) !== estadoFiltrosDashboard.plataforma) return false;
  return true;
}

/**
 * Orden de filtros: 1) mes, 2) rango de fechas (inclusive), 3) segmentadores (tipo, intake, etc.).
 */
function getDashboardFilteredData() {
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  const mesSel = estadoFiltrosDashboard.mes;
  const fi = String(estadoFiltrosDashboard.fechaInicio || "").trim();
  const ff = String(estadoFiltrosDashboard.fechaFin || "").trim();
  return modeloAnalitico.filter((r) => {
    // Campañas con data: el modelo analítico debería cumplirlo siempre, pero se valida por seguridad.
    if (!(r.fecha instanceof Date) || !String(r.idCampania ?? "").trim()) return false;
    if (formatMonthYearData(r.fecha) !== mesSel) return false;
    const ds = formatDateInputFromDate(r.fecha);
    if (fi && ds < fi) return false;
    if (ff && ds > ff) return false;
    if (!dashboardModeloFiltroSegmentos(r)) return false;
    return true;
  });
}

/**
 * Mismo criterio de periodo que getDashboardFilteredData (mes + fechaInicio/fechaFin),
 * sin segmentadores (tipo, intake, tracking, plataforma), sin estado de campaña y sin branding.
 * Para donut "Distribución por plataforma" y Top 5 CPL (vista global del periodo).
 */
function getDashboardFilteredDataPeriodOnly() {
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  const mesSel = estadoFiltrosDashboard.mes;
  const fi = String(estadoFiltrosDashboard.fechaInicio || "").trim();
  const ff = String(estadoFiltrosDashboard.fechaFin || "").trim();
  return modeloAnalitico.filter((r) => {
    if (!(r.fecha instanceof Date) || !String(r.idCampania ?? "").trim()) return false;
    if (formatMonthYearData(r.fecha) !== mesSel) return false;
    const ds = formatDateInputFromDate(r.fecha);
    if (fi && ds < fi) return false;
    if (ff && ds > ff) return false;
    return true;
  });
}

/** Modelo analítico solo con segmentadores del dashboard (sin mes ni rango). */
function getDashboardModeloFilteredBySegmentsOnly() {
  return modeloAnalitico.filter((r) => dashboardModeloFiltroSegmentos(r));
}

function dashboardRowKeyMatchesDashboardSegmentFilters(rowKey) {
  const row = parseDashboardRowKey(rowKey);
  if (estadoFiltrosDashboard.tipo && String(row.tipo) !== estadoFiltrosDashboard.tipo) return false;
  if (estadoFiltrosDashboard.intake && String(row.intake) !== estadoFiltrosDashboard.intake) return false;
  if (estadoFiltrosDashboard.tracking && String(row.tracking) !== estadoFiltrosDashboard.tracking) return false;
  if (estadoFiltrosDashboard.plataforma && String(row.plataforma) !== estadoFiltrosDashboard.plataforma) return false;
  if (estadoFiltrosDashboard.estado && getDashboardRowDeliveryEstado(rowKey) !== estadoFiltrosDashboard.estado) return false;
  return true;
}

/** Modelo dashboard Comercial CRM: segmentadores sí; mes y rango de fechas NO acotan plataforma/CRM aquí. */
function getDashboardFilteredModeloParaComercialCrm() {
  return modeloAnalitico.filter((r) => {
    if (!(r.fecha instanceof Date) || !String(r.idCampania ?? "").trim()) return false;
    return dashboardModeloFiltroSegmentos(r);
  });
}

/** Columna «Programa» en tabla CRM (sin duplicar el tracking). */
function dashboardRowProgramaSoloNombreFromKey(rowKey) {
  const row = parseDashboardRowKey(rowKey);
  const programa = String(row.programa ?? "").trim();
  if (programa) return programa;
  return "—";
}

/** Columna «Fuente» en tabla CRM (tracking / FuenteVF normalizado en planning). */
function dashboardRowFuenteLabelFromKey(rowKey) {
  const row = parseDashboardRowKey(rowKey);
  const tracking = String(row.tracking ?? "").trim();
  return tracking || "—";
}

function dashboardComercialCrmLeadRowPassesGlobalFilter(r) {
  if (!(r.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
  return dashboardCrmRowMatchesSessionTeam(r);
}

function dashCrmMergeChartDateBounds(bounds, fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) return;
  const d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 12, 0, 0);
  if (!bounds.startD || d < bounds.startD) bounds.startD = d;
  if (!bounds.endD || d > bounds.endD) bounds.endD = d;
}

function getDashboardComercialCrmChartDateRange(platRowsModelo, crmRowsLeads) {
  const bounds = { startD: null, endD: null };
  (platRowsModelo || []).forEach((rp) => dashCrmMergeChartDateBounds(bounds, rp.fecha));
  (crmRowsLeads || []).forEach((rr) => dashCrmMergeChartDateBounds(bounds, rr.fecha));
  if (!bounds.startD || !bounds.endD) return null;
  return bounds;
}

function dashboardCrmRowMatchesSessionTeam(r) {
  const ct = String(getCurrentTeamId() || "").trim();
  if (!ct) return true;
  const rt = String(normalizeRowTeamId(r) || "").trim();
  if (!rt) return true;
  return rt === ct;
}

function buildCrmKeyToPlanningKeysMap() {
  const m = new Map();
  relacionesCrm.forEach((rel) => {
    const k = normalizarTexto(String(rel.crmKey || ""));
    if (!k) return;
    const pk = String(rel.planningKey || "").trim();
    if (!pk) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(pk);
  });
  return m;
}

function isDashboardComercialCrmActiveView() {
  return getDashboardSubtabVisibility().crm && getDashboardEffectiveSubtab() === "crm";
}

/** Mes del selector (mes completo), sin rango día — alcance «Mes» en Comercial CRM. */
function dashboardCrmLeadPassesMesOnlyFilter(r) {
  if (!(r?.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  return formatMonthYearData(r.fecha) === estadoFiltrosDashboard.mes;
}

/** Alcance Total/Mes para tablas laterales CRM (dinámica superior e intervalo). */
function dashboardCrmIntervaloLeadPassesScopeFilter(r) {
  if (!(r?.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
  if (dashboardCrmIntervaloPeriodScope === "total") return true;
  return dashboardCrmLeadPassesMesOnlyFilter(r);
}

/** Suma leads plataforma por fila — tab Comercial CRM (global por segmentadores, sin mes ni rango). */
function getDashboardPlatformLeadsByRowKeyForCrm() {
  const dataGlob = filtrarDashboardSinBranding(getDashboardFilteredModeloParaComercialCrm());
  const map = new Map();
  dataGlob.forEach((r) => {
    const key = dashboardRowKeyFromModelo(r) || "|||";
    map.set(key, (map.get(key) || 0) + (Number(r.leads) || 0));
  });
  return map;
}

function aggregateDashboardCrmMetricsByRowKey() {
  const ckMap = buildCrmKeyToPlanningKeysMap();
  const agg = new Map();
  const busq = String(estadoFiltrosDashboard.busquedaPrograma ?? "").trim().toLowerCase();
  crmLeads.forEach((r) => {
    if (!dashboardComercialCrmLeadRowPassesGlobalFilter(r)) return;
    const ck = crmCampaignKeyFromRow(r);
    if (!ck) return;
    const pks = ckMap.get(ck);
    if (!pks?.length) return;
    for (const pk of pks) {
      const rowKey = planningKeyToDashboardRowKey(pk);
      if (!dashboardRowKeyMatchesDashboardSegmentFilters(rowKey)) continue;
      if (busq && !dashboardRowSearchHaystackFromKey(rowKey).includes(busq)) continue;
      if (!agg.has(rowKey)) {
        agg.set(rowKey, { crmLeads: 0, crmInt: 0, crmPost: 0, crmMat: 0 });
      }
      const slot = agg.get(rowKey);
      slot.crmLeads += Number(r.leads) || 0;
      if (r.esInteresado) slot.crmInt += 1;
      if (r.esPostulante) slot.crmPost += 1;
      if (r.esMatriculado) slot.crmMat += 1;
    }
  });
  return agg;
}

function dashCrmPctDiffClass(ratio) {
  if (!Number.isFinite(ratio)) return "";
  if (ratio < -1e-9) return "dash-crm-diff-neg";
  if (ratio > 1e-9) return "dash-crm-diff-pos";
  return "";
}

function dashCrmNormalizeFuentePivot(label) {
  const canon = crmNormalizedTrafficFromFuenteVF(String(label ?? ""));
  if (canon) return canon;
  const n = normalizarTexto(String(label ?? ""));
  if (!n) return "Otros";
  if (n.includes("tiktok")) return "TikTok";
  return "Otros";
}

function dashCrmNormalizeFuentePivotFromRow(row) {
  const h = crmHydrateDimensionalFieldsOnRow(row);
  const t = String(h.crmTrafficType || "").trim();
  if (t) return t;
  return dashCrmNormalizeFuentePivot(row?.fuenteCrm);
}

/** Filas CRM vinculadas + segmentadores; sin filtro de mes ni rango (vista CRM global). */
function getDashboardCrmRowsForBottomPanels() {
  const ckMap = buildCrmKeyToPlanningKeysMap();
  const busq = String(estadoFiltrosDashboard.busquedaPrograma ?? "").trim().toLowerCase();
  const out = [];
  crmLeads.forEach((r) => {
    if (!dashboardComercialCrmLeadRowPassesGlobalFilter(r)) return;
    const ck = crmCampaignKeyFromRow(r);
    if (!ck) return;
    const pks = ckMap.get(ck);
    if (!pks?.length) return;
    let ok = false;
    for (const pk of pks) {
      const rowKey = planningKeyToDashboardRowKey(pk);
      if (!dashboardRowKeyMatchesDashboardSegmentFilters(rowKey)) continue;
      if (busq && !dashboardRowSearchHaystackFromKey(rowKey).includes(busq)) continue;
      ok = true;
      break;
    }
    if (ok) out.push(r);
  });
  return out;
}

function filterDashboardCrmLeadRowsPorFilaSeleccionada(rows) {
  const selRow = String(programaSeleccionado ?? "").trim();
  if (!selRow) return rows || [];
  const ckMap = buildCrmKeyToPlanningKeysMap();
  return (rows || []).filter((r) => {
    const ck = crmCampaignKeyFromRow(r);
    const pks = ckMap.get(ck);
    if (!pks?.length) return false;
    return pks.some((pk) => planningKeyToDashboardRowKey(pk) === selRow);
  });
}

/** Si hay fila seleccionada en la tabla CRM/plataforma, reduce mapas KPI a esa clave. */
function dashboardCrmSubsetKeyedMap(map, emptyVal) {
  const selRow = String(programaSeleccionado ?? "").trim();
  if (!selRow) return map;
  const slot = map.has(selRow) ? map.get(selRow) : emptyVal;
  return new Map([[selRow, slot]]);
}

function dashboardCrmSortKey(rowKey) {
  const row = parseDashboardRowKey(rowKey);
  return [String(row.tipo || ""), String(row.programa || ""), String(row.intake || ""), String(row.tracking || "")].join(
    "|"
  );
}

function renderDashboardKpisCrm() {
  const host = document.getElementById("dashboardKpisCrmHolder");
  if (!host) return;
  if (!getDashboardSubtabVisibility().crm || getDashboardEffectiveSubtab() !== "crm") {
    ensureMesCardOutsideCrmKpiStrip();
    host.innerHTML = "";
    return;
  }
  const platMap = dashboardCrmSubsetKeyedMap(getDashboardPlatformLeadsByRowKeyForCrm(), 0);
  const crmMap = dashboardCrmSubsetKeyedMap(aggregateDashboardCrmMetricsByRowKey(), {
    crmLeads: 0,
    crmInt: 0,
    crmPost: 0,
    crmMat: 0
  });
  let tPlat = 0;
  let tCrm = 0;
  let tInt = 0;
  let tPost = 0;
  let tMat = 0;
  crmMap.forEach((v) => {
    tCrm += v.crmLeads;
    tInt += v.crmInt;
    tPost += v.crmPost;
    tMat += v.crmMat;
  });
  platMap.forEach((n) => {
    tPlat += n;
  });
  const caida = tPlat > 0 ? (tPlat - tCrm) / tPlat : null;
  const c1 = tCrm > 0 ? tInt / tCrm : null;
  const c2 = tInt > 0 ? tPost / tInt : null;
  const c3 = tPost > 0 ? tMat / tPost : null;
  const scopeSub = "Consolidado global · mes y día solo afectan gráficos";
  const period = document.getElementById("dashPeriodoCard");
  if (period instanceof HTMLElement && host.contains(period)) {
    period.remove();
  }
  host.className = "dashboard-kpis-inner dashboard-kpis-inner--crm-strip";
  host.innerHTML = `
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-leads">
      <div class="dash-kpi-head kpi-title">Leads Plataforma</div>
      <div class="dash-kpi-main kpi-value">${escapeHtml(dashFmtLeadsKpiMain(tPlat))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)}</div>
    </div>
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-cpl">
      <div class="dash-kpi-head kpi-title">Leads CRM</div>
      <div class="dash-kpi-main kpi-value">${escapeHtml(dashFmtLeadsKpiMain(tCrm))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)}</div>
    </div>
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-mix">
      <div class="dash-kpi-head kpi-title">Caída CRM</div>
      <div class="dash-kpi-main kpi-value">${caida == null ? "—" : escapeHtml(dashFmtPctFromRatio(caida))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)} · (Plat. − CRM) / Plat.</div>
    </div>
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-presupuesto">
      <div class="dash-kpi-head kpi-title">Lead → Interesado</div>
      <div class="dash-kpi-main kpi-value">${c1 == null ? "—" : escapeHtml(dashFmtPctFixed2FromRatio(c1))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)} · embudo CRM</div>
    </div>
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-leads">
      <div class="dash-kpi-head kpi-title">Interesado → Postulante</div>
      <div class="dash-kpi-main kpi-value">${c2 == null ? "—" : escapeHtml(dashFmtPctFixed2FromRatio(c2))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)} · embudo CRM</div>
    </div>
    <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-cpl">
      <div class="dash-kpi-head kpi-title">Postulante → Matrícula</div>
      <div class="dash-kpi-main kpi-value">${c3 == null ? "—" : escapeHtml(dashFmtPctFixed2FromRatio(c3))}</div>
      <div class="dash-kpi-sub kpi-subtext">${escapeHtml(scopeSub)} · ganado = matriculado</div>
    </div>`;
  if (period instanceof HTMLElement) {
    host.appendChild(period);
    period.classList.add("dash-periodo--crm-kpi-slot");
  }
}

/** Claves de programa visibles en la tabla CRM (mismos criterios que `renderDashboardCrmTabla`). */
function getDashboardCrmVisibleTableRowKeys() {
  const platMap = getDashboardPlatformLeadsByRowKeyForCrm();
  const crmMap = aggregateDashboardCrmMetricsByRowKey();
  const keys = new Set([...platMap.keys(), ...crmMap.keys()]);
  let list = [...keys].filter((k) => {
    const p = platMap.get(k) || 0;
    const c = crmMap.get(k);
    const cL = c?.crmLeads || 0;
    if (!(p > 0 || cL > 0 || (c?.crmInt || c?.crmPost || c?.crmMat))) return false;
    return dashboardRowKeyMatchesDashboardSegmentFilters(k);
  });
  const busq = String(estadoFiltrosDashboard.busquedaPrograma ?? "").trim().toLowerCase();
  if (busq) {
    list = list.filter((k) => dashboardRowSearchHaystackFromKey(k).includes(busq));
  }
  return list;
}

function getDashboardCrmVisibleTableRowKeysSet() {
  return new Set(getDashboardCrmVisibleTableRowKeys());
}

function filterDashboardCrmLeadRowsByVisibleTableRowKeys(rows, visibleKeys) {
  if (!visibleKeys || visibleKeys.size === 0) return [];
  const ckMap = buildCrmKeyToPlanningKeysMap();
  return (rows || []).filter((r) => {
    const ck = crmCampaignKeyFromRow(r);
    const pks = ckMap.get(ck);
    if (!pks?.length) return false;
    return pks.some((pk) => visibleKeys.has(planningKeyToDashboardRowKey(pk)));
  });
}

function renderDashboardCrmTabla() {
  const tbody = document.getElementById("dashCrmTbody");
  const tfoot = document.getElementById("dashCrmTfoot");
  if (!tbody || !tfoot) return;
  if (!hasAnyDataLoaded() || !getDashboardSubtabVisibility().crm || getDashboardEffectiveSubtab() !== "crm") {
    tbody.innerHTML = "";
    tfoot.innerHTML = "";
    return;
  }
  const platMap = getDashboardPlatformLeadsByRowKeyForCrm();
  const crmMap = aggregateDashboardCrmMetricsByRowKey();
  let list = getDashboardCrmVisibleTableRowKeys();
  list.sort((a, b) =>
    dashboardCrmSortKey(a).localeCompare(dashboardCrmSortKey(b), "es", {
      sensitivity: "base",
      numeric: true
    })
  );
  const totals = {
    metaL: 0,
    plat: 0,
    crm: 0,
    metaI: 0,
    ri: 0,
    metaP: 0,
    rp: 0,
    metaM: 0,
    rm: 0
  };
  const rowsHtml = list
    .map((rowKey) => {
      const row = parseDashboardRowKey(rowKey);
      const planningRows = getPlanningByProgIntakeTrackPlat(row.programa, row.intake, row.tracking, row.plataforma, row.tipo);
      const planningRowsOperativas = planningRows.filter((rec) => !esTipoBrandingConvocatoriaDashboard(rec.tipo));
      const cal = dashboardPlanningCalendarFromRows(planningRowsOperativas);
      const pmGlobal = dashPlanningMetaOcultarLeadsSiTipoBranding(
        computeDashboardPlanningGlobalMeta(planningRowsOperativas),
        planningRowsOperativas
      );
      const funnel = computeDashboardPlanningFunnelMetaPeriod(planningRowsOperativas, pmGlobal);
      const platL = platMap.get(rowKey) || 0;
      const crm = crmMap.get(rowKey) || { crmLeads: 0, crmInt: 0, crmPost: 0, crmMat: 0 };
      const metaL = Number(pmGlobal.metaLeadsPeriod) || 0;
      const pctDif = platL > 0 ? (crm.crmLeads - platL) / platL : null;
      const pctAv = metaL > 0 ? crm.crmLeads / metaL : null;
      const semAv =
        pctAv != null && Number.isFinite(pctAv) ? dashSemMetaG1(1, pctAv, "leads") : "";
      totals.metaL += metaL;
      totals.plat += platL;
      totals.crm += crm.crmLeads;
      totals.metaI += funnel.metaInteresados;
      totals.ri += crm.crmInt;
      totals.metaP += funnel.metaPostulantes;
      totals.rp += crm.crmPost;
      totals.metaM += funnel.metaMatriculados;
      totals.rm += crm.crmMat;
      const estadoDelivery = getDashboardRowDeliveryEstado(rowKey);
      const deliveryDotClass =
        estadoDelivery === "Activo"
          ? "dash-delivery-dot--on"
          : estadoDelivery === "Inactivo"
            ? "dash-delivery-dot--off"
            : "dash-delivery-dot--nodata";
      const difCls = dashCrmPctDiffClass(pctDif != null ? pctDif : NaN);
      const selClass = programaSeleccionado === rowKey ? "dash-row-selected" : "";
      return `<tr data-dash-row="${escapeHtml(rowKey)}" class="${selClass}">
        <td class="dash-estado-col" title="${escapeHtml(estadoDelivery)}"><span class="dash-delivery-dot ${deliveryDotClass}" aria-hidden="true"></span></td>
        <td class="tipo-col">${escapeHtml(row.tipo || "—")}</td>
        <td class="dash-int-col">${escapeHtml(dashboardRowIntakeDisplayFromKey(rowKey))}</td>
        <td class="dash-plat-col">${formatearPlataforma(row.plataforma)}</td>
        <td class="programa-col dash-td-prog">${escapeHtml(dashboardRowProgramaSoloNombreFromKey(rowKey))}</td>
        <td class="dash-tracking-col">${escapeHtml(dashboardRowFuenteLabelFromKey(rowKey))}</td>
        <td class="dash-grp-col dash-grp-col-meta dash-grp-col-first dash-crm-num">${escapeHtml(formatFechaDdMmmEsFromDate(cal.fechaInMin))}</td>
        <td class="dash-grp-col dash-grp-col-meta dash-crm-num">${escapeHtml(formatFechaDdMmmEsFromDate(cal.fechaFinMax))}</td>
        <td class="dash-grp-col dash-grp-col-meta dash-crm-num">${dashFmtLeads(cal.diasPauta)}</td>
        <td class="dash-grp-col dash-grp-col-meta dash-grp-col-last dash-col-separador-right dash-grp-sep-right grupo-separador dash-crm-num">${dashFmtLeads(cal.diasPendientes)}</td>
        <td class="dash-grp-col dash-grp-col-leads dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(metaL)))}</td>
        <td class="dash-grp-col dash-grp-col-leads dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(platL)))}</td>
        <td class="dash-grp-col dash-grp-col-leads dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(crm.crmLeads)))}</td>
        <td class="dash-grp-col dash-grp-col-leads dash-crm-num"><span class="dash-chip-metric ${difCls}">${pctDif == null ? "—" : escapeHtml(dashFmtPctFromRatio(pctDif))}</span></td>
        <td class="dash-grp-col dash-grp-col-leads dash-grp-col-last dash-crm-num ${semAv}">${pctAv == null ? "—" : escapeHtml(dashFmtPctFromRatio(pctAv))}</td>
        <td class="dash-grp-col dash-grp-col-int dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(funnel.metaInteresados)))}</td>
        <td class="dash-grp-col dash-grp-col-int dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(crm.crmInt))}</td>
        <td class="dash-grp-col dash-grp-col-post dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(funnel.metaPostulantes)))}</td>
        <td class="dash-grp-col dash-grp-col-post dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(crm.crmPost))}</td>
        <td class="dash-grp-col dash-grp-col-mat dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(funnel.metaMatriculados)))}</td>
        <td class="dash-grp-col dash-grp-col-mat dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(crm.crmMat))}</td>
      </tr>`;
    })
    .join("");
  tbody.innerHTML = rowsHtml || `<tr><td colspan="21" class="dash-empty-mini">Sin filas para los filtros seleccionados.</td></tr>`;
  const footDif = totals.plat > 0 ? (totals.crm - totals.plat) / totals.plat : null;
  const footAv = totals.metaL > 0 ? totals.crm / totals.metaL : null;
  const footDifCls = dashCrmPctDiffClass(footDif != null ? footDif : NaN);
  tfoot.innerHTML = `<tr class="dash-tfoot-row dash-crm-tfoot-row">
    <td class="dash-estado-col dash-tfoot-empty dash-tfoot-estado">&nbsp;</td>
    <td class="tipo-col dash-tfoot-empty">&nbsp;</td>
    <td class="dash-int-col dash-tfoot-empty">&nbsp;</td>
    <td class="dash-plat-col dash-tfoot-empty">&nbsp;</td>
    <td class="programa-col dash-tfoot-label"><strong>Total</strong></td>
    <td class="dash-tracking-col dash-tfoot-empty">&nbsp;</td>
    <td class="dash-grp-col dash-grp-col-meta dash-grp-col-first dash-tfoot-empty">&nbsp;</td>
    <td class="dash-grp-col dash-grp-col-meta dash-tfoot-empty">&nbsp;</td>
    <td class="dash-grp-col dash-grp-col-meta dash-tfoot-empty">&nbsp;</td>
    <td class="dash-grp-col dash-grp-col-meta dash-grp-col-last dash-tfoot-empty">&nbsp;</td>
    <td class="dash-grp-col dash-grp-col-leads dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.metaL)))}</td>
    <td class="dash-grp-col dash-grp-col-leads dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.plat)))}</td>
    <td class="dash-grp-col dash-grp-col-leads dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.crm)))}</td>
    <td class="dash-grp-col dash-grp-col-leads dash-crm-num"><span class="dash-chip-metric dash-crm-tfoot-metric ${footDifCls}">${footDif == null ? "—" : escapeHtml(dashFmtPctFromRatio(footDif))}</span></td>
    <td class="dash-grp-col dash-grp-col-leads dash-grp-col-last dash-crm-num">${footAv == null ? "—" : escapeHtml(dashFmtPctFromRatio(footAv))}</td>
    <td class="dash-grp-col dash-grp-col-int dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.metaI)))}</td>
    <td class="dash-grp-col dash-grp-col-int dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(totals.ri))}</td>
    <td class="dash-grp-col dash-grp-col-post dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.metaP)))}</td>
    <td class="dash-grp-col dash-grp-col-post dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(totals.rp))}</td>
    <td class="dash-grp-col dash-grp-col-mat dash-grp-col-first dash-crm-num">${escapeHtml(dashFmtLeads(Math.round(totals.metaM)))}</td>
    <td class="dash-grp-col dash-grp-col-mat dash-grp-col-last dash-crm-num">${escapeHtml(dashFmtLeads(totals.rm))}</td>
  </tr>`;
}

function renderDashboardCrmCompareChart() {
  const svg = document.getElementById("dashboardChartCrmCompare");
  if (!svg) return;
  const platByDay = new Map();
  const crmByDay = new Map();
  const platGlob = getDashboardPlatformRowsForCrmCharts();
  platGlob.forEach((r) => {
    if (!(r.fecha instanceof Date)) return;
    const d = formatDateInputFromDate(r.fecha);
    platByDay.set(d, (platByDay.get(d) || 0) + (Number(r.leads) || 0));
  });
  const panelRows = getDashboardCrmRowsForCharts();
  panelRows.forEach((r) => {
    const d = formatDateInputFromDate(r.fecha);
    crmByDay.set(d, (crmByDay.get(d) || 0) + (Number(r.leads) || 0));
  });
  const dayKeys = [...new Set([...platByDay.keys(), ...crmByDay.keys()])]
    .filter((d) => (platByDay.get(d) || 0) > 0 || (crmByDay.get(d) || 0) > 0)
    .sort();
  if (!dayKeys.length) {
    svg.innerHTML = `<text x="20" y="36" fill="#94a3b8">Sin datos para graficar en la vista actual</text>`;
    updateDashboardCrmDynamicTitle(0);
    return;
  }
  const points = dayKeys.map((d) => ({
    d,
    plat: platByDay.get(d) || 0,
    crm: crmByDay.get(d) || 0
  }));
  const dm = document.body.classList.contains("dark-mode");
  const chartBg = dm ? "#0f172a" : "#ffffff";
  const gridStroke = dm ? "rgba(148, 163, 184, 0.22)" : "#e8eef5";
  const axisBottomStroke = dm ? "rgba(148, 163, 184, 0.45)" : "#94a3b8";
  const xLabelFill = dm ? "#cbd5e1" : "#64748b";
  let w = Math.round(svg.getBoundingClientRect().width);
  const needsWidthRetry = !Number.isFinite(w) || w < 80;
  if (needsWidthRetry) w = 960;
  else w = Math.min(Math.max(w, 320), 6000);
  const h = 132;
  const plotPadL = 10;
  const plotPadR = 10;
  const padT = 22;
  const padB = dm ? 30 : 22;
  const axisY = h - padB;
  const maxV = Math.max(...points.map((p) => Math.max(p.plat, p.crm)), 1);
  const ticks = dashboardChartNiceLinearTicks(maxV, 5);
  const maxAxis = ticks[ticks.length - 1] || maxV;
  const n = points.length;
  const innerW = w - plotPadL - plotPadR;
  const groupW = innerW / Math.max(n, 1);
  const pairGap = Math.min(4, Math.max(2, groupW * 0.06));
  const barW = Math.max(4, Math.min(32, (groupW - pairGap - 8) / 2));
  const xGroupCenter = (i) => plotPadL + (i + 0.5) * groupW;
  const yVal = (v) => padT + (h - padT - padB) - (v / maxAxis) * (h - padT - padB);
  const barValueFs = n > 28 ? 7 : n > 18 ? 8 : 9;
  let fs = 10;
  if (n > 45) fs = 7;
  else if (n > 32) fs = 8;
  else if (n > 22) fs = 9;
  const minLabelPitchPx = Math.max(fs * 3.85, 20);
  const maxLabelSlots = Math.max(2, Math.floor(innerW / minLabelPitchPx));
  let labelStep = 1;
  if (n > 1 && n > maxLabelSlots) {
    labelStep = Math.max(1, Math.ceil((n - 1) / Math.max(1, maxLabelSlots - 1)));
  }
  const showXLabel = (i) => {
    if (n <= 1) return true;
    if (i === 0 || i === n - 1) return true;
    return i % labelStep === 0;
  };
  const barValueLabel = (x, yTop, val, fill) => {
    if (!(val > 0)) return "";
    const lab = dashFmtLeads(Math.round(val));
    const yy = Math.max(padT + barValueFs * 0.5, yTop - 3);
    return `<text x="${x + barW / 2}" y="${yy}" fill="${fill}" font-size="${barValueFs}" font-weight="600" text-anchor="middle" dominant-baseline="auto">${escapeHtml(
      lab
    )}</text>`;
  };
  const bars = points
    .map((p, i) => {
      const cx = xGroupCenter(i);
      const yP = yVal(p.plat);
      const yC = yVal(p.crm);
      const hP = axisY - yP;
      const hC = axisY - yC;
      const tip = `${escapeHtml(formatDashboardTooltipDate(p.d))}&#10;Plat.: ${dashFmtLeads(Math.round(p.plat))}&#10;CRM: ${dashFmtLeads(Math.round(p.crm))}`;
      const leftX = cx - barW - pairGap / 2;
      const rightX = cx + pairGap / 2;
      const rP =
        p.plat <= 0
          ? `<rect x="${leftX}" y="${axisY}" width="${barW}" height="0" fill="#2563eb" opacity="0"><title>${tip}</title></rect>`
          : `<rect x="${leftX}" y="${yP}" width="${barW}" height="${hP}" fill="#2563eb" fill-opacity="0.88" rx="2"><title>${tip}</title></rect>`;
      const rC =
        p.crm <= 0
          ? `<rect x="${rightX}" y="${axisY}" width="${barW}" height="0" fill="#059669" opacity="0"><title>${tip}</title></rect>`
          : `<rect x="${rightX}" y="${yC}" width="${barW}" height="${hC}" fill="#059669" fill-opacity="0.88" rx="2"><title>${tip}</title></rect>`;
      const lblP = barValueLabel(leftX, yP, p.plat, "#2563eb");
      const lblC = barValueLabel(rightX, yC, p.crm, "#059669");
      return rP + lblP + rC + lblC;
    })
    .join("");
  const xLabels = points
    .map((p, i) => {
      if (!showXLabel(i)) return "";
      const lab = formatDashboardChartLabel(p.d);
      const xi = xGroupCenter(i);
      return `<text x="${xi}" y="${axisY + 12}" fill="${xLabelFill}" font-size="${fs}" text-anchor="middle" dominant-baseline="hanging">${escapeHtml(lab)}</text>`;
    })
    .filter(Boolean)
    .join("");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  if (needsWidthRetry) {
    requestAnimationFrame(() => {
      const w2 = Math.round(svg.getBoundingClientRect().width);
      if (Number.isFinite(w2) && w2 >= 80 && Math.abs(w2 - w) > 2) {
        renderDashboardCrmCompareChart();
      }
    });
  }
  const legendCx = w / 2;
  svg.innerHTML = `
    <rect x="0" y="0" width="${w}" height="${h}" fill="${chartBg}" />
    <line x1="${plotPadL}" y1="${axisY}" x2="${w - plotPadR}" y2="${axisY}" stroke="${axisBottomStroke}" stroke-width="1" />
    ${bars}
    ${xLabels}
    <text x="${legendCx - 52}" y="14" fill="#2563eb" font-size="10" font-weight="700" text-anchor="end">Plataforma</text>
    <text x="${legendCx + 52}" y="14" fill="#059669" font-size="10" font-weight="700" text-anchor="start">CRM</text>`;
  updateDashboardCrmDynamicTitle(0);
}

function dashCrmPivotFuenteMonthTotal(m, days) {
  let t = 0;
  days.forEach((d) => {
    t += m.get(d) || 0;
  });
  return t;
}

function syncDashboardCrmPivotColgroup(table, dayCount, fuentes) {
  if (!table || dayCount < 1) return;
  let cg = table.querySelector("colgroup.dash-crm-pivot-colgroup");
  if (!cg) {
    cg = document.createElement("colgroup");
    cg.className = "dash-crm-pivot-colgroup";
    const thead = table.querySelector("thead");
    table.insertBefore(cg, thead || table.firstChild);
  }
  const dayCols = Array.from({ length: dayCount }, () => '<col class="dash-crm-pivot-col-day" />').join("");
  cg.innerHTML = `<col class="dash-crm-pivot-col-fuente" />${dayCols}<col class="dash-crm-pivot-col-sum" />`;
  const longestLen = (fuentes || []).reduce((mx, f) => Math.max(mx, String(f || "").length), 7);
  const fuenteRem = Math.max(5.75, longestLen * 0.58 + 1.1);
  table.style.setProperty("--dash-crm-pivot-fuente-w", `${fuenteRem.toFixed(2)}rem`);
}

function dashCrmPivotRowToneClass(fuente, idx) {
  const byName = {
    Leadgen: "dash-crm-pivot-row--tone-blue",
    Pixel: "dash-crm-pivot-row--tone-green",
    Google: "dash-crm-pivot-row--tone-amber",
    TikTok: "dash-crm-pivot-row--tone-violet",
    Otros: "dash-crm-pivot-row--tone-slate"
  };
  if (byName[fuente]) return byName[fuente];
  const cycle = ["dash-crm-pivot-row--tone-blue", "dash-crm-pivot-row--tone-green", "dash-crm-pivot-row--tone-amber", "dash-crm-pivot-row--tone-violet", "dash-crm-pivot-row--tone-slate"];
  return cycle[Math.abs(idx) % cycle.length];
}

function updateDashboardCrmDynamicTitle(pivotTotalLeads) {
  const titleEl = document.getElementById("dashCrmDynamicTitle");
  if (!titleEl) return;
  if (dashboardCrmBottomMode === "fuente") {
    const total = Number.isFinite(Number(pivotTotalLeads)) ? Math.max(0, Math.round(Number(pivotTotalLeads))) : 0;
    titleEl.textContent = `Vista operativa | Total Leads: ${dashFmtLeads(total)}`;
    return;
  }
  let totalPlat = 0;
  let totalCrm = 0;
  getDashboardPlatformRowsForCrmCharts().forEach((r) => {
    totalPlat += Number(r.leads) || 0;
  });
  getDashboardCrmRowsForCharts().forEach((r) => {
    totalCrm += Math.max(0, Math.round(Number(r.leads) || 0));
  });
  titleEl.textContent = `Vista operativa | Total Plataforma: ${dashFmtLeads(Math.round(totalPlat))} | Total CRM: ${dashFmtLeads(Math.round(totalCrm))}`;
}

function renderDashboardCrmPivotFuente() {
  const table = document.getElementById("dashCrmPivotTable");
  const thead = document.getElementById("dashCrmPivotThead");
  const tbody = document.getElementById("dashCrmPivotTbody");
  if (!table || !thead || !tbody) return;

  const rows = getDashboardCrmRowsForPivotFuente();
  const days = dashboardAllDaysInSelectedMonth();
  const pivotTotalLeads = rows.reduce(
    (acc, r) => acc + Math.max(0, Math.round(Number(r.leads) || 0)),
    0
  );
  updateDashboardCrmDynamicTitle(pivotTotalLeads);

  const bucket = new Map();
  rows.forEach((r) => {
    const f = dashCrmNormalizeFuentePivotFromRow(r);
    const d = formatDateInputFromDate(r.fecha);
    if (!d) return;
    if (!bucket.has(f)) bucket.set(f, new Map());
    const m = bucket.get(f);
    m.set(d, (m.get(d) || 0) + Math.max(0, Math.round(Number(r.leads) || 0)));
  });

  const preferred = ["Leadgen", "Pixel", "Google", "TikTok", "Otros"];
  const seen = new Set();
  const fuentes = [];
  preferred.forEach((f) => {
    const m = bucket.get(f);
    if (m && dashCrmPivotFuenteMonthTotal(m, days) > 0) {
      fuentes.push(f);
      seen.add(f);
    }
  });
  [...bucket.keys()]
    .filter((k) => !seen.has(k) && dashCrmPivotFuenteMonthTotal(bucket.get(k), days) > 0)
    .sort((a, b) => a.localeCompare(b, "es"))
    .forEach((k) => fuentes.push(k));

  const thD = days
    .map((d) => {
      const dt = parseDateInput(d);
      const lab = dt ? String(dt.getDate()).padStart(2, "0") : d.slice(8, 10);
      return `<th class="col-num dash-crm-pivot-day-col">${escapeHtml(lab)}</th>`;
    })
    .join("");
  thead.innerHTML = `<tr><th class="dash-crm-pivot-fuente-col">Fuente</th>${thD}<th class="col-num dash-crm-pivot-sum-col">Σ</th></tr>`;

  if (!days.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="2" class="dash-empty-mini">Selecciona un mes válido para ver el detalle por fuente.</td></tr>`;
    table.querySelector("colgroup.dash-crm-pivot-colgroup")?.remove();
    return;
  }

  syncDashboardCrmPivotColgroup(table, days.length, fuentes);

  if (!rows.length || !fuentes.length) {
    tbody.innerHTML = `<tr><td colspan="${days.length + 2}" class="dash-empty-mini">Sin fuentes con leads en el mes y filtros actuales.</td></tr>`;
    return;
  }

  tbody.innerHTML = fuentes
    .map((f, rowIdx) => {
      const m = bucket.get(f) || new Map();
      let sum = 0;
      const toneClass = dashCrmPivotRowToneClass(f, rowIdx);
      const tds = days
        .map((d) => {
          const v = m.get(d) || 0;
          sum += v;
          const cell =
            v > 0
              ? escapeHtml(dashFmtLeads(v))
              : "";
          const emptyCls = v > 0 ? "" : " dash-crm-pivot-day-col--empty";
          return `<td class="col-num dash-crm-pivot-day-col${emptyCls}">${cell}</td>`;
        })
        .join("");
      return `<tr class="dash-crm-pivot-row ${toneClass}"><td class="dash-crm-pivot-fuente-col">${escapeHtml(f)}</td>${tds}<td class="col-num dash-crm-pivot-sum-col"><strong>${escapeHtml(dashFmtLeads(sum))}</strong></td></tr>`;
    })
    .join("");
}

/** Orden fijo de intervalos CRM (menor → mayor tiempo; al final casos sin clasificar). */
const DASH_CRM_INTERVAL_ORDER = [
  "0-15 min",
  "15-30 min",
  "30-45 min",
  "45-60 min",
  "1-2 horas",
  "2-5 horas",
  "5-24 horas",
  "1-2 días",
  "2-7 días",
  "Sin gestión",
  "Otros"
];

const DASH_CRM_INTERVAL_PALETTE = [
  "#93c5fd",
  "#67e8f9",
  "#a5b4fc",
  "#fcd34d",
  "#86efac",
  "#fda4af",
  "#d8b4fe",
  "#fdba74",
  "#99f6e4",
  "#cbd5e1",
  "#94a3b8"
];

/** @param {unknown} raw */
function canonDashboardCrmIntervalLabel(raw) {
  const s0 = String(raw ?? "").trim();
  const key = s0
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  if (!key) return "Sin gestión";
  if (key === "otros") return "Otros";
  if (key.includes("sin gestion")) return "Sin gestión";
  if (/^0[-\s]?15/.test(key) || key.includes("0 a 15")) return "0-15 min";
  if (/^15[-\s]?30/.test(key) || key.includes("15 a 30")) return "15-30 min";
  if (/^30[-\s]?45/.test(key) || key.includes("30 a 45")) return "30-45 min";
  if (/^45[-\s]?60/.test(key) || key.includes("45 a 60")) return "45-60 min";
  if ((key.includes("1-2") || key.includes("1–2")) && (key.includes("hor") || key.includes("hr"))) return "1-2 horas";
  if ((key.includes("2-5") || key.includes("2–5")) && (key.includes("hor") || key.includes("hr"))) return "2-5 horas";
  if (key.includes("5-24") || key.includes("5–24") || key.includes("5 a 24")) return "5-24 horas";
  if ((key.includes("1-2") || key.includes("1–2")) && key.includes("dia")) return "1-2 días";
  if ((key.includes("2-7") || key.includes("2–7")) && key.includes("dia")) return "2-7 días";
  return s0;
}

function applyDashboardCrmIntervaloPeriodScopeUi() {
  const bTotal = document.getElementById("dashCrmScopeTotal");
  const bMes = document.getElementById("dashCrmScopeMes");
  const m = dashboardCrmIntervaloPeriodScope;
  bTotal?.classList.toggle("dash-crm-toggle-btn--active", m === "total");
  bMes?.classList.toggle("dash-crm-toggle-btn--active", m === "mes");
}

function renderDashboardCrmIntervaloTabla() {
  const tbody = document.getElementById("dashCrmIntervalTbody");
  if (!tbody) return;
  applyDashboardCrmIntervaloPeriodScopeUi();

  const rows = getDashboardCrmRowsForIntervaloTabla();
  const counts = new Map();
  let totalLeads = 0;
  rows.forEach((r) => {
    const label = canonDashboardCrmIntervalLabel(r.intervaloGestion);
    const n = Math.max(0, Math.round(Number(r.leads) || 0));
    if (n <= 0) return;
    counts.set(label, (counts.get(label) || 0) + n);
    totalLeads += n;
  });

  if (totalLeads <= 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="dash-crm-interval-empty">Sin intervalos CRM en la vista actual.</td></tr>`;
    const tableEmpty = tbody.closest(".dash-crm-interval-table");
    if (tableEmpty instanceof HTMLElement) {
      tableEmpty.style.setProperty("--dash-crm-interval-visible-rows", "1");
    }
    return;
  }

  const extraKeys = [...counts.keys()].filter((k) => !DASH_CRM_INTERVAL_ORDER.includes(k));
  const orderedLabs = [...DASH_CRM_INTERVAL_ORDER, ...extraKeys];
  const htmlRows = orderedLabs.map((lab) => {
    const val = counts.get(lab) || 0;
    const pct = totalLeads > 0 ? Math.round((val / totalLeads) * 100) : 0;
    return `<tr>
      <td class="dash-crm-interval-lab">${escapeHtml(lab)}</td>
      <td class="dash-crm-interval-num">${escapeHtml(dashFmtLeads(val))}</td>
      <td class="dash-crm-interval-pct">${escapeHtml(String(pct))}%</td>
    </tr>`;
  });
  htmlRows.push(`<tr>
    <td class="dash-crm-interval-lab dash-crm-interval-total">TOTAL</td>
    <td class="dash-crm-interval-num dash-crm-interval-total">${escapeHtml(dashFmtLeads(totalLeads))}</td>
    <td class="dash-crm-interval-pct dash-crm-interval-total">100%</td>
  </tr>`);
  tbody.innerHTML = htmlRows.join("");
  const table = tbody.closest(".dash-crm-interval-table");
  if (table instanceof HTMLElement) {
    table.style.setProperty("--dash-crm-interval-visible-rows", String(Math.max(1, htmlRows.length)));
  }
}

function applyDashboardCrmBottomModeUi() {
  const pCmp = document.getElementById("dashCrmPanelCompare");
  const pFte = document.getElementById("dashCrmPanelFuente");
  const b1 = document.getElementById("dashCrmViewPlatVsCrm");
  const b2 = document.getElementById("dashCrmViewFuente");
  const m = dashboardCrmBottomMode;
  pCmp?.classList.toggle("hidden", m !== "platVsCrm");
  pFte?.classList.toggle("hidden", m !== "fuente");
  b1?.classList.toggle("dash-crm-toggle-btn--active", m === "platVsCrm");
  b2?.classList.toggle("dash-crm-toggle-btn--active", m === "fuente");
  if (m === "platVsCrm") updateDashboardCrmDynamicTitle(0);
}

function renderDashboardCrmBottomPanels() {
  if (!getDashboardSubtabVisibility().crm) return;
  applyDashboardCrmBottomModeUi();
  if (dashboardCrmBottomMode === "platVsCrm") {
    renderDashboardCrmCompareChart();
  } else {
    renderDashboardCrmPivotFuente();
  }
  renderDashboardCrmIntervaloTabla();
  renderDashboardCrmMotivosTabla();
}

/** KPIs + paneles inferiores CRM (gráfico evolutivo e intervalo) sin recargar tabla principal. */
function renderDashboardCrmPanelsOnly() {
  if (!hasAnyDataLoaded()) return;
  const { vis, eff } = prepareDashboardUiSubtabState();
  if (!(vis.crm && eff === "crm")) return;
  renderDashboardKpisCrm();
  renderDashboardCrmBottomPanels();
}

function modeloRowFechaEnRangoCampania(r, startD, endD) {
  if (!(r.fecha instanceof Date) || !startD || !endD || startD > endD) return false;
  const ds = formatDateInputFromDate(r.fecha);
  return ds >= formatDateInputFromDate(startD) && ds <= formatDateInputFromDate(endD);
}

function dashboardDateInActiveRange(dateValue) {
  const ds = formatDateInputFromDate(dateValue);
  if (estadoFiltrosDashboard.fechaInicio && ds < estadoFiltrosDashboard.fechaInicio) return false;
  if (estadoFiltrosDashboard.fechaFin && ds > estadoFiltrosDashboard.fechaFin) return false;
  return true;
}

/** Mes + rango día (toolbar): solo gráficos y evolutivos, no tabla ni KPIs. */
function dashboardModeloPassesChartPeriodFilter(r) {
  if (!(r?.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  if (formatMonthYearData(r.fecha) !== estadoFiltrosDashboard.mes) return false;
  return dashboardDateInActiveRange(r.fecha);
}

function dashboardCrmLeadPassesChartPeriodFilter(r) {
  if (!(r?.fecha instanceof Date) || Number.isNaN(r.fecha.getTime())) return false;
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  if (formatMonthYearData(r.fecha) !== estadoFiltrosDashboard.mes) return false;
  return dashboardDateInActiveRange(r.fecha);
}

/** Inicio / fin / días de pauta desde planning (misma lógica que dashboard Plataforma). */
function dashboardPlanningCalendarFromRows(planningRows) {
  let fechaInMin = null;
  let fechaFinMax = null;
  (planningRows || []).forEach((rec) => {
    const s = parseDateInput(rec.fechaInicio);
    const e = parseDateInput(rec.fechaFin);
    if (s && (!fechaInMin || s < fechaInMin)) fechaInMin = s;
    if (e && (!fechaFinMax || e > fechaFinMax)) fechaFinMax = e;
  });
  setFechaActualData();
  const diasPauta =
    fechaInMin && fechaFinMax ? getDaysTotalInclusive(fechaInMin, fechaFinMax) : 0;
  const diasTranscurridos =
    fechaInMin && fechaFinMax ? getDaysElapsedInclusive(fechaInMin, fechaFinMax, fechaActualData) : 0;
  const diasPendientes = Math.max(0, diasPauta - diasTranscurridos);
  return { fechaInMin, fechaFinMax, diasPauta, diasPendientes };
}

function dashboardModeloFilteredBySegmentsAndBusqueda(rows) {
  let out = rows || [];
  const busq = String(estadoFiltrosDashboard.busquedaPrograma ?? "").trim().toLowerCase();
  if (busq) {
    out = out.filter((r) =>
      dashboardRowSearchHaystackFromKey(dashboardRowKeyFromModelo(r)).includes(busq)
    );
  }
  return out;
}

/** Modelo para gráfico evolutivo Plataforma (segmentadores + mes/día). */
function getDashboardChartModeloData() {
  const base = getDashboardModeloFilteredBySegmentsOnly().filter(dashboardModeloPassesChartPeriodFilter);
  return filtrarDashboardSinBranding(base);
}

function getDashboardPlatformRowsForCrmCharts() {
  const visibleKeys = getDashboardCrmVisibleTableRowKeysSet();
  let base = getDashboardFilteredModeloParaComercialCrm().filter(dashboardModeloPassesChartPeriodFilter);
  base = filtrarDashboardSinBranding(base);
  base = base.filter((r) => visibleKeys.has(dashboardRowKeyFromModelo(r) || "|||"));
  const selRow = String(programaSeleccionado ?? "").trim();
  if (selRow) {
    base = base.filter((r) => dashboardRowKeyFromModelo(r) === selRow);
  }
  return base;
}

function getDashboardCrmRowsForCharts() {
  const visibleKeys = getDashboardCrmVisibleTableRowKeysSet();
  let rows = getDashboardCrmRowsForBottomPanels().filter(dashboardCrmLeadPassesChartPeriodFilter);
  rows = filterDashboardCrmLeadRowsPorFilaSeleccionada(rows);
  return filterDashboardCrmLeadRowsByVisibleTableRowKeys(rows, visibleKeys);
}

/** CRM tablas laterales: filtros tabla + Total/Mes + fila seleccionada. */
function getDashboardCrmRowsForSidePanelScope() {
  const rows = getDashboardCrmRowsForBottomPanels().filter(dashboardCrmIntervaloLeadPassesScopeFilter);
  return filterDashboardCrmLeadRowsPorFilaSeleccionada(rows);
}

/** CRM para Intervalo de Gestión. */
function getDashboardCrmRowsForIntervaloTabla() {
  return getDashboardCrmRowsForSidePanelScope();
}

/** CRM para tabla dinámica superior del panel derecho. */
function getDashboardCrmRowsForMotivosTabla() {
  return getDashboardCrmRowsForSidePanelScope();
}

/** CRM pivot Por fuente: filtros de tabla + mes seleccionado (todos los días del mes, con 0). */
function getDashboardCrmRowsForPivotFuente() {
  let rows = filterDashboardCrmLeadRowsPorFilaSeleccionada(getDashboardCrmRowsForBottomPanels());
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  const mesSel = estadoFiltrosDashboard.mes;
  return rows.filter((r) => formatMonthYearData(r.fecha) === mesSel);
}

/** Todos los días (01…último) del mes activo en filtros del dashboard CRM. */
function dashboardAllDaysInSelectedMonth() {
  if (!estadoFiltrosDashboard.mes) {
    const now = new Date();
    estadoFiltrosDashboard.mes = formatMonthYearData(now);
  }
  const bounds = dashboardMonthKeyBounds(estadoFiltrosDashboard.mes);
  if (!bounds?.min || !bounds?.max) return [];
  const start = parseDateInput(bounds.min);
  const end = parseDateInput(bounds.max);
  if (!start || !end || start > end) return [];
  const days = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endT = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= endT) {
    days.push(formatDateInputFromDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function obtenerEtiquetaPeriodo(mesSeleccionado, fechaInicio, fechaFin) {
  const mes = String(mesSeleccionado || "").trim();
  const parts = mes.split("-");
  const monthEn = parts[0] || "";
  const mi = MONTHS_EN_SHORT.indexOf(monthEn);
  const nombreMes = mi >= 0 ? MESES_LARGOS_ES[mi] : monthEn;
  return String(nombreMes || "MES").toUpperCase();
}

function renderDashboardPeriodHeaders() {
  const leadsHead = document.getElementById("dashHeaderLeads");
  const gastoHead = document.getElementById("dashHeaderGasto");
  if (!leadsHead || !gastoHead) return;
  leadsHead.textContent = "LEADS";
  gastoHead.textContent = "GASTO";
}

function guardarMostrarMetaGlobal() {
  try {
    appMemoryKV.setItem(LS_DASH_MOSTRAR_META_GLOBAL, String(mostrarMetaGlobal));
  } catch (err) {
    console.warn("No se pudo guardar estado de META GLOBAL", err);
  }
}

function renderDashboardTableFooter() {
  const tfoot = document.getElementById("dashTfoot");
  if (!tfoot) return;
  const empty = `<td class="dash-tfoot-empty">&nbsp;</td>`;
  const emptyMeta = `<td class="dash-tfoot-empty dash-grp-col dash-grp-col-meta">&nbsp;</td>`;
  const emptyLeads = `<td class="dash-tfoot-empty dash-grp-col dash-grp-col-leads">&nbsp;</td>`;
  const emptyGasto = `<td class="dash-tfoot-empty dash-grp-col dash-grp-col-gasto">&nbsp;</td>`;
  const metaBlock = mostrarMetaGlobal
    ? `
      <td class="dash-tfoot-empty dash-col-separador-left dash-grp-col dash-grp-col-meta dash-grp-col-first">&nbsp;</td>
      ${emptyMeta}
      ${emptyMeta}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-col dash-grp-col-meta">&nbsp;</td>
      <td class="dash-tfoot-total-metric dash-col-separador-left dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalMetaGasto">$0</span></td>
      ${emptyMeta}
      <td class="dash-tfoot-total-metric dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalGastoReal">$0</span></td>
      ${emptyMeta}
      ${emptyMeta}
      <td class="dash-tfoot-total-metric dash-col-separador-right dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalGastoPendiente">$0</span></td>
      <td class="dash-tfoot-empty dash-col-separador-left dash-grp-col dash-grp-col-meta">&nbsp;</td>
      ${emptyMeta}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-col dash-grp-col-meta">&nbsp;</td>
      <td class="dash-tfoot-empty dash-col-separador-left dash-grp-col dash-grp-col-meta">&nbsp;</td>
      ${emptyMeta}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-col dash-grp-col-meta">&nbsp;</td>
      <td class="dash-tfoot-total-metric dash-col-separador-left dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalMetaLeads">0</span></td>
      ${emptyMeta}
      <td class="dash-tfoot-total-metric dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalLeadsReal">0</span></td>
      ${emptyMeta}
      ${emptyMeta}
      <td class="dash-tfoot-total-metric dash-grp-col dash-grp-col-meta"><span id="dashTotalMetaGlobalLeadsPendiente">0</span></td>
      ${emptyMeta}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-sep-right grupo-separador dash-grp-col dash-grp-col-meta dash-grp-col-last">&nbsp;</td>
    `
    : "";
  tfoot.innerHTML = `
    <tr class="dash-tfoot-row">
      <td class="dash-estado-col dash-tfoot-empty dash-tfoot-estado">&nbsp;</td>
      <td class="tipo-col dash-tfoot-empty">&nbsp;</td>
      <td class="dash-int-col dash-tfoot-empty">&nbsp;</td>
      <td class="dash-plat-col dash-tfoot-empty">&nbsp;</td>
      <td class="programa-col dash-tfoot-label dash-col-separador-right"><strong>Total general</strong></td>
      ${metaBlock}
      <td class="dash-tfoot-total-metric dash-tfoot-total-leads-meta dash-grp-col dash-grp-col-leads dash-grp-col-first"><span id="dashTotalLeadsMeta">0</span></td>
      ${emptyLeads}
      ${emptyLeads}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-col dash-grp-col-leads">&nbsp;</td>
      <td class="dash-tfoot-total-metric dash-tfoot-total-leads dash-grp-col dash-grp-col-leads"><span id="dashTotalLeads">0</span></td>
      ${emptyLeads}
      ${emptyLeads}
      <td class="dash-tfoot-total-metric dash-tfoot-total-leads-pendiente dash-col-separador-right dash-grp-col dash-grp-col-leads"><span id="dashTotalLeadsPendiente">0</span></td>
      ${emptyLeads}
      <td class="dash-tfoot-empty dash-grp-sep-right grupo-separador dash-grp-col dash-grp-col-leads dash-grp-col-last">&nbsp;</td>
      <td class="dash-tfoot-total-metric dash-tfoot-total-gasto-meta dash-col-separador-left dash-grp-col dash-grp-col-gasto dash-grp-col-first"><span id="dashTotalGastoMeta">$0</span></td>
      ${emptyGasto}
      ${emptyGasto}
      <td class="dash-tfoot-empty dash-col-separador-right dash-grp-col dash-grp-col-gasto">&nbsp;</td>
      <td class="dash-tfoot-total-metric dash-tfoot-total-gasto dash-grp-col dash-grp-col-gasto"><span id="dashTotalGasto">$0</span></td>
      ${emptyGasto}
      ${emptyGasto}
      <td class="dash-tfoot-total-metric dash-tfoot-total-gasto-pendiente dash-col-separador-right dash-grp-col dash-grp-col-gasto dash-grp-col-last"><span id="dashTotalGastoPendiente">$0</span></td>
    </tr>
  `;
}

function updateDashboardMetaGlobalVisibility() {
  const groupHead = document.getElementById("dashMetaGlobalGroupHead");
  const toggleBtn = document.getElementById("dashToggleMetaGlobal");
  const expandBtn = document.getElementById("dashExpandMetaGlobal");
  document.querySelectorAll(".dash-meta-global-col").forEach((col) => {
    if (!(col instanceof HTMLElement)) return;
    col.style.display = mostrarMetaGlobal ? "" : "none";
  });
  if (groupHead instanceof HTMLElement) {
    groupHead.style.display = mostrarMetaGlobal ? "" : "none";
    groupHead.classList.toggle("dash-meta-global-collapsed", !mostrarMetaGlobal);
  }
  if (expandBtn instanceof HTMLButtonElement) {
    if (mostrarMetaGlobal) {
      expandBtn.style.display = "none";
    } else {
      expandBtn.style.display = "inline-flex";
    }
  }
  if (toggleBtn instanceof HTMLButtonElement) {
    toggleBtn.textContent = mostrarMetaGlobal ? "−" : "+";
    toggleBtn.setAttribute("aria-label", mostrarMetaGlobal ? "Colapsar META GLOBAL" : "Expandir META GLOBAL");
    toggleBtn.setAttribute("title", mostrarMetaGlobal ? "Colapsar META GLOBAL" : "Expandir META GLOBAL");
  }
}

function setMostrarMetaGlobal(valor) {
  mostrarMetaGlobal = Boolean(valor);
  guardarMostrarMetaGlobal();
  updateDashboardMetaGlobalVisibility();
  renderDashboardTableFooter();
}

function getDashboardTablaLeadsGastoData() {
  return filtrarDashboardSinBranding(getDashboardFilteredData());
}

function dashboardPlanningRecordMatchesSegments(rec) {
  if (estadoFiltrosDashboard.tipo && String(rec.tipo) !== estadoFiltrosDashboard.tipo) return false;
  if (estadoFiltrosDashboard.intake && String(rec.intake) !== estadoFiltrosDashboard.intake) return false;
  if (estadoFiltrosDashboard.tracking && String(rec.tracking) !== estadoFiltrosDashboard.tracking) return false;
  if (estadoFiltrosDashboard.plataforma && String(rec.plataforma) !== estadoFiltrosDashboard.plataforma) return false;
  return true;
}

function dashboardPlanningRecordContainsMonth(rec, monthKey) {
  const parsed = parseMonthYearData(monthKey);
  if (!parsed) return false;
  const start = parseDateInput(rec.fechaInicio);
  const end = parseDateInput(rec.fechaFin);
  if (!start || !end || start > end) return false;
  const monthStart = new Date(parsed.year, parsed.monthIndex, 1);
  const monthEnd = new Date(parsed.year, parsed.monthIndex + 1, 0);
  return start <= monthEnd && end >= monthStart;
}

function getDashboardKpiDataset() {
  const base = aplicarFiltroBrandingTarjetas(getDashboardFilteredData());
  if (!programaSeleccionado) return base;
  const row = parseDashboardRowKey(programaSeleccionado);
  return base.filter(
    (r) =>
      String(r.tipo) === row.tipo &&
      String(r.programa) === row.programa &&
      String(r.intake) === row.intake &&
      String(r.tracking) === row.tracking &&
      String(r.plataforma) === row.plataforma
  );
}

function dashPlataformaStyleClass(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "meta" || /^meta\b/.test(s)) return "dash-plat-style-meta";
  if (s.includes("google")) return "dash-plat-style-google";
  if (s.includes("tiktok")) return "dash-plat-style-tiktok";
  if (s.includes("linkedin")) return "dash-plat-style-linkedin";
  return "dash-plat-style-default";
}

/** Familia visual/filtro coherente con dashPlataformaStyleClass (vacío → otras). */
function dashPlataformaFamilyKey(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "meta" || /^meta\b/.test(s)) return "meta";
  if (s.includes("google")) return "google";
  if (s.includes("linkedin")) return "linkedin";
  if (s.includes("tiktok")) return "tiktok";
  return "";
}

/**
 * Meta → Google → LinkedIn → TikTok siempre visibles (placeholders si no hay data).
 * Valores elegidos desde datos cuando existan, para mantener igualdad exacta al filtrar filas.
 */
function getDashboardPlataformaSegmentValues() {
  const order = ["meta", "google", "linkedin", "tiktok"];
  const labels = ["Meta", "Google", "LinkedIn", "TikTok"];
  const dataVals = uniqueVals("plataforma").map(String);
  const rep = Object.create(null);
  for (const v of dataVals) {
    const fam = dashPlataformaFamilyKey(v);
    if (fam && rep[fam] === undefined) rep[fam] = v;
  }
  const main = order.map((fam, i) => (rep[fam] !== undefined ? rep[fam] : labels[i]));
  const extras = dataVals
    .filter((v) => {
      const fam = dashPlataformaFamilyKey(v);
      if (!fam) return true;
      return rep[fam] !== v;
    })
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => String(a).localeCompare(String(b), "es"));
  return main.concat(extras);
}

function renderDashboardSegmentButtons(containerId, field, values) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const cur = estadoFiltrosDashboard[field];
  box.innerHTML = values
    .map((v) => {
      const active = cur === v ? " dash-seg-btn-active" : "";
      const valEsc = escapeHtml(v);
      const platExtra = field === "plataforma" ? ` ${dashPlataformaStyleClass(v)}` : "";
      return `<button type="button" class="dash-seg-btn dash-seg-${escapeHtml(field)}${platExtra}${active}"
      data-dash-seg="${escapeHtml(field)}" data-dash-val="${valEsc}">${valEsc}</button>`;
    })
    .join("");
}

function renderDashboardAllSegmentGroups() {
  if (esTipoBrandingConvocatoriaDashboard(estadoFiltrosDashboard.tipo)) {
    estadoFiltrosDashboard.tipo = "";
  }
  renderDashboardSegmentButtons("dashSegTipo", "tipo", getDashboardSegmentTiposComerciales());
  renderDashboardSegmentButtons("dashSegTracking", "tracking", uniqueVals("tracking"));
  renderDashboardSegmentButtons("dashSegPlataforma", "plataforma", getDashboardPlataformaSegmentValues());
  renderDashboardSegmentButtons("dashSegEstado", "estado", getDashboardUniqueEstados());
}

function fillDashboardIntakeSelect() {
  const sel = document.getElementById("dashFiltroIntake");
  if (!sel) return;
  const current = estadoFiltrosDashboard.intake || "";
  const values = getPlanningUniqueIntakes();
  sel.innerHTML = `<option value="">Todos</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(toShortIntakeLabel(v))}</option>`).join("");
  if (current && values.includes(current)) sel.value = current;
  else if (current) estadoFiltrosDashboard.intake = "";
}

function fillDashboardMesSelect() {
  const sel = document.getElementById("dashFiltroMes");
  if (!sel) return;
  const now = new Date();
  const currentMonth = formatMonthYearData(now);
  const options = sortDashboardMonthKeysChrono(
    Array.from(
      new Set(
        dataReal
          .map((r) => (r?.fecha instanceof Date ? formatMonthYearData(r.fecha) : ""))
          .filter(Boolean)
      )
    )
  );
  if (!options.length) options.push(currentMonth);
  const cur = estadoFiltrosDashboard.mes || currentMonth;
  sel.innerHTML = options
    .map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(dashboardMonthKeyToLabel(k))}</option>`)
    .join("");
  if (options.includes(cur)) sel.value = cur;
  else if (options.includes(currentMonth)) sel.value = currentMonth;
  else sel.value = options[options.length - 1];
  estadoFiltrosDashboard.mes = sel.value;
}

/**
 * Ajusta min/max de los inputs al mes seleccionado.
 * @param {boolean} resetRangeToFullMonth Si true, reinicia el rango al mes completo (p. ej. al cambiar de mes).
 */
function syncDashboardDateInputsToMonth(resetRangeToFullMonth = false) {
  const fi = document.getElementById("dashFechaInicio");
  const ff = document.getElementById("dashFechaFin");
  if (!fi || !ff) return;
  if (!estadoFiltrosDashboard.mes) estadoFiltrosDashboard.mes = formatMonthYearData(new Date());
  const b = dashboardMonthKeyBounds(estadoFiltrosDashboard.mes);
  if (b) {
    fi.min = b.min;
    fi.max = b.max;
    ff.min = b.min;
    ff.max = b.max;
    if (resetRangeToFullMonth) {
      estadoFiltrosDashboard.fechaInicio = b.min;
      estadoFiltrosDashboard.fechaFin = b.max;
      fi.value = b.min;
      ff.value = b.max;
    }
  } else {
    fi.removeAttribute("min");
    fi.removeAttribute("max");
    ff.removeAttribute("min");
    ff.removeAttribute("max");
  }
}

/**
 * Garantiza rango dentro del mes; opcionalmente alerta al usuario.
 * @param {{ silent?: boolean }} options silent=true evita alert() al corregir automáticamente (carga UI, cambio de mes).
 */
function validateDashboardRangoFechas(options = {}) {
  const silent = Boolean(options.silent);
  const b = dashboardMonthKeyBounds(estadoFiltrosDashboard.mes);
  const fiEl = document.getElementById("dashFechaInicio");
  const ffEl = document.getElementById("dashFechaFin");
  if (!b) {
    if (fiEl) fiEl.value = estadoFiltrosDashboard.fechaInicio || "";
    if (ffEl) ffEl.value = estadoFiltrosDashboard.fechaFin || "";
    return;
  }
  let a = String(estadoFiltrosDashboard.fechaInicio || "").trim();
  let c = String(estadoFiltrosDashboard.fechaFin || "").trim();
  let invalidUserRange = false;
  if (!a || !c) {
    a = b.min;
    c = b.max;
  } else {
    const outsideMonth = a < b.min || a > b.max || c < b.min || c > b.max;
    const inverted = a > c;
    if (outsideMonth || inverted) {
      invalidUserRange = true;
      a = b.min;
      c = b.max;
    }
  }
  if (invalidUserRange && !silent) {
    alert("El rango de fechas debe estar dentro del mes seleccionado");
  }
  estadoFiltrosDashboard.fechaInicio = a;
  estadoFiltrosDashboard.fechaFin = c;
  if (fiEl) fiEl.value = a;
  if (ffEl) ffEl.value = c;
}

const DASH_GASTO_DIFF_EPS = 0.009;
let dashGastoDiffExcludedRowsCache = [];
let dashEndingSoonAlertTimer = null;
let dashEndingSoonAlertShown = false;
/** Si el usuario cierra la alerta con ✕, se oculta hasta que cambie el periodo (mes o rango). */
let dashGastoDiffBannerDismissed = false;
let dashGastoDiffPeriodSnapshot = null;

function getDashboardGastoDiffPeriodKey() {
  return `${estadoFiltrosDashboard.mes}|${String(estadoFiltrosDashboard.fechaInicio || "").trim()}|${String(estadoFiltrosDashboard.fechaFin || "").trim()}`;
}

/** DATA general acotada al mes y rango del dashboard (sin tipo, intake, tracking, etc.). */
function dataRealPasaFiltroPeriodoDashboard(d) {
  if (!(d.fecha instanceof Date) || Number.isNaN(d.fecha.getTime())) return false;
  const mesSel = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());
  if (formatMonthYearData(d.fecha) !== mesSel) return false;
  const ds = formatDateInputFromDate(d.fecha);
  const fi = String(estadoFiltrosDashboard.fechaInicio || "").trim();
  const ff = String(estadoFiltrosDashboard.fechaFin || "").trim();
  if (fi && ds < fi) return false;
  if (ff && ds > ff) return false;
  return true;
}

function getTotalDataGastoPeriodoDashboard() {
  return dataReal.filter(dataRealPasaFiltroPeriodoDashboard).reduce((a, d) => a + (Number(d.gasto) || 0), 0);
}

/** Mismo conjunto de filas del modelo que usa el KPI de presupuesto/gasto (filtros + branding + fila de programa). */
function getDashboardModeloRowsForGastoTotal() {
  let rows = aplicarFiltroBrandingTarjetas(getDashboardFilteredData());
  if (programaSeleccionado) {
    const row = parseDashboardRowKey(programaSeleccionado);
    rows = rows.filter(
      (r) =>
        String(r.tipo) === row.tipo &&
        String(r.programa) === row.programa &&
        String(r.intake) === row.intake &&
        String(r.tracking) === row.tracking &&
        String(r.plataforma) === row.plataforma
    );
  }
  return rows;
}

function dashboardModeloRowDedupeKeyFromModeloRow(r) {
  return [
    r.tipo,
    r.programa,
    r.intake,
    r.plataforma,
    r.tracking,
    formatDateInputFromDate(r.fecha),
    r.gasto,
    r.leads,
    r.clics,
    r.impresiones,
    r.idCampania
  ].join("||");
}

function dashboardModeloRowDedupeKeyFromParts(planning, d, rel) {
  return [
    planning.tipo,
    planning.programa,
    planning.intake,
    planning.plataforma,
    planning.tracking,
    formatDateInputFromDate(d.fecha),
    d.gasto,
    d.leads,
    d.clics,
    d.impresiones,
    rel.idCampania
  ].join("||");
}

function collectMotivosBaseDashboardFilters(mrow) {
  const out = [];
  const mesSel = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());
  if (formatMonthYearData(mrow.fecha) !== mesSel) out.push("No pertenece al mes seleccionado");
  const ds = formatDateInputFromDate(mrow.fecha);
  const fi = String(estadoFiltrosDashboard.fechaInicio || "").trim();
  const ff = String(estadoFiltrosDashboard.fechaFin || "").trim();
  if (fi && ds < fi) out.push("Fuera de rango de fechas");
  if (ff && ds > ff) out.push("Fuera de rango de fechas");
  if (estadoFiltrosDashboard.tipo && String(mrow.tipo) !== String(estadoFiltrosDashboard.tipo)) out.push("Filtro de tipo activo");
  if (estadoFiltrosDashboard.intake && String(mrow.intake) !== String(estadoFiltrosDashboard.intake)) out.push("Filtro de intake activo");
  if (estadoFiltrosDashboard.tracking && String(mrow.tracking) !== String(estadoFiltrosDashboard.tracking)) out.push("Filtro de tracking activo");
  if (estadoFiltrosDashboard.plataforma && String(mrow.plataforma) !== String(estadoFiltrosDashboard.plataforma)) out.push("Filtro de plataforma activo");
  if (estadoFiltrosDashboard.estado && !dashboardModeloCumpleEstado(mrow)) out.push("Filtro de estado de campaña activo");
  return [...new Set(out)];
}

function collectMotivosWhyNotInFinalDashboard(mrow, dedupeKey) {
  if (
    getDashboardModeloRowsForGastoTotal().some((r) => dashboardModeloRowDedupeKeyFromModeloRow(r) === dedupeKey)
  ) {
    return [];
  }
  const baseRows = getDashboardFilteredData();
  const inBase = baseRows.some((r) => dashboardModeloRowDedupeKeyFromModeloRow(r) === dedupeKey);
  const afterBrand = aplicarFiltroBrandingModeloGasto(baseRows);
  const inAfterBrand = afterBrand.some((r) => dashboardModeloRowDedupeKeyFromModeloRow(r) === dedupeKey);
  if (!inBase) return collectMotivosBaseDashboardFilters(mrow);
  if (!inAfterBrand) return ["Campaña de branding no incluida"];
  if (programaSeleccionado) return ["No coincide con el programa seleccionado en la tabla"];
  return ["No relacionado en módulo RELACIONES"];
}

function computeDashGastoDiffExcludedRows() {
  const excluded = [];
  const keyFinal = new Set(getDashboardModeloRowsForGastoTotal().map(dashboardModeloRowDedupeKeyFromModeloRow));
  for (const d of dataReal) {
    if (!dataRealPasaFiltroPeriodoDashboard(d)) continue;
    const g = Number(d.gasto) || 0;
    if (g < DASH_GASTO_DIFF_EPS) continue;
    const dataId = String(d.idCampania || "").trim();
    const rels = getRelacionesPlataforma().filter((rel) => String(rel.idCampania || "").trim() === dataId);
    if (!rels.length) {
      excluded.push({
        fecha: d.fecha,
        idCampania: d.idCampania,
        nombre: d.nombre,
        gasto: g,
        motivo: "No relacionado en módulo RELACIONES"
      });
      continue;
    }
    let hit = false;
    const reasonsAcc = [];
    for (const rel of rels) {
      const planning = planningDraftRecords().find((rec) => planningKeyFromRecord(rec) === rel.planningKey);
      if (!planning) {
        reasonsAcc.push("No relacionado en módulo RELACIONES");
        continue;
      }
      const ps = parseDateInput(planning.fechaInicio);
      const pe = parseDateInput(planning.fechaFin);
      if (!ps || !pe || d.fecha < ps || d.fecha > pe) {
        reasonsAcc.push("Fuera de rango de fechas");
        continue;
      }
      const dk = dashboardModeloRowDedupeKeyFromParts(planning, d, rel);
      const mrow = modeloAnalitico.find((r) => dashboardModeloRowDedupeKeyFromModeloRow(r) === dk);
      if (!mrow) {
        reasonsAcc.push("No relacionado en módulo RELACIONES");
        continue;
      }
      if (keyFinal.has(dk)) {
        hit = true;
        break;
      }
      collectMotivosWhyNotInFinalDashboard(mrow, dk).forEach((w) => reasonsAcc.push(w));
    }
    if (!hit) {
      const uniq = [...new Set(reasonsAcc.filter(Boolean))];
      const motivo = uniq.length ? uniq.join("; ") : "No relacionado en módulo RELACIONES";
      excluded.push({
        fecha: d.fecha,
        idCampania: d.idCampania,
        nombre: d.nombre,
        gasto: g,
        motivo
      });
    }
  }
  return excluded;
}

function closeDashGastoDiffModal() {
  document.getElementById("dashGastoDiffModal")?.classList.add("hidden");
}

function closeDashEndingSoonModal() {
  document.getElementById("dashEndingSoonModal")?.classList.add("hidden");
}

function diffDaysFromTodayToDate(targetDate) {
  if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return Infinity;
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const b = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

const DASH_ENDING_SOON_ALERT_DAYS = 10;

function dashEndingSoonDaysBadgeClass(diasRestantes) {
  const d = Math.max(0, Math.round(Number(diasRestantes) || 0));
  if (d <= 3) return "dash-ending-soon-badge dash-ending-soon-badge--critical";
  if (d <= 6) return "dash-ending-soon-badge dash-ending-soon-badge--warning";
  return "dash-ending-soon-badge dash-ending-soon-badge--notice";
}

function collectDashboardCampaignsEndingSoon() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const limit = new Date(start);
  limit.setDate(limit.getDate() + DASH_ENDING_SOON_ALERT_DAYS);
  return planningDraftRecords()
    .filter((rec) => !esTipoBrandingConvocatoriaDashboard(rec.tipo))
    .map((rec) => {
      const endDate = parseDateInput(rec.fechaFin);
      if (!endDate) return null;
      if (endDate < start || endDate > limit) return null;
      const diasRestantes = diffDaysFromTodayToDate(endDate);
      return {
        programa: String(rec.programa || ""),
        tipo: String(rec.tipo || ""),
        intake: String(rec.intake || ""),
        fechaFin: endDate,
        diasRestantes
      };
    })
    .filter((x) => x != null)
    .sort((a, b) => {
      const ta = a.fechaFin.getTime();
      const tb = b.fechaFin.getTime();
      if (ta !== tb) return ta - tb;
      return a.programa.localeCompare(b.programa, "es");
    });
}

function openDashEndingSoonModal() {
  if (getCampatrackRole() === "viewer") return;
  const modal = document.getElementById("dashEndingSoonModal");
  const tbody = document.getElementById("dashEndingSoonTbody");
  if (!modal || !tbody) return;
  const rows = collectDashboardCampaignsEndingSoon();
  if (!rows.length) return;
  tbody.innerHTML = rows
    .map((row) => {
      const badgeCls = dashEndingSoonDaysBadgeClass(row.diasRestantes);
      const diasLabel = row.diasRestantes === 1 ? "1 día" : `${row.diasRestantes} días`;
      return `<tr class="dash-ending-soon-row">
        <td class="dash-ending-soon-cell dash-ending-soon-cell--programa" title="${escapeHtml(row.programa)}">${escapeHtml(row.programa)}</td>
        <td class="dash-ending-soon-cell">${escapeHtml(row.tipo)}</td>
        <td class="dash-ending-soon-cell">${escapeHtml(row.intake)}</td>
        <td class="dash-ending-soon-cell dash-ending-soon-cell--date">${escapeHtml(formatFechaDdMmmEsFromDate(row.fechaFin))}</td>
        <td class="dash-ending-soon-cell dash-ending-soon-cell--badge"><span class="${badgeCls}">${escapeHtml(diasLabel)}</span></td>
      </tr>`;
    })
    .join("");
  modal.classList.remove("hidden");
}

function scheduleDashEndingSoonAlert() {
  if (getCampatrackRole() === "viewer") {
    if (dashEndingSoonAlertTimer != null) {
      clearTimeout(dashEndingSoonAlertTimer);
      dashEndingSoonAlertTimer = null;
    }
    return;
  }
  if (dashEndingSoonAlertShown) return;
  if (dashEndingSoonAlertTimer != null) {
    clearTimeout(dashEndingSoonAlertTimer);
    dashEndingSoonAlertTimer = null;
  }
  dashEndingSoonAlertTimer = setTimeout(() => {
    dashEndingSoonAlertTimer = null;
    dashEndingSoonAlertShown = true;
    const dashboardVisible = !document.getElementById("dashboardModule")?.classList.contains("hidden");
    if (!dashboardVisible) return;
    openDashEndingSoonModal();
  }, 3000);
}

/** Nombre de archivo: detalle_diferencias_dashboard_abril_2026.xlsx */
function dashboardGastoDiffExportFilename() {
  const mes = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());
  const parts = String(mes).split("-");
  const mi = MONTHS_EN_SHORT.indexOf(parts[0]);
  const y = String(parts[1] || "").trim().replace(/\s+/g, "");
  const mesSlug =
    mi >= 0 && MESES_LARGOS_ES[mi]
      ? String(MESES_LARGOS_ES[mi])
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, "_")
      : "mes";
  return `detalle_diferencias_dashboard_${mesSlug}_${y || "sin_ano"}.xlsx`;
}

function formatFechaExportDashGastoDiff(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const y = d.getFullYear();
  return `${day}/${month}/${y}`;
}

function exportDashGastoDiffToExcel() {
  void showAppDialog({
    message: "La exportación a Excel está deshabilitada.",
    primaryText: "Entendido",
    showSecondary: false,
    primaryDanger: false
  });
}

function dashboardExportFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `dashboard_export_${yyyy}${mm}${dd}.xlsx`;
}

function exportDashboardTableToExcel() {
  void showAppDialog({
    message: "La exportación a Excel está deshabilitada.",
    primaryText: "Entendido",
    showSecondary: false,
    primaryDanger: false
  });
}

function planningExportFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `planning_export_${yyyy}${mm}${dd}.xlsx`;
}

function exportPlanningTableToExcel() {
  void showAppDialog({
    message: "La exportación a Excel está deshabilitada.",
    primaryText: "Entendido",
    showSecondary: false,
    primaryDanger: false
  });
}

function openDashGastoDiffModal() {
  if (getCampatrackRole() === "viewer") return;
  const modal = document.getElementById("dashGastoDiffModal");
  const tbody = document.getElementById("dashGastoDiffTbody");
  if (!modal || !tbody) return;
  dashGastoDiffExcludedRowsCache = computeDashGastoDiffExcludedRows();
  tbody.innerHTML = dashGastoDiffExcludedRowsCache
    .map((row) => {
      const fStr =
        row.fecha instanceof Date
          ? formatDateDdMmm(formatDateInputFromDate(row.fecha))
          : "—";
      return `<tr>
        <td>${escapeHtml(fStr)}</td>
        <td>${escapeHtml(String(row.idCampania ?? ""))}</td>
        <td>${escapeHtml(String(row.nombre ?? ""))}</td>
        <td>${escapeHtml(dashFmtMoney(row.gasto))}</td>
        <td>${escapeHtml(row.motivo)}</td>
      </tr>`;
    })
    .join("");
  if (!dashGastoDiffExcludedRowsCache.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="dash-empty-mini">No hay filas para listar (revisa totales o recarga el modelo).</td></tr>`;
  }
  modal.classList.remove("hidden");
}

function renderDashboardGastoDiffBanner() {
  const wrap = document.getElementById("dashGastoDiffBanner");
  if (!wrap) return;
  if (dashboardActiveSubtab === "crm") {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  if (getCampatrackRole() === "viewer") {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const periodKey = getDashboardGastoDiffPeriodKey();
  if (periodKey !== dashGastoDiffPeriodSnapshot) {
    dashGastoDiffPeriodSnapshot = periodKey;
    dashGastoDiffBannerDismissed = false;
  }
  if (!hasAnyDataLoaded() || !dataReal.length) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const totalDataPeriodo = getTotalDataGastoPeriodoDashboard();
  const totalDashboard = getDashboardModeloRowsForGastoTotal().reduce((a, r) => a + (Number(r.gasto) || 0), 0);
  const diff = totalDataPeriodo - totalDashboard;
  if (Math.abs(diff) < DASH_GASTO_DIFF_EPS) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  if (dashGastoDiffBannerDismissed) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  const btnCerrar = `<button type="button" id="dashGastoDiffCloseBtn" class="dash-gasto-diff-close" aria-label="Cerrar aviso">✕</button>`;
  if (diff > DASH_GASTO_DIFF_EPS) {
    wrap.innerHTML = `
      <div class="dash-gasto-diff-inner">
        <span class="dash-gasto-diff-text">
          Diferencia detectada: <strong>${escapeHtml(dashFmtMoney(diff))}</strong> no está siendo considerado en el dashboard para el periodo seleccionado
        </span>
        <div class="dash-gasto-diff-actions">
          <button type="button" id="dashGastoDiffDetalleBtn" class="btn-toolbar btn-secondary dash-gasto-diff-btn">Ver detalle</button>
          ${btnCerrar}
        </div>
      </div>`;
  } else {
    wrap.innerHTML = `
      <div class="dash-gasto-diff-inner dash-gasto-diff-warn-neg">
        <span class="dash-gasto-diff-text">
          El dashboard suma <strong>${escapeHtml(dashFmtMoney(-diff))}</strong> más que la suma en DATA del periodo seleccionado (p. ej. misma fila vinculada a varios programas en RELACIONES).
        </span>
        <div class="dash-gasto-diff-actions">${btnCerrar}</div>
      </div>`;
  }
}

function dashFmtKpiComma(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-US");
}

/** Mini tendencia CPL en canvas (solo presentación: línea + marcadores). */
function dashPaintCplMiniChartPlaceholder(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cssH = 36;
  const cssW = Math.max(120, canvas.clientWidth || 180);
  const dpr = Math.min(typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  const dm = document.body.classList.contains("dark-mode");
  if (dm) {
    ctx.fillStyle = "rgba(15, 23, 42, 0.65)";
    ctx.fillRect(0, 0, W, H);
  }
  const lineColor = dm ? "rgba(251, 146, 60, 0.9)" : "rgba(234, 88, 12, 0.72)";
  const pts = [
    [4, H * 0.62],
    [W * 0.14, H * 0.4],
    [W * 0.28, H * 0.52],
    [W * 0.42, H * 0.3],
    [W * 0.56, H * 0.48],
    [W * 0.72, H * 0.32],
    [W * 0.86, H * 0.44],
    [W - 4, H * 0.38],
  ];
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.45;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  const r = 2.6;
  ctx.fillStyle = lineColor;
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderDashboardKpis() {
  const el = document.getElementById("dashboardKpis");
  if (!el) return;
  setFechaActualData();
  const dataFiltrada = getDashboardKpiDataset();
  const dataGastoTotal = getDashboardModeloRowsForGastoTotal();
  const gastoReal = dataGastoTotal.reduce((a, r) => a + (Number(r.gasto) || 0), 0);
  const leadsReal = dataFiltrada.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const clicsReal = dataFiltrada.reduce((a, r) => a + (Number(r.clics) || 0), 0);
  const impReal = dataFiltrada.reduce((a, r) => a + (Number(r.impresiones) || 0), 0);
  const cplReal = leadsReal > 0 ? gastoReal / leadsReal : 0;
  const t = getDashboardMetaTriplet();
  const metaPresupuesto = t.metaPresupuesto;
  const metaLeads = t.metaLeads;
  const metaCpl = t.metaCpl;

  const ratioPres = metaPresupuesto > 0 ? gastoReal / metaPresupuesto : 0;
  const ratioLeads = metaLeads > 0 ? leadsReal / metaLeads : 0;

  const saldoPres = metaPresupuesto - gastoReal;
  const saldoLeads = metaLeads - leadsReal;
  const diffCpl = cplReal - metaCpl;
  const diffCplSpanCls = diffCpl < 0 ? "dash-kpi-diff-neg" : diffCpl > 0 ? "dash-kpi-diff-pos" : "";

  const ctr = impReal > 0 ? clicsReal / impReal : 0;
  const cpc = clicsReal > 0 ? gastoReal / clicsReal : 0;
  const cvr = clicsReal > 0 ? leadsReal / clicsReal : 0;

  const subPres = `Meta: ${dashFmtKpiComma(metaPresupuesto)} | ${dashFmtPct(ratioPres)} | Saldo: ${dashFmtKpiComma(saldoPres)}`;
  const subLeads = `Meta: ${dashFmtKpiComma(metaLeads)} | ${dashFmtPct(ratioLeads)} | Saldo: ${dashFmtKpiComma(saldoLeads)}`;
  const pctBarPres = metaPresupuesto > 0 ? Math.min(100, ratioPres * 100) : 0;
  const pctBarLeads = metaLeads > 0 ? Math.min(100, ratioLeads * 100) : 0;

  el.innerHTML = `
      <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-presupuesto">
        <div class="dash-kpi-head kpi-title">PRESUPUESTO</div>
        <div class="dash-kpi-main kpi-value">${dashFmtMoneyKpiMain(gastoReal)}</div>
        <div class="dash-kpi-sub kpi-subtext">${escapeHtml(subPres)}</div>
        <div class="kpi-progress" role="presentation" aria-hidden="true"><div class="kpi-progress-bar presupuesto" style="width:${pctBarPres}%"></div></div>
      </div>
      <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-leads">
        <div class="dash-kpi-head kpi-title">LEADS</div>
        <div class="dash-kpi-main kpi-value">${dashFmtLeadsKpiMain(leadsReal)}</div>
        <div class="dash-kpi-sub kpi-subtext">${escapeHtml(subLeads)}</div>
        <div class="kpi-progress" role="presentation" aria-hidden="true"><div class="kpi-progress-bar leads" style="width:${pctBarLeads}%"></div></div>
      </div>
      <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-cpl">
        <div class="dash-kpi-head kpi-title">CPL</div>
        <div class="dash-kpi-main kpi-value">${dashFmtDecimalFixed2(cplReal)}</div>
        <div class="dash-kpi-sub kpi-subtext">Meta: ${dashFmtDecimalFixed2(metaCpl)} | Dif: <span class="${diffCplSpanCls}">${dashFmtDecimalFixed2(diffCpl)}</span></div>
        <div class="kpi-chart" aria-hidden="true"><canvas id="cplMiniChart" class="cpl-mini-spark" width="180" height="36"></canvas></div>
      </div>
      <div class="dash-kpi-card dashboard-card kpi-card dash-kpi-theme-mix kpi-card-wide">
        <div class="dash-kpi-head kpi-title">Rendimiento</div>
        <div class="kpi-mix-strip" role="group" aria-label="CTR, CPC y CVR">
          <div class="kpi-mix-stat">
            <span class="kpi-mix-label">CTR</span>
            <span class="kpi-mix-value">${dashFmtPctFixed2FromRatio(ctr)}</span>
          </div>
          <div class="kpi-mix-stat">
            <span class="kpi-mix-label">CPC</span>
            <span class="kpi-mix-value">${dashFmtMoneyFixed2(cpc)}</span>
          </div>
          <div class="kpi-mix-stat">
            <span class="kpi-mix-label">CVR</span>
            <span class="kpi-mix-value">${dashFmtPctFixed2FromRatio(cvr)}</span>
          </div>
        </div>
      </div>
  `;

  requestAnimationFrame(() => dashPaintCplMiniChartPlaceholder(document.getElementById("cplMiniChart")));
}

function renderDashboardTabla() {
  renderDashboardTableFooter();
  updateDashboardMetaGlobalVisibility();
  const tbody = document.getElementById("dashTbody");
  const totalLeadsEl = document.getElementById("dashTotalLeads");
  const totalGastoEl = document.getElementById("dashTotalGasto");
  if (!tbody || !totalLeadsEl || !totalGastoEl) return;
  renderDashboardPeriodHeaders();

  const dataMesRaw = getDashboardFilteredData();
  const dataMesGasto = filtrarDashboardSinBranding(dataMesRaw);
  const dataMesPerf = filtrarDashboardSinBranding(dataMesRaw);

  setFechaActualData();
  const baseSegModelo = getDashboardModeloFilteredBySegmentsOnly();

  const mapMes = new Map();
  dataMesPerf.forEach((r) => {
    const key = dashboardRowKeyFromModelo(r) || "|||";
    if (!mapMes.has(key)) mapMes.set(key, []);
    mapMes.get(key).push(r);
  });
  const mapMesAll = new Map();
  dataMesGasto.forEach((r) => {
    const key = dashboardRowKeyFromModelo(r) || "|||";
    if (!mapMesAll.has(key)) mapMesAll.set(key, []);
    mapMesAll.get(key).push(r);
  });

  const busq = String(estadoFiltrosDashboard.busquedaPrograma ?? "").trim().toLowerCase();
  // Solo campañas con data en el dataset filtrado (evita mostrar filas "solo planning").
  let entries = Array.from(mapMes.entries());
  // Refuerzo defensivo: nunca renderizar campañas sin data.
  entries = entries.filter(([rowKey]) => (mapMesAll.get(rowKey) || []).length > 0);
  if (estadoFiltrosDashboard.estado) {
    entries = entries.filter(([rowKey]) => getDashboardRowDeliveryEstado(rowKey) === estadoFiltrosDashboard.estado);
  }
  if (busq) {
    entries = entries.filter(([rowKey]) => {
      return dashboardRowSearchHaystackFromKey(rowKey).includes(busq);
    });
  }
  const totals = {
    metaGlobalMetaLeads: 0,
    metaGlobalLeadsReal: 0,
    metaGlobalLeadsPendiente: 0,
    metaGlobalMetaGasto: 0,
    metaGlobalGastoReal: 0,
    metaGlobalGastoPendiente: 0,
    leadsMeta: 0,
    leadsReal: 0,
    leadsPendiente: 0,
    gastoMeta: 0,
    gastoReal: 0,
    gastoPendiente: 0
  };
  const mesGastoDiarioKey = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());

  const rowsHtml = entries.map(([rowKey, rowsMes]) => {
    const rowsMesAll = mapMesAll.get(rowKey) || [];
    const gastoRealMes = rowsMesAll.reduce((a, r) => a + (Number(r.gasto) || 0), 0);
    const leadsRealMes = rowsMes.reduce((a, r) => a + (Number(r.leads) || 0), 0);
    const row = parseDashboardRowKey(rowKey);
    const planningRows = getPlanningByProgIntakeTrackPlat(row.programa, row.intake, row.tracking, row.plataforma, row.tipo);
    const nombrePrograma = dashboardRowProgramaNombreFromKey(rowKey);
    const intakeValor = dashboardRowIntakeDisplayFromKey(rowKey);
    const tipo = row.tipo || "—";
    let fechaInMin = null;
    let fechaFinMax = null;
    planningRows.forEach((rec) => {
      const s = parseDateInput(rec.fechaInicio);
      const e = parseDateInput(rec.fechaFin);
      if (s && (!fechaInMin || s < fechaInMin)) fechaInMin = s;
      if (e && (!fechaFinMax || e > fechaFinMax)) fechaFinMax = e;
    });
    const rowsForKey = baseSegModelo.filter((r) => dashboardRowKeyFromModelo(r) === rowKey);
    const winCamp =
      fechaInMin && fechaFinMax
        ? rowsForKey.filter((r) => modeloRowFechaEnRangoCampania(r, fechaInMin, fechaFinMax))
        : [];
    const rowsGlobalAll = filtrarDashboardSinBranding(winCamp);
    const rowsGlobal = filtrarDashboardSinBranding(winCamp);
    const gastoRealGlobal = rowsGlobalAll.reduce((a, r) => a + (Number(r.gasto) || 0), 0);
    const leadsRealGlobal = rowsGlobal.reduce((a, r) => a + (Number(r.leads) || 0), 0);
    const planningRowsOperativas = planningRows.filter((rec) => !esTipoBrandingConvocatoriaDashboard(rec.tipo));
    let pmGlobal = computeDashboardPlanningGlobalMeta(planningRowsOperativas);
    let pmMes = computeDashboardPlanningPeriodMeta(planningRowsOperativas);

    const diasPautaGlobal = getDaysTotalInclusive(fechaInMin, fechaFinMax);
    const diasTranscurridosGlobal = getDaysElapsedInclusive(fechaInMin, fechaFinMax, fechaActualData);
    const diasPendientesGlobal = Math.max(0, diasPautaGlobal - diasTranscurridosGlobal);
    const ratioAvIdealGlobal = diasPautaGlobal > 0 ? diasTranscurridosGlobal / diasPautaGlobal : 0;
    const leadsDiarioRealGlobal = diasTranscurridosGlobal > 0 ? leadsRealGlobal / diasTranscurridosGlobal : 0;
    const gastoDiarioRealGlobal = diasTranscurridosGlobal > 0 ? gastoRealGlobal / diasTranscurridosGlobal : 0;
    const cplRealGlobal = leadsRealGlobal > 0 ? gastoRealGlobal / leadsRealGlobal : 0;
    const pctIdealLeadsGlobal = ratioAvIdealGlobal;
    const pctRealLeadsGlobal =
      pmGlobal.metaLeadsPeriod > 0 ? leadsRealGlobal / pmGlobal.metaLeadsPeriod : 0;
    const pctIdealGastoGlobal = ratioAvIdealGlobal;
    const pctRealGastoGlobal =
      pmGlobal.presupuestoPeriod > 0 ? gastoRealGlobal / pmGlobal.presupuestoPeriod : 0;
    const metaLeadsHoyGlobal = pmGlobal.metaLeadsPeriod * ratioAvIdealGlobal;
    const metaGastoHoyGlobal = pmGlobal.presupuestoPeriod * ratioAvIdealGlobal;
    const metaLeadsDiarioGlobal = diasPautaGlobal > 0 ? pmGlobal.metaLeadsPeriod / diasPautaGlobal : 0;
    const metaGastoDiarioGlobal = diasPautaGlobal > 0 ? pmGlobal.presupuestoPeriod / diasPautaGlobal : 0;
    const leadsPendGlobal = pmGlobal.metaLeadsPeriod - leadsRealGlobal;
    const gastoPendGlobal = pmGlobal.presupuestoPeriod - gastoRealGlobal;
    const gastoDiarioNextDays = diasPendientesGlobal > 0 ? gastoPendGlobal / diasPendientesGlobal : 0;
    const cplDiffGlobal = cplRealGlobal - pmGlobal.metaCplPeriod;

    const diasMesMetricasDiarioReal = computeDashboardDiasGastoDiarioRealMes(
      planningRowsOperativas,
      mesGastoDiarioKey,
      fechaActualData
    );
    const leadsDiarioRealMes = diasMesMetricasDiarioReal > 0 ? leadsRealMes / diasMesMetricasDiarioReal : 0;
    const gastoDiarioRealMes = diasMesMetricasDiarioReal > 0 ? gastoRealMes / diasMesMetricasDiarioReal : 0;
    const cplRealMes = leadsRealMes > 0 ? gastoRealMes / leadsRealMes : 0;
    const pctAvIdealL = pmMes.metaLeadsPeriod > 0 ? pmMes.metaLeadsHoyPeriod / pmMes.metaLeadsPeriod : 0;
    const pctAvRealL = pmMes.metaLeadsPeriod > 0 ? leadsRealMes / pmMes.metaLeadsPeriod : 0;
    const pctAvIdealG = pmMes.presupuestoPeriod > 0 ? pmMes.metaGastoHoyPeriod / pmMes.presupuestoPeriod : 0;
    const pctAvRealG = pmMes.presupuestoPeriod > 0 ? gastoRealMes / pmMes.presupuestoPeriod : 0;
    const leadsPendMes = Math.round(pmMes.metaLeadsPeriod - leadsRealMes);
    const gastoPendMes = pmMes.presupuestoPeriod - gastoRealMes;

    totals.metaGlobalMetaLeads += Number(pmGlobal.metaLeadsPeriod) || 0;
    totals.metaGlobalLeadsReal += Number(leadsRealGlobal) || 0;
    totals.metaGlobalLeadsPendiente += Number(leadsPendGlobal) || 0;
    totals.metaGlobalMetaGasto += Number(pmGlobal.presupuestoPeriod) || 0;
    totals.metaGlobalGastoReal += Number(gastoRealGlobal) || 0;
    totals.metaGlobalGastoPendiente += Number(gastoPendGlobal) || 0;
    totals.leadsMeta += Number(pmMes.metaLeadsPeriod) || 0;
    totals.leadsReal += Number(leadsRealMes) || 0;
    totals.leadsPendiente += Number(leadsPendMes) || 0;
    totals.gastoMeta += Number(pmMes.presupuestoPeriod) || 0;
    totals.gastoReal += Number(gastoRealMes) || 0;
    totals.gastoPendiente += Number(gastoPendMes) || 0;

    const semGlobalLeads = dashSemMetaG1(pctIdealLeadsGlobal, pctRealLeadsGlobal, "leads");
    const semGlobalGasto = dashSemMetaG1(pctIdealGastoGlobal, pctRealGastoGlobal, "gasto");
    const semMesLeads = dashSemMetaG1(pctAvIdealL, pctAvRealL, "leads");
    const semMesGasto = dashSemMetaG1(pctAvIdealG, pctAvRealG, "gasto");
    /** Misma lógica de semáforo que CPL Real del grupo Leads (ok / warn / bad vs meta período). */
    const cplClsGlobal = dashCplRealLeadsPeriodClass(pmGlobal.metaCplPeriod, cplRealGlobal);
    const cplClsMes = dashCplRealLeadsPeriodClass(pmMes.metaCplPeriod, cplRealMes);
    const sel = programaSeleccionado === rowKey ? "dash-row-selected" : "";
    const estadoDelivery = getDashboardRowDeliveryEstado(rowKey);
    const deliveryDotClass =
      estadoDelivery === "Activo"
        ? "dash-delivery-dot--on"
        : estadoDelivery === "Inactivo"
          ? "dash-delivery-dot--off"
          : "dash-delivery-dot--nodata";
    const estadoAria = estadoDelivery;
    const estadoTitle = estadoDelivery;
    const metaGlobalCells = mostrarMetaGlobal
      ? `
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-meta dash-grp-col-first">${escapeHtml(formatFechaDdMmmEsFromDate(fechaInMin))}</td>
        <td class="dash-grp-col dash-grp-col-meta">${escapeHtml(formatFechaDdMmmEsFromDate(fechaFinMax))}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtLeads(diasPautaGlobal)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-meta">${dashFmtLeads(diasPendientesGlobal)}</td>
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-meta">${dashFmtMoney(pmGlobal.presupuestoPeriod)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtMoney(metaGastoHoyGlobal)}</td>
        <td class="dash-cell-real-metric dash-grp-col dash-grp-col-meta">${dashFmtMoney(gastoRealGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtPctFromRatio(pctIdealGastoGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta ${semGlobalGasto}">${dashFmtPctFromRatio(pctRealGastoGlobal)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-meta">${dashFmtMoney(gastoPendGlobal)}</td>
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-meta">${dashFmtMoney(metaGastoDiarioGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtMoney(gastoDiarioRealGlobal)}</td>
        <td class="dash-col-separador-right dash-next-days-cell dash-grp-col dash-grp-col-meta">${dashFmtMoney(gastoDiarioNextDays)}</td>
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-meta">${dashFmtMoney(pmGlobal.metaCplPeriod)}</td>
        <td class="dash-grp-col dash-grp-col-meta ${cplClsGlobal}">${dashFmtMoney(cplRealGlobal)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-meta">${dashFmtSignedMoney(cplDiffGlobal)}</td>
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-meta">${dashFmtLeads(pmGlobal.metaLeadsPeriod)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtLeads(metaLeadsHoyGlobal)}</td>
        <td class="dash-cell-real-metric dash-grp-col dash-grp-col-meta">${dashFmtLeads(leadsRealGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtPctFromRatio(pctIdealLeadsGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta ${semGlobalLeads}">${dashFmtPctFromRatio(pctRealLeadsGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtLeads(leadsPendGlobal)}</td>
        <td class="dash-grp-col dash-grp-col-meta">${dashFmtLeads(metaLeadsDiarioGlobal)}</td>
        <td class="dash-col-separador-right dash-grp-sep-right grupo-separador dash-grp-col dash-grp-col-meta dash-grp-col-last">${dashFmtLeads(leadsDiarioRealGlobal)}</td>
      `
      : "";

    return `
      <tr class="${sel}" data-dash-row="${escapeHtml(rowKey)}">
        <td class="dash-estado-col" title="${escapeHtml(estadoTitle)}" role="img" aria-label="${escapeHtml(estadoAria)}"><span class="dash-delivery-dot ${deliveryDotClass}" aria-hidden="true"></span></td>
        <td class="tipo-col dash-td-tipo">${escapeHtml(tipo)}</td>
        <td class="dash-int-col">${escapeHtml(intakeValor)}</td>
        <td class="dash-plat-col">${formatearPlataforma(row.plataforma)}</td>
        <td class="programa-col dash-td-prog dash-col-separador-right">${escapeHtml(nombrePrograma)}</td>
        ${metaGlobalCells}
        <td class="dash-grp-col dash-grp-col-leads dash-grp-col-first">${dashFmtLeads(Math.round(pmMes.metaLeadsPeriod))}</td>
        <td class="dash-grp-col dash-grp-col-leads">${dashFmtLeads(Math.round(pmMes.metaLeadsHoyPeriod))}</td>
        <td class="dash-grp-col dash-grp-col-leads">${dashFmtLeads(Math.round(pmMes.metaLeadsDiarioPeriod))}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-leads">${dashFmtPctFromRatio(pctAvIdealL)}</td>
        <td class="dash-cell-real-metric dash-grp-col dash-grp-col-leads">${dashFmtLeads(Math.round(leadsRealMes))}</td>
        <td class="dash-grp-col dash-grp-col-leads">${dashFmtLeads(Math.round(leadsDiarioRealMes))}</td>
        <td class="dash-grp-col dash-grp-col-leads ${semMesLeads}">${dashFmtPctFromRatio(pctAvRealL)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-leads">${dashFmtLeads(leadsPendMes)}</td>
        <td class="dash-grp-col dash-grp-col-leads">${dashFmt2(pmMes.metaCplPeriod)}</td>
        <td class="dash-grp-sep-right grupo-separador dash-grp-col dash-grp-col-leads dash-grp-col-last ${cplClsMes}">${dashFmt2(cplRealMes)}</td>
        <td class="dash-col-separador-left dash-grp-col dash-grp-col-gasto dash-grp-col-first">${dashFmtMoney(pmMes.presupuestoPeriod)}</td>
        <td class="dash-grp-col dash-grp-col-gasto">${dashFmtMoney(pmMes.metaGastoHoyPeriod)}</td>
        <td class="dash-grp-col dash-grp-col-gasto">${dashFmtMoney(pmMes.metaGastoDiarioPeriod)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-gasto">${dashFmtPctFromRatio(pctAvIdealG)}</td>
        <td class="dash-cell-real-metric dash-grp-col dash-grp-col-gasto">${dashFmtMoney(gastoRealMes)}</td>
        <td class="dash-grp-col dash-grp-col-gasto">${dashFmtMoney(gastoDiarioRealMes)}</td>
        <td class="dash-grp-col dash-grp-col-gasto ${semMesGasto}">${dashFmtPctFromRatio(pctAvRealG)}</td>
        <td class="dash-col-separador-right dash-grp-col dash-grp-col-gasto dash-grp-col-last">${dashFmtMoney(gastoPendMes)}</td>
      </tr>
    `;
  }).join("");
  tbody.innerHTML = rowsHtml;

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText("dashTotalMetaGlobalMetaLeads", dashFmtLeads(totals.metaGlobalMetaLeads));
  setText("dashTotalMetaGlobalLeadsReal", dashFmtLeads(totals.metaGlobalLeadsReal));
  setText("dashTotalMetaGlobalLeadsPendiente", dashFmtLeads(totals.metaGlobalLeadsPendiente));
  setText("dashTotalMetaGlobalMetaGasto", dashFmtMoney(totals.metaGlobalMetaGasto));
  setText("dashTotalMetaGlobalGastoReal", dashFmtMoney(totals.metaGlobalGastoReal));
  setText("dashTotalMetaGlobalGastoPendiente", dashFmtMoney(totals.metaGlobalGastoPendiente));
  setText("dashTotalLeadsMeta", dashFmtLeads(totals.leadsMeta));
  totalLeadsEl.textContent = dashFmtLeads(totals.leadsReal);
  setText("dashTotalLeadsPendiente", dashFmtLeads(totals.leadsPendiente));
  setText("dashTotalGastoMeta", dashFmtMoney(totals.gastoMeta));
  totalGastoEl.textContent = dashFmtMoney(totals.gastoReal);
  setText("dashTotalGastoPendiente", dashFmtMoney(totals.gastoPendiente));
}

function formatDashboardChartLabel(yyyyMmDd) {
  const d = parseDateInput(yyyyMmDd);
  if (!d) return yyyyMmDd;
  const day = String(d.getDate()).padStart(2, "0");
  return `${day} ${MONTHS_EN_SHORT[d.getMonth()] || ""}`;
}

function formatDashboardTooltipDate(yyyyMmDd) {
  const d = parseDateInput(yyyyMmDd);
  if (!d) return yyyyMmDd;
  const day = String(d.getDate()).padStart(2, "0");
  const mon = MONTHS_EN_SHORT[d.getMonth()] || "";
  return `${day}-${mon}`;
}

function getDashboardChartDateRange() {
  setFechaActualData();
  const mes = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());
  const a = parseDateInput(estadoFiltrosDashboard.fechaInicio);
  const c = parseDateInput(estadoFiltrosDashboard.fechaFin);
  if (a && c) return { startD: a, endD: c };
  const b = dashboardMonthKeyBounds(mes);
  if (b) return { startD: parseDateInput(b.min), endD: parseDateInput(b.max) };
  return null;
}

/** Ticks 0…≥maxVal para ejes del gráfico Evolución diaria (solo visual). */
function dashboardChartNiceLinearTicks(maxVal, maxTickCount) {
  const cap = Number(maxVal);
  if (!Number.isFinite(cap) || cap <= 0) return [0, 1];
  if (cap < 1e-9) return [0, cap];
  const tc = Number(maxTickCount);
  const target = Math.max(2, Math.min(8, Number.isFinite(tc) && tc > 0 ? tc : 5));
  const rough = cap / (target - 1);
  const pow10 = 10 ** Math.floor(Math.log10(rough));
  const r = rough / pow10;
  let nice = pow10;
  if (r <= 1) nice = pow10;
  else if (r <= 2) nice = 2 * pow10;
  else if (r <= 5) nice = 5 * pow10;
  else nice = 10 * pow10;
  const ticks = [0];
  let v = nice;
  const limit = cap * 1.00001;
  while (v <= limit && ticks.length < 14) {
    ticks.push(v);
    v += nice;
  }
  if (ticks[ticks.length - 1] < cap) ticks.push(ticks[ticks.length - 1] + nice);
  return ticks;
}

function dashboardChartAxisLeadsFormat(v) {
  const n = Number(v) || 0;
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  const r = Math.round(n);
  if (Math.abs(n - r) < 1e-6) return String(r);
  return String(Math.round(n * 10) / 10);
}

function dashboardChartAxisCplFormat(v) {
  const num = Number(v) || 0;
  if (!Number.isFinite(num)) return "$0";
  const ix = Math.round(num);
  if (Math.abs(num - ix) < 1e-9) return `$${ix.toLocaleString("en-US")}`;
  const r2 = Math.round(num * 100) / 100;
  return `$${r2.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderDashboardChart(data) {
  const svg = document.getElementById("dashboardChart");
  if (!svg) return;
  const dm = document.body.classList.contains("dark-mode");
  const chartBg = dm ? "#0f172a" : "#ffffff";
  const gridStroke = dm ? "rgba(148, 163, 184, 0.22)" : "#e8eef5";
  const axisBottomStroke = dm ? "rgba(148, 163, 184, 0.45)" : "#94a3b8";
  const xLabelFill = dm ? "#cbd5e1" : "#64748b";
  const axisTickLeadsFill = dm ? "#93c5fd" : "#2563eb";
  const axisTickCplFill = dm ? "#fdba74" : "#ea580c";
  const axisVertLeadsStroke = dm ? "rgba(96, 165, 250, 0.55)" : "rgba(37, 99, 235, 0.45)";
  const axisVertCplStroke = dm ? "rgba(251, 146, 60, 0.58)" : "rgba(234, 88, 12, 0.5)";
  const map = new Map();
  data.forEach((r) => {
    const key = formatDateInputFromDate(r.fecha);
    if (!map.has(key)) map.set(key, { leads: 0, gasto: 0 });
    const row = map.get(key);
    row.leads += Number(r.leads) || 0;
    row.gasto += Number(r.gasto) || 0;
  });

  const range = getDashboardChartDateRange();
  if (!range || !range.startD || !range.endD) {
    svg.innerHTML = `<text x="20" y="36" fill="#94a3b8">Sin datos para graficar</text>`;
    return;
  }
  const startD = range.startD;
  const endD = range.endD;

  const days = [];
  const cur = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate());
  const endT = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate());
  while (cur <= endT) {
    days.push(formatDateInputFromDate(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const points = days.map((d) => {
    const v = map.get(d) || { leads: 0, gasto: 0 };
    const leads = v.leads;
    return { d, leads, cpl: leads > 0 ? v.gasto / leads : 0 };
  });

  let w = Math.round(svg.getBoundingClientRect().width);
  const needsWidthRetry = !Number.isFinite(w) || w < 80;
  if (needsWidthRetry) w = 960;
  else w = Math.min(Math.max(w, 320), 6000);
  const h = 120;
  /* Márgenes horizontales: separar valores de ejes de la primera/última barra */
  const plotPadL = 60;
  const plotPadR = 60;
  const axisLineL = plotPadL - 2;
  const axisLineR = w - plotPadR + 2;
  const tickTextL = 34;
  const tickTextR = w - 32;
  /** Margen superior interno del trazado: evita que ticks/barras rocen el borde superior del SVG */
  const padT = 32;
  const cantidadDias = points.length;
  /** Eje X: margen inferior para etiquetas de fechas (sin cambiar altura CSS del SVG) */
  const padB = dm ? 30 : 22;

  let fs = 10;
  if (cantidadDias > 45) fs = 7;
  else if (cantidadDias > 32) fs = 8;
  else if (cantidadDias > 22) fs = 9;

  const maxLeads = Math.max(...points.map((p) => p.leads), 1);
  const maxCpl = Math.max(...points.map((p) => p.cpl), 0.0001);
  const n = points.length;
  const innerW = w - plotPadL - plotPadR;
  const minLabelPitchPx = Math.max(fs * 3.85, 20);
  const maxLabelSlots = Math.max(2, Math.floor(innerW / minLabelPitchPx));
  let labelStep = 1;
  if (n > 1 && n > maxLabelSlots) {
    labelStep = Math.max(1, Math.ceil((n - 1) / Math.max(1, maxLabelSlots - 1)));
  }
  const showXLabel = (i) => {
    if (n <= 1) return true;
    if (i === 0 || i === n - 1) return true;
    return i % labelStep === 0;
  };
  const x = (i) => {
    if (n <= 1) return plotPadL + innerW / 2;
    return plotPadL + (i * innerW) / (n - 1);
  };
  const leadsTicks = dashboardChartNiceLinearTicks(maxLeads, 5);
  const maxLeadsAxis = leadsTicks[leadsTicks.length - 1] || Math.max(maxLeads, 1);
  const cplTicks = dashboardChartNiceLinearTicks(maxCpl, 5);
  const maxCplAxis = cplTicks[cplTicks.length - 1] || maxCpl;
  const yLeads = (v) => padT + (h - padT - padB) - (v / maxLeadsAxis) * (h - padT - padB);
  const yCpl = (v) => padT + (h - padT - padB) - (v / maxCplAxis) * (h - padT - padB);
  const cplPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCpl(p.cpl)}`).join(" ");
  const axisY = h - padB;
  const tickFs = 9;
  const gridLines = leadsTicks
    .map((tick) => {
      const yy = yLeads(tick);
      return `<line x1="${plotPadL}" y1="${yy}" x2="${w - plotPadR}" y2="${yy}" stroke="${gridStroke}" stroke-width="1" />`;
    })
    .join("");
  const leftAxisTicks = leadsTicks
    .map((tick) => {
      const yy = yLeads(tick);
      return `<line x1="${axisLineL - 4}" y1="${yy}" x2="${axisLineL}" y2="${yy}" stroke="${axisTickLeadsFill}" stroke-width="1.25" />
<text x="${tickTextL}" y="${yy}" fill="${axisTickLeadsFill}" font-size="${tickFs}" font-weight="700" text-anchor="end" dominant-baseline="middle">${escapeHtml(
        dashboardChartAxisLeadsFormat(tick)
      )}</text>`;
    })
    .join("");
  const rightAxisTicks = cplTicks
    .map((tick) => {
      const yy = yCpl(tick);
      return `<line x1="${axisLineR}" y1="${yy}" x2="${axisLineR + 4}" y2="${yy}" stroke="${axisTickCplFill}" stroke-width="1.25" />
<text x="${tickTextR}" y="${yy}" fill="${axisTickCplFill}" font-size="${tickFs}" font-weight="700" text-anchor="start" dominant-baseline="middle">${escapeHtml(
        dashboardChartAxisCplFormat(tick)
      )}</text>`;
    })
    .join("");
  const tipFor = (p) =>
    `${escapeHtml(formatDashboardTooltipDate(p.d))}&#10;Leads: ${dashFmtLeads(Math.round(p.leads))}&#10;CPL: ${dashFmt2(p.cpl)}`;
  const slotW = n > 1 ? innerW / (n - 1) : innerW;
  const barW = Math.min(22, Math.max(3, slotW * 0.58));
  const barsLeads = points
    .map((p, i) => {
      const cx = x(i);
      const yTop = yLeads(p.leads);
      const barH = axisY - yTop;
      const bx = cx - barW / 2;
      const tip = tipFor(p);
      if (p.leads <= 0) {
        return `<rect x="${bx}" y="${axisY}" width="${barW}" height="0" fill="#007bff" opacity="0" aria-hidden="true"><title>${tip}</title></rect>`;
      }
      return `<rect x="${bx}" y="${yTop}" width="${barW}" height="${barH}" fill="#007bff" fill-opacity="0.88" rx="2" ry="2"><title>${tip}</title></rect>`;
    })
    .join("");
  const xLabels = points
    .map((p, i) => {
      if (!showXLabel(i)) return "";
      const lab = formatDashboardChartLabel(p.d);
      const xi = x(i);
      return `<text x="${xi}" y="${axisY + 12}" fill="${xLabelFill}" font-size="${fs}" text-anchor="middle" dominant-baseline="hanging">${escapeHtml(lab)}</text>`;
    })
    .filter(Boolean)
    .join("");
  const hitsCpl = points
    .map((p, i) => {
      const cx = x(i);
      const cy = yCpl(p.cpl);
      const tip = tipFor(p);
      return `<circle cx="${cx}" cy="${cy}" r="11" fill="transparent"><title>${tip}</title></circle>
      <circle cx="${cx}" cy="${cy}" r="3.5" fill="#ea580c"><title>${tip}</title></circle>`;
    })
    .join("");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  if (needsWidthRetry) {
    requestAnimationFrame(() => {
      const w2 = Math.round(svg.getBoundingClientRect().width);
      if (Number.isFinite(w2) && w2 >= 80 && Math.abs(w2 - w) > 2) {
        renderDashboardChart(data);
      }
    });
  }
  svg.innerHTML = `
    <rect x="0" y="0" width="${w}" height="${h}" fill="${chartBg}" />
    ${gridLines}
    <line x1="${plotPadL}" y1="${axisY}" x2="${w - plotPadR}" y2="${axisY}" stroke="${axisBottomStroke}" stroke-width="1" />
    <line x1="${axisLineL}" y1="${padT}" x2="${axisLineL}" y2="${axisY}" stroke="${axisVertLeadsStroke}" stroke-width="1.35" />
    <line x1="${axisLineR}" y1="${padT}" x2="${axisLineR}" y2="${axisY}" stroke="${axisVertCplStroke}" stroke-width="1.35" />
    ${leftAxisTicks}
    ${rightAxisTicks}
    ${barsLeads}
    <path d="${cplPath}" fill="none" stroke="#ea580c" stroke-width="2.2"></path>
    ${hitsCpl}
    ${xLabels}
  `;
}

function dashboardDatePassesFilters(dateValue) {
  if (!(dateValue instanceof Date)) return false;
  const mes = estadoFiltrosDashboard.mes || formatMonthYearData(new Date());
  const b = dashboardMonthKeyBounds(mes);
  const min = b ? parseDateInput(b.min) : null;
  const max = b ? parseDateInput(b.max) : null;
  if (min && dateValue < min) return false;
  if (max && dateValue > max) return false;
  if (estadoFiltrosDashboard.fechaInicio) {
    const s = parseFechaData(estadoFiltrosDashboard.fechaInicio);
    if (s && dateValue < s) return false;
  }
  if (estadoFiltrosDashboard.fechaFin) {
    const e = parseFechaData(estadoFiltrosDashboard.fechaFin);
    if (e && dateValue > e) return false;
  }
  return true;
}

function dashboardCampaignKeyExact(idCampania, nombre) {
  return `${String(idCampania ?? "")}||${String(nombre ?? "")}`;
}

function dashboardCampaignKeyNormalized(idCampania, nombre) {
  return `${normalizarTexto(idCampania)}||${normalizarTexto(nombre)}`;
}

function dashboardCampaignIdKey(idCampania) {
  return `id:${normalizarTexto(idCampania)}`;
}

function getDashboardLinkedCampaignDateWindows() {
  const filtered = getDashboardKpiDataset();
  let planningKeys = new Set(
    filtered.map((r) => r.planningKey || `${r.tipo} | ${r.programa} | ${r.intake} | ${r.plataforma} | ${r.tracking}`)
  );
  if (!planningKeys.size) {
    planningKeys = new Set(
      planningDraftRecords()
        .filter((rec) => dashboardPlanningRecordMatchesSegments(rec))
        .filter((rec) => !estadoFiltrosDashboard.mes || dashboardPlanningRecordContainsMonth(rec, estadoFiltrosDashboard.mes))
        .map((rec) => planningKeyFromRecord(rec))
    );
  }
  const planningByKey = new Map(planningDraftRecords().map((r) => [planningKeyFromRecord(r), r]));
  const campaignWindows = new Map();
  const appendWindows = (k, windows) => {
    if (!k) return;
    if (!campaignWindows.has(k)) campaignWindows.set(k, []);
    campaignWindows.get(k).push(...windows);
  };
  getRelacionesPlataforma().forEach((rel) => {
    if (!planningKeys.has(rel.planningKey)) return;
    const rec = planningByKey.get(rel.planningKey);
    if (!rec) return;
    const start = parseDateInput(rec.fechaInicio);
    const end = parseDateInput(rec.fechaFin);
    if (!start || !end || start > end) return;
    const windows = [{ start, end }];
    appendWindows(dashboardCampaignKeyExact(rel.idCampania, rel.nombre), windows);
    appendWindows(dashboardCampaignKeyNormalized(rel.idCampania, rel.nombre), windows);
    appendWindows(dashboardCampaignIdKey(rel.idCampania), windows);
  });
  return campaignWindows;
}

function agruparSumaResultados(rows, campo) {
  const map = new Map();
  rows.forEach((r) => {
    const key = String(r?.[campo] || "Sin dato").trim() || "Sin dato";
    const resultados = Number(r?.resultados ?? r?.leads) || 0;
    map.set(key, (map.get(key) || 0) + resultados);
  });
  return map;
}

function limpiarRegion(nombre) {
  return String(nombre ?? "").replace(" Region", "").trim();
}

const DASH_INSIGHT_PLAT_ORDER = [
  { fam: "meta", label: "Meta Ads", color: "#1877f2", iconRaw: "Meta" },
  { fam: "google", label: "Google Ads", color: "#34a853", iconRaw: "Google Ads" },
  { fam: "tiktok", label: "TikTok Ads", color: "#0f172a", iconRaw: "TikTok" },
  { fam: "linkedin", label: "LinkedIn Ads", color: "#eab308", iconRaw: "LinkedIn" },
  { fam: "otro", label: "Otros", color: "#94a3b8", iconRaw: "Otro" }
];

function aggregateDashboardGastoByPlataformaFamilia() {
  const buckets = { meta: 0, google: 0, tiktok: 0, linkedin: 0, otro: 0 };
  getDashboardFilteredDataPeriodOnly().forEach((r) => {
    const g = Number(r.gasto) || 0;
    const fam = dashPlataformaFamilyKey(r.plataforma);
    if (fam === "meta") buckets.meta += g;
    else if (fam === "google") buckets.google += g;
    else if (fam === "tiktok") buckets.tiktok += g;
    else if (fam === "linkedin") buckets.linkedin += g;
    else buckets.otro += g;
  });
  return buckets;
}

function dashboardInsightDonutSlice(cx, cy, rout, rin, a0, a1) {
  const xo0 = cx + rout * Math.cos(a0);
  const yo0 = cy + rout * Math.sin(a0);
  const xo1 = cx + rout * Math.cos(a1);
  const yo1 = cy + rout * Math.sin(a1);
  const xi0 = cx + rin * Math.cos(a0);
  const yi0 = cy + rin * Math.sin(a0);
  const xi1 = cx + rin * Math.cos(a1);
  const yi1 = cy + rin * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${xo0} ${yo0} A ${rout} ${rout} 0 ${large} 1 ${xo1} ${yo1} L ${xi1} ${yi1} A ${rin} ${rin} 0 ${large} 0 ${xi0} ${yi0} Z`;
}

function collectDashboardInsightsCampaignRows() {
  const dataMesRaw = getDashboardFilteredDataPeriodOnly();
  const dataMesGasto = dataMesRaw;
  const dataMesPerf = dataMesRaw;
  const mapMes = new Map();
  dataMesPerf.forEach((r) => {
    const key = dashboardRowKeyFromModelo(r) || "|||";
    if (!mapMes.has(key)) mapMes.set(key, []);
    mapMes.get(key).push(r);
  });
  const mapMesAll = new Map();
  dataMesGasto.forEach((r) => {
    const key = dashboardRowKeyFromModelo(r) || "|||";
    if (!mapMesAll.has(key)) mapMesAll.set(key, []);
    mapMesAll.get(key).push(r);
  });
  let entries = Array.from(mapMes.entries());
  entries = entries.filter(([rowKey]) => (mapMesAll.get(rowKey) || []).length > 0);
  const out = [];
  for (const [rowKey, rowsMes] of entries) {
    const rowsMesAll = mapMesAll.get(rowKey) || [];
    const gastoRealMes = rowsMesAll.reduce((a, r) => a + (Number(r.gasto) || 0), 0);
    const leadsRealMes = rowsMes.reduce((a, r) => a + (Number(r.leads) || 0), 0);
    const row = parseDashboardRowKey(rowKey);
    const planningRows = getPlanningByProgIntakeTrackPlat(row.programa, row.intake, row.tracking, row.plataforma, row.tipo);
    const nombrePrograma = dashboardRowProgramaNombreFromKey(rowKey);
    const tipo = row.tipo || "—";
    const planningRowsOperativas = planningRows.filter((rec) => !esTipoBrandingConvocatoriaDashboard(rec.tipo));
    const pmMes = computeDashboardPlanningPeriodMeta(planningRowsOperativas);
    const cplRealMes = leadsRealMes > 0 ? gastoRealMes / leadsRealMes : 0;
    out.push({
      rowKey,
      nombrePrograma,
      tipo,
      gastoRealMes,
      leadsRealMes,
      cplRealMes,
      metaCplPeriod: Number(pmMes.metaCplPeriod) || 0
    });
  }
  return out;
}

function renderDashboardInsightsSidePanels() {
  const donutEl = document.getElementById("dashGastoPlatDonut");
  const legendEl = document.getElementById("dashGastoPlatLegend");
  const listEl = document.getElementById("dashTopCplList");
  if (!donutEl || !legendEl || !listEl) return;
  const dm = document.body.classList.contains("dark-mode");
  const donutSegStroke = dm ? "#0f172a" : "#fff";
  const donutEmptyRing = dm ? "rgba(148, 163, 184, 0.35)" : "#e2e8f0";
  const donutLabFill = dm ? "#94a3b8" : "#64748b";
  const donutValFill = dm ? "#f1f5f9" : "#0f172a";

  const buckets = aggregateDashboardGastoByPlataformaFamilia();
  const platRows = DASH_INSIGHT_PLAT_ORDER.map((p) => ({
    ...p,
    value: Number(buckets[p.fam]) || 0
  }));
  const totalGasto = platRows.reduce((a, x) => a + x.value, 0);

  const cx = 66;
  const cy = 66;
  const rout = 58;
  const rin = 46;
  let ang = -Math.PI / 2;
  const paths = [];
  if (totalGasto <= 0) {
    paths.push(
      `<circle cx="${cx}" cy="${cy}" r="${(rout + rin) / 2}" fill="none" stroke="${donutEmptyRing}" stroke-width="${rout - rin}" />`
    );
  } else {
    platRows.forEach((seg) => {
      const sweep = (seg.value / totalGasto) * Math.PI * 2;
      if (sweep <= 0) return;
      const a0 = ang;
      const a1 = ang + sweep;
      const pathCmd = (t0, t1) =>
        `<path d="${dashboardInsightDonutSlice(cx, cy, rout, rin, t0, t1)}" fill="${seg.color}" stroke="${donutSegStroke}" stroke-width="0.75" />`;
      /* Anillo 100%: un solo arco 2π deja inicio=fin y el path SVG no pinta; partimos en dos medias lunas. */
      if (sweep >= Math.PI * 2 - 1e-4) {
        const mid = a0 + Math.PI;
        paths.push(pathCmd(a0, mid));
        paths.push(pathCmd(mid, a1));
      } else {
        paths.push(pathCmd(a0, a1));
      }
      ang = a1;
    });
  }
  donutEl.innerHTML = `<svg viewBox="0 0 132 132" width="132" height="132" aria-hidden="true">
    ${paths.join("")}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${donutLabFill}" font-size="9.5" font-weight="700">Total</text>
    <text x="${cx}" y="${cy + 11}" text-anchor="middle" fill="${donutValFill}" font-size="12.5" font-weight="900">${escapeHtml(dashFmtMoney(totalGasto))}</text>
  </svg>`;

  legendEl.innerHTML = `<div class="dash-donut-legend-rows" role="list">${platRows
    .map((seg) => {
      const pct = totalGasto > 0 ? Math.round((seg.value / totalGasto) * 100) : 0;
      return `<div class="dash-donut-legend-row" role="listitem">
        <span class="dash-donut-legend-swatch" style="background-color:${escapeHtml(seg.color)}" aria-hidden="true"></span>
        <span class="dash-donut-legend-name">${escapeHtml(seg.label)}</span>
        <span class="dash-donut-legend-pct">${pct}%</span>
        <span class="dash-donut-legend-amt">${escapeHtml(dashFmtMoney(seg.value))}</span>
      </div>`;
    })
    .join("")}</div>`;

  const campRows = collectDashboardInsightsCampaignRows();
  const ranked = campRows
    .filter((r) => r.leadsRealMes > 0 && r.metaCplPeriod > 0)
    .map((r) => ({
      ...r,
      ratio: r.cplRealMes / r.metaCplPeriod
    }))
    .sort((a, b) => {
      if (a.ratio !== b.ratio) return a.ratio - b.ratio;
      return a.cplRealMes - b.cplRealMes;
    })
    .slice(0, 5);

  if (!ranked.length) {
    listEl.innerHTML = `<li class="dash-topcpl-empty">Sin datos con CPL comparable en el periodo</li>`;
    return;
  }
  listEl.innerHTML = ranked
    .map(
      (r) => `<li class="dash-topcpl-item">
      <div class="dash-topcpl-body">
        <div class="dash-topcpl-name">${escapeHtml(r.nombrePrograma)}</div>
        <div class="dash-topcpl-meta">
          <span>${escapeHtml(r.tipo)}</span>
          <span class="dash-topcpl-cpl">CPL ${escapeHtml(dashFmt2(r.cplRealMes))} · meta ${escapeHtml(dashFmt2(r.metaCplPeriod))}</span>
        </div>
      </div>
    </li>`
    )
    .join("");
}

/** @deprecated nombre histórico; usa renderDashboardInsightsSidePanels. */
function renderDashboardDemographicGeoPanels() {
  renderDashboardInsightsSidePanels();
}

/** Placeholders de carga rápida tras login (antes de aplicar bundle del servidor). */
function renderDashboardSkeleton() {
  const root = document.getElementById("dashboardModule");
  if (root) root.classList.add("dashboard-module-loading");
  let vis;
  let eff;
  try {
    ({ vis, eff } = prepareDashboardUiSubtabState());
  } catch (_) {
    vis = getDashboardSubtabVisibility();
    eff = getDashboardEffectiveSubtab();
  }
  ensureDashboardInitialMonth();
  fillDashboardIntakeSelect();
  fillDashboardMesSelect();
  renderDashboardTableFooter();
  updateDashboardMetaGlobalVisibility();
  const selMes = document.getElementById("dashFiltroMes");
  if (selMes && estadoFiltrosDashboard.mes) selMes.value = estadoFiltrosDashboard.mes;
  const selIntake = document.getElementById("dashFiltroIntake");
  if (selIntake) selIntake.value = estadoFiltrosDashboard.intake || "";
  const kpiEl = document.getElementById("dashboardKpis");
  if (kpiEl) {
    if (vis.plataforma && eff === "plataforma") {
      kpiEl.innerHTML = Array.from(
        { length: 4 },
        () =>
          `<div class="dash-kpi-card dashboard-card campatrack-skeleton campatrack-skeleton--kpi" aria-hidden="true"></div>`
      ).join("");
    } else {
      kpiEl.innerHTML = "";
    }
  }
  const tbody = document.getElementById("dashTbody");
  if (tbody) {
    const totalColumnas = mostrarMetaGlobal ? 47 : 23;
    tbody.innerHTML = Array.from(
      { length: 10 },
      () =>
        `<tr><td colspan="${totalColumnas}"><span class="campatrack-skeleton campatrack-skeleton--bar" aria-hidden="true"></span></td></tr>`
    ).join("");
  }
  const svg = document.getElementById("dashboardChart");
  if (svg) {
    svg.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="currentColor" opacity="0.4" font-size="13">Cargando datos…</text>`;
  }
  const donutEl = document.getElementById("dashGastoPlatDonut");
  if (donutEl) donutEl.innerHTML = "";
  const legendEl = document.getElementById("dashGastoPlatLegend");
  if (legendEl) legendEl.innerHTML = "";
  const topCplEl = document.getElementById("dashTopCplList");
  if (topCplEl) topCplEl.innerHTML = "";
  ensureMesCardOutsideCrmKpiStrip();
  const crmHold = document.getElementById("dashboardKpisCrmHolder");
  if (crmHold && vis.crm && eff === "crm" && !crmHold.classList.contains("hidden")) {
    crmHold.className = "dashboard-kpis-inner dashboard-kpis-inner--crm-strip";
    crmHold.innerHTML = Array.from(
      { length: 6 },
      () =>
        `<div class="dash-kpi-card dashboard-card campatrack-skeleton campatrack-skeleton--kpi" aria-hidden="true"></div>`
    ).join("");
    attachMesCardToCrmKpiStrip();
  } else if (crmHold) {
    crmHold.innerHTML = "";
    crmHold.classList.remove("dashboard-kpis-inner--crm-strip");
  }
  const crmBody = document.getElementById("dashCrmTbody");
  if (crmBody) {
    crmBody.innerHTML = Array.from(
      { length: 6 },
      () => `<tr><td colspan="17"><span class="campatrack-skeleton campatrack-skeleton--bar" aria-hidden="true"></span></td></tr>`
    ).join("");
  }
  const crmSvg = document.getElementById("dashboardChartCrmCompare");
  if (crmSvg) {
    crmSvg.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="currentColor" opacity="0.4" font-size="13">Cargando datos…</text>`;
  }
}

function clearDashboardSkeletonMode() {
  document.getElementById("dashboardModule")?.classList.remove("dashboard-module-loading");
}

function renderDashboardSinData() {
  const { vis, eff } = prepareDashboardUiSubtabState();
  const kpiEl = document.getElementById("dashboardKpis");
  renderDashboardTableFooter();
  updateDashboardMetaGlobalVisibility();
  const tbody = document.getElementById("dashTbody");
  const totalLeadsEl = document.getElementById("dashTotalLeads");
  const totalGastoEl = document.getElementById("dashTotalGasto");
  const svg = document.getElementById("dashboardChart");
  const donutEl = document.getElementById("dashGastoPlatDonut");
  const legendEl = document.getElementById("dashGastoPlatLegend");
  const topCplEl = document.getElementById("dashTopCplList");
  if (kpiEl && vis.plataforma && eff === "plataforma") {
    kpiEl.innerHTML = `<div class="dash-kpi-card dashboard-card"><div class="dash-kpi-main">No hay data cargada</div></div>`;
  } else if (kpiEl) {
    kpiEl.innerHTML = "";
  }
  if (tbody) {
    const totalColumnas = mostrarMetaGlobal ? 47 : 23;
    tbody.innerHTML = `<tr><td colspan="${totalColumnas}" class="dash-empty-mini">No hay data cargada</td></tr>`;
  }
  if (totalLeadsEl) totalLeadsEl.textContent = "0";
  if (totalGastoEl) totalGastoEl.textContent = "$0";
  if (svg) svg.innerHTML = `<text x="20" y="36" fill="#94a3b8">No hay data cargada</text>`;
  if (donutEl) donutEl.innerHTML = "";
  if (legendEl) legendEl.innerHTML = `<div class="dash-donut-legend-rows"><div class="dash-empty-mini">No hay data cargada</div></div>`;
  if (topCplEl) topCplEl.innerHTML = `<li class="dash-topcpl-empty">No hay data cargada</li>`;
  const diffBanner = document.getElementById("dashGastoDiffBanner");
  if (diffBanner) {
    diffBanner.classList.add("hidden");
    diffBanner.innerHTML = "";
  }
  const crmKpi = document.getElementById("dashboardKpisCrmHolder");
  if (crmKpi) {
    if (vis.crm && eff === "crm") {
      ensureMesCardOutsideCrmKpiStrip();
      crmKpi.className = "dashboard-kpis-inner dashboard-kpis-inner--crm-strip";
      crmKpi.innerHTML = `<div class="dash-kpi-card dashboard-card dash-kpi-card--crm-sin-data"><div class="dash-kpi-main">No hay data cargada</div></div>`;
      const period = document.getElementById("dashPeriodoCard");
      if (period instanceof HTMLElement) {
        crmKpi.appendChild(period);
        period.classList.add("dash-periodo--crm-kpi-slot");
      }
    } else {
      ensureMesCardOutsideCrmKpiStrip();
      crmKpi.innerHTML = "";
      crmKpi.classList.remove("dashboard-kpis-inner--crm-strip");
    }
  }
  const crmTb = document.getElementById("dashCrmTbody");
  const crmTf = document.getElementById("dashCrmTfoot");
  if (crmTb) crmTb.innerHTML = `<tr><td colspan="21" class="dash-empty-mini">No hay data cargada</td></tr>`;
  if (crmTf) crmTf.innerHTML = "";
  const crmCmp = document.getElementById("dashboardChartCrmCompare");
  if (crmCmp) crmCmp.innerHTML = `<text x="20" y="36" fill="#94a3b8">No hay data cargada</text>`;
  const crmPivotHead = document.getElementById("dashCrmPivotThead");
  if (crmPivotHead) crmPivotHead.innerHTML = "";
  const crmPivotTb = document.getElementById("dashCrmPivotTbody");
  if (crmPivotTb) crmPivotTb.innerHTML = "";
  const crmIntervalTb = document.getElementById("dashCrmIntervalTbody");
  if (crmIntervalTb) crmIntervalTb.innerHTML = "";
  mostrarFechaActualizacion();
}

function renderDashboardFromFilters() {
  programaSeleccionado = null;
  setFechaActualData();
  renderDashboardAllSegmentGroups();
  if (!hasAnyDataLoaded()) {
    renderDashboardSinData();
    return;
  }
  const { vis, eff } = prepareDashboardUiSubtabState();

  if (vis.plataforma && eff === "plataforma") {
    renderDashboardKpis();
    renderDashboardGastoDiffBanner();
    renderDashboardTabla();
    renderDashboardChart(getDashboardKpiDataset());
    renderDashboardDemographicGeoPanels();
  } else if (vis.plataforma) {
    const kpiEl = document.getElementById("dashboardKpis");
    if (kpiEl) kpiEl.innerHTML = "";
    const svg = document.getElementById("dashboardChart");
    if (svg) svg.innerHTML = "";
  }

  if (vis.crm && eff === "crm") {
    renderDashboardKpisCrm();
    renderDashboardCrmTabla();
    renderDashboardCrmBottomPanels();
  } else {
    ensureMesCardOutsideCrmKpiStrip();
    const crmHold = document.getElementById("dashboardKpisCrmHolder");
    if (crmHold) {
      crmHold.innerHTML = "";
      crmHold.classList.remove("dashboard-kpis-inner--crm-strip");
    }
  }

  mostrarFechaActualizacion();
}

/** KPIs, gráfico evolutivo y paneles laterales Plataforma (p. ej. al seleccionar fila). */
function renderDashboardKpisChartOnly() {
  if (!hasAnyDataLoaded()) {
    renderDashboardSinData();
    return;
  }
  const { vis, eff } = prepareDashboardUiSubtabState();
  if (vis.plataforma && eff === "plataforma") {
    renderDashboardKpis();
    renderDashboardGastoDiffBanner();
    renderDashboardChart(getDashboardKpiDataset());
    renderDashboardDemographicGeoPanels();
  }
  if (vis.crm && eff === "crm") {
    renderDashboardCrmBottomPanels();
  }
  mostrarFechaActualizacion();
}

/** Mes/día: gráficos CRM; en Plataforma también KPIs y paneles (tabla sin recargar en búsqueda). */
function renderDashboardChartsOnly() {
  if (!hasAnyDataLoaded()) {
    renderDashboardSinData();
    return;
  }
  const { vis, eff } = prepareDashboardUiSubtabState();
  if (vis.plataforma && eff === "plataforma") {
    renderDashboardKpis();
    renderDashboardGastoDiffBanner();
    renderDashboardChart(getDashboardKpiDataset());
    renderDashboardDemographicGeoPanels();
  }
  if (vis.crm && eff === "crm") {
    renderDashboardCrmPanelsOnly();
  }
  mostrarFechaActualizacion();
}

function renderDashboard() {
  clearDashboardSkeletonMode();
  ensureDashboardInitialMonth();
  fillDashboardIntakeSelect();
  fillDashboardMesSelect();
  const selMes = document.getElementById("dashFiltroMes");
  if (selMes && estadoFiltrosDashboard.mes) selMes.value = estadoFiltrosDashboard.mes;
  const selIntake = document.getElementById("dashFiltroIntake");
  if (selIntake) selIntake.value = estadoFiltrosDashboard.intake || "";
  const bp = document.getElementById("dashBusquedaPrograma");
  if (bp) bp.value = estadoFiltrosDashboard.busquedaPrograma || "";
  const chkBranding = document.getElementById("dashIncluirBranding");
  if (chkBranding instanceof HTMLInputElement) chkBranding.checked = incluirBrandingDashboard;
  applyDashboardMainSubtabsNavVisibility();
  syncDashboardActiveSubtabWithPermissions();
  try {
    const v = getDashboardSubtabVisibility();
    if (v.plataforma && v.crm) {
      const raw = appMemoryKV.getItem(LS_DASH_ACTIVE_SUBTAB);
      if (raw === "crm" || raw === "plataforma") dashboardActiveSubtab = raw;
    }
  } catch (_) {
    /* ignore */
  }
  if (dashboardActiveSubtab === "crm" && !getDashboardSubtabVisibility().crm) dashboardActiveSubtab = "plataforma";
  if (
    dashboardActiveSubtab === "plataforma" &&
    !getDashboardSubtabVisibility().plataforma &&
    getDashboardSubtabVisibility().crm
  ) {
    dashboardActiveSubtab = "crm";
  }
  applyDashboardShellVisibilityForSubtab();
  renderDashboardTableFooter();
  updateDashboardMetaGlobalVisibility();
  syncDashboardDateInputsToMonth(false);
  validateDashboardRangoFechas({ silent: true });
  renderDashboardFromFilters();
}

function initDashboardModule() {
  const root = document.getElementById("dashboardModule");
  if (!root || dashboardUiInicializado) return;
  dashboardUiInicializado = true;

  document.getElementById("closeDashGastoDiffModal")?.addEventListener("click", () => closeDashGastoDiffModal());
  document.getElementById("closeDashEndingSoonModal")?.addEventListener("click", () => closeDashEndingSoonModal());
  document.getElementById("closeDashEndingSoonModalTop")?.addEventListener("click", () => closeDashEndingSoonModal());
  document.getElementById("dashGastoDiffExportBtn")?.addEventListener("click", () => exportDashGastoDiffToExcel());
  document.getElementById("dashExportTableBtn")?.addEventListener("click", () => exportDashboardTableToExcel());
  document.getElementById("dashGastoDiffModal")?.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "dashGastoDiffModal") closeDashGastoDiffModal();
  });
  document.getElementById("dashEndingSoonModal")?.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "dashEndingSoonModal") closeDashEndingSoonModal();
  });

  root.addEventListener("click", (e) => {
    const diffDet = e.target instanceof HTMLElement ? e.target.closest("#dashGastoDiffDetalleBtn") : null;
    if (diffDet) {
      openDashGastoDiffModal();
      return;
    }
    const diffClose = e.target instanceof HTMLElement ? e.target.closest("#dashGastoDiffCloseBtn") : null;
    if (diffClose) {
      dashGastoDiffBannerDismissed = true;
      renderDashboardGastoDiffBanner();
      return;
    }
    const expandMeta = e.target instanceof HTMLElement ? e.target.closest("#dashExpandMetaGlobal") : null;
    if (expandMeta) {
      setMostrarMetaGlobal(true);
      programaSeleccionado = null;
      renderDashboardFromFilters();
      return;
    }
    const toggleMeta = e.target instanceof HTMLElement ? e.target.closest("#dashToggleMetaGlobal") : null;
    if (toggleMeta) {
      setMostrarMetaGlobal(!mostrarMetaGlobal);
      programaSeleccionado = null;
      renderDashboardFromFilters();
      return;
    }
    const seg = e.target instanceof HTMLElement ? e.target.closest("[data-dash-seg]") : null;
    if (seg) {
      const field = seg.getAttribute("data-dash-seg") || "";
      const val = seg.getAttribute("data-dash-val") || "";
      if (!field) return;
      estadoFiltrosDashboard[field] = estadoFiltrosDashboard[field] === val ? "" : val;
      programaSeleccionado = null;
      renderDashboardFromFilters();
      return;
    }
    const crmTr = e.target instanceof HTMLElement ? e.target.closest("#dashCrmTbody tr[data-dash-row]") : null;
    if (crmTr) {
      const p = crmTr.getAttribute("data-dash-row") || "";
      programaSeleccionado = programaSeleccionado === p ? null : p;
      syncDashboardTableRowDomSelectionHighlight();
      renderDashboardCrmPanelsOnly();
      return;
    }
    const tr = e.target instanceof HTMLElement ? e.target.closest("#dashTbody tr[data-dash-row]") : null;
    if (tr) {
      const p = tr.getAttribute("data-dash-row") || "";
      programaSeleccionado = programaSeleccionado === p ? null : p;
      syncDashboardTableRowDomSelectionHighlight();
      renderDashboardKpisChartOnly();
    }
  });

  document.getElementById("dashFiltroMes")?.addEventListener("change", (e) => {
    estadoFiltrosDashboard.mes = e.target.value || "";
    if (!isDashboardComercialCrmActiveView()) programaSeleccionado = null;
    syncDashboardDateInputsToMonth(true);
    validateDashboardRangoFechas({ silent: true });
    if (isDashboardComercialCrmActiveView()) {
      syncDashboardTableRowDomSelectionHighlight();
      renderDashboardKpisCrm();
      renderDashboardCrmBottomPanels();
    } else {
      renderDashboardFromFilters();
    }
  });
  document.getElementById("dashFiltroIntake")?.addEventListener("change", (e) => {
    estadoFiltrosDashboard.intake = e.target.value || "";
    programaSeleccionado = null;
    renderDashboardFromFilters();
  });
  document.getElementById("dashFechaInicio")?.addEventListener("change", (e) => {
    estadoFiltrosDashboard.fechaInicio = e.target instanceof HTMLInputElement ? e.target.value : "";
    validateDashboardRangoFechas({ silent: false });
    if (!isDashboardComercialCrmActiveView()) programaSeleccionado = null;
    if (isDashboardComercialCrmActiveView()) {
      syncDashboardTableRowDomSelectionHighlight();
      renderDashboardChartsOnly();
    } else {
      renderDashboardFromFilters();
    }
  });
  document.getElementById("dashFechaFin")?.addEventListener("change", (e) => {
    estadoFiltrosDashboard.fechaFin = e.target instanceof HTMLInputElement ? e.target.value : "";
    validateDashboardRangoFechas({ silent: false });
    if (!isDashboardComercialCrmActiveView()) programaSeleccionado = null;
    if (isDashboardComercialCrmActiveView()) {
      syncDashboardTableRowDomSelectionHighlight();
      renderDashboardChartsOnly();
    } else {
      renderDashboardFromFilters();
    }
  });

  let dashBusquedaProgramaTimer = null;
  document.getElementById("dashBusquedaPrograma")?.addEventListener("input", (e) => {
    estadoFiltrosDashboard.busquedaPrograma = e.target.value || "";
    if (dashBusquedaProgramaTimer) clearTimeout(dashBusquedaProgramaTimer);
    dashBusquedaProgramaTimer = setTimeout(() => {
      dashBusquedaProgramaTimer = null;
      requestAnimationFrame(() => {
        try {
          renderDashboardTabla();
          if (
            getDashboardSubtabVisibility().crm &&
            getDashboardEffectiveSubtab() === "crm"
          )
            renderDashboardCrmTabla();
          renderDashboardChartsOnly();
        } catch (err) {
          console.warn("renderDashboardTabla (búsqueda)", err);
        }
      });
    }, 48);
  });

  document.getElementById("dashIncluirBranding")?.addEventListener("change", (e) => {
    const t = e.target;
    incluirBrandingDashboard = t instanceof HTMLInputElement && t.checked;
    programaSeleccionado = null;
    renderDashboardFromFilters();
  });

  const dashChartResizeHost = root.querySelector(".dash-shell-plataforma .full-width-chart");
  if (dashChartResizeHost && typeof ResizeObserver !== "undefined") {
    let dashChartRoTimer = null;
    const dashChartRo = new ResizeObserver(() => {
      if (root.classList.contains("hidden")) return;
      if (dashChartRoTimer) clearTimeout(dashChartRoTimer);
      dashChartRoTimer = setTimeout(() => {
        dashChartRoTimer = null;
        if (hasAnyDataLoaded()) renderDashboardChart(getDashboardKpiDataset());
      }, 80);
    });
    dashChartRo.observe(dashChartResizeHost);
  }

  document.getElementById("dashTabPlataforma")?.addEventListener("click", () => {
    if (!getDashboardSubtabVisibility().plataforma) return;
    dashboardActiveSubtab = "plataforma";
    try {
      appMemoryKV.setItem(LS_DASH_ACTIVE_SUBTAB, "plataforma");
    } catch (_) {
      /* ignore */
    }
    renderDashboardFromFilters();
  });
  document.getElementById("dashTabComercialCrm")?.addEventListener("click", () => {
    if (!getDashboardSubtabVisibility().crm) return;
    dashboardActiveSubtab = "crm";
    try {
      appMemoryKV.setItem(LS_DASH_ACTIVE_SUBTAB, "crm");
    } catch (_) {
      /* ignore */
    }
    renderDashboardFromFilters();
  });
  document.getElementById("dashCrmViewPlatVsCrm")?.addEventListener("click", () => {
    dashboardCrmBottomMode = "platVsCrm";
    renderDashboardCrmBottomPanels();
  });
  document.getElementById("dashCrmViewFuente")?.addEventListener("click", () => {
    dashboardCrmBottomMode = "fuente";
    renderDashboardCrmBottomPanels();
  });
  document.getElementById("dashCrmScopeTotal")?.addEventListener("click", () => {
    if (dashboardCrmIntervaloPeriodScope === "total") return;
    dashboardCrmIntervaloPeriodScope = "total";
    renderDashboardCrmBottomPanels();
  });
  document.getElementById("dashCrmScopeMes")?.addEventListener("click", () => {
    if (dashboardCrmIntervaloPeriodScope === "mes") return;
    dashboardCrmIntervaloPeriodScope = "mes";
    renderDashboardCrmBottomPanels();
  });
  initDashboardCrmOperTabs();
  const crmChartResizeHost = document.getElementById("dashCrmPanelCompare")?.querySelector(".full-width-chart");
  if (crmChartResizeHost && typeof ResizeObserver !== "undefined") {
    let dashCrmRoTimer = null;
    const dashCrmRo = new ResizeObserver(() => {
      if (root.classList.contains("hidden")) return;
      if (dashCrmRoTimer) clearTimeout(dashCrmRoTimer);
      dashCrmRoTimer = setTimeout(() => {
        dashCrmRoTimer = null;
        if (hasAnyDataLoaded() && dashboardCrmBottomMode === "platVsCrm") renderDashboardCrmCompareChart();
      }, 80);
    });
    dashCrmRo.observe(crmChartResizeHost);
  }

  /** El primer pintado del dashboard lo hace `initTabs` → `setActive` (sesión) o el flujo post-login. */
}

const LS_CAMPATRACK_AUTH = "auth";
const LS_CAMPATRACK_ROLE = "rol";
const LS_CAMPATRACK_USER = "campatrack_user";
/** Clave localStorage para tema (`"dark"` | `"light"`). */
const LS_CAMPATRACK_THEME = "theme";

function campatrackInvalidateUsersDraft() {
  const d = ensureCampatrackUsersDraftShape();
  d.length = 0;
}

function getCampatrackStoredUsers() {
  return ensureCampatrackUsersDraftShape().map((u) => (u && typeof u === "object" ? { ...u } : u));
}

function saveCampatrackStoredUsers(list) {
  const next = Array.isArray(list) ? list.map((u) => (u && typeof u === "object" ? { ...u } : u)) : [];
  const draft = ensureCampatrackUsersDraftShape();
  draft.length = 0;
  next.forEach((u) => draft.push(u));
  registerUnpublishedDraftMutation();
}

/** URLs de avatar de demostración antiguas — no deben tratarse como foto real del usuario */
const CAMPATRACK_LEGACY_PROFILE_PHOTO_URLS = new Set([
  "assets/profile-richi.png",
  "assets/profile-randy.png",
  "assets/profile-wiener.png"
]);

function normalizeCampatrackUserFotoValue(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  if (CAMPATRACK_LEGACY_PROFILE_PHOTO_URLS.has(t)) return "";
  return t;
}

function hasUsableProfilePhotoUrl(raw) {
  return normalizeCampatrackUserFotoValue(raw) !== "";
}

function pickCampatrackInitialLetterNombreUsuario(nombre, usuario, fallback = "?") {
  const nome = String(nombre ?? "").trim();
  const usr = String(usuario ?? "").trim();
  const src = nome || usr;
  if (!src) return fallback;
  const fc = [...src][0];
  try {
    return fc.toLocaleUpperCase("es");
  } catch {
    return fc.toUpperCase();
  }
}

/**
 * Usuario interno solo en memoria. No existe en BD.
 * Credenciales: `admin` / `admin` (validación solo en cliente).
 */
const SYSTEM_ADMIN = {
  id: "admin",
  usuario: "admin",
  clave: "admin",
  nombre: "Administrador",
  apellido: "Sistema",
  cargo: "Administrador",
  permisos: "ALL",
};

function buildCampatrackSystemAdminSession(selectedTeamId) {
  ensureCampatrackTeamsSeed();
  const tid = resolveCampatrackTeamId(String(selectedTeamId || "").trim());
  const teamIds = campatrackGetCanonTeamIds();
  return {
    id: SYSTEM_ADMIN.id,
    username: SYSTEM_ADMIN.usuario,
    role: "admin",
    nombre: SYSTEM_ADMIN.nombre,
    apellido: SYSTEM_ADMIN.apellido,
    cargo: SYSTEM_ADMIN.cargo,
    teamId: tid,
    teams: [...teamIds],
    teamNombre: tid ? resolveCampatrackTeamNombre(tid) : "",
    foto: "",
    permissions: { canExport: true, canImport: true, canReset: true },
    campatrackSystemRoot: true,
  };
}

const CAMPATRACK_TOPBAR_META = {
  dashboard: { title: "Dashboard", sub: "Resumen de desempeño, presupuesto y rendimiento", icon: "fa-chart-pie" },
  costos: { title: "Centro de costos", sub: "Bolsas de presupuesto derivadas del Planning.", icon: "fa-wallet" },
  planning: { title: "Planning", sub: "Planificación y calendario de campañas.", icon: "fa-calendar-days" },
  bitacora: { title: "Bitácora", sub: "Registro de actividades y seguimiento.", icon: "fa-clipboard-list" },
  data: { title: "Data", sub: "Carga, visualización y preparación de data real", icon: "fa-database" },
  relaciones: { title: "Relaciones", sub: "Vinculación entre planning y data.", icon: "fa-diagram-project" },
  medidas: { title: "Medidas", sub: "Cálculos y fórmulas personalizadas.", icon: "fa-ruler-combined" },
  "ads-report": { title: "Reporte de anuncios", sub: "Vista tipo Ads Manager.", icon: "fa-bullhorn" },
  usuarios: { title: "Usuarios", sub: "Registro de usuarios y permisos por módulo.", icon: "fa-user-plus" },
  auditoria: { title: "Auditoría", sub: "Historial de cambios en Planning y Data por equipo.", icon: "fa-clipboard-check" },
  configuracion: { title: "Configuración", sub: "Repositorio y token GitHub para datos y publicación.", icon: "fa-gear" },
};

const CAMPATRACK_REGISTER_MODULE_CARDS = [
  { id: "costos", label: "Centro de costos", desc: "Presupuestos por bolsa", icon: "fa-wallet", tone: "blue" },
  { id: "planning", label: "Planning", desc: "Calendario y planificación", icon: "fa-calendar-days", tone: "purple" },
  { id: "bitacora", label: "Bitácora", desc: "Actividades y notas", icon: "fa-clipboard-list", tone: "green" },
  { id: "data", label: "Data", desc: "Tablas de campañas", icon: "fa-table", tone: "orange" },
  { id: "relaciones", label: "Relaciones", desc: "Vínculos entre fuentes", icon: "fa-diagram-project", tone: "pink" },
  { id: "medidas", label: "Medidas", desc: "Métricas y fórmulas", icon: "fa-ruler-combined", tone: "amber" },
  { id: "dashboard", label: "Dashboard", desc: "Resumen ejecutivo", icon: "fa-chart-pie", tone: "indigo" },
  { id: "dashboard_plataforma", label: "Dashboard · Plataforma", desc: "KPI y tabla financiera / leads plataforma", icon: "fa-chart-column", tone: "indigo" },
  { id: "dashboard_crm", label: "Dashboard · Comercial CRM", desc: "Operación comercial vs CRM", icon: "fa-handshake", tone: "teal" },
  { id: "ads-report", label: "Reporte de anuncios", desc: "Rendimiento de anuncios", icon: "fa-bullhorn", tone: "sky" },
  { id: "auditoria", label: "Auditoría", desc: "Historial de cambios", icon: "fa-clipboard-check", tone: "purple" },
];

const CAMPATRACK_LS_PRESERVE_ON_LOGIN = [
  LS_PLANNING_DATA,
  "planning",
  "planningData",
  LS_CC_DATA,
  "centro_costos",
  "centros_costos",
  LS_CATALOGOS_SISTEMA,
  LS_KEYS.dataReal,
  "data_general",
  "dataReal",
  LS_KEYS.dataAdsReport,
  "data_ads_report",
  "dataAdsReport",
  LS_KEYS.dataAnuncios,
  "data_anuncios",
  "dataAnuncios",
  LS_KEYS.relaciones,
  "relaciones",
  LS_KEYS.campaniasUnicasData,
  LS_KEYS.medidas,
  LS_KEYS.modeloAnalitico,
  "modelo",
  LS_CONSUMO_CAMPANA,
  LS_BITACORA_DATA,
  "programas",
  LS_CAMPATRACK_TEAMS,
  LS_DASH_MOSTRAR_META_GLOBAL,
  LS_ADS_REPORT_THUMBS
];

function campatrackSnapshotAuthLocalStorage() {
  let theme = null;
  try {
    theme = appMemoryKV.getItem(LS_CAMPATRACK_THEME);
  } catch (_) {}
  const preserved = {};
  for (const k of CAMPATRACK_LS_PRESERVE_ON_LOGIN) {
    try {
      const v = appMemoryKV.getItem(k);
      if (v != null) preserved[k] = v;
    } catch (_) {}
  }
  return { theme, preserved };
}

function campatrackRestoreAuthLocalStorage(snap, opts = {}) {
  if (!snap) return;
  try {
    if (snap.theme != null) appMemoryKV.setItem(LS_CAMPATRACK_THEME, snap.theme);
  } catch (_) {}
  if (
    !opts.skipPreservedDataKeys &&
    snap.preserved &&
    typeof snap.preserved === "object"
  ) {
    for (const [k, v] of Object.entries(snap.preserved)) {
      if (v == null) continue;
      try {
        appMemoryKV.setItem(k, v);
      } catch (_) {}
    }
  }
}

/** Acepta `modulos` como array de ids o como mapa { id: true }; devuelve mapa para permisos. */
function normalizeCampatrackUserModulos(modulos) {
  if (Array.isArray(modulos)) {
    const o = {};
    for (const id of modulos) {
      const k = String(id || "").trim();
      if (k) o[k] = true;
    }
    return o;
  }
  if (modulos && typeof modulos === "object") {
    const o = {};
    for (const [k, v] of Object.entries(modulos)) {
      if (v === true) o[k] = true;
    }
    return o;
  }
  return {};
}

/** Lista de ids con acceso (para persistir como `modulos: []`). */
function campatrackUserModulosToIdList(modMap) {
  const n = normalizeCampatrackUserModulos(modMap);
  return Object.keys(n).filter((k) => n[k] === true);
}

async function campatrackHashPassword(username, plain) {
  const base = `${String(username).trim()}\n${String(plain)}`;
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const enc = new TextEncoder().encode(base);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return btoa(unescape(encodeURIComponent(base)));
}

function buildCampatrackLocalSessionFromRecord(rec, preservedSession = null) {
  const modulos = { ...normalizeCampatrackUserModulos(rec.modulos) };
  const membershipTeams = campatrackNormalizeTeamsFromDraftRecord(rec);
  const prev = preservedSession && typeof preservedSession === "object" ? preservedSession : null;
  let teamId =
    prev && String(prev.teamId || "").trim()
      ? String(prev.teamId).trim()
      : "";
  teamId = resolveCampatrackTeamId(teamId) || teamId;
  if (!teamId && membershipTeams.length) teamId = membershipTeams[0];
  teamId = resolveCampatrackTeamId(teamId) || teamId;
  let teamsArr = membershipTeams.slice();
  if (!teamsArr.length && prev && Array.isArray(prev.teams)) {
    teamsArr = [...new Set(prev.teams.map((x) => String(x || "").trim()).filter(campatrackIsCanonTeamId))];
  }
  const username = String(rec.usuario || "").trim();
  return {
    id: username,
    username,
    role: normalizeCampatrackRoleKey(rec.rol || "usuario"),
    nombre: String(rec.nombre || "").trim(),
    apellido: String(rec.apellido || "").trim(),
    cargo: String(rec.cargo || "").trim(),
    foto: normalizeCampatrackUserFotoValue(rec.foto),
    campatrackLocalProfile: true,
    permisosModulos: modulos,
    teamId,
    teams: teamsArr,
    teamNombre: teamId ? resolveCampatrackTeamNombre(teamId) : "",
    permissions: deriveToolbarPermissionsForStoredUserRecord(rec),
  };
}

function campatrackRefreshSessionIfUserRecordMatches(updatedRecord) {
  const u = getUser();
  if (!u || !updatedRecord) return;
  const same =
    String(u.username || "").trim().toLowerCase() ===
    String(updatedRecord.usuario || "").trim().toLowerCase();
  if (!same) return;
  try {
    const next = buildCampatrackLocalSessionFromRecord(updatedRecord, u);
    window.currentUser = {
      ...next,
      permissions: resolveCampatrackSessionPermissions(next)
    };
    appMemorySession.setItem(SS_USER_SESSION_JSON, JSON.stringify(window.currentUser));
  } catch (_) {
    /* ignore */
  }
  syncCampatrackProfileHeader();
  if (typeof window.campatrackRefreshModuleNav === "function") {
    try {
      window.campatrackRefreshModuleNav();
    } catch (_) {
      /* ignore */
    }
  }
}

function campatrackApplyLoginSuccessToStorage(sessionUser) {
  const snap = campatrackSnapshotAuthLocalStorage();
  try {
    appMemoryKV.clear();
  } catch (_) {}
  campatrackRestoreAuthLocalStorage(snap, { skipPreservedDataKeys: true });
  try {
    const baseUser = {
      ...sessionUser,
      id: sessionUser.id != null ? String(sessionUser.id) : String(sessionUser.username ?? "").trim()
    };
    window.currentUser = {
      ...baseUser,
      permissions: resolveCampatrackSessionPermissions(baseUser)
    };
    appMemorySession.setItem(SS_USER_SESSION_JSON, JSON.stringify(window.currentUser));
    appMemorySession.setItem(SS_USUARIO_LOGUEADO, "true");
    appMemoryKV.setItem(LS_CAMPATRACK_AUTH, "true");
    appMemoryKV.setItem(LS_CAMPATRACK_ROLE, normalizeCampatrackRoleKey(sessionUser.role));
    appMemoryKV.setItem(LS_CAMPATRACK_USER, String(sessionUser.username ?? ""));
  } catch (se) {
    console.warn("No se pudo guardar sesión", se);
  }
  campatrackInvalidateUsersDraft();
}

function updateAppTopbarForModule(which) {
  const meta = CAMPATRACK_TOPBAR_META[which] || CAMPATRACK_TOPBAR_META.dashboard;
  const titleEl = document.getElementById("appTopbarDashTitle");
  const subEl = document.getElementById("appTopbarDashSub");
  const icoEl = document.getElementById("appTopbarDashIco");
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.sub;
  if (icoEl) {
    icoEl.className = `fa-solid ${meta.icon} app-saas-topbar-dashbind-ico`;
  }
}

function applyCampatrackThemeToggleUi() {
  const btn = document.getElementById("appThemeToggle");
  if (!btn) return;
  const dark = document.body.classList.contains("dark-mode");
  btn.classList.toggle("app-theme-toggle--dark", dark);
  btn.setAttribute("aria-pressed", dark ? "true" : "false");
  btn.setAttribute("aria-label", dark ? "Activar modo claro" : "Activar modo oscuro");
  btn.title = dark ? "Modo claro" : "Modo oscuro";
}

function refreshChartsAfterThemeChange() {
  const dash = document.getElementById("dashboardModule");
  if (dash && !dash.classList.contains("hidden") && typeof hasAnyDataLoaded === "function" && hasAnyDataLoaded()) {
    try {
      if (typeof renderDashboardChart === "function") {
        renderDashboardChart(typeof getDashboardKpiDataset === "function" ? getDashboardKpiDataset() : []);
      }
    } catch (e) {
      console.warn("renderDashboardChart tema", e);
    }
    try {
      if (typeof renderDashboardInsightsSidePanels === "function") renderDashboardInsightsSidePanels();
    } catch (e) {
      console.warn("renderDashboardInsightsSidePanels tema", e);
    }
  }
  try {
    const c = document.getElementById("cplMiniChart");
    if (c && typeof dashPaintCplMiniChartPlaceholder === "function") dashPaintCplMiniChartPlaceholder(c);
  } catch (e) {
    console.warn("cplMiniChart tema", e);
  }
}

function initAppThemeToggle() {
  const btn = document.getElementById("appThemeToggle");
  if (!btn) return;
  try {
    const theme = appMemoryKV.getItem(LS_CAMPATRACK_THEME);
    if (theme === "dark") document.body.classList.add("dark-mode");
    else if (theme === "light") document.body.classList.remove("dark-mode");
  } catch (e) {
    /* ignore */
  }
  applyCampatrackThemeToggleUi();
  btn.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    const dark = document.body.classList.contains("dark-mode");
    try {
      appMemoryKV.setItem(LS_CAMPATRACK_THEME, dark ? "dark" : "light");
    } catch (err) {
      /* ignore */
    }
    applyCampatrackThemeToggleUi();
    refreshChartsAfterThemeChange();
  });
}
const SS_USUARIO_LOGUEADO = "usuario_logueado";
/** Sesión backend: { username, role } — clave solicitada por el contrato de API */
const SS_USER_SESSION_JSON = "user";
/** Tras login con `reload()`, evita un segundo GET a `/api/data` ya que la data acaba de persistirse. */
const SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH = "campatrack_skip_next_dashboard_backend_fetch";
const API_LOGIN_URL = `${CAMPATRACK_API_ORIGIN}/api/login`;

/** Control central de sesión en memoria (`appMemorySession` / `window.currentUser`). */
function isAuthenticated() {
  try {
    if (window.currentUser != null && typeof window.currentUser === "object") return true;
  } catch (_) {}
  return isCampatrackAuthenticated();
}

/** Permisos de exportar / importar / reset por rol (base antes de overrides en sesión). */
function computeCampatrackToolbarPermissionsFromRole(user) {
  const role = normalizeCampatrackRoleKey(user?.role);
  return {
    canExport: role === "admin" || role === "usuario",
    canImport: role === "admin" || role === "usuario",
    canReset: role === "admin"
  };
}

function deriveToolbarPermissionsForStoredUserRecord(rec) {
  const p = rec?.permissions;
  if (p != null && typeof p === "object" && !Array.isArray(p)) {
    return {
      canExport: p.canExport === true,
      canImport: p.canImport === true,
      canReset: p.canReset === true
    };
  }
  return computeCampatrackToolbarPermissionsFromRole({
    role: normalizeCampatrackRoleKey(rec?.rol ?? "usuario"),
    username: String(rec?.usuario || "").trim()
  });
}

/**
 * Si existe `permissions` en la sesión, solo los `true` explícitos activan cada acción; si falta el objeto se usan las reglas por rol.
 */
function resolveCampatrackSessionPermissions(user) {
  const p = user?.permissions;
  if (p != null && typeof p === "object" && !Array.isArray(p)) {
    return {
      canExport: p.canExport === true,
      canImport: p.canImport === true,
      canReset: p.canReset === true
    };
  }
  return computeCampatrackToolbarPermissionsFromRole(user);
}

/**
 * Tras hidratar el bundle (login API / refresco), copia nombre, apellido, cargo, foto, equipo y permisos
 * desde `campatrack_users_db` a la sesión para el header y la navegación por módulos.
 */
function campatrackMergeSessionProfileFromDraftUsers() {
  const raw =
    window.currentUser != null && typeof window.currentUser === "object" ? window.currentUser : null;
  if (!raw || raw.campatrackSystemRoot === true) return;
  const uname = String(raw.username || "").trim().toLowerCase();
  if (!uname) return;
  const list = getCampatrackStoredUsers();
  const rec = list.find((r) => String(r.usuario || "").trim().toLowerCase() === uname);
  if (!rec) return;
  if (String(rec.estado || "activo").toLowerCase() === "inactivo") return;
  try {
    const merged = buildCampatrackLocalSessionFromRecord(rec, raw);
    const prev = raw && typeof raw === "object" ? { ...raw } : {};
    const nextPerms = resolveCampatrackSessionPermissions(merged);
    /** No pisar datos ya traídos por `/api/login` (profile_json) si el borrador no los trae. */
    let fotoOut = normalizeCampatrackUserFotoValue(merged.foto);
    if (!hasUsableProfilePhotoUrl(fotoOut) && hasUsableProfilePhotoUrl(prev.foto)) {
      fotoOut = normalizeCampatrackUserFotoValue(prev.foto);
    }
    let nombreOut = String(merged.nombre || "").trim();
    let apellidoOut = String(merged.apellido || "").trim();
    let cargoOut = String(merged.cargo || "").trim();
    if (!nombreOut && String(prev.nombre || "").trim()) nombreOut = String(prev.nombre).trim();
    if (!apellidoOut && String(prev.apellido || "").trim()) apellidoOut = String(prev.apellido).trim();
    if (!cargoOut && String(prev.cargo || "").trim()) cargoOut = String(prev.cargo).trim();
    window.currentUser = {
      ...merged,
      nombre: nombreOut,
      apellido: apellidoOut,
      cargo: cargoOut,
      foto: fotoOut,
      permissions: nextPerms,
    };
    appMemorySession.setItem(SS_USER_SESSION_JSON, JSON.stringify(window.currentUser));
  } catch (_) {
    /* ignore */
  }
}

function getUser() {
  try {
    if (window.currentUser != null && typeof window.currentUser === "object") {
      const w = window.currentUser;
      if (
        w.username !== undefined &&
        w.role !== undefined &&
        String(w.username || "").trim() !== "" &&
        String(w.role || "").trim() !== ""
      ) {
        return { ...w, permissions: resolveCampatrackSessionPermissions(w) };
      }
    }
    const raw = appMemorySession.getItem(SS_USER_SESSION_JSON);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, permissions: resolveCampatrackSessionPermissions(parsed) };
  } catch {
    return null;
  }
}

function getCampatrackLoginPageUrl() {
  return getCampatrackIndexPageUrl();
}

function getCampatrackIndexPageUrl() {
  return window.location.protocol === "file:" ? "index.html" : "/index.html";
}

let campatrackPopStateTrapInstalled = false;

function installCampatrackBackButtonTrap() {
  if (campatrackPopStateTrapInstalled) return;
  campatrackPopStateTrapInstalled = true;
  window.history.pushState(null, "", window.location.href);
  window.addEventListener("popstate", () => {
    window.history.pushState(null, "", window.location.href);
  });
}
const CAMPATRACK_DEFAULT_ROLE = "admin";
const CAMPATRACK_ALLOWED_MODULES_BY_ROLE = {
  admin: new Set([
    "costos",
    "planning",
    "bitacora",
    "data",
    "relaciones",
    "medidas",
    "dashboard",
    "ads-report",
    "usuarios",
    "auditoria",
  ]),
  planner: new Set(["planning", "dashboard", "auditoria"]),
  usuario: new Set(["costos", "planning", "bitacora", "dashboard", "ads-report", "auditoria"]),
  viewer: new Set(["dashboard"]),
};
const CAMPATRACK_PROFILE_BY_ROLE = {
  admin: { name: "Usuario", title: "Sesión iniciada", avatar: "" },
  usuario: { name: "Usuario", title: "", avatar: "" },
  planner: { name: "Usuario", title: "Planning", avatar: "" },
  viewer: { name: "Usuario", title: "Solo lectura", avatar: "" },
};

function isCampatrackAuthenticated() {
  const u = getUser();
  return !!(u && u.username !== undefined && u.username !== null && String(u.username).trim() !== "" &&
    u.role !== undefined &&
    String(u.role).trim() !== "");
}

function normalizeCampatrackRoleKey(raw) {
  const role = String(raw || "").trim().toLowerCase();
  if (!role) return "viewer";
  if (role === "planner") return "planner";
  if (role === "viewer") return "viewer";
  if (role === "admin") return "admin";
  if (role === "usuario") return "usuario";
  return "viewer";
}

function getCampatrackRole() {
  const u = getUser();
  if (u && u.role != null) return normalizeCampatrackRoleKey(u.role);
  const role = String(appMemoryKV.getItem(LS_CAMPATRACK_ROLE) || "").trim();
  return normalizeCampatrackRoleKey(role);
}

function getAllowedCampatrackModules(role) {
  return CAMPATRACK_ALLOWED_MODULES_BY_ROLE[role] || CAMPATRACK_ALLOWED_MODULES_BY_ROLE.admin;
}

/** Conjunto de módulos visibles en sidebar: permisos del usuario local o rol API. */
function getCampatrackModuleVisibilitySet() {
  const u = getUser();
  if (u && u.campatrackSystemRoot === true) {
    const s = new Set(getAllowedCampatrackModules("admin"));
    if (campatrackIsLiteMode()) s.add("configuracion");
    return s;
  }
  if (u && u.campatrackLocalProfile === true && u.permisosModulos && typeof u.permisosModulos === "object") {
    const s = new Set(Object.keys(u.permisosModulos).filter((k) => u.permisosModulos[k] === true));
    if (normalizeCampatrackRoleKey(u.role) === "admin" && campatrackIsLiteMode()) s.add("configuracion");
    return s;
  }
  const base = getAllowedCampatrackModules(getCampatrackRole());
  if (campatrackIsLiteMode() && getCampatrackRole() === "admin") {
    const x = new Set(base);
    x.add("configuracion");
    return x;
  }
  return base;
}

function campatrackHasDashboardAccess() {
  const vis = getCampatrackModuleVisibilitySet();
  return vis.has("dashboard") || vis.has("dashboard_plataforma") || vis.has("dashboard_crm");
}

/** Permisos granulares del dashboard (solo perfiles locales con `permisosModulos`). Si no hay granularidad, replica el flag `dashboard`. */
function getDashboardSubtabVisibility() {
  const vis = getCampatrackModuleVisibilitySet();
  const legacyDash = vis.has("dashboard");
  const u = getUser();
  const granular =
    !!(u && u.campatrackLocalProfile === true && u.permisosModulos && typeof u.permisosModulos === "object") &&
    (u.permisosModulos.dashboard_plataforma === true || u.permisosModulos.dashboard_crm === true);
  if (granular) {
    return {
      plataforma: u.permisosModulos.dashboard_plataforma === true,
      crm: u.permisosModulos.dashboard_crm === true
    };
  }
  return { plataforma: legacyDash, crm: legacyDash };
}

/** Subtab efectiva tras permisos — misma prioridad que el shell CRM/Plataforma. */
function getDashboardEffectiveSubtab() {
  const vis = getDashboardSubtabVisibility();
  if (dashboardActiveSubtab === "crm" && vis.crm) return "crm";
  if (dashboardActiveSubtab === "plataforma" && vis.plataforma) return "plataforma";
  return vis.crm ? "crm" : "plataforma";
}

/** Evita borrar/dañar la tarjeta MES dentro del strip CRM antes de innerHTML.clear. */
function ensureMesCardOutsideCrmKpiStrip() {
  const period = document.getElementById("dashPeriodoCard");
  const bar = document.querySelector("#dashboardModule .dashboard-kpis.dash-dashboard-shared-bar");
  const kpiCrm = document.getElementById("dashboardKpisCrmHolder");
  if (!(period instanceof HTMLElement) || !(bar instanceof HTMLElement) || !(kpiCrm instanceof HTMLElement)) return;
  if (!kpiCrm.contains(period)) return;
  bar.insertBefore(period, kpiCrm.nextSibling);
  period.classList.remove("dash-periodo--crm-kpi-slot");
  kpiCrm.classList.remove("dashboard-kpis-inner--crm-strip");
}

function attachMesCardToCrmKpiStrip() {
  const period = document.getElementById("dashPeriodoCard");
  const kpiCrm = document.getElementById("dashboardKpisCrmHolder");
  if (!(period instanceof HTMLElement) || !(kpiCrm instanceof HTMLElement)) return;
  kpiCrm.appendChild(period);
  period.classList.add("dash-periodo--crm-kpi-slot");
  kpiCrm.classList.add("dashboard-kpis-inner--crm-strip");
}

function syncDashboardActiveSubtabWithPermissions() {
  const v = getDashboardSubtabVisibility();
  if (!v.plataforma && v.crm) dashboardActiveSubtab = "crm";
  else if (v.plataforma && !v.crm) dashboardActiveSubtab = "plataforma";
  else if (!v.plataforma && !v.crm) dashboardActiveSubtab = "plataforma";
}

function applyDashboardShellVisibilityForSubtab() {
  const crmOn = getDashboardEffectiveSubtab() === "crm";
  document.querySelector("#dashboardModule .dash-toolbar-branding")?.classList.toggle("hidden", crmOn);
  if (!crmOn) ensureMesCardOutsideCrmKpiStrip();
  document.getElementById("dashShellPlataforma")?.classList.toggle("hidden", crmOn);
  document.getElementById("dashShellCrm")?.classList.toggle("hidden", !crmOn);
  document.getElementById("dashboardKpis")?.classList.toggle("hidden", crmOn);
  document.getElementById("dashboardKpisCrmHolder")?.classList.toggle("hidden", !crmOn);
  const tabP = document.getElementById("dashTabPlataforma");
  const tabC = document.getElementById("dashTabComercialCrm");
  if (tabP instanceof HTMLButtonElement) {
    tabP.classList.toggle("dash-dashboard-header-tab--active", !crmOn);
    tabP.setAttribute("aria-selected", !crmOn ? "true" : "false");
  }
  if (tabC instanceof HTMLButtonElement) {
    tabC.classList.toggle("dash-dashboard-header-tab--active", crmOn);
    tabC.setAttribute("aria-selected", crmOn ? "true" : "false");
  }
  syncDashboardCrmHeaderBadges();
}

function applyDashboardMainSubtabsNavVisibility() {
  const wrap = document.getElementById("campatrackDashHeaderSubtabsWrap");
  const dash = document.getElementById("dashboardModule");
  const onDash = !!(dash && !dash.classList.contains("hidden"));
  if (!(wrap instanceof HTMLElement)) return;
  if (!onDash) {
    wrap.classList.add("hidden");
    wrap.setAttribute("aria-hidden", "true");
    return;
  }
  const v = getDashboardSubtabVisibility();
  const showBoth = v.plataforma && v.crm;
  wrap.classList.toggle("hidden", !showBoth);
  wrap.setAttribute("aria-hidden", showBoth ? "false" : "true");
}

/** Tabs + permisos + shell + branding; devuelve vistas activas para renders condicionales. */
function prepareDashboardUiSubtabState() {
  applyDashboardMainSubtabsNavVisibility();
  syncDashboardActiveSubtabWithPermissions();
  if (dashboardActiveSubtab === "crm" && !getDashboardSubtabVisibility().crm) dashboardActiveSubtab = "plataforma";
  if (
    dashboardActiveSubtab === "plataforma" &&
    !getDashboardSubtabVisibility().plataforma &&
    getDashboardSubtabVisibility().crm
  ) {
    dashboardActiveSubtab = "crm";
  }
  applyDashboardShellVisibilityForSubtab();
  return {
    vis: getDashboardSubtabVisibility(),
    eff: getDashboardEffectiveSubtab()
  };
}

function isCampatrackModuleAllowed(which) {
  const u = getUser();
  if (which === "dashboard") {
    return campatrackHasDashboardAccess();
  }
  if (which === "configuracion") {
    if (!campatrackIsLiteMode()) return false;
    const r = getCampatrackRole();
    return r === "admin" || !!(u && u.campatrackSystemRoot === true);
  }
  if (u && u.campatrackSystemRoot === true) return true;
  if (u && u.campatrackLocalProfile === true && u.permisosModulos && typeof u.permisosModulos === "object") {
    return u.permisosModulos[which] === true;
  }
  const allowed = getAllowedCampatrackModules(getCampatrackRole());
  return allowed.has(which);
}

function refreshCampatrackTeamHeader() {
  const el = document.getElementById("appTeamHeaderBadge");
  if (!el) return;
  const u = getUser();
  const name = u && String(u.teamNombre || "").trim() ? String(u.teamNombre).trim() : resolveCampatrackTeamNombre(u?.teamId);
  if (name) {
    el.textContent = `Equipo: ${name}`;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

/** Un solo hijo dentro del botón del header: foto o inicial (mutuamente excluyente). */
function mountCampatrackHeaderAvatar(showPhoto, fotoFinal, altText, initialLetter) {
  const btn = document.getElementById("appProfileAvatarBtn");
  if (!(btn instanceof HTMLButtonElement)) return;
  btn.replaceChildren();

  function renderCampatrackHeaderAvatarImagen(src, alt) {
    const img = document.createElement("img");
    img.className = "app-profile-avatar app-profile-avatar--photo";
    img.alt = alt || "";
    img.decoding = "async";
    img.src = src;
    btn.appendChild(img);
  }

  function renderCampatrackHeaderAvatarInicial(letra) {
    const span = document.createElement("span");
    span.className = "app-profile-avatar app-profile-avatar--letter";
    span.setAttribute("aria-hidden", "true");
    span.textContent = letra;
    btn.appendChild(span);
  }

  if (showPhoto && fotoFinal) {
    renderCampatrackHeaderAvatarImagen(String(fotoFinal).trim(), altText);
    return;
  }
  renderCampatrackHeaderAvatarInicial(initialLetter || "?");
}

function syncCampatrackProfileHeader() {
  const name = document.getElementById("appProfileName");
  const roleEl = document.getElementById("appProfileRole");
  const roleKey = getCampatrackRole();
  const profile = CAMPATRACK_PROFILE_BY_ROLE[roleKey] || CAMPATRACK_PROFILE_BY_ROLE.admin;
  const sess = typeof getUser === "function" ? getUser() : null;
  const hasNombreCompleto =
    sess &&
    String(sess.nombre || "").trim() !== "" &&
    String(sess.apellido || "").trim() !== "";
  const displayName = hasNombreCompleto
    ? `${String(sess.nombre).trim()} ${String(sess.apellido).trim()}`
    : sess && sess.username !== undefined && String(sess.username).trim() !== ""
      ? String(sess.username).trim()
      : profile.name;
  const titleText =
    sess && sess.cargo !== undefined && String(sess.cargo || "").trim() !== ""
      ? String(sess.cargo).trim()
      : profile.title;
  const fotoFinal = sess
    ? normalizeCampatrackUserFotoValue(sess.foto)
    : normalizeCampatrackUserFotoValue(profile.avatar);
  const showPhoto = hasUsableProfilePhotoUrl(fotoFinal);
  const initial = pickCampatrackInitialLetterNombreUsuario(
    hasNombreCompleto ? sess?.nombre : displayName,
    sess?.username
  );
  mountCampatrackHeaderAvatar(showPhoto, fotoFinal, displayName, initial);
  if (name) name.textContent = displayName;
  if (roleEl) roleEl.textContent = titleText;
  refreshCampatrackTeamHeader();
}

function bootstrapCampatrackAuthShell() {
  const login = document.getElementById("loginScreen");
  const shell = document.getElementById("mainAppShell");
  if (!login || !shell) return;
  const lite = campatrackIsLiteMode();
  const ghOk = !lite || hasClientGithubConfigComplete();
  if (lite && !ghOk) {
    login.classList.add("hidden");
    shell.classList.add("hidden");
    login.setAttribute("aria-hidden", "true");
    shell.setAttribute("aria-hidden", "true");
    campatrackGateOnLogout();
    return;
  }
  let ok = isCampatrackAuthenticated();
  if (!ok) {
    try {
      window.currentUser = null;
      appMemorySession.removeItem(SS_USUARIO_LOGUEADO);
      appMemorySession.removeItem(SS_USER_SESSION_JSON);
      appMemoryKV.removeItem(LS_CAMPATRACK_AUTH);
      appMemoryKV.removeItem(LS_CAMPATRACK_ROLE);
      appMemoryKV.removeItem(LS_CAMPATRACK_USER);
    } catch (_) {}
  } else {
    try {
      const u = getUser();
      if (u) {
        appMemorySession.setItem(SS_USUARIO_LOGUEADO, "true");
        appMemoryKV.setItem(LS_CAMPATRACK_AUTH, "true");
        appMemoryKV.setItem(LS_CAMPATRACK_ROLE, normalizeCampatrackRoleKey(u.role));
        appMemoryKV.setItem(LS_CAMPATRACK_USER, String(u.username ?? ""));
      }
    } catch (_) {}
    installCampatrackBackButtonTrap();
    ok = isCampatrackAuthenticated();
    if (!ok) {
      try {
        window.currentUser = null;
        appMemorySession.removeItem(SS_USUARIO_LOGUEADO);
        appMemorySession.removeItem(SS_USER_SESSION_JSON);
        appMemoryKV.removeItem(LS_CAMPATRACK_AUTH);
        appMemoryKV.removeItem(LS_CAMPATRACK_ROLE);
        appMemoryKV.removeItem(LS_CAMPATRACK_USER);
      } catch (_) {}
    }
  }
  syncCampatrackProfileHeader();
  const showShell = ok && (!lite || campatrackGateIsReady());
  login.classList.toggle("hidden", ok);
  shell.classList.toggle("hidden", !showShell);
  login.setAttribute("aria-hidden", ok ? "true" : "false");
  shell.setAttribute("aria-hidden", showShell ? "false" : "true");
  if (lite && ok && !campatrackGateIsReady()) {
    login.classList.remove("hidden");
    login.setAttribute("aria-hidden", "false");
  }
  appDeferredDiskPersistence = ok ? false : true;
  if (!ok && lite) campatrackGateOnLogout();
}

/** @type {((which: string) => void) | null} */
let appActivateMainModule = null;

function campatrackPerformLogout() {
  try {
    window.currentUser = null;
    appMemorySession.clear();
    appMemoryKV.removeItem(LS_CAMPATRACK_AUTH);
    appMemoryKV.removeItem(LS_CAMPATRACK_ROLE);
    appMemoryKV.removeItem(LS_CAMPATRACK_USER);
    appMemoryKV.removeItem(LS_PUBLISH_PENDING);
    appMemoryKV.removeItem(LS_PUBLISH_BASELINE);
  } catch (e) {
    console.warn("No se pudo cerrar sesión", e);
  }
  appPendingPublishCount = 0;
  appPublishSnapshotBaselineJson = null;
  resetAppStatePendingChanges();
  const passEl = document.getElementById("campatrackPass");
  if (passEl instanceof HTMLInputElement) passEl.value = "";
  bootstrapCampatrackAuthShell();
}

function campatrackPerformLogoutToIndex() {
  try {
    window.currentUser = null;
    appMemorySession.clear();
    appMemoryKV.removeItem(LS_CAMPATRACK_AUTH);
    appMemoryKV.removeItem(LS_CAMPATRACK_ROLE);
    appMemoryKV.removeItem(LS_CAMPATRACK_USER);
    appMemoryKV.removeItem(LS_PUBLISH_PENDING);
    appMemoryKV.removeItem(LS_PUBLISH_BASELINE);
  } catch (e) {
    console.warn("No se pudo cerrar sesión", e);
  }
  appPendingPublishCount = 0;
  appPublishSnapshotBaselineJson = null;
  resetAppStatePendingChanges();
  window.location.reload();
}

function initCampatrackAppHeader() {
  const wrap = document.getElementById("appProfileWrap");
  const btn = document.getElementById("appProfileAvatarBtn");
  const menu = document.getElementById("appProfileMenu");
  const logoutBtn = document.getElementById("appLogoutBtn");
  if (!wrap || !btn || !menu) return;
  syncCampatrackProfileHeader();

  const closeMenu = () => {
    menu.classList.remove("is-open");
    menu.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    menu.classList.add("is-open");
    menu.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("is-open")) closeMenu();
    else openMenu();
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  logoutBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMenu();
    campatrackPerformLogout();
  });
}

function campatrackIsSingleTokenNamePart(value) {
  const t = String(value || "").trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  try {
    return /^[\p{L}]+$/u.test(t);
  } catch {
    return /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]+$/.test(t);
  }
}

function initUsuariosModule() {
  const root = document.getElementById("usersModule");
  const modGrid = document.getElementById("usersModCards");
  const listPanel = document.getElementById("usersListPanel");
  const modalEl = document.getElementById("usersModal");
  const listBody = document.getElementById("usersListBody");
  if (!root || !modGrid || !listPanel || !modalEl || !listBody) return;

  let photoDataUrl = null;
  let editingUserId = null;
  let editingOriginalFoto = "";

  const el = (id) => document.getElementById(id);

  const syncUsersModalPhotoUi = () => {
    const prevImg = el("usersPhotoPreview");
    const prevLetter = el("usersPhotoPreviewLetter");
    const wrap = el("usersPhotoPreviewWrap");
    const dzEl = el("usersPhotoDropzone");
    const nombrePart = el("usersNombre") instanceof HTMLInputElement ? el("usersNombre").value : "";
    const usuarioPart = el("usersUsuario") instanceof HTMLInputElement ? el("usersUsuario").value : "";
    const url =
      typeof photoDataUrl === "string" && photoDataUrl.startsWith("data:image")
        ? photoDataUrl
        : hasUsableProfilePhotoUrl(editingOriginalFoto)
          ? String(editingOriginalFoto).trim()
          : "";
    if (url) {
      if (prevImg instanceof HTMLImageElement) prevImg.src = url;
      prevImg?.classList.remove("hidden");
      prevLetter?.classList.add("hidden");
      wrap?.classList.remove("hidden");
      dzEl?.classList.add("users-photo-dropzone--compact");
      return;
    }
    const letter = pickCampatrackInitialLetterNombreUsuario(nombrePart, usuarioPart);
    const showLetterPreview =
      editingUserId != null || !!nombrePart.trim() || !!usuarioPart.trim();
    if (showLetterPreview) {
      if (prevLetter instanceof HTMLElement) prevLetter.textContent = letter;
      prevLetter?.classList.remove("hidden");
      prevImg?.classList.add("hidden");
      wrap?.classList.remove("hidden");
      dzEl?.classList.add("users-photo-dropzone--compact");
    } else {
      wrap?.classList.add("hidden");
      dzEl?.classList.remove("users-photo-dropzone--compact");
      prevLetter?.classList.add("hidden");
      prevImg?.classList.add("hidden");
    }
  };

  ensureCampatrackTeamsSeed();

  const teamsChecksHost = el("usersTeamsChecks");

  const getSelectedTeamsFromChecks = () => {
    const out = [];
    if (!teamsChecksHost) return out;
    teamsChecksHost.querySelectorAll("input.users-team-chk:checked").forEach((ch) => {
      if (ch instanceof HTMLInputElement && campatrackIsCanonTeamId(ch.value)) out.push(String(ch.value).trim());
    });
    return [...new Set(out)];
  };

  const renderUsersTeamsCheckboxes = (selectedIds) => {
    ensureCampatrackTeamsSeed();
    if (!teamsChecksHost) return;
    const want = new Set((Array.isArray(selectedIds) ? selectedIds : []).filter(campatrackIsCanonTeamId));
    teamsChecksHost.innerHTML = campatrackCanonTeamDefinitions()
      .map((t) => {
        const id = escapeHtml(String(t.id));
        const lbl = escapeHtml(String(t.nombre));
        const checked = want.has(t.id) ? " checked" : "";
        return `<label class="users-team-chk-row"><input type="checkbox" class="users-team-chk" value="${id}"${checked}/><span>${lbl}</span></label>`;
      })
      .join("");
  };

  const renderUsersList = () => {
    const nu = el("usersNuevoBtn");
    const rows = getCampatrackStoredUsers();
    const activeCount = rows.filter((x) => String(x.estado || "").toLowerCase() !== "inactivo").length;
    if (nu instanceof HTMLButtonElement) {
      nu.disabled = activeCount >= 10;
      nu.title = activeCount >= 10 ? "Máximo 10 usuarios activos." : "";
    }
    if (!rows.length) {
      listBody.innerHTML =
        `<div class="users-list-empty"><i class="fa-solid fa-users-slash" aria-hidden="true"></i><p>No hay usuarios registrados aún.</p></div>`;
      return;
    }
    const esc = (s) => escapeHtml(String(s ?? ""));
    const estadoLabel = (r) => {
      const e = String(r.estado || "activo").toLowerCase();
      if (e === "inactivo") return `<span class="users-estado-badge users-estado-badge--off">Inactivo</span>`;
      return `<span class="users-estado-badge users-estado-badge--on">Activo</span>`;
    };
    listBody.innerHTML = `<table class="users-list-table data-table"><thead><tr>
      <th>Foto</th><th>Nombre completo</th><th>Cargo</th><th>Equipos</th><th>Usuario</th><th>Estado</th><th class="users-list-actions-col">Acciones</th>
    </tr></thead><tbody>${rows
      .map((r) => {
        const id = esc(r.id);
        const inactive = String(r.estado || "").toLowerCase() === "inactivo";
        const ids = campatrackNormalizeTeamsFromDraftRecord(r);
        const teamLabel = esc(
          ids.length ? ids.map((tid) => resolveCampatrackTeamNombre(tid) || tid).join(", ") : "—"
        );
        const fotoNorm = normalizeCampatrackUserFotoValue(r.foto);
        const ini = pickCampatrackInitialLetterNombreUsuario(r.nombre, r.usuario);
        const avatarCell = hasUsableProfilePhotoUrl(fotoNorm)
          ? `<img class="users-list-avatar users-list-avatar--img" src="${esc(fotoNorm)}" alt="" width="40" height="40" loading="lazy" />`
          : `<span class="users-list-avatar users-list-avatar--letter" aria-hidden="true">${esc(ini)}</span>`;
        return `<tr data-user-id="${id}">
      <td class="users-list-avatar-cell">${avatarCell}</td>
      <td>${esc([r.nombre, r.apellido].filter(Boolean).join(" "))}</td>
      <td>${esc(r.cargo)}</td>
      <td>${teamLabel}</td>
      <td><code>${esc(r.usuario)}</code></td>
      <td>${estadoLabel(r)}</td>
      <td class="users-list-actions-cell">
        <button type="button" class="btn-toolbar btn-small users-row-edit" data-user-id="${id}">Editar</button>
        <button type="button" class="btn-toolbar btn-small users-row-deactivate" data-user-id="${id}"${inactive ? " disabled" : ""}>Eliminar</button>
      </td>
    </tr>`;
      })
      .join("")}</tbody></table>`;
  };

  const closeUsersModalOnly = () => {
    modalEl.classList.add("hidden");
    try {
      modalEl.setAttribute("aria-hidden", "true");
    } catch (_) {
      /* ignore */
    }
  };

  const openUsersModal = () => {
    modalEl.classList.remove("hidden");
    try {
      modalEl.setAttribute("aria-hidden", "false");
    } catch (_) {
      /* ignore */
    }
    const firstFocus = modalEl.querySelector("#usersNombre");
    if (firstFocus instanceof HTMLElement) window.setTimeout(() => firstFocus.focus(), 0);
  };

  const showListPanel = () => {
    closeUsersModalOnly();
    renderUsersList();
  };

  window.campatrackUsersOnOpen = () => {
    showListPanel();
  };

  const showErr = (id, msg) => {
    const n = el(id);
    if (!n) return;
    if (msg) {
      n.textContent = msg;
      n.classList.remove("hidden");
    } else {
      n.textContent = "";
      n.classList.add("hidden");
    }
  };
  const globalErrNodes = () =>
    [el("usersFormGlobalError"), el("usersFormPageAlert")].filter((n) => n instanceof HTMLElement);

  const setGlobal = (msg) => {
    const nodes = globalErrNodes();
    if (!nodes.length) return;
    for (const globalErr of nodes) {
      globalErr.classList.remove("users-global-error--success");
      if (msg) {
        globalErr.textContent = msg;
        globalErr.classList.remove("hidden");
      } else {
        globalErr.textContent = "";
        globalErr.classList.add("hidden");
      }
    }
  };

  const setGlobalSuccess = (msg) => {
    const nodes = globalErrNodes();
    for (const globalErr of nodes) {
      globalErr.classList.add("users-global-error--success");
      globalErr.textContent = msg;
      globalErr.classList.remove("hidden");
    }
  };

  const clearFieldErrors = () => {
    [
      "usersNombreErr",
      "usersApellidoErr",
      "usersCargoErr",
      "usersUsuarioErr",
      "usersClaveErr",
      "usersModulosErr",
      "usersPhotoError",
      "usersTeamErr"
    ].forEach((id) => showErr(id, ""));
    setGlobal("");
  };

  const getChecks = () => Array.from(modGrid.querySelectorAll(".users-mod-check"));

  const syncSelectAllCheckbox = () => {
    const master = el("usersSelectAllModsChk");
    if (!(master instanceof HTMLInputElement)) return;
    const all = getChecks().filter((c) => c instanceof HTMLInputElement);
    if (!all.length) {
      master.checked = false;
      master.indeterminate = false;
      return;
    }
    const n = all.filter((c) => c.checked).length;
    master.checked = n === all.length;
    master.indeterminate = n > 0 && n < all.length;
  };

  const applyFormModeUi = () => {
    const isEdit = editingUserId != null;
    const titleEl = el("usersFormTitle");
    const subEl = el("usersFormSubtitle");
    const saveLbl = el("usersSaveBtnLabel");
    const usrIn = el("usersUsuario");
    const hintEdit = el("usersClaveEditHint");
    const hintNew = document.querySelector("#usersModal .users-clave-hint-new");
    const reqClave = el("usersClaveReq");
    if (titleEl) {
      titleEl.innerHTML = isEdit
        ? `<i class="fa-solid fa-user-pen users-title-ico" aria-hidden="true"></i> Editar usuario`
        : `<i class="fa-solid fa-user-plus users-title-ico" aria-hidden="true"></i> Registrar nuevo usuario`;
    }
    if (subEl) {
      subEl.textContent = isEdit
        ? "Modifica los datos o el acceso a módulos y guarda los cambios."
        : "Completa la información para crear un nuevo usuario en el sistema.";
    }
    if (saveLbl) saveLbl.textContent = isEdit ? "Guardar cambios" : "Guardar usuario";
    if (usrIn instanceof HTMLInputElement) usrIn.readOnly = isEdit;
    hintEdit?.classList.toggle("hidden", !isEdit);
    if (hintNew instanceof HTMLElement) hintNew.classList.toggle("hidden", isEdit);
    reqClave?.classList.toggle("hidden", isEdit);
  };

  if (!modGrid.dataset.rendered) {
    modGrid.innerHTML = CAMPATRACK_REGISTER_MODULE_CARDS.map(
      (c) =>
        `<label class="users-mod-card users-mod-card--${c.tone}">` +
        `<input type="checkbox" class="users-mod-check" name="usersMod" value="${c.id}" />` +
        `<span class="users-mod-card-inner">` +
        `<span class="users-mod-icon-wrap" aria-hidden="true"><i class="fa-solid ${c.icon} users-mod-ico"></i></span>` +
        `<span class="users-mod-text">` +
        `<span class="users-mod-label">${c.label}</span>` +
        `<span class="users-mod-desc">${c.desc}</span>` +
        `</span></span></label>`
    ).join("");
    modGrid.dataset.rendered = "1";
  }

  const readPhotoFile = (file) => {
    const errEl = el("usersPhotoError");
    if (!file) return;
    const okType = file.type === "image/jpeg" || file.type === "image/png";
    if (!okType) {
      if (errEl) {
        errEl.textContent = "Solo se permiten imágenes JPG o PNG.";
        errEl.classList.remove("hidden");
      }
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      if (errEl) {
        errEl.textContent = "El archivo supera el máximo de 2 MB.";
        errEl.classList.remove("hidden");
      }
      return;
    }
    if (errEl) errEl.classList.add("hidden");
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") {
        photoDataUrl = r;
        syncUsersModalPhotoUi();
      }
    };
    reader.readAsDataURL(file);
  };

  const resetPhotoUiOnly = () => {
    const inp = el("usersPhotoInput");
    if (inp instanceof HTMLInputElement) inp.value = "";
    el("usersPhotoPreviewWrap")?.classList.add("hidden");
    el("usersPhotoDropzone")?.classList.remove("users-photo-dropzone--compact");
    el("usersPhotoPreviewLetter")?.classList.add("hidden");
    el("usersPhotoPreview")?.classList.add("hidden");
    showErr("usersPhotoError", "");
  };

  const resetPhoto = () => {
    photoDataUrl = null;
    resetPhotoUiOnly();
    syncUsersModalPhotoUi();
  };

  const resetUsersPasswordFieldUi = () => {
    const p = el("usersClave");
    const btn = el("usersClaveToggle");
    if (p instanceof HTMLInputElement) {
      p.type = "password";
      p.value = "";
    }
    if (btn) {
      const i = btn.querySelector("i");
      if (i) i.className = "fa-solid fa-eye";
      btn.setAttribute("aria-label", "Mostrar contraseña");
    }
  };

  function resetForm() {
    clearFieldErrors();
    editingUserId = null;
    editingOriginalFoto = "";
    resetPhoto();
    const n = el("usersNombre");
    const a = el("usersApellido");
    const c = el("usersCargo");
    const u = el("usersUsuario");
    resetUsersPasswordFieldUi();
    if (n instanceof HTMLInputElement) n.value = "";
    if (a instanceof HTMLInputElement) a.value = "";
    if (c instanceof HTMLInputElement) c.value = "";
    if (u instanceof HTMLInputElement) {
      u.value = "";
      u.readOnly = false;
    }
    renderUsersTeamsCheckboxes([]);
    getChecks().forEach((ch) => {
      if (ch instanceof HTMLInputElement) ch.checked = false;
    });
    const master = el("usersSelectAllModsChk");
    if (master instanceof HTMLInputElement) {
      master.checked = false;
      master.indeterminate = false;
    }
    for (const permId of ["usersPermExport", "usersPermImport", "usersPermReset"]) {
      const n = el(permId);
      if (n instanceof HTMLInputElement) n.checked = false;
    }
    applyFormModeUi();
    syncUsersModalPhotoUi();
  }

  const loadUserForEdit = (id) => {
    const list = getCampatrackStoredUsers();
    const r = list.find((x) => String(x.id) === String(id));
    if (!r) return;
    clearFieldErrors();
    editingUserId = r.id;
    editingOriginalFoto = normalizeCampatrackUserFotoValue(r.foto);
    const n = el("usersNombre");
    const a = el("usersApellido");
    const c = el("usersCargo");
    const u = el("usersUsuario");
    const p = el("usersClave");
    if (n instanceof HTMLInputElement) n.value = String(r.nombre || "");
    if (a instanceof HTMLInputElement) a.value = String(r.apellido || "");
    if (c instanceof HTMLInputElement) c.value = String(r.cargo || "");
    if (u instanceof HTMLInputElement) {
      u.value = String(r.usuario || "");
      u.readOnly = true;
    }
    if (p instanceof HTMLInputElement) {
      const plain = String(r.clave_plano ?? "").trim();
      p.value = plain;
      const btn = el("usersClaveToggle");
      if (plain) {
        p.type = "text";
        if (btn) {
          const i = btn.querySelector("i");
          if (i) i.className = "fa-solid fa-eye-slash";
          btn.setAttribute("aria-label", "Ocultar contraseña");
        }
      } else {
        p.type = "password";
        if (btn) {
          const i = btn.querySelector("i");
          if (i) i.className = "fa-solid fa-eye";
          btn.setAttribute("aria-label", "Mostrar contraseña");
        }
      }
    }
    resetPhotoUiOnly();
    photoDataUrl =
      editingOriginalFoto && String(editingOriginalFoto).startsWith("data:image")
        ? editingOriginalFoto
        : null;
    syncUsersModalPhotoUi();
    const modMap = normalizeCampatrackUserModulos(r.modulos);
    CAMPATRACK_REGISTER_MODULE_CARDS.forEach((c) => {
      const ch = modGrid.querySelector(`input.users-mod-check[value="${c.id}"]`);
      if (ch instanceof HTMLInputElement) ch.checked = !!modMap[c.id];
    });
    syncSelectAllCheckbox();
    renderUsersTeamsCheckboxes(campatrackNormalizeTeamsFromDraftRecord(r));
    const tp = deriveToolbarPermissionsForStoredUserRecord(r);
    const pe = el("usersPermExport");
    const pi = el("usersPermImport");
    const pr = el("usersPermReset");
    if (pe instanceof HTMLInputElement) pe.checked = tp.canExport;
    if (pi instanceof HTMLInputElement) pi.checked = tp.canImport;
    if (pr instanceof HTMLInputElement) pr.checked = tp.canReset;
    applyFormModeUi();
    openUsersModal();
  };

  const validate = () => {
    clearFieldErrors();
    let ok = true;
    const isEdit = editingUserId != null;
    const nombre = String(el("usersNombre")?.value || "").trim();
    const apellido = String(el("usersApellido")?.value || "").trim();
    const cargo = String(el("usersCargo")?.value || "").trim();
    const usuario = String(el("usersUsuario")?.value || "").trim();
    const clave = String(el("usersClave")?.value || "");

    if (!nombre) {
      showErr("usersNombreErr", "El nombre es obligatorio.");
      ok = false;
    } else if (!campatrackIsSingleTokenNamePart(nombre)) {
      showErr("usersNombreErr", "Una sola palabra, sin espacios, solo letras (ej.: Juan, no Juan Carlos).");
      ok = false;
    }
    if (!apellido) {
      showErr("usersApellidoErr", "El apellido es obligatorio.");
      ok = false;
    } else if (!campatrackIsSingleTokenNamePart(apellido)) {
      showErr("usersApellidoErr", "Una sola palabra, sin espacios, solo letras.");
      ok = false;
    }
    if (!cargo) {
      showErr("usersCargoErr", "Ingresa el cargo del usuario.");
      ok = false;
    }
    if (!usuario) {
      showErr("usersUsuarioErr", "El usuario es obligatorio.");
      ok = false;
    } else if (/\s/.test(usuario)) {
      showErr("usersUsuarioErr", "El usuario no puede contener espacios.");
      ok = false;
    } else if (!/^[a-zA-Z0-9._-]+$/.test(usuario)) {
      showErr("usersUsuarioErr", "Solo letras, números, punto, guión y guión bajo.");
      ok = false;
    }
    if (!isEdit) {
      if (!clave) {
        showErr("usersClaveErr", "La contraseña es obligatoria.");
        ok = false;
      } else if (clave.length < 8) {
        showErr("usersClaveErr", "Mínimo 8 caracteres.");
        ok = false;
      }
    } else if (clave && clave.length < 8) {
      showErr("usersClaveErr", "Mínimo 8 caracteres.");
      ok = false;
    }
    const anyMod = getChecks().some((ch) => ch instanceof HTMLInputElement && ch.checked);
    if (!anyMod) {
      showErr("usersModulosErr", "Selecciona al menos un módulo.");
      ok = false;
    }
    const taken = getCampatrackStoredUsers().some((rec) => {
      if (String(rec.usuario || "").trim().toLowerCase() !== usuario.toLowerCase()) return false;
      if (editingUserId == null) return true;
      return String(rec.id) !== String(editingUserId);
    });
    if (taken) {
      showErr("usersUsuarioErr", "Este nombre de usuario ya está registrado.");
      ok = false;
    }
    if (!getSelectedTeamsFromChecks().length) {
      showErr("usersTeamErr", "Selecciona al menos un equipo.");
      ok = false;
    }
    return ok;
  };

  listBody.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const editBtn = t.closest("button.users-row-edit");
    const offBtn = t.closest("button.users-row-deactivate");
    if (editBtn instanceof HTMLButtonElement && editBtn.dataset.userId) {
      loadUserForEdit(editBtn.dataset.userId);
      return;
    }
    if (offBtn instanceof HTMLButtonElement && offBtn.dataset.userId && !offBtn.disabled) {
      const uid = offBtn.dataset.userId;
      if (!confirm("¿Eliminar este usuario? Pasará a inactivo y no podrá iniciar sesión.")) return;
      const list = getCampatrackStoredUsers();
      const idx = list.findIndex((x) => String(x.id) === String(uid));
      if (idx === -1) return;
      const prevRec = { ...list[idx] };
      list[idx] = {
        ...list[idx],
        estado: "inactivo",
        fecha_baja: new Date().toISOString(),
      };
      saveCampatrackStoredUsers(list);
      const sess = getUser();
      if (
        sess &&
        String(sess.username || "").trim().toLowerCase() === String(prevRec.usuario || "").trim().toLowerCase()
      ) {
        campatrackPerformLogoutToIndex();
        return;
      }
      renderUsersList();
    }
  });

  el("usersPhotoInput")?.addEventListener("change", (e) => {
    const tgt = e.target;
    const f = tgt instanceof HTMLInputElement && tgt.files ? tgt.files[0] : null;
    if (f) readPhotoFile(f);
  });

  const dz = el("usersPhotoDropzone");
  dz?.addEventListener("click", () => {
    el("usersPhotoInput")?.click();
  });
  dz?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el("usersPhotoInput")?.click();
    }
  });
  dz?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("users-photo-dropzone--drag");
  });
  dz?.addEventListener("dragleave", () => dz.classList.remove("users-photo-dropzone--drag"));
  dz?.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("users-photo-dropzone--drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) readPhotoFile(f);
  });

  el("usersPhotoClearBtn")?.addEventListener("click", () => {
    photoDataUrl = null;
    if (editingUserId != null) editingOriginalFoto = "";
    resetPhotoUiOnly();
    syncUsersModalPhotoUi();
  });

  el("usersSelectAllModsChk")?.addEventListener("change", () => {
    const master = el("usersSelectAllModsChk");
    const on = master instanceof HTMLInputElement && master.checked;
    getChecks().forEach((ch) => {
      if (ch instanceof HTMLInputElement) ch.checked = on;
    });
    showErr("usersModulosErr", "");
  });

  modGrid.addEventListener("change", (e) => {
    const tgt = e.target;
    if (tgt instanceof HTMLInputElement && tgt.classList.contains("users-mod-check")) {
      syncSelectAllCheckbox();
    }
  });

  el("usersClearMods")?.addEventListener("click", () => {
    getChecks().forEach((ch) => {
      if (ch instanceof HTMLInputElement) ch.checked = false;
    });
    syncSelectAllCheckbox();
  });

  el("usersClaveToggle")?.addEventListener("click", () => {
    const inp = el("usersClave");
    const btn = el("usersClaveToggle");
    if (!(inp instanceof HTMLInputElement) || !btn) return;
    const next = inp.type === "password" ? "text" : "password";
    inp.type = next;
    const i = btn.querySelector("i");
    if (i) {
      i.className = next === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
    }
    btn.setAttribute("aria-label", next === "password" ? "Mostrar contraseña" : "Ocultar contraseña");
  });

  const closeUsersModal = () => {
    closeUsersModalOnly();
    resetForm();
  };

  el("usersNuevoBtn")?.addEventListener("click", () => {
    ensureCampatrackTeamsSeed();
    resetForm();
    openUsersModal();
  });

  el("usersModalCloseBtn")?.addEventListener("click", () => {
    closeUsersModal();
  });

  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeUsersModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!modalEl || modalEl.classList.contains("hidden")) return;
    closeUsersModal();
  });

  el("usersCancelBtn")?.addEventListener("click", () => {
    closeUsersModal();
  });

  el("usersSaveBtn")?.addEventListener("click", async () => {
    if (!validate()) return;
    const nombre = String(el("usersNombre")?.value || "").trim();
    const apellido = String(el("usersApellido")?.value || "").trim();
    const cargo = String(el("usersCargo")?.value || "").trim();
    const usuario = String(el("usersUsuario")?.value || "").trim();
    const clave = String(el("usersClave")?.value || "");
    const modObj = {};
    CAMPATRACK_REGISTER_MODULE_CARDS.forEach((c) => {
      const ch = modGrid.querySelector(`input.users-mod-check[value="${c.id}"]`);
      modObj[c.id] = ch instanceof HTMLInputElement && ch.checked;
    });
    const modulos = campatrackUserModulosToIdList(modObj);
    const teamsSaved = getSelectedTeamsFromChecks().sort();
    const list = getCampatrackStoredUsers();
    const isEdit = editingUserId != null;
    const toolbarPerms = {
      canExport: el("usersPermExport") instanceof HTMLInputElement && el("usersPermExport").checked,
      canImport: el("usersPermImport") instanceof HTMLInputElement && el("usersPermImport").checked,
      canReset: el("usersPermReset") instanceof HTMLInputElement && el("usersPermReset").checked
    };
    let fotoOut = "";
    if (typeof photoDataUrl === "string" && photoDataUrl.startsWith("data:image")) fotoOut = photoDataUrl;
    else if (isEdit && hasUsableProfilePhotoUrl(editingOriginalFoto)) fotoOut = String(editingOriginalFoto).trim();
    let record;
    if (isEdit) {
      const idx = list.findIndex((x) => String(x.id) === String(editingUserId));
      if (idx === -1) {
        setGlobal("No se encontró el usuario a editar.");
        return;
      }
      const prev = list[idx];
      const hash =
        clave.length > 0 ? await campatrackHashPassword(usuario, clave) : String(prev.clave || "");
      record = {
        ...prev,
        nombre,
        apellido,
        cargo,
        usuario,
        clave: hash,
        clave_plano: clave,
        foto: fotoOut,
        modulos,
        teams: teamsSaved,
        permissions: toolbarPerms
      };
      delete record.teamId;
      list[idx] = record;
    } else {
      const activeCount = getCampatrackStoredUsers().filter(
        (x) => String(x.estado || "").toLowerCase() !== "inactivo"
      ).length;
      if (activeCount >= 10) {
        setGlobal("Límite alcanzado: máximo 10 usuarios activos. Desactiva uno antes de crear otro.");
        return;
      }
      const hash = await campatrackHashPassword(usuario, clave);
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      record = {
        id,
        nombre,
        apellido,
        usuario,
        clave: hash,
        clave_plano: clave,
        cargo,
        foto: fotoOut,
        estado: "activo",
        rol: "usuario",
        modulos,
        teams: teamsSaved,
        fecha_creacion: new Date().toISOString(),
        permissions: toolbarPerms
      };
      list.push(record);
    }
    saveCampatrackStoredUsers(list);
    campatrackRefreshSessionIfUserRecordMatches(record);
    resetForm();
    closeUsersModalOnly();
    renderUsersList();
    setGlobalSuccess(
      isEdit
        ? "Usuario actualizado en el borrador. Pulsa Publicar para guardar en el servidor."
        : "Usuario guardado en el borrador. Pulsa Publicar para guardar en el servidor."
    );
    window.setTimeout(() => setGlobal(""), 5000);
  });

  const bindNombreApellidoLive = () => {
    const run = (inp, errId) => {
      if (!(inp instanceof HTMLInputElement)) return;
      const raw = inp.value;
      if (/\s/.test(raw)) {
        inp.value = raw.replace(/\s/g, "");
        showErr(errId, "No se permiten espacios.");
        window.setTimeout(() => {
          if (campatrackIsSingleTokenNamePart(inp.value)) showErr(errId, "");
        }, 400);
        return;
      }
      const t = inp.value.trim();
      if (t && !campatrackIsSingleTokenNamePart(t)) {
        showErr(errId, "Solo letras, una sola palabra.");
      } else if (t) {
        showErr(errId, "");
      }
    };
    el("usersNombre")?.addEventListener("input", () => {
      run(el("usersNombre"), "usersNombreErr");
      syncUsersModalPhotoUi();
    });
    el("usersApellido")?.addEventListener("input", () => run(el("usersApellido"), "usersApellidoErr"));
    el("usersUsuario")?.addEventListener("input", () => syncUsersModalPhotoUi());
  };
  bindNombreApellidoLive();

  applyFormModeUi();
  renderUsersList();
  window.campatrackRefreshUsersListIfVisible = () => {
    try {
      renderUsersList();
    } catch (_) {}
  };
  try {
    globalThis.__campatrackUsersAfterHydrate = () => {
      try {
        if (typeof window.campatrackRefreshUsersListIfVisible === "function") {
          window.campatrackRefreshUsersListIfVisible();
        }
      } catch (_) {}
    };
  } catch (_) {}
}

function escapeAuditoriaCell(v) {
  if (v === undefined || v === null) return "—";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  const cut = s.length > 240 ? `${s.slice(0, 240)}…` : s;
  return escapeHtml(cut);
}

function getAuditoriaRowsFilteredForUi() {
  const list = ensureAuditoriaDraftShape();
  const u = typeof getUser === "function" ? getUser() : null;
  const userTeamRaw = u?.teamId != null ? String(u.teamId).trim() : "";
  const userTeam = userTeamRaw ? resolveCampatrackTeamId(userTeamRaw) || userTeamRaw : "";
  let rows = list.filter((r) => {
    if (!userTeam) return false;
    return String(r.teamId ?? "").trim() === String(userTeam).trim();
  });
  const modF = String(document.getElementById("auditFilterModulo")?.value || "").trim();
  if (modF) rows = rows.filter((r) => String(r.modulo || "") === modF);
  const usrF = String(document.getElementById("auditFilterUsuario")?.value || "").trim().toLowerCase();
  if (usrF) rows = rows.filter((r) => String(r.usuario || "").toLowerCase().includes(usrF));
  const actF = String(document.getElementById("auditFilterAccion")?.value || "").trim();
  if (actF) rows = rows.filter((r) => String(r.accion || "") === actF);
  const d0 = String(document.getElementById("auditFilterFechaDesde")?.value || "").trim();
  const d1 = String(document.getElementById("auditFilterFechaHasta")?.value || "").trim();
  if (d0) {
    const t0 = new Date(`${d0}T00:00:00`).getTime();
    rows = rows.filter((r) => {
      const t = Date.parse(String(r.fecha || ""));
      return Number.isFinite(t) && t >= t0;
    });
  }
  if (d1) {
    const t1 = new Date(`${d1}T23:59:59.999`).getTime();
    rows = rows.filter((r) => {
      const t = Date.parse(String(r.fecha || ""));
      return Number.isFinite(t) && t <= t1;
    });
  }
  return rows;
}

function exportAuditoriaVisibleToXlsx() {
  const XLSX = typeof window !== "undefined" ? window.XLSX : null;
  const rows = getAuditoriaRowsFilteredForUi();
  if (!XLSX?.utils?.json_to_sheet) {
    void showAppDialog({
      message: "No se encontró la librería de Excel (SheetJS). Recarga la página e inténtalo de nuevo.",
      primaryText: "Entendido",
      showSecondary: false,
      primaryDanger: false
    });
    return;
  }
  const data = rows.map((r) => ({
    Fecha: r.fecha || "",
    Usuario: r.usuario || "",
    Equipo: r.teamId || "",
    Módulo: r.modulo || "",
    Acción: r.accion || "",
    Campo: r.campo || "",
    Descripción: r.descripcion || "",
    "Valor anterior":
      r.valorAnterior == null ? "" : typeof r.valorAnterior === "object" ? JSON.stringify(r.valorAnterior) : String(r.valorAnterior),
    "Valor nuevo":
      r.valorNuevo == null ? "" : typeof r.valorNuevo === "object" ? JSON.stringify(r.valorNuevo) : String(r.valorNuevo)
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ Fecha: "", Nota: "Sin filas para exportar" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Auditoria");
  const fname = `auditoria_${new Date().toISOString().slice(0, 10)}_${Date.now()}.xlsx`;
  XLSX.writeFile(wb, fname);
}

function rebuildAuditoriaTable() {
  const tbody = document.getElementById("auditTbody");
  const emptyEl = document.getElementById("auditEmpty");
  if (!tbody) return;
  const rows = getAuditoriaRowsFilteredForUi();
  if (!rows.length) {
    tbody.innerHTML = "";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("hidden");
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
    <td>${escapeHtml(String(r.fecha || "").replace("T", " ").slice(0, 19))}</td>
    <td>${escapeHtml(String(r.usuario || ""))}</td>
    <td>${escapeHtml(String(r.modulo || ""))}</td>
    <td>${escapeHtml(String(r.accion || ""))}</td>
    <td>${escapeHtml(String(r.campo || ""))}</td>
    <td>${escapeHtml(String(r.descripcion || ""))}</td>
    <td class="audit-col-json">${escapeAuditoriaCell(r.valorAnterior)}</td>
    <td class="audit-col-json">${escapeAuditoriaCell(r.valorNuevo)}</td>
  </tr>`
    )
    .join("");
}

function initAuditoriaModule() {
  const filM = document.getElementById("auditFilterModulo");
  const filU = document.getElementById("auditFilterUsuario");
  const filA = document.getElementById("auditFilterAccion");
  const filD0 = document.getElementById("auditFilterFechaDesde");
  const filD1 = document.getElementById("auditFilterFechaHasta");
  const btnApply = document.getElementById("auditFilterApplyBtn");
  const btnExport = document.getElementById("auditExportBtn");
  const re = () => {
    try {
      rebuildAuditoriaTable();
    } catch (e) {
      console.warn("rebuildAuditoriaTable", e);
    }
  };
  btnApply?.addEventListener("click", re);
  [filM, filU, filA, filD0, filD1].forEach((el) => el?.addEventListener("change", re));
  const debU = debounce(re, 280);
  filU?.addEventListener("input", debU);
  btnExport?.addEventListener("click", () => exportAuditoriaVisibleToXlsx());
  try {
    globalThis.__campatrackRebuildAuditoriaAfterHydrate = re;
  } catch (_) {}
}


function initCampatrackGithubSetupOverlay() {
  const ov = document.getElementById("campatrackGithubSetupOverlay");
  const form = document.getElementById("campatrackGithubSetupForm");
  const repoIn = document.getElementById("ghSetupRepo");
  const tokIn = document.getElementById("ghSetupToken");
  const err = document.getElementById("ghSetupError");
  if (!ov || !form || !(repoIn instanceof HTMLInputElement) || !(tokIn instanceof HTMLInputElement)) return;
  const defaultBranch = "main";
  const apply = () => {
    const need = campatrackIsLiteMode() && !hasClientGithubConfigComplete();
    ov.classList.toggle("hidden", !need);
    ov.setAttribute("aria-hidden", need ? "false" : "true");
    if (!need) {
      ov.setAttribute("hidden", "true");
    } else {
      ov.removeAttribute("hidden");
    }
    document.body.classList.toggle("campatrack-setup-active", need);
    const login = document.getElementById("loginScreen");
    const shell = document.getElementById("mainAppShell");
    if (need) {
      login?.classList.add("hidden");
      shell?.classList.add("hidden");
    }
    if (need) {
      const c = loadClientGithubConfig();
      if (c) {
        repoIn.value = String(c.repoInput || "").trim();
      }
      tokIn.value = "";
      err?.classList.add("hidden");
      err?.classList.remove("campatrack-setup-error--ok");
      window.setTimeout(() => repoIn.focus(), 50);
    }
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    err?.classList.add("hidden");
    err?.classList.remove("campatrack-setup-error--ok");
    const ac = new AbortController();
    const to = window.setTimeout(() => ac.abort(), 45000);
    try {
      const repoInput = String(repoIn.value || "").trim();
      const token = String(tokIn.value || "").trim();
      const branch = defaultBranch;
      if (!repoInput || !token) {
        if (err) {
          err.textContent = "Completa repositorio y token.";
          err.classList.remove("hidden");
        }
        return;
      }
      const parsed = parseGithubRepoInput(repoInput);
      if (!parsed) {
        if (err) {
          err.textContent = "No se pudo interpretar el repositorio. Usa URL de GitHub o owner/repo.";
          err.classList.remove("hidden");
        }
        return;
      }
      const chk = await validateClientGithubConnection(repoInput, token, branch, { signal: ac.signal });
      if (!chk.ok) {
        if (err) {
          err.textContent = chk.message || "No se pudo validar con GitHub.";
          err.classList.remove("hidden");
        }
        return;
      }
      try {
        saveClientGithubConfig({
          repoInput,
          owner: parsed.owner,
          repo: parsed.repo,
          branch,
          token
        });
      } catch (se) {
        console.error("[GitHub setup] No se pudo guardar en localStorage:", se);
        if (err) {
          err.textContent =
            "No se pudo guardar la configuración (¿navegación privada o almacenamiento bloqueado?). " +
            String(se?.message || "");
          err.classList.remove("hidden");
        }
        return;
      }
      if (!hasClientGithubConfigComplete()) {
        console.error("[GitHub setup] Config guardada pero hasClientGithubConfigComplete() sigue en false.", loadClientGithubConfig());
        if (err) {
          err.textContent = "Error interno: la configuración no se reconoció tras guardar. Recarga la página.";
          err.classList.remove("hidden");
        }
        return;
      }
      apply();
      campatrackGateOnGithubConfigured();
      bootstrapCampatrackAuthShell();
      const loginErr = document.getElementById("campatrackLoginError");
      if (loginErr) {
        loginErr.textContent = "Repositorio GitHub configurado. Ya puedes iniciar sesión.";
        loginErr.classList.add("campatrack-login-error--success");
        loginErr.classList.remove("hidden");
        window.setTimeout(() => {
          loginErr.classList.add("hidden");
          loginErr.classList.remove("campatrack-login-error--success");
          loginErr.textContent = "Credenciales incorrectas";
        }, 6500);
      }
      const uIn = document.getElementById("campatrackUser");
      if (uIn instanceof HTMLInputElement) window.setTimeout(() => uIn.focus(), 120);
      console.info("[GitHub setup] Configuración guardada; overlay cerrado.");
    } catch (ex) {
      console.error("[GitHub setup] Error inesperado:", ex);
      if (err) {
        err.textContent = String(ex?.message || "Error inesperado al validar.");
        err.classList.remove("hidden");
      }
    } finally {
      window.clearTimeout(to);
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  });
  apply();
}

function initConfiguracionModule() {
  const root = document.getElementById("configModule");
  if (!root) return;
  const repoIn = document.getElementById("cfgAppRepo");
  const tokIn = document.getElementById("cfgAppToken");
  const msg = document.getElementById("cfgAppMsg");
  const btnEdit = document.getElementById("cfgAppEditBtn");
  const btnSave = document.getElementById("cfgAppSaveBtn");
  if (!(repoIn instanceof HTMLInputElement) || !(tokIn instanceof HTMLInputElement) || !btnEdit || !btnSave) return;
  const defaultBranch = "main";
  let editing = false;
  const TOKEN_MASK = "---";
  const showMsg = (t, ok) => {
    if (!msg) return;
    msg.textContent = t || "";
    msg.classList.toggle("hidden", !t);
    msg.classList.toggle("users-global-error--success", !!ok);
    msg.classList.toggle("users-global-error", !ok);
  };
  const applyLockUi = () => {
    const c = loadClientGithubConfig();
    const hasTok = !!(c && String(c.token || "").trim());
    repoIn.readOnly = !editing;
    tokIn.readOnly = !editing;
    if (c) {
      repoIn.value = String(c.repoInput || "").trim();
    }
    if (!editing && hasTok) {
      tokIn.value = TOKEN_MASK;
      tokIn.setAttribute("data-masked", "1");
    } else {
      tokIn.removeAttribute("data-masked");
      if (editing) tokIn.value = "";
    }
    btnEdit.textContent = editing ? "Cancelar edición" : "Editar configuración";
  };
  btnEdit.addEventListener("click", () => {
    if (editing) {
      editing = false;
      applyLockUi();
      return;
    }
    editing = true;
    applyLockUi();
  });
  btnSave.addEventListener("click", async () => {
    showMsg("", false);
    const repoInput = String(repoIn.value || "").trim();
    const branch = defaultBranch;
    const prev = loadClientGithubConfig();
    let token = String(tokIn.value || "").trim();
    if (tokIn.getAttribute("data-masked") === "1") {
      showMsg("Pulsa «Editar configuración» para introducir un token.", false);
      return;
    }
    if (!token && prev && String(prev.token || "").trim()) {
      token = String(prev.token || "").trim();
    }
    if (!repoInput || !token) {
      showMsg("Repositorio y token son obligatorios.", false);
      return;
    }
    const parsed = parseGithubRepoInput(repoInput);
    if (!parsed) {
      showMsg("Repositorio inválido.", false);
      return;
    }
    const chk = await validateClientGithubConnection(repoInput, token, branch);
    if (!chk.ok) {
      showMsg(chk.message || "Error al validar.", false);
      return;
    }
    saveClientGithubConfig({ repoInput, owner: parsed.owner, repo: parsed.repo, branch, token });
    editing = false;
    applyLockUi();
    showMsg("Configuración guardada correctamente.", true);
    window.setTimeout(() => showMsg("", false), 4000);
  });
  window.campatrackConfigModuleOnOpen = () => {
    editing = false;
    applyLockUi();
    showMsg("", false);
  };
  applyLockUi();
}

function initCampatrackLogin() {
  const form = document.getElementById("campatrackLoginForm");
  const err = document.getElementById("campatrackLoginError");
  const passEl = document.getElementById("campatrackPass");
  const passToggle = document.getElementById("campatrackPassToggle");

  function resolveLoginSessionTeamId() {
    ensureCampatrackTeamsSeed();
    const ids = campatrackGetCanonTeamIds();
    return ids.length ? ids[0] : "";
  }

  passToggle?.addEventListener("click", () => {
    if (!(passEl instanceof HTMLInputElement)) return;
    const show = passEl.type === "password";
    passEl.type = show ? "text" : "password";
    passToggle.setAttribute("aria-pressed", show ? "true" : "false");
    passToggle.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
    const ico = passToggle.querySelector("i");
    if (ico) ico.className = show ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = String(document.getElementById("campatrackUser")?.value || "").trim();
    const p = String(document.getElementById("campatrackPass")?.value || "").trim();
    const selTeam = resolveLoginSessionTeamId();
    const submitBtn = form?.querySelector('button[type="submit"]');
    err?.classList.add("hidden");
    if (err) err.textContent = "Credenciales incorrectas";
    if (!selTeam) {
      if (err) {
        err.textContent = "No hay equipos definidos en el sistema.";
        err.classList.remove("hidden");
      }
      return;
    }
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    const finishOk = async (loggedInUser) => {
      err?.classList.add("hidden");
      const uOk =
        loggedInUser && String(loggedInUser.username || "").trim()
          ? loggedInUser
          : typeof getUser === "function"
            ? getUser()
            : null;
      campatrackPostLoginHydrationBusy = true;
      if (campatrackIsLiteMode()) campatrackGateBeginDataLoad();
      bootstrapCampatrackAuthShell();
      try {
        if (appActivateMainModule && isCampatrackAuthenticated() && campatrackGateIsReady()) {
          appActivateMainModule("dashboard");
        }
      } catch (_) {}
      await campatrackYieldToPaint();
      try {
        let preloadedBundle = null;
        if (uOk) {
          try {
            preloadedBundle = await afterLoginSuccess(uOk);
          } catch (e) {
            console.warn("Error cargando data; se continúa con bundle vacío:", e);
            if (campatrackIsLiteMode()) preloadedBundle = createEmptyCampatrackBundle();
          }
        }
        campatrackCompletePostLoginPipeline(
          preloadedBundle ||
            (campatrackIsLiteMode() ? createEmptyCampatrackBundle() : null)
        );
      } catch (e) {
        console.error("Error cargando data:", e);
        try {
          sessionStorage.setItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH, "1");
        } catch (_) {}
        clearDashboardSkeletonMode();
        if (typeof renderDashboardSinData === "function") renderDashboardSinData();
      } finally {
        campatrackPostLoginHydrationBusy = false;
      }
    };
    try {
      if (u === SYSTEM_ADMIN.usuario && p === SYSTEM_ADMIN.clave) {
        const sessionUser = buildCampatrackSystemAdminSession(selTeam);
        if (campatrackIsLiteMode()) {
          try {
            campatrackLiteLoginBundleCache = await fetchCampatrackLiteBundleFromRemote();
          } catch (e) {
            console.error(e);
            campatrackLiteLoginBundleCache = null;
          }
        }
        campatrackApplyLoginSuccessToStorage(sessionUser);
        await finishOk(sessionUser);
        return;
      }
      if (campatrackIsLiteMode()) {
        let bundle;
        try {
          bundle = await fetchCampatrackLiteBundleFromRemote();
        } catch (e) {
          console.warn("[CampaTrack lite] Error cargando JSON remoto; se usará bundle vacío.", e);
          bundle = createEmptyCampatrackBundle();
        }
        const usersDb = Array.isArray(bundle.campatrack_users_db) ? bundle.campatrack_users_db : [];
        const demoU = String(window.CAMPATRACK_LITE_DEMO_USER ?? "demo").trim();
        const demoP = String(window.CAMPATRACK_LITE_DEMO_PASS ?? "demo");
        if (u === demoU && p === demoP) {
          campatrackLiteLoginBundleCache = bundle;
          const sessionUser = buildCampatrackSystemAdminSession(selTeam);
          campatrackApplyLoginSuccessToStorage(sessionUser);
          await finishOk(sessionUser);
          return;
        }
        const hashTry = await campatrackHashPassword(u, p);
        for (const rec of usersDb) {
          if (!rec || typeof rec !== "object") continue;
          if (String(rec.estado || "").toLowerCase() === "inactivo") continue;
          const loginName = String(rec.usuario || "").trim().toLowerCase();
          if (!loginName || loginName !== u.toLowerCase()) continue;
          const stored = String(rec.clave || "").trim();
          const okPass =
            stored &&
            (stored === p ||
              stored === hashTry ||
              String(stored).toLowerCase() === String(hashTry).toLowerCase());
          if (!okPass) continue;
          campatrackLiteLoginBundleCache = bundle;
          const sessionUser = buildCampatrackLocalSessionFromRecord(rec, null);
          campatrackApplyLoginSuccessToStorage(sessionUser);
          await finishOk(sessionUser);
          return;
        }
        if (err) {
          err.textContent = "Usuario o contraseña incorrectos.";
          err.classList.remove("hidden");
        }
        return;
      }
      const res = await fetch(API_LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p, teamId: selTeam }),
      });
      const body =
        res.headers.get("content-type")?.includes("application/json")
          ? await res.json()
          : null;
      if (!res.ok || !body?.success || !body.user) {
        const msg =
          typeof body?.message === "string" && body.message.trim()
            ? body.message.trim()
            : res.status === 403
              ? "No tienes acceso a este equipo"
              : "Credenciales incorrectas";
        if (err) {
          err.textContent = msg;
          err.classList.remove("hidden");
        }
        return;
      }
      const apiUser = { ...body.user };
      if (apiUser.id == null || String(apiUser.id).trim() === "") {
        apiUser.id = String(apiUser.username ?? "").trim();
      }
      if (typeof apiUser.nombre === "string") apiUser.nombre = apiUser.nombre.trim();
      if (typeof apiUser.apellido === "string") apiUser.apellido = apiUser.apellido.trim();
      if (typeof apiUser.cargo === "string") apiUser.cargo = apiUser.cargo.trim();
      if (typeof apiUser.foto === "string") {
        apiUser.foto = normalizeCampatrackUserFotoValue(apiUser.foto);
      } else {
        delete apiUser.foto;
      }
      if (Array.isArray(apiUser.modulos) && apiUser.modulos.length > 0) {
        apiUser.permisosModulos = normalizeCampatrackUserModulos(apiUser.modulos);
        apiUser.campatrackLocalProfile = true;
        delete apiUser.modulos;
      }
      let membership = Array.isArray(apiUser.teams)
        ? [
            ...new Set(
              apiUser.teams.map((x) => String(x || "").trim()).filter(campatrackIsCanonTeamId)
            )
          ]
        : [];
      if (!membership.length)
        membership = campatrackNormalizeTeamsFromDraftRecord({ teamId: apiUser.teamId });
      apiUser.teams = membership;
      const tid = resolveCampatrackTeamId(String(apiUser.teamId || "").trim()) || String(apiUser.teamId || "").trim();
      apiUser.teamId = tid;
      if (!campatrackIsCanonTeamId(apiUser.teamId)) {
        if (err) {
          err.textContent = "Sesión sin equipo válido.";
          err.classList.remove("hidden");
        }
        return;
      }
      apiUser.teamNombre = resolveCampatrackTeamNombre(apiUser.teamId);
      if (body.user.permissions && typeof body.user.permissions === "object" && !Array.isArray(body.user.permissions)) {
        const q = body.user.permissions;
        apiUser.permissions = {
          canExport: q.canExport === true,
          canImport: q.canImport === true,
          canReset: q.canReset === true
        };
      }
      campatrackApplyLoginSuccessToStorage(apiUser);
      await finishOk(apiUser);
      return;
    } catch (fetchErr) {
      console.warn("Login API", fetchErr);
      err?.classList.remove("hidden");
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  });
}

function initTabs() {
  const tabPlanning = document.getElementById("tabPlanning");
  const tabBitacora = document.getElementById("tabBitacora");
  const tabData = document.getElementById("tabData");
  const tabRelaciones = document.getElementById("tabRelaciones");
  const tabMedidas = document.getElementById("tabMedidas");
  const tabDashboard = document.getElementById("tabDashboard");
  const tabCentroCostos = document.getElementById("tabCentroCostos");
  const tabReporteAnuncios = document.getElementById("tabReporteAnuncios");
  const tabUsuarios = document.getElementById("tabUsuarios");
  const tabAuditoria = document.getElementById("tabAuditoria");
  const tabConfiguracion = document.getElementById("tabConfiguracion");
  const planningModule = document.getElementById("planningModule");
  const bitacoraModule = document.getElementById("bitacoraModule");
  const dataModule = document.getElementById("dataModule");
  const relacionesModule = document.getElementById("relacionesModule");
  const medidasModule = document.getElementById("medidasModule");
  const dashboardModule = document.getElementById("dashboardModule");
  const costCenterModule = document.getElementById("costCenterModule");
  const adsReportModule = document.getElementById("adsReportModule");
  const usersModule = document.getElementById("usersModule");
  const auditoriaModule = document.getElementById("auditoriaModule");
  const configModule = document.getElementById("configModule");
  if (
    !tabPlanning ||
    !tabBitacora ||
    !tabData ||
    !tabRelaciones ||
    !tabMedidas ||
    !tabDashboard ||
    !tabCentroCostos ||
    !tabReporteAnuncios ||
    !tabUsuarios ||
    !tabAuditoria ||
    !tabConfiguracion ||
    !planningModule ||
    !bitacoraModule ||
    !dataModule ||
    !relacionesModule ||
    !medidasModule ||
    !dashboardModule ||
    !costCenterModule ||
    !adsReportModule ||
    !usersModule ||
    !auditoriaModule ||
    !configModule
  )
    return;

  const applyRoleVisibility = () => {
    const role = getCampatrackRole();
    const visibility = getCampatrackModuleVisibilitySet();
    const roleTabs = getAllowedCampatrackModules(role);
    const canAccessPlanning = visibility.has("planning");
    const canAccessBitacora = visibility.has("bitacora");
    const canAccessData = visibility.has("data");
    const canAccessRelaciones = visibility.has("relaciones");
    const canAccessMedidas = visibility.has("medidas");
    const canAccessDashboard = campatrackHasDashboardAccess();
    const canAccessAdsReport = visibility.has("ads-report");
    const canAccessCostos = visibility.has("costos");
    const canAccessUsuarios = roleTabs.has("usuarios");
    const canAccessAuditoria = visibility.has("auditoria");
    const canAccessConfig = visibility.has("configuracion");
    tabPlanning.classList.toggle("hidden", !canAccessPlanning);
    tabBitacora.classList.toggle("hidden", !canAccessBitacora);
    tabData.classList.toggle("hidden", !canAccessData);
    tabRelaciones.classList.toggle("hidden", !canAccessRelaciones);
    tabMedidas.classList.toggle("hidden", !canAccessMedidas);
    tabDashboard.classList.toggle("hidden", !canAccessDashboard);
    tabCentroCostos.classList.toggle("hidden", !canAccessCostos);
    tabReporteAnuncios.classList.toggle("hidden", !canAccessAdsReport);
    tabUsuarios.classList.toggle("hidden", !canAccessUsuarios);
    tabAuditoria.classList.toggle("hidden", !canAccessAuditoria);
    tabConfiguracion.classList.toggle("hidden", !canAccessConfig);
    mountCampatrackSidebarFooterTools();
    if (dashboardUiInicializado) {
      try {
        applyDashboardMainSubtabsNavVisibility();
        syncDashboardActiveSubtabWithPermissions();
        applyDashboardShellVisibilityForSubtab();
      } catch (e2) {
        console.warn("dashboard subtab chrome", e2);
      }
    }
  };

  window.campatrackRefreshModuleNav = () => {
    try {
      applyRoleVisibility();
    } catch (e) {
      console.warn("campatrackRefreshModuleNav", e);
    }
  };

  const setActive = (which) => {
    console.log("Relaciones actuales (antes cambio módulo):", appState.dataDraft.relaciones);
    applyRoleVisibility();
    const safeModule = isCampatrackModuleAllowed(which) ? which : "dashboard";
    const isPlanning = safeModule === "planning";
    const isBitacora = safeModule === "bitacora";
    const isData = safeModule === "data";
    const isAuditoria = safeModule === "auditoria";
    const isCostos = safeModule === "costos";
    const isConfig = safeModule === "configuracion";
    planningModule.classList.toggle("hidden", !isPlanning);
    bitacoraModule.classList.toggle("hidden", !isBitacora);
    dataModule.classList.toggle("hidden", !isData);
    relacionesModule.classList.toggle("hidden", safeModule !== "relaciones");
    medidasModule.classList.toggle("hidden", safeModule !== "medidas");
    dashboardModule.classList.toggle("hidden", safeModule !== "dashboard");
    try {
      if (typeof applyDashboardMainSubtabsNavVisibility === "function") applyDashboardMainSubtabsNavVisibility();
    } catch (e) {
      console.warn("applyDashboardMainSubtabsNavVisibility", e);
    }
    try {
      if (typeof applyRelacionesHeaderSubtabsNavVisibility === "function") applyRelacionesHeaderSubtabsNavVisibility();
    } catch (e) {
      console.warn("applyRelacionesHeaderSubtabsNavVisibility", e);
    }
    costCenterModule.classList.toggle("hidden", !isCostos);
    adsReportModule.classList.toggle("hidden", safeModule !== "ads-report");
    usersModule.classList.toggle("hidden", safeModule !== "usuarios");
    auditoriaModule.classList.toggle("hidden", !isAuditoria);
    configModule.classList.toggle("hidden", !isConfig);
    tabPlanning.classList.toggle("tab-active", isPlanning);
    tabBitacora.classList.toggle("tab-active", isBitacora);
    tabData.classList.toggle("tab-active", isData);
    tabRelaciones.classList.toggle("tab-active", safeModule === "relaciones");
    tabMedidas.classList.toggle("tab-active", safeModule === "medidas");
    tabDashboard.classList.toggle("tab-active", safeModule === "dashboard");
    tabCentroCostos.classList.toggle("tab-active", isCostos);
    tabReporteAnuncios.classList.toggle("tab-active", safeModule === "ads-report");
    tabUsuarios.classList.toggle("tab-active", safeModule === "usuarios");
    tabAuditoria.classList.toggle("tab-active", isAuditoria);
    tabConfiguracion.classList.toggle("tab-active", isConfig);
    if (typeof updateAppTopbarForModule === "function") {
      updateAppTopbarForModule(safeModule);
    }
    if (safeModule !== "dashboard") {
      document.getElementById("dashCrmActualizadoHeader")?.classList.add("hidden");
      refreshCampatrackTeamHeader();
    } else if (typeof syncDashboardCrmHeaderBadges === "function") {
      syncDashboardCrmHeaderBadges();
    }
    if (isBitacora) {
      if (typeof refreshBitacoraFormProgramaOptions === "function") refreshBitacoraFormProgramaOptions();
      if (typeof renderBitacoraTable === "function") renderBitacoraTable();
    }
    if (safeModule === "relaciones") {
      refreshRelacionesModuleView();
    }
    if (safeModule === "dashboard") {
      if (campatrackPostLoginHydrationBusy) {
        renderDashboardSkeleton();
      } else {
        renderDashboard();
        scheduleDashEndingSoonAlert();
        let skipRedundantBackendFetch = false;
        try {
          if (sessionStorage.getItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH) === "1") {
            sessionStorage.removeItem(SS_SKIP_NEXT_DASHBOARD_BACKEND_FETCH);
            skipRedundantBackendFetch = true;
          }
        } catch (_) {
          /* ignore */
        }
        if (!skipRedundantBackendFetch) {
          void cargarDataDesdeBackend();
        }
      }
    } else if (dashEndingSoonAlertTimer != null) {
      clearTimeout(dashEndingSoonAlertTimer);
      dashEndingSoonAlertTimer = null;
    }
    if (safeModule === "ads-report") {
      refreshAdsReportFilterOptions();
      renderAdsReportModule();
    }
    if (safeModule === "usuarios" && typeof window.campatrackUsersOnOpen === "function") {
      try {
        window.campatrackUsersOnOpen();
      } catch (e) {
        console.warn("campatrackUsersOnOpen", e);
      }
    }
    if (isConfig && typeof window.campatrackConfigModuleOnOpen === "function") {
      try {
        window.campatrackConfigModuleOnOpen();
      } catch (e) {
        console.warn("campatrackConfigModuleOnOpen", e);
      }
    }
    if (isAuditoria && typeof rebuildAuditoriaTable === "function") {
      try {
        rebuildAuditoriaTable();
      } catch (e) {
        console.warn("rebuildAuditoriaTable", e);
      }
    }
    if (isCostos) {
      try {
        syncConsumoFromRecords();
        refreshCentroCostosUI();
      } catch (e) {
        console.warn("Centro de costos: refresco desde Planning", e);
      }
    }
    if (isData) {
      actualizarFiltrosCache();
      refreshFechaFiltersUI();
      renderTablaData();
      renderTablaAnuncios();
      renderTablaCampañas();
    }
    console.log("Relaciones actuales (después cambio módulo):", appState.dataDraft.relaciones);
  };

  tabPlanning.addEventListener("click", () => setActive("planning"));
  tabBitacora.addEventListener("click", () => setActive("bitacora"));
  tabData.addEventListener("click", () => setActive("data"));
  tabRelaciones.addEventListener("click", () => setActive("relaciones"));
  tabMedidas.addEventListener("click", () => setActive("medidas"));
  tabDashboard.addEventListener("click", () => setActive("dashboard"));
  tabCentroCostos.addEventListener("click", () => setActive("costos"));
  tabReporteAnuncios.addEventListener("click", () => setActive("ads-report"));
  tabUsuarios.addEventListener("click", () => setActive("usuarios"));
  tabAuditoria.addEventListener("click", () => setActive("auditoria"));
  tabConfiguracion.addEventListener("click", () => setActive("configuracion"));

  appActivateMainModule = setActive;
  applyRoleVisibility();
  if (isCampatrackAuthenticated()) {
    setActive("dashboard");
  } else {
    setActive("dashboard");
  }
}

/** Sidebar colapsable: siempre inicia contraído; solo cambia con clic (sin persistencia). */
function initCampatrackSidebarToggle() {
  const shell = document.getElementById("mainAppShell");
  const btn = document.getElementById("campatrackSidebarToggle");
  if (!shell || !btn) return;
  const apply = (collapsed) => {
    shell.classList.toggle("campatrack-sidebar-collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.title = collapsed ? "Expandir menú" : "Colapsar menú";
  };
  apply(true);
  btn.addEventListener("click", () => {
    apply(!shell.classList.contains("campatrack-sidebar-collapsed"));
  });
}

/** Tooltips al hover solo con sidebar colapsado (texto del <span> de cada ítem). */
function initCampatrackSidebarCollapsedTooltips() {
  const shell = document.getElementById("mainAppShell");
  const sidebar = document.querySelector(".campatrack-sidebar");
  if (!shell || !sidebar) return;

  let tip = document.getElementById("campatrackSidebarTooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "campatrackSidebarTooltip";
    tip.className = "campatrack-sidebar-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  let showTimer = null;
  let hideTimer = null;
  let pendingEl = null;

  const isCollapsed = () => shell.classList.contains("campatrack-sidebar-collapsed");

  const hideNow = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    pendingEl = null;
    tip.classList.remove("campatrack-sidebar-tooltip--visible");
    tip.hidden = true;
    tip.setAttribute("aria-hidden", "true");
    tip.textContent = "";
  };

  const scheduleHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hideNow();
    }, 80);
  };

  const getItemLabel = (el) => {
    const span = el.querySelector(":scope > span");
    const t = span?.textContent?.trim();
    if (t) return t;
    return String(el.getAttribute("aria-label") || "").trim();
  };

  const showForEl = (el) => {
    if (!isCollapsed()) return;
    const label = getItemLabel(el);
    if (!label) return;
    tip.textContent = label;
    tip.hidden = false;
    tip.setAttribute("aria-hidden", "false");
    tip.style.visibility = "hidden";
    tip.classList.remove("campatrack-sidebar-tooltip--visible");
    const rect = el.getBoundingClientRect();
    const gap = 10;
    const edge = 8;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.right + gap;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + tw > vw - edge) left = Math.max(edge, vw - tw - edge);
    if (left < edge) left = edge;
    let top = rect.top + (rect.height - th) / 2;
    if (top < edge) top = edge;
    if (top + th > vh - edge) top = Math.max(edge, vh - th - edge);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.visibility = "visible";
    requestAnimationFrame(() => {
      if (!isCollapsed() || tip.textContent !== label) return;
      tip.classList.add("campatrack-sidebar-tooltip--visible");
    });
  };

  sidebar.addEventListener(
    "mouseover",
    (e) => {
      const el = e.target.closest(".campatrack-side-nav-item, .campatrack-side-tool-btn");
      if (!el || !sidebar.contains(el)) return;
      if (el.classList.contains("hidden")) return;
      if (!isCollapsed()) return;

      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (showTimer) clearTimeout(showTimer);
      pendingEl = el;
      showTimer = setTimeout(() => {
        showTimer = null;
        if (!isCollapsed() || pendingEl !== el) return;
        showForEl(el);
      }, 160);
    },
    true
  );

  sidebar.addEventListener(
    "mouseout",
    (e) => {
      const rel = e.relatedTarget;
      if (rel instanceof Node && sidebar.contains(rel)) return;
      pendingEl = null;
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      scheduleHide();
    },
    true
  );

  window.addEventListener(
    "scroll",
    () => {
      if (tip.classList.contains("campatrack-sidebar-tooltip--visible")) hideNow();
    },
    true
  );
  window.addEventListener("resize", hideNow);

  try {
    const mo = new MutationObserver(() => {
      if (!isCollapsed()) hideNow();
    });
    mo.observe(shell, { attributes: true, attributeFilter: ["class"] });
  } catch (_) {
    /* ignore */
  }
}

/** Inicializa CRM sin tumbar login ni bootstrap si falta DOM o hay error puntual. */
function campatrackSafeInitCrmModules() {
  try {
    initCrmImportModule();
  } catch (e) {
    console.warn("[CampaTrack] CRM Import no se pudo inicializar:", e);
  }
  try {
    initCrmRelacionesModule();
  } catch (e) {
    console.warn("[CampaTrack] Relación CRM no se pudo inicializar:", e);
  }
}

function campatrackBootDeferredModules() {
  if (typeof campatrackGateIsReady === "function" && campatrackIsLiteMode() && !campatrackGateIsReady()) {
    return;
  }
  hydratarDesdeLocalStorage();
  ensureCampatrackTeamsSeed();
  initTabs();
  initCampatrackAppHeader();
  initAppThemeToggle();
  initCampatrackSidebarToggle();
  initCampatrackSidebarCollapsedTooltips();
  initBitacoraModule();
  initExportImportDatos();
  initCampaignPreviewBudgetEdit();
  initDataSubTabs();
  initDataLoadModal();
  initDataErrorModal();
  initDataFilters();
  initRelacionesModule();
  campatrackSafeInitCrmModules();
  initMedidasModule();
  initDashboardModule();
  initAdsReportModule();
  initUsuariosModule();
  initConfiguracionModule();
  initAuditoriaModule();
  initCentroCostosModule();
  initCentroCostosTabs();
  limpiarFiltrosUiDataGeneral();
  actualizarFiltrosCache();
  refreshFechaFiltersUI();
  renderTablaData();
  renderTablaAnuncios();
  renderTablaCampañas();
  refreshAdsReportFilterOptions();
  renderAdsReportModule();
  if (Array.isArray(modeloAnalitico) && modeloAnalitico.length > 0) {
    renderModeloTabla();
    refreshSegmentadoresValues();
    refreshMedidasFiltros();
  } else {
    withDraftNotificationsSuppressed(() => REGENERAR_MODELO());
  }
  withDraftNotificationsSuppressed(() => restoreOrResetPublishDraftAfterBoot());
  initDraftPublishToolbar();
  if (!document.getElementById("dashboardModule")?.classList.contains("hidden")) {
    withDraftNotificationsSuppressed(() => renderDashboard());
  }
}

async function campatrackResumeLiteSessionIfNeeded() {
  if (!campatrackIsLiteMode() || !hasClientGithubConfigComplete() || !isCampatrackAuthenticated()) return;
  campatrackGateBeginDataLoad();
  bootstrapCampatrackAuthShell();
  try {
    const u = typeof getUser === "function" ? getUser() : null;
    const bundle = u ? await afterLoginSuccess(u) : null;
    campatrackCompletePostLoginPipeline(bundle);
  } catch (e) {
    console.warn("[CampaTrack] Reanudar sesión lite con bundle vacío:", e);
    campatrackCompletePostLoginPipeline(createEmptyCampatrackBundle());
  }
}

initCampatrackGithubSetupOverlay();
campatrackGateInit();
campatrackGateRegisterModuleBoot(campatrackBootDeferredModules);
bootstrapCampatrackAuthShell();
initCampatrackLogin();
if (!campatrackIsLiteMode()) {
  campatrackBootDeferredModules();
} else {
  void campatrackResumeLiteSessionIfNeeded();
}
