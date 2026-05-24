/**
 * Estado central: planning, data general, relaciones, centros de costo, bitácora, modelo y usuarios
 * viven en `dataDraft`; publicación envía el bundle a la API (sin depender de appMemoryKV para esas piezas).
 */

import { hasClientGithubConfigComplete } from "./campatrack-github-config.js";
import { createEmptyCampatrackBundle, loadModularBundleFromGithub } from "./campatrack-data-store.js";
import { reconcilePlanningRecordIdSeq } from "./campatrack-planning-ids.js";
import { crmDebugEnabled, crmDebugLog, crmDebugBundleMeta, crmDebugLeadsCount } from "./campatrack-crm-debug.js";

export const appState = {
  dataOriginal: {},
  dataDraft: {},
  pendingChanges: 0
};

/** Solo depuración: misma instancia que importan Planning/Data/Relaciones (`./app-state.js`). */
if (typeof window !== "undefined") {
  window.appState = appState;
}

function apiOrigin() {
  if (typeof window !== "undefined" && window.CAMPATRACK_API_ORIGIN) {
    return String(window.CAMPATRACK_API_ORIGIN).replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

/** Alineado con `campatrackIsLiteMode` en `_app.impl.js` (modo demo Vercel / JSON remoto). */
function campatrackAppIsLiteFromWindow() {
  if (typeof window === "undefined") return false;
  const mode = String(window.CAMPATRACK_APP_MODE || "full").trim().toLowerCase();
  if (mode === "lite" || mode === "demo") return true;
  return window.CAMPATRACK_USE_REMOTE_JSON === true;
}

/** Garantiza `{ records: [], recordIdSeq: 1 }` en `dataDraft.planning`. */
export function ensurePlanningDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  let p = appState.dataDraft.planning;
  if (!p || typeof p !== "object") {
    p = { records: [], recordIdSeq: 1 };
    appState.dataDraft.planning = p;
  }
  if (!Array.isArray(p.records)) p.records = [];
  if (!Number.isFinite(Number(p.recordIdSeq)) || Number(p.recordIdSeq) < 1) p.recordIdSeq = 1;
  return p;
}

/** Filas DATA → General (cada fila con `teamId` para filtrar por equipo de sesión); misma idea que `planning.records`. */
export function ensureDataGeneralDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.data_general)) appState.dataDraft.data_general = [];
  return appState.dataDraft.data_general;
}

export function ensureRelacionesDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.relaciones)) appState.dataDraft.relaciones = [];
  return appState.dataDraft.relaciones;
}

export function ensureRelacionesCrmDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.relaciones_crm)) appState.dataDraft.relaciones_crm = [];
  return appState.dataDraft.relaciones_crm;
}

/** Relación DATA ↔ Planning (motor Plataforma / gasto / modelo). */
export function isRelacionPlataformaRow(rel) {
  if (!rel || typeof rel !== "object") return false;
  return !!String(rel.idCampania ?? "").trim();
}

/** Relación CRM ↔ Planning (motor Comercial CRM). */
export function isRelacionCrmRow(rel) {
  if (!rel || typeof rel !== "object") return false;
  const crmKey = String(rel.crmKey ?? "").trim();
  const idCampania = String(rel.idCampania ?? "").trim();
  return !!crmKey && !idCampania;
}

/**
 * Aísla canales: en `relaciones` solo DATA; filas CRM erróneas pasan a `relaciones_crm`.
 * @returns {number} filas reubicadas desde relaciones → relaciones_crm
 */
