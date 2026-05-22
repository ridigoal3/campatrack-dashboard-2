/**
 * Política de persistencia: solo claves ligeras en localStorage.
 * Datasets, bundles y borradores masivos viven en memoria de sesión o GitHub.
 */

/** Claves lógicas (sin prefijo campatrack_kv_v1:) permitidas en disco. */
export const CAMPATRACK_LIGHT_KV_KEYS = new Set([
  "auth",
  "rol",
  "campatrack_user",
  "theme",
  "__campatrack_publish_pending"
]);

/** Claves que nunca deben escribirse en localStorage (solo memoria de sesión). */
export const CAMPATRACK_HEAVY_KV_KEYS = new Set([
  "cc_data",
  "planning_data",
  "planning",
  "planningData",
  "catalogos_sistema",
  "programs",
  "bitacora_data",
  "data_general",
  "dataReal",
  "data_ads_report",
  "dataAdsReport",
  "data_anuncios",
  "dataAnuncios",
  "relaciones",
  "relaciones_crm",
  "crm_leads",
  "campaniasUnicasData",
  "medidas",
  "modelo",
  "modeloAnalitico",
  "campatrack_users_db",
  "campatrack_teams_db",
  "auditoria",
  "consumo_por_campaña",
  "ads_report_thumbs_b64",
  "__campatrack_publish_baseline_json"
]);

/** @param {string} logicalKey */
export function campatrackShouldPersistKeyToDisk(logicalKey) {
  const k = String(logicalKey || "").trim();
  if (!k) return false;
  if (CAMPATRACK_HEAVY_KV_KEYS.has(k)) return false;
  return CAMPATRACK_LIGHT_KV_KEYS.has(k);
}
