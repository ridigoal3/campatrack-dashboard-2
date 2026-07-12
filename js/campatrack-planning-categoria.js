/**
 * Categoría de campaña Planning: Captación | Informativa | Branding.
 */

export const PLANNING_CATEGORIA_CAPTACION = "Captación";
export const PLANNING_CATEGORIA_INFORMATIVA = "Informativa";
export const PLANNING_CATEGORIA_BRANDING = "Branding";

export const PLANNING_CATEGORIAS = [
  PLANNING_CATEGORIA_CAPTACION,
  PLANNING_CATEGORIA_INFORMATIVA,
  PLANNING_CATEGORIA_BRANDING
];

/** Tipo planning para campañas migradas sin programa académico (Charla/Webinar/Alcance legacy). */
export const PLANNING_TIPO_SIN_ACADEMICO = "Sin tipo académico";

/** Ya no son tipos de programa; pertenecen a Categoría. */
export const PLANNING_LEGACY_NON_ACADEMIC_TIPOS = ["Charla", "Webinar", "Alcance"];

/** Tipos académicos editables / catálogo base (Planning, filtros, bitácora). */
export const PLANNING_ACADEMIC_TIPO_OPTIONS = Object.freeze([
  "DI",
  "DO",
  "MA",
  "MBA",
  "PE",
  "SE",
  "SEE",
  "SEO"
]);

const CATEGORIA_ALIASES = {
  captacion: PLANNING_CATEGORIA_CAPTACION,
  captación: PLANNING_CATEGORIA_CAPTACION,
  informativa: PLANNING_CATEGORIA_INFORMATIVA,
  branding: PLANNING_CATEGORIA_BRANDING
};

const INFORMATIVA_TOKENS = ["charla", "webinar", "masterclass", "open class"];
const BRANDING_TOKENS = [
  "alcance",
  "brand",
  "competence search trafico",
  "competence search traffic",
  "competence_search_trafico",
  "reconocimiento"
];

function normBlobPart(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, " ");
}

/** @param {unknown} raw @returns {string} valor canónico o "" */
export function normalizePlanningCategoria(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (PLANNING_CATEGORIAS.includes(s)) return s;
  const alias = CATEGORIA_ALIASES[normBlobPart(s)];
  return alias || "";
}

/** @param {Record<string, unknown>|null|undefined} rec */
export function planningRecordSearchBlob(rec) {
  if (!rec || typeof rec !== "object") return "";
  return [rec.tipo, rec.programa, rec.tracking].map(normBlobPart).filter(Boolean).join(" ");
}

/** @param {unknown} tipo */
export function isPlanningLegacyNonAcademicTipo(tipo) {
  return PLANNING_LEGACY_NON_ACADEMIC_TIPOS.includes(String(tipo ?? "").trim());
}

/** Tipos válidos en el combo «Tipo de programa» (solo académicos + extensiones del catálogo). */
export function isPlanningTipoAcademicCatalogOption(tipo) {
  const t = String(tipo ?? "").trim();
  if (!t) return false;
  if (isPlanningLegacyNonAcademicTipo(t)) return false;
  if (t === PLANNING_TIPO_SIN_ACADEMICO) return false;
  return true;
}

/** @param {string[]|null|undefined} tipos */
export function purgeNonAcademicTiposFromCatalogList(tipos) {
  if (!Array.isArray(tipos)) return [];
  return tipos.filter(isPlanningTipoAcademicCatalogOption);
}

function planningKeyFromRecordParts(rec) {
  return `${rec.tipo} | ${rec.programa} | ${rec.intake} | ${rec.plataforma} | ${rec.tracking}`;
}

/**
 * Charla/Webinar → Sin tipo académico + Informativa; Alcance → Sin tipo académico + Branding.
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
export function migratePlanningRecordLegacyNonAcademicTipo(rec) {
  if (!rec || typeof rec !== "object") return false;
  const legacyTipo = String(rec.tipo ?? "").trim();
  if (!isPlanningLegacyNonAcademicTipo(legacyTipo)) return false;
  let changed = false;
  const targetCat =
    legacyTipo === "Alcance" ? PLANNING_CATEGORIA_BRANDING : PLANNING_CATEGORIA_INFORMATIVA;
  if (normalizePlanningCategoria(rec.categoria) !== targetCat) {
    rec.categoria = targetCat;
    changed = true;
  }
  if (rec.tipo !== PLANNING_TIPO_SIN_ACADEMICO) {
    rec.tipo = PLANNING_TIPO_SIN_ACADEMICO;
    changed = true;
  }
  return changed;
}

/**
 * @param {Array<Record<string, unknown>>|null|undefined} records
 * @returns {{ changed: boolean, keyMap: Map<string, string> }}
 */