export function sanitizeRelacionesDraftChannels() {
  const dr = ensureRelacionesDraftShape();
  const drCrm = ensureRelacionesCrmDraftShape();
  const nextPlat = [];
  let moved = 0;
  for (const r of dr) {
    if (!r || typeof r !== "object") continue;
    if (isRelacionCrmRow(r)) {
      const planningKey = String(r.planningKey || "").trim();
      const crmKey = String(r.crmKey || "").trim();
      if (planningKey && crmKey) {
        const exists = drCrm.some(
          (x) =>
            String(x.planningKey || "").trim() === planningKey &&
            String(x.crmKey || "").trim() === crmKey
        );
        if (!exists) {
          drCrm.push({
            planningKey,
            crmKey,
            nombre: String(r.nombre || crmKey).trim() || crmKey,
            fechaRelacion:
              String(r.fechaRelacion || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
            estado: String(r.estado || "activa").toLowerCase() === "inactivo" ? "inactiva" : "activa"
          });
        }
        moved++;
      }
      continue;
    }
    if (isRelacionPlataformaRow(r)) nextPlat.push(r);
  }
  if (moved > 0 || nextPlat.length !== dr.length) {
    dr.length = 0;
    nextPlat.forEach((x) => dr.push(x));
  }
  return moved;
}

export function ensureCrmLeadsDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.crm_leads)) appState.dataDraft.crm_leads = [];
  return appState.dataDraft.crm_leads;
}

/** Usuarios CampaTrack (lista en `dataDraft`, misma clave que el bundle API `campatrack_users_db`). */
export function ensureCampatrackUsersDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.campatrack_users_db)) appState.dataDraft.campatrack_users_db = [];
  return appState.dataDraft.campatrack_users_db;
}

/** Restaura usuarios y auditoría desde un bundle API/GitHub (misma fuente de verdad que relaciones). */
export function hydrateCampatrackUsersAndAuditoriaFromBundle(bundle) {
  if (bundle == null || typeof bundle !== "object" || Array.isArray(bundle)) return;
  ensureCampatrackUsersDraftShape();
  if (Array.isArray(bundle.campatrack_users_db)) {
    appState.dataDraft.campatrack_users_db = bundle.campatrack_users_db.map((u) =>
      u && typeof u === "object" ? { ...u } : u
    );
  } else if (Object.prototype.hasOwnProperty.call(bundle, "campatrack_users_db")) {
    appState.dataDraft.campatrack_users_db = [];
  }
  ensureAuditoriaDraftShape();
  if (Array.isArray(bundle.auditoria)) {
    appState.dataDraft.auditoria = bundle.auditoria.map((x) =>
      x && typeof x === "object" ? { ...x } : x
    );
  } else if (Object.prototype.hasOwnProperty.call(bundle, "auditoria")) {
    appState.dataDraft.auditoria = [];
  }
}

/** Historial de auditoría (planning / data); persiste en el bundle API bajo `auditoria`. */
export function ensureAuditoriaDraftShape() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  if (!Array.isArray(appState.dataDraft.auditoria)) appState.dataDraft.auditoria = [];
  return appState.dataDraft.auditoria;
}

export function getPlanningRecordIdSeq() {
  return ensurePlanningDraftShape().recordIdSeq;
}

export function setPlanningRecordIdSeq(n) {
  const p = ensurePlanningDraftShape();
  p.recordIdSeq = Math.max(1, Math.round(Number(n)) || 1);
}

export function bumpAppStatePendingChanges() {
  appState.pendingChanges += 1;
}

export function resetAppStatePendingChanges() {
  appState.pendingChanges = 0;
}

function normalizePlanningSliceFromBundle(planningData) {
  if (!planningData || typeof planningData !== "object") return { records: [], recordIdSeq: 1 };
  if (Array.isArray(planningData)) return { records: planningData.slice(), recordIdSeq: 1 };
  const recs = Array.isArray(planningData.records) ? planningData.records : [];
  const seq = Number.isFinite(Number(planningData.recordIdSeq))
    ? Math.max(1, Math.round(Number(planningData.recordIdSeq)))
    : 1;
  return { records: recs, recordIdSeq: reconcilePlanningRecordIdSeq(recs, seq) };
}

/**
 * Rellena `dataOriginal` / `dataDraft` y planning / data_general / relaciones desde un bundle (p. ej. GET /api/data).
 * Tras esto, `_app.impl.js` sincroniza planning, centros de costo, bitácora, modelo y usuarios desde `dataDraft` vía hooks globales.
 *
 * Para no pisar borradores locales hasta publicar/descartar, `cargarDataDesdeBackend` omita esta función
 * mientras hay cambios pendientes (`appPendingPublishCount`).
 */
