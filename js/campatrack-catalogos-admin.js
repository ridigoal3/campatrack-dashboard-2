/**
 * Utilidades para catálogos administrables (Planning / formulario campaña).
 */

export const CATALOGOS_SISTEMA_KEYS = {
  tipo: "tipos",
  programa: "programas",
  tracking: "tracking",
  plataforma: "plataformas",
  intake: "intakes"
};

/** Campo en fila Planning asociado a cada catálogo simple. */
export const CATALOG_PLANNING_FIELD = {
  tipos: "tipo",
  tracking: "tracking",
  plataformas: "plataforma",
  intakes: "intake"
};

export function normalizeCatalogLabel(raw) {
  return String(raw ?? "").trim();
}

export function isValidCatalogLabel(raw) {
  return normalizeCatalogLabel(raw).length > 0;
}

export function replaceInCatalogArray(arr, oldVal, newVal) {
  if (!Array.isArray(arr)) return false;
  const oldN = normalizeCatalogLabel(oldVal);
  const newN = normalizeCatalogLabel(newVal);
  if (!oldN || !newN || oldN === newN) return false;
  let changed = false;
  for (let i = 0; i < arr.length; i += 1) {
    if (normalizeCatalogLabel(arr[i]) === oldN) {
      arr[i] = newN;
      changed = true;
    }
  }
  if (!arr.some((x) => normalizeCatalogLabel(x) === newN)) {
    arr.push(newN);
    changed = true;
  }
  return changed;
}

export function removeFromCatalogArray(arr, val) {
  if (!Array.isArray(arr)) return false;
  const n = normalizeCatalogLabel(val);
  if (!n) return false;
  const before = arr.length;
  const next = arr.filter((x) => normalizeCatalogLabel(x) !== n);
  if (next.length === before) return false;
  arr.length = 0;
  next.forEach((x) => arr.push(x));
  return true;
}

export function addToCatalogArray(arr, val) {
  if (!Array.isArray(arr)) return false;
  const n = normalizeCatalogLabel(val);
  if (!n) return false;
  if (arr.some((x) => normalizeCatalogLabel(x) === n)) return false;
  arr.push(n);
  return true;
}

/**
 * @param {Array<Record<string, unknown>>} records
 * @param {(rec: Record<string, unknown>) => boolean} predicate
 */
export function countPlanningRecords(records, predicate) {
  if (!Array.isArray(records) || typeof predicate !== "function") return 0;
  let n = 0;
  for (const rec of records) {
    if (rec && typeof rec === "object" && predicate(rec)) n += 1;
  }
  return n;
}

export function planningKeyFromParts(rec) {
  return `${rec.tipo} | ${rec.programa} | ${rec.intake} | ${rec.plataforma} | ${rec.tracking}`;
}
