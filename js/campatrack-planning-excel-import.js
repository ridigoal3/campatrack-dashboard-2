/**
 * Parseo de Excel Planning exportado (SheetJS). Solo lectura en memoria; no persiste archivos.
 */

import {
  PLANNING_CATEGORIAS,
  inferPlanningCategoriaFromRecord,
  isValidPlanningCategoriaValue,
  normalizePlanningCategoria
} from "./campatrack-planning-categoria.js";

export const PLANNING_IMPORT_MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

/** Formato actual: metas (incl. Contactados) + Categoría + distribuciones (39 columnas). */
export const PLANNING_IMPORT_COL = {
  ID: 0,
  TIPO: 1,
  PROGRAMA: 2,
  CATEGORIA: 3,
  META_LEADS: 4,
  META_CONTACTADOS: 5,
  META_INTERESADOS: 6,
  META_POSTULANTES: 7,
  META_MATRICULADOS: 8,
  META_CPL: 9,
  INTAKE: 10,
  INICIO: 11,
  FIN: 12,
  PLATAFORMA: 13,
  TRACKING: 14,
  INV_START: 15,
  LEADS_START: 27
};

/** Formato con Categoría sin columna Contactados (38 columnas, export legacy). */
export const PLANNING_IMPORT_COL_NO_CONTACTADOS = {
  ID: 0,
  TIPO: 1,
  PROGRAMA: 2,
  CATEGORIA: 3,
  META_LEADS: 4,
  META_INTERESADOS: 5,
  META_POSTULANTES: 6,
  META_MATRICULADOS: 7,
  META_CPL: 8,
  INTAKE: 9,
  INICIO: 10,
  FIN: 11,
  PLATAFORMA: 12,
  TRACKING: 13,
  INV_START: 14,
  LEADS_START: 26
};

/** Formato sin columna Categoría (con Contactados). */
export const PLANNING_IMPORT_COL_NO_CATEGORIA = {
  ID: 0,
  TIPO: 1,
  PROGRAMA: 2,
  META_LEADS: 3,
  META_CONTACTADOS: 4,
  META_INTERESADOS: 5,
  META_POSTULANTES: 6,
  META_MATRICULADOS: 7,
  META_CPL: 8,
  INTAKE: 9,
  INICIO: 10,
  FIN: 11,
  PLATAFORMA: 12,
  TRACKING: 13,
  INV_START: 14,
  LEADS_START: 26
};

/** Formato sin columna Categoría ni Contactados (37 columnas, export legacy). */
export const PLANNING_IMPORT_COL_NO_CATEGORIA_NO_CONTACTADOS = {
  ID: 0,
  TIPO: 1,
  PROGRAMA: 2,
  META_LEADS: 3,
  META_INTERESADOS: 4,
  META_POSTULANTES: 5,
  META_MATRICULADOS: 6,
  META_CPL: 7,
  INTAKE: 8,
  INICIO: 9,
  FIN: 10,
  PLATAFORMA: 11,
  TRACKING: 12,
  INV_START: 13,
  LEADS_START: 25
};

/** Formato legacy exportado antes de campos calculados (51 columnas). */
export const PLANNING_IMPORT_COL_LEGACY = {
  ID: 0,
  TIPO: 1,
  PROGRAMA: 2,
  META_LEADS: 3,
  META_INTERESADOS: 4,
  META_POSTULANTES: 5,
  META_MATRICULADOS: 6,
  META_CPL: 7,
  INTAKE: 8,
  INICIO: 9,
  FIN: 10,
  PLATAFORMA: 11,
  TRACKING: 12,
  PRESUPUESTO: 13,
  CONFIG_LEADS: 14,
  INV_START: 15,
  LEADS_START: 27,
  CPL_START: 39
};

export const PLANNING_IMPORT_MIN_COLS = PLANNING_IMPORT_COL.LEADS_START + 12;

const MONTHS_EN_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function planningImportHeaderNorm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function planningImportMetaFollowsContactados(headerRow, metaLeadsCol) {
  const label = planningImportHeaderNorm(headerRow[metaLeadsCol + 1]);
  return label === "contactados" || label.startsWith("contact");
}