export function hydrateAppStateDraftFromApiBundle(bundle) {
  if (bundle == null || typeof bundle !== "object" || Array.isArray(bundle)) return;
  crmDebugBundleMeta(bundle, "hydrate (entrada hydrateAppStateDraftFromApiBundle)");
  const draftCrmAntes = Array.isArray(appState.dataDraft?.crm_leads) ? appState.dataDraft.crm_leads.length : 0;
  const cloneOrig =
    typeof structuredClone === "function" ? structuredClone(bundle) : JSON.parse(JSON.stringify(bundle));
  const cloneDraft =
    typeof structuredClone === "function" ? structuredClone(bundle) : JSON.parse(JSON.stringify(bundle));
  appState.dataOriginal = cloneOrig;
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") appState.dataDraft = {};
  for (const key of Object.keys(cloneDraft)) {
    if (
      key === "planning_data" ||
      key === "planning" ||
      key === "data_general" ||
      key === "relaciones" ||
      key === "crm_leads" ||
      key === "campatrack_users_db" ||
      key === "auditoria"
    ) {
      continue;
    }
    appState.dataDraft[key] = cloneDraft[key];
  }
  const slice = normalizePlanningSliceFromBundle(bundle.planning_data ?? bundle.planning);
  const p = ensurePlanningDraftShape();
  p.records.length = 0;
  slice.records.forEach((r) => p.records.push(r && typeof r === "object" ? { ...r } : r));
  setPlanningRecordIdSeq(slice.recordIdSeq);
  try {
    if (typeof globalThis.__campatrackSyncPlanningAfterHydrate === "function") {
      globalThis.__campatrackSyncPlanningAfterHydrate();
    }
  } catch (_) {
    /* ignore */
  }
  ensureDataGeneralDraftShape();
  try {
    if (typeof globalThis.__campatrackHydrateDataGeneralFromBundle === "function") {
      globalThis.__campatrackHydrateDataGeneralFromBundle(bundle);
    }
  } catch (_) {
    /* ignore */
  }
  ensureRelacionesDraftShape();
  let relaciones = bundle.relaciones;

  if (typeof relaciones === "string") {
    try {
      relaciones = JSON.parse(relaciones);
    } catch (e) {
      console.error("Error parseando relaciones:", e);
      relaciones = [];
    }
  }

  if (Array.isArray(relaciones)) {
    appState.dataDraft.relaciones = relaciones;
  } else {
    appState.dataDraft.relaciones = [];
  }

  ensureRelacionesCrmDraftShape();
  let relacionesCrm = bundle.relaciones_crm;
  if (typeof relacionesCrm === "string") {
    try {
      relacionesCrm = JSON.parse(relacionesCrm);
    } catch {
      relacionesCrm = [];
    }
  }
  appState.dataDraft.relaciones_crm = Array.isArray(relacionesCrm) ? relacionesCrm : [];
  sanitizeRelacionesDraftChannels();

  ensureCrmLeadsDraftShape();
  crmDebugLeadsCount("hydrate (pre hook crm_leads)", {
    origen: "hydrateAppStateDraftFromApiBundle",
    draft_crm_leads_antes: draftCrmAntes,
    bundle_tiene_clave_crm_leads: Object.prototype.hasOwnProperty.call(bundle, "crm_leads"),
    bundle_crm_leads_count: Array.isArray(bundle.crm_leads)
      ? bundle.crm_leads.length
      : bundle.crm_leads == null
        ? null
        : typeof bundle.crm_leads
  });

  hydrateCampatrackUsersAndAuditoriaFromBundle(bundle);

  console.log("Relaciones después de hydrate:", appState.dataDraft.relaciones);
  try {
    if (typeof globalThis.__campatrackRebuildRelacionesTable === "function") {
      globalThis.__campatrackRebuildRelacionesTable();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackHydrateCrmFromBundle === "function") {
      globalThis.__campatrackHydrateCrmFromBundle(bundle);
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackSyncRelacionesCrmFromDraft === "function") {
      globalThis.__campatrackSyncRelacionesCrmFromDraft();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackSyncCcBitacoraModeloAfterHydrate === "function") {
      globalThis.__campatrackSyncCcBitacoraModeloAfterHydrate();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackRenderBitacoraAfterHydrate === "function") {
      globalThis.__campatrackRenderBitacoraAfterHydrate();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackUsersAfterHydrate === "function") {
      globalThis.__campatrackUsersAfterHydrate();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof globalThis.__campatrackRebuildAuditoriaAfterHydrate === "function") {
      globalThis.__campatrackRebuildAuditoriaAfterHydrate();
    }
  } catch (_) {
    /* ignore */
  }
  if (crmDebugEnabled()) {
    crmDebugLeadsCount("hydrate (fin hydrateAppStateDraftFromApiBundle)", {
      origen: "hydrateAppStateDraftFromApiBundle",
      draft_crm_leads: appState.dataDraft.crm_leads?.length ?? 0
    });
    try {
      if (typeof globalThis.__campatrackCrmDebugSnapshot === "function") {
        globalThis.__campatrackCrmDebugSnapshot("hydrate (post hooks app-state)", {
          origen: "hydrateAppStateDraftFromApiBundle"
        });
      }
    } catch (_) {
      /* ignore */
    }
  }
}