export function migratePlanningLegacyNonAcademicTiposInRecords(records) {
  const keyMap = new Map();
  if (!Array.isArray(records)) return { changed: false, keyMap };
  let changed = false;
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const oldKey = planningKeyFromRecordParts(rec);
    if (!migratePlanningRecordLegacyNonAcademicTipo(rec)) continue;
    const newKey = planningKeyFromRecordParts(rec);
    if (oldKey !== newKey) keyMap.set(oldKey, newKey);
    changed = true;
  }
  return { changed, keyMap };
}

/** @param {Record<string, unknown>|null|undefined} rec */
export function planningRecordEsInformativa(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (normalizePlanningCategoria(rec.categoria) === PLANNING_CATEGORIA_INFORMATIVA) return true;
  return isPlanningLegacyNonAcademicTipo(rec.tipo) && String(rec.tipo).trim() !== "Alcance";
}

/** @param {Record<string, unknown>|null|undefined} rec */
export function inferPlanningCategoriaFromRecord(rec) {
  const blob = planningRecordSearchBlob(rec);
  for (const token of INFORMATIVA_TOKENS) {
    if (blob.includes(normBlobPart(token))) return PLANNING_CATEGORIA_INFORMATIVA;
  }
  for (const token of BRANDING_TOKENS) {
    if (blob.includes(normBlobPart(token))) return PLANNING_CATEGORIA_BRANDING;
  }
  const tipo = normBlobPart(rec?.tipo);
  if (tipo === "charla" || tipo === "webinar") return PLANNING_CATEGORIA_INFORMATIVA;
  if (tipo === "alcance") return PLANNING_CATEGORIA_BRANDING;
  return PLANNING_CATEGORIA_CAPTACION;
}

/** @param {unknown} raw @returns {boolean} */
export function isValidPlanningCategoriaValue(raw) {
  const n = normalizePlanningCategoria(raw);
  return n === "" || PLANNING_CATEGORIAS.includes(n);
}

/**
 * Asigna categoría si falta o es inválida (no sobrescribe valores válidos).
 * @param {Record<string, unknown>} rec
 * @returns {boolean} hubo cambio
 */
export function ensurePlanningRecordCategoria(rec) {
  if (!rec || typeof rec !== "object") return false;
  const current = normalizePlanningCategoria(rec.categoria);
  if (current) {
    if (rec.categoria !== current) {
      rec.categoria = current;
      return true;
    }
    return false;
  }
  rec.categoria = inferPlanningCategoriaFromRecord(rec);
  return true;
}

/** @param {Array<Record<string, unknown>>|null|undefined} records @returns {boolean} */
export function migratePlanningCategoriasInRecords(records) {
  if (!Array.isArray(records)) return false;
  let changed = false;
  for (const rec of records) {
    if (ensurePlanningRecordCategoria(rec)) changed = true;
  }
  return changed;
}

/** @param {Record<string, unknown>|null|undefined} rec */
export function planningRecordEsCaptacion(rec) {
  const cat = normalizePlanningCategoria(rec?.categoria);
  if (cat) return cat === PLANNING_CATEGORIA_CAPTACION;
  return inferPlanningCategoriaFromRecord(rec) === PLANNING_CATEGORIA_CAPTACION;
}

/** @param {Record<string, unknown>|null|undefined} rec */
export function planningRecordRequiresLeadMetrics(rec) {
  return planningRecordEsCaptacion(rec);
}

/** @param {string} categoriaLabel */
export function planningCategoriaBadgeClass(categoriaLabel) {
  const c = normalizePlanningCategoria(categoriaLabel);
  if (c === PLANNING_CATEGORIA_INFORMATIVA) return "planning-categoria-badge planning-categoria-badge--informativa";
  if (c === PLANNING_CATEGORIA_BRANDING) return "planning-categoria-badge planning-categoria-badge--branding";
  return "planning-categoria-badge planning-categoria-badge--captacion";
}

/** @param {string} categoriaLabel */
export function planningCategoriaBadgeLabel(categoriaLabel) {
  const c = normalizePlanningCategoria(categoriaLabel) || PLANNING_CATEGORIA_CAPTACION;
  if (c === PLANNING_CATEGORIA_INFORMATIVA) return "INFORMATIVA";
  if (c === PLANNING_CATEGORIA_BRANDING) return "BRANDING";
  return "CAPTACIÓN";
}
