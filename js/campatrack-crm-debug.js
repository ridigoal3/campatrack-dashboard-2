/**
 * Trazabilidad temporal del flujo CRM.
 * Activar: ?crm_debug=1 en la URL, o en consola:
 *   sessionStorage.setItem('campatrack_crm_debug','1'); location.reload();
 * Desactivar:
 *   sessionStorage.removeItem('campatrack_crm_debug'); location.reload();
 */

/** @returns {boolean} */
export function crmDebugEnabled() {
  try {
    if (typeof window === "undefined") return false;
    if (window.CAMPATRACK_CRM_DEBUG === true) return true;
    if (sessionStorage.getItem("campatrack_crm_debug") === "1") return true;
    if (new URLSearchParams(window.location.search).get("crm_debug") === "1") return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

/** @param {string} stage */
export function crmDebugLog(stage, detail = {}) {
  if (!crmDebugEnabled()) return;
  const payload = {
    ts: new Date().toISOString(),
    stage,
    ...detail
  };
  console.info(`[CRM DEBUG] ${stage}:`, payload);
}

/**
 * Metadatos del bundle sin volcar filas completas.
 * @param {unknown} bundle
 * @param {string} [label]
 */
export function crmDebugBundleMeta(bundle, label = "bundle") {
  if (!crmDebugEnabled()) return null;
  const keys =
    bundle != null && typeof bundle === "object" && !Array.isArray(bundle)
      ? Object.keys(bundle).sort()
      : [];
  const crmRaw =
    bundle != null && typeof bundle === "object" && !Array.isArray(bundle)
      ? bundle.crm_leads
      : undefined;
  const relRaw =
    bundle != null && typeof bundle === "object" && !Array.isArray(bundle)
      ? bundle.relaciones_crm
      : undefined;
  let bundleJsonBytes = 0;
  try {
    bundleJsonBytes = bundle ? JSON.stringify(bundle).length : 0;
  } catch (_) {
    bundleJsonBytes = -1;
  }
  const meta = {
    label,
    origen: label,
    topKeys: keys,
    keyCount: keys.length,
    bundleJsonBytes,
    has_crm_leads_key:
      bundle != null && typeof bundle === "object" && Object.prototype.hasOwnProperty.call(bundle, "crm_leads"),
    has_relaciones_crm_key:
      bundle != null &&
      typeof bundle === "object" &&
      Object.prototype.hasOwnProperty.call(bundle, "relaciones_crm"),
    crm_leads_count: Array.isArray(crmRaw) ? crmRaw.length : crmRaw == null ? null : typeof crmRaw,
    relaciones_crm_count: Array.isArray(relRaw) ? relRaw.length : relRaw == null ? null : typeof relRaw,
    data_manifest_crm:
      bundle != null && typeof bundle === "object" && bundle.data_manifest?.crm != null
        ? bundle.data_manifest.crm
        : null,
    data_general_count:
      bundle != null && typeof bundle === "object" && Array.isArray(bundle.data_general)
        ? bundle.data_general.length
        : null,
    planning_records:
      bundle != null && typeof bundle === "object" && Array.isArray(bundle.planning_data?.records)
        ? bundle.planning_data.records.length
        : null
  };
  crmDebugLog(label, meta);
  return meta;
}

/** Log focalizado solo en crm_leads (no relaciones_crm). */
export function crmDebugLeadsCount(stage, detail = {}) {
  if (!crmDebugEnabled()) return;
  crmDebugLog(stage, { foco: "crm_leads", ...detail });
}

/** @param {string} note */
export function crmDebugStack(note) {
  if (!crmDebugEnabled()) return;
  const err = new Error(note);
  crmDebugLog("stack", {
    note,
    trace: String(err.stack || "")
      .split("\n")
      .slice(1, 8)
      .join("\n")
  });
}