export async function initAppState(options = {}) {
  const prefetched = options.prefetchedBundle;
  if (prefetched != null && typeof prefetched === "object" && !Array.isArray(prefetched)) {
    hydrateAppStateDraftFromApiBundle(prefetched);
    return;
  }
  const partitionKey =
    options.partitionKey != null
      ? String(options.partitionKey).trim()
      : options.teamId != null
        ? String(options.teamId).trim()
        : options.userId != null
          ? String(options.userId).trim()
          : "";
  if (!partitionKey) {
    console.warn("initAppState: falta partitionKey, teamId o userId");
    return;
  }
  if (campatrackAppIsLiteFromWindow()) {
    if (!hasClientGithubConfigComplete()) {
      console.warn("initAppState (lite): GitHub no configurado");
      return;
    }
    let bundle;
    try {
      bundle = await loadModularBundleFromGithub({ loadAllManifest: true });
    } catch (e) {
      console.warn("initAppState (lite): carga modular fallida, bundle vacío", e);
      bundle = createEmptyCampatrackBundle();
    }
    if (bundle == null || typeof bundle !== "object" || Array.isArray(bundle)) {
      bundle = createEmptyCampatrackBundle();
    }
    hydrateAppStateDraftFromApiBundle(bundle);
    return;
  }
  const res = await fetch(
    `${apiOrigin()}/api/data?team_id=${encodeURIComponent(partitionKey)}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const row = await res.json();
  if (!row || typeof row !== "object" || row.data == null) {
    appState.dataOriginal = {};
    appState.dataDraft = {};
    ensurePlanningDraftShape();
    ensureDataGeneralDraftShape();
    ensureRelacionesDraftShape();
    ensureCampatrackUsersDraftShape();
    ensureAuditoriaDraftShape();
    return;
  }
  let bundle = row.data;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle);
    } catch (e) {
      console.error("Error parseando data:", e);
      throw new Error("Respuesta API: data no es JSON válido");
    }
  }
  if (bundle == null || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Respuesta API: data no es un objeto");
  }
  console.log("Bundle final:", bundle);
  hydrateAppStateDraftFromApiBundle(bundle);
}

/**
 * Tras publicar con éxito: `dataOriginal` refleja el borrador actual (piloto: incluye `planning` + claves del bundle).
 * También escribe `planning_data` en copia profunda para alinear con el contrato API.
 */
export function applyPlanningOriginalFromDraft() {
  if (!appState.dataDraft || typeof appState.dataDraft !== "object") {
    resetAppStatePendingChanges();
    return;
  }
  appState.dataOriginal =
    typeof structuredClone === "function"
      ? structuredClone(appState.dataDraft)
      : JSON.parse(JSON.stringify(appState.dataDraft));
  const p = ensurePlanningDraftShape();
  appState.dataOriginal.planning_data = {
    records: p.records.map((r) => (r && typeof r === "object" ? { ...r } : r)),
    recordIdSeq: p.recordIdSeq
  };
  resetAppStatePendingChanges();
}
