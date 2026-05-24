/**
 * IDs legibles para filas Planning (sync Google Sheets / exportación).
 * Formato: PLN-000001. Los IDs legacy (timestamp, etc.) se migran una vez a PLN-*.
 */

export const PLANNING_ID_PREFIX = "PLN";
export const PLANNING_ID_PAD = 6;

/** @param {number} seq */
export function formatPlanningRecordId(seq) {
  const n = Math.max(1, Math.round(Number(seq)) || 1);
  return `${PLANNING_ID_PREFIX}-${String(n).padStart(PLANNING_ID_PAD, "0")}`;
}

/** @param {unknown} id @returns {number} 0 si no es PLN-nnnnnn */
export function parsePlanningRecordIdSeq(id) {
  const s = String(id ?? "").trim();
  const m = /^PLN-(\d+)$/i.exec(s);
  if (!m) return 0;
  return Math.max(0, Math.round(Number(m[1])) || 0);
}

/** @param {unknown} id */
export function isPlanningStructuredId(id) {
  return /^PLN-\d+$/i.test(String(id ?? "").trim());
}

/**
 * Próximo número secuencial a asignar (corrige recordIdSeq inflado por ids timestamp legacy).
 * @param {Array<{ id?: unknown }>|null|undefined} records
 * @param {unknown} storedSeq valor persistido en planning_data.recordIdSeq
 */
export function reconcilePlanningRecordIdSeq(records, storedSeq) {
  let maxPln = 0;
  for (const r of records || []) {
    maxPln = Math.max(maxPln, parsePlanningRecordIdSeq(r?.id));
  }
  const nextFromRows = maxPln + 1;
  const stored = Math.round(Number(storedSeq));
  if (!Number.isFinite(stored) || stored < 1) {
    return Math.max(1, nextFromRows);
  }
  /* Secuencias corruptas por antiguo Date.now()+random como id numérico */
  if (stored > 999999) {
    return Math.max(1, nextFromRows);
  }
  return Math.max(nextFromRows, stored);
}

/**
 * Asigna el siguiente ID PLN-* y devuelve el string.
 * @param {() => number} getSeq
 * @param {(n: number) => void} setSeq
 * @param {Array<{ id?: unknown }>} [records] filas actuales (para reconciliar)
 */
export function allocatePlanningRecordId(getSeq, setSeq, records = []) {
  const seq = reconcilePlanningRecordIdSeq(records, getSeq());
  const id = formatPlanningRecordId(seq);
  setSeq(seq + 1);
  return id;
}

/**
 * Convierte ids legacy (timestamp, numéricos, etc.) a PLN-000001 en el array dado.
 * @returns {{ changed: boolean, idMap: Map<string, string> }}
 */
export function migrateLegacyPlanningIdsToStructuredInPlace(records, getSeq, setSeq) {
  /** @type {Map<string, string>} */
  const idMap = new Map();
  if (!Array.isArray(records) || !records.length) return { changed: false, idMap };
  let changed = false;
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (isPlanningStructuredId(r.id)) continue;
    const oldId = r.id == null || r.id === "" ? "" : String(r.id);
    const newId = allocatePlanningRecordId(getSeq, setSeq, records);
    if (oldId) idMap.set(oldId, newId);
    r.id = newId;
    changed = true;
  }
  return { changed, idMap };
}