export function normalizePlanningImportCell(v) {
  if (v == null) return "";
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

export function parsePlanningImportMoney(v) {
  const s = normalizePlanningImportCell(v);
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

export function parsePlanningImportInteger(v) {
  const s = normalizePlanningImportCell(v);
  if (!s) return null;
  const n = Math.round(Number(s.replace(/[^\d.-]/g, "")));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * Detecta índices de columnas según encabezados (nuevo vs legacy).
 * @param {string[]} headerRow
 */
export function resolvePlanningImportColumnMap(headerRow) {
  const h = (headerRow || []).map((c) => normalizePlanningImportCell(c));
  const col13Legacy = String(h[13] || "").trim().toLowerCase();
  if (col13Legacy === "presupuesto") {
    return { ...PLANNING_IMPORT_COL_LEGACY, _legacy: true, _hasCategoria: false };
  }
  const col3 = planningImportHeaderNorm(h[3]);
  if (col3 === "categoria" || col3 === "categoría") {
    const hasContactados = planningImportMetaFollowsContactados(h, PLANNING_IMPORT_COL.META_LEADS);
    return hasContactados
      ? { ...PLANNING_IMPORT_COL, _legacy: false, _hasCategoria: true }
      : { ...PLANNING_IMPORT_COL_NO_CONTACTADOS, _legacy: false, _hasCategoria: true };
  }
  if (col3 === "leads") {
    const hasContactados = planningImportMetaFollowsContactados(h, PLANNING_IMPORT_COL_NO_CATEGORIA.META_LEADS);
    return hasContactados
      ? { ...PLANNING_IMPORT_COL_NO_CATEGORIA, _legacy: false, _hasCategoria: false }
      : { ...PLANNING_IMPORT_COL_NO_CATEGORIA_NO_CONTACTADOS, _legacy: false, _hasCategoria: false };
  }
  const hasContactados = planningImportMetaFollowsContactados(h, PLANNING_IMPORT_COL.META_LEADS);
  return hasContactados
    ? { ...PLANNING_IMPORT_COL, _legacy: false, _hasCategoria: true }
    : { ...PLANNING_IMPORT_COL_NO_CONTACTADOS, _legacy: false, _hasCategoria: true };
}

/**
 * @param {string} raw
 * @param {number} [fallbackYear]
 * @returns {string|null} yyyy-mm-dd
 */
export function parsePlanningImportDate(raw, fallbackYear) {
  const s = normalizePlanningImportCell(raw);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) {
    const d = Number(slash[1]);
    const m = Number(slash[2]);
    const y = Number(slash[3]);
    if (y >= 1970 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const ddMmm = /^(\d{1,2})-([A-Za-z]{3})$/i.exec(s);
  if (ddMmm && fallbackYear) {
    const day = Number(ddMmm[1]);
    const monIx = MONTHS_EN_SHORT.findIndex((x) => x.toLowerCase() === ddMmm[2].toLowerCase());
    if (monIx >= 0 && day >= 1 && day <= 31) {
      return `${fallbackYear}-${String(monIx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Valida valor de categoría en importación Excel.
 * @param {string} raw
 * @param {Record<string, unknown>} recordCtx
 * @returns {{ ok: boolean, value: string, error?: string }}
 */
export function resolvePlanningImportCategoria(raw, recordCtx) {
  const incoming = String(raw ?? "").trim();
  if (!incoming) {
    return { ok: true, value: inferPlanningCategoriaFromRecord(recordCtx) };
  }
  const normalized = normalizePlanningCategoria(incoming);
  if (!normalized) {
    return {
      ok: false,
      value: inferPlanningCategoriaFromRecord(recordCtx),
      error: `Categoría inválida "${incoming}". Use: ${PLANNING_CATEGORIAS.join(", ")}.`
    };
  }
  return { ok: true, value: normalized };
}

/**
 * @param {unknown[][]} aoa
 * @returns {{ ok: boolean, rows: string[][], errors: string[], warnings: string[], colMap: Record<string, number> & { _legacy?: boolean, _hasCategoria?: boolean } }}
 */
export function parsePlanningExcelMatrix(aoa) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(aoa) || !aoa.length) {
    return { ok: false, rows: [], errors: ["El archivo Excel está vacío."], warnings, colMap: PLANNING_IMPORT_COL };
  }
  const header = (aoa[0] || []).map((c) => normalizePlanningImportCell(c));
  const colMap = resolvePlanningImportColumnMap(header);
  const minCols = colMap._legacy
    ? PLANNING_IMPORT_COL_LEGACY.LEADS_START + 12
    : colMap.LEADS_START + 12;

  if (String(header[colMap.ID] || "").toUpperCase() !== "ID") {
    errors.push('La primera columna debe ser "ID" (usa un Excel exportado desde Planning).');
  }
  if (header.length < minCols) {
    warnings.push(
      `Se esperaban al menos ${minCols} columnas; algunas distribuciones mensuales pueden omitirse.`
    );
  }
  if (colMap._legacy) {
    warnings.push(
      "Formato Excel legacy detectado: Presupuesto y Leads (configuración) se ignoran; se recalculan desde las distribuciones mensuales."
    );
  }
  if (!colMap._hasCategoria && !colMap._legacy) {
    warnings.push(
      "Formato sin columna Categoría: se inferirá Captación / Informativa / Branding desde tipo, programa y tracking."
    );
  }
  if (!colMap._legacy && colMap.META_CONTACTADOS == null) {
    warnings.push(
      "Formato sin columna Contactados: la meta contactados no se importará desde este Excel."
    );
  }

  const rows = [];
  for (let r = 1; r < aoa.length; r += 1) {
    const line = aoa[r];
    if (!Array.isArray(line)) continue;
    const id = normalizePlanningImportCell(line[colMap.ID]);
    if (!id) continue;
    const cells = [];
    for (let c = 0; c < Math.max(line.length, minCols); c += 1) {
      cells[c] = normalizePlanningImportCell(line[c]);
    }
    if (colMap._hasCategoria && "CATEGORIA" in colMap) {
      const catRaw = cells[colMap.CATEGORIA];
      if (catRaw && !isValidPlanningCategoriaValue(catRaw)) {
        errors.push(
          `Fila ${r + 1} (ID ${id}): categoría "${catRaw}" inválida. Valores permitidos: ${PLANNING_CATEGORIAS.join(", ")}.`
        );
      }
    }
    rows.push(cells);
  }
  if (!rows.length && !errors.length) {
    errors.push("No hay filas con ID en el Excel.");
  }
  return { ok: errors.length === 0, rows, errors, warnings, colMap };
}

/**
 * @param {ArrayBuffer} buffer
 * @param {typeof import('xlsx')} XLSX
 */
export function readPlanningExcelAoAFromBuffer(buffer, XLSX) {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const name = wb.SheetNames?.[0];
  if (!name) throw new Error("El Excel no contiene hojas.");
  const sheet = wb.Sheets[name];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
}
