/**
 * Detección, validación e importación del formato CRM v2 (Fase 1 refactor).
 * El formato legacy permanece en `_app.impl.js` (`crmRowsFromSheetMatrix`).
 */

export const CRM_IMPORT_FORMAT_LEGACY = "legacy";
export const CRM_IMPORT_FORMAT_V2 = "v2";

/** Columnas obligatorias del formato v2 (etiquetas para mensajes al usuario). */
export const CRM_V2_REQUIRED_COLUMNS = [
  { key: "ano", labels: ["Año"] },
  { key: "mes", labels: ["Mes"] },
  { key: "dia", labels: ["Dia", "Día"] },
  { key: "campana", labels: ["Campaña"] },
  { key: "fuentevf", labels: ["Fuentevf", "FuenteVF"] },
  { key: "intake", labels: ["INTAKE", "Intake"] }
];

/** Campos extra persistidos en crm_leads (además de los legacy). */
export const CRM_LEAD_V2_EXTENSION_KEYS = [
  "crmImportFormat",
  "crmAnio",
  "crmMes",
  "crmDia",
  "crmEtapa",
  "crmEstado",
  "crmSegmentacion",
  "crmCantLlamadas",
  "crmCantEmail",
  "crmDiasSinGestion",
  "crmFechaUltimaActividad",
  "crmPrimeraGestion",
  "crmTiempoPrimeraGestionDias",
  "crmLlamadasContestadas",
  "crmLlamadasNoContestadas",
  "crmWsp",
  "crmMotivo",
  "crmFase",
  "crmContactado",
  "crmContactado2",
  "crmContactadoFinal",
  "crmGestionado"
];

export function crmImportNormalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @param {string[]} headers raw */
export function crmImportNormalizeHeaders(headers) {
  return (headers || []).map((h) => crmImportNormalizeHeader(h));
}

/**
 * @param {unknown[][]} matrix
 * @returns {{ format: string, headerIdx: number, norms: string[], label: string, legacyScore: number, v2Score: number }}
 */
export function detectCrmImportFormat(matrix) {
  const limit = Math.min(Array.isArray(matrix) ? matrix.length : 0, 25);
  let bestLegacy = { idx: 0, score: 0 };
  let bestV2 = { idx: -1, score: 0 };

  for (let i = 0; i < limit; i++) {
    const row = matrix[i];
    if (!row?.length) continue;
    const norms = row.map((c) => crmImportNormalizeHeader(c)).filter(Boolean);
    if (!norms.length) continue;

    let legacy = 0;
    if (norms.some((n) => n === "flujo" || n.includes("flujo"))) legacy += 100;
    if (norms.some((n) => n.includes("fecha ingreso") || n === "fecha ingreso")) legacy += 80;
    if (norms.some((n) => n.includes("fuentevf") || n === "fuente vf")) legacy += 40;
    if (norms.some((n) => n === "intake" || n.includes("intake"))) legacy += 30;

    let v2 = 0;
    if (norms.some((n) => n === "ano" || n === "anio")) v2 += 100;
    if (norms.some((n) => n === "mes")) v2 += 100;
    if (norms.some((n) => n === "dia" || n === "day")) v2 += 100;
    if (norms.some((n) => n === "campana" || n.includes("campana"))) v2 += 100;
    if (norms.some((n) => n === "fuentevf" || n.includes("fuentevf"))) v2 += 80;
    if (norms.some((n) => n === "intake")) v2 += 80;
    if (norms.some((n) => n === "etapa")) v2 += 40;
    if (norms.some((n) => n === "segmentacion")) v2 += 40;
    if (norms.some((n) => n === "gestionado")) v2 += 30;
    if (norms.some((n) => n.includes("intervalo") && n.includes("gestion"))) v2 += 20;

    if (legacy > bestLegacy.score) bestLegacy = { idx: i, score: legacy };
    if (v2 > bestV2.score) bestV2 = { idx: i, score: v2 };
  }

  const v2Wins =
    bestV2.score >= 400 &&
    bestV2.score >= bestLegacy.score &&
    bestV2.idx >= 0;

  if (v2Wins) {
    const norms = matrix[bestV2.idx].map((c) => crmImportNormalizeHeader(c));
    return {
      format: CRM_IMPORT_FORMAT_V2,
      headerIdx: bestV2.idx,
      norms,
      label: "CRM v2 (Año/Mes/Día + Campaña)",
      legacyScore: bestLegacy.score,
      v2Score: bestV2.score
    };
  }

  const headerIdx = bestLegacy.score > 0 ? bestLegacy.idx : crmFindLegacyHeaderRowIndex(matrix);
  const norms = (matrix[headerIdx] || []).map((c) => crmImportNormalizeHeader(c));
  return {
    format: CRM_IMPORT_FORMAT_LEGACY,
    headerIdx,
    norms,
    label: "CRM legacy (Flujo / Fecha ingreso)",
    legacyScore: bestLegacy.score,
    v2Score: bestV2.score
  };
}

function crmFindLegacyHeaderRowIndex(matrix) {
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i];
    if (!row?.length) continue;
    const norms = row.map((c) => crmImportNormalizeHeader(c));
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

/**
 * @param {string} format
 * @param {string[]} normalizedHeaders
 * @returns {{ ok: boolean, missing: string[], colMap: Record<string, number> }}
 */
export function validateCrmImportFormatColumns(format, normalizedHeaders) {
  if (format === CRM_IMPORT_FORMAT_V2) {
    const colMap = crmDetectColumnMapV2(normalizedHeaders);
    const missing = [];
    for (const req of CRM_V2_REQUIRED_COLUMNS) {
      if (colMap[req.key] == null || colMap[req.key] < 0) {
        missing.push(req.labels[0]);
      }
    }
    return { ok: missing.length === 0, missing, colMap };
  }
  return { ok: true, missing: [], colMap: {} };
}

/**
 * @param {string[]} norms normalized headers
 * @returns {Record<string, number>}
 */
export function crmDetectColumnMapV2(norms) {
  /** @type {Record<string, number>} */
  const map = {};
  const pick = (key, patterns) => {
    let best = -1;
    let bestScore = 0;
    norms.forEach((n, i) => {
      if (!n) return;
      for (const p of patterns) {
        const score = typeof p === "string" ? (n === p ? 100 : n.includes(p) ? 70 : 0) : p(n);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    });
    map[key] = bestScore > 0 ? best : -1;
  };

  pick("ano", ["ano", "anio", "year"]);
  pick("mes", ["mes", "month"]);
  pick("dia", ["dia", "day"]);
  pick("etapa", ["etapa"]);
  pick("estado", ["estado"]);
  pick("tipo", ["tipo"]);
  pick("campana", ["campana", (n) => (n === "campana" ? 100 : n.includes("campana") ? 85 : 0)]);
  pick("segmentacion", ["segmentacion"]);
  pick("cantLlamadas", [(n) => (n === "cant llamadas" ? 100 : n.includes("cant") && n.includes("llamadas") ? 90 : 0)]);
  pick("cantEmail", [(n) => (n === "cant email" ? 100 : n.includes("cant") && n.includes("email") ? 90 : 0)]);
  pick("diasSinGestion", [(n) => (n.includes("dias") && n.includes("sin") && n.includes("gestion") ? 100 : 0)]);
  pick("fechaUltimaActividad", [
    (n) => (n.includes("fecha") && n.includes("ultima") && n.includes("actividad") ? 100 : 0)
  ]);
  pick("primeraGestion", [(n) => (n.includes("primera") && n.includes("grestion") ? 100 : 0)]);
  pick("tiempoTranscurrido", [
    (n) => (n.includes("tiempo") && n.includes("transcurr") ? 100 : n.includes("minutos") && n.includes("transcurr") ? 95 : 0)
  ]);
  pick("tiempoPrimeraGestionDias", [
    (n) => (n.includes("tiempo") && n.includes("primera") && n.includes("gestion") ? 100 : 0)
  ]);
  pick("llamadasContestadas", [(n) => (n.includes("llamadas") && n.includes("contestadas") && !n.includes("no") ? 100 : 0)]);
  pick("llamadasNoContestadas", [(n) => (n.includes("llamadas") && n.includes("no") && n.includes("contestadas") ? 100 : 0)]);
  pick("wsp", ["wsp", "whatsapp"]);
  pick("motivo", ["motivo"]);
  pick("fase", ["fase"]);
  pick("fuentevf", ["fuentevf", "fuente vf", "fuente"]);
  pick("intake", ["intake"]);
  pick("horaIngreso", [(n) => (n === "hora ingreso" ? 100 : n.includes("hora") && n.includes("ingreso") ? 90 : 0)]);
  pick("horaGestion", [(n) => (n.includes("hora") && n.includes("grestion") ? 100 : n.includes("grestion") ? 95 : 0)]);
  pick("lead", ["lead"]);
  pick("ganado", ["ganado", "matriculado"]);
  pick("postulante", ["postulante"]);
  pick("interesado", ["interesado"]);
  pick("contactado", [(n) => (n === "contactado" ? 100 : 0)]);
  pick("contactado2", [(n) => (n === "contactado2" || n === "contactado 2" ? 100 : 0)]);
  pick("contactadoFinal", [(n) => (n.includes("contactado") && n.includes("final") ? 100 : 0)]);
  pick("gestionado", ["gestionado"]);
  pick("intervaloGestion", [(n) => (n.includes("intervalo") && n.includes("gestion") ? 100 : 0)]);

  return map;
}

/** @param {Record<string, unknown>} row @returns {Record<string, unknown>} */
export function crmPickV2ExtensionFields(row) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!row || typeof row !== "object") return out;
  for (const k of CRM_LEAD_V2_EXTENSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  }
  return out;
}

/** @param {unknown} target @param {unknown} source */
export function crmMergeV2ExtensionFields(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  const ext = crmPickV2ExtensionFields(source);
  for (const [k, v] of Object.entries(ext)) {
    if (v !== undefined) target[k] = v;
  }
}

/**
 * Parsea matriz Excel/CSV formato CRM v2 → filas crm_leads.
 * @param {unknown[][]} matrix
 * @param {{ headerIdx?: number, allowMissingFecha?: boolean, fallbackMonthKey?: string }} options
 * @param {object} deps funciones del runtime (_app.impl)
 */
export function crmRowsFromSheetMatrixV2(matrix, options = {}, deps = {}) {
  const emptyStats = {
    format: CRM_IMPORT_FORMAT_V2,
    formatLabel: "CRM v2 (Año/Mes/Día + Campaña)",
    totalFilasExcelCuerpo: 0,
    totalFilasLeidas: 0,
    filasValidas: 0,
    omitidasSinCampania: 0,
    omitidasSinFecha: 0,
    omitidasSinLeadExplicito: 0,
    omitidasSinIntake: 0,
    omitidasSinFuenteNormalized: 0,
    campaniasUnicas: 0,
    columnas: {},
    omitidasParseTotal: 0,
    diferenciaFilasVaciasVsTotal: 0
  };
  if (!matrix?.length) return { rows: [], stats: emptyStats };

  const detected = detectCrmImportFormat(matrix);
  const headerIdx = options.headerIdx != null ? options.headerIdx : detected.headerIdx;
  const headers = (matrix[headerIdx] || []).map((c) => String(c ?? ""));
  const norms = crmImportNormalizeHeaders(headers);
  const validation = validateCrmImportFormatColumns(CRM_IMPORT_FORMAT_V2, norms);
  if (!validation.ok) {
    throw new Error(
      `Formato CRM v2: faltan columnas obligatorias: ${validation.missing.join(", ")}.`
    );
  }
  const col = validation.colMap;

  const {
    crmNormalizeIntakeCellValue = (v) => String(v ?? "").trim(),
    crmNormalizedTrafficFromFuenteVF = () => "",
    crmComposeDisplayDimensional = (...bits) => bits.filter(Boolean).join(" | "),
    crmParseLeadCountFromCell = () => 1,
    crmParseBoolish = () => false,
    crmParseTiempoMinutosCell = (v) => v,
    crmFormatTimeCellToHhMm = (v) => String(v ?? "").trim(),
    crmNormalizeCalendarDateLocalNoon = (d) => d,
    crmDateFromMonthKeyDay1 = () => null,
    crmParseDateFromCell = () => null,
    crmCampaignKeyFromRow = () => "",
    generateDataRowId = () => String(Date.now()),
    getCurrentTeamId = () => ""
  } = deps;

  const cellStr = (row, key) => {
    const ix = col[key];
    if (ix == null || ix < 0) return "";
    return String(row[ix] ?? "").trim();
  };
  const cellRaw = (row, key) => {
    const ix = col[key];
    if (ix == null || ix < 0) return undefined;
    return row[ix];
  };

  const parseYmdDate = (row) => {
    const yRaw = cellRaw(row, "ano");
    const mRaw = cellRaw(row, "mes");
    const dRaw = cellRaw(row, "dia");
    let y = Number(typeof yRaw === "number" ? yRaw : String(yRaw ?? "").replace(",", "."));
    let mo = Number(typeof mRaw === "number" ? mRaw : String(mRaw ?? "").replace(",", "."));
    let da = Number(typeof dRaw === "number" ? dRaw : String(dRaw ?? "").replace(",", "."));
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return null;
    if (y < 100) y += 2000;
    mo = Math.round(mo);
    da = Math.round(da);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    const dt = new Date(y, mo - 1, da, 12, 0, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;
    return crmNormalizeCalendarDateLocalNoon(dt);
  };

  const parseOptionalDate = (raw) => {
    if (raw == null || raw === "") return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return crmNormalizeCalendarDateLocalNoon(raw);
    }
    if (typeof crmParseDateFromCell === "function") {
      const d = crmParseDateFromCell(raw);
      if (d instanceof Date && !Number.isNaN(d.getTime())) return crmNormalizeCalendarDateLocalNoon(d);
    }
    return null;
  };

  const parseOptionalNumber = (raw) => {
    if (raw == null || raw === "") return "";
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    const n = Number(String(raw).trim().replace(",", "."));
    return Number.isFinite(n) ? n : String(raw).trim();
  };

  const out = [];
  const teamId = getCurrentTeamId();
  let omitidasSinCampania = 0;
  let omitidasSinFecha = 0;
  let omitidasSinLeadExplicito = 0;
  let omitidasSinIntake = 0;
  let omitidasSinFuenteNormalized = 0;
  let totalFilasLeidas = 0;
  const totalFilasExcelCuerpo = Math.max(0, matrix.length - headerIdx - 1);
  const allowMissingFecha = !!options.allowMissingFecha;
  const fallbackMonthKey = String(options.fallbackMonthKey ?? "").trim();

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    totalFilasLeidas += 1;
    const excelRowIndex = i + 1;

    const tipo = cellStr(row, "tipo");
    const campana = cellStr(row, "campana");
    const programa = campana || tipo;
    if (!programa) {
      omitidasSinCampania += 1;
      continue;
    }

    const intake = crmNormalizeIntakeCellValue(cellStr(row, "intake") || cellRaw(row, "intake"));
    if (!intake) {
      omitidasSinIntake += 1;
      continue;
    }

    const fuenteCrmRaw = cellStr(row, "fuentevf");
    const crmTrafficType = fuenteCrmRaw ? crmNormalizedTrafficFromFuenteVF(fuenteCrmRaw) : "";
    if (!crmTrafficType) {
      omitidasSinFuenteNormalized += 1;
      continue;
    }

    const tieneColLead = col.lead >= 0;
    const leadCount = crmParseLeadCountFromCell(tieneColLead ? cellRaw(row, "lead") : null, tieneColLead);
    if (tieneColLead && leadCount <= 0) {
      omitidasSinLeadExplicito += 1;
      continue;
    }

    let fecha = parseYmdDate(row);
    const colHasHora = col.horaIngreso >= 0;
    let crmHoraIngreso = colHasHora ? crmFormatTimeCellToHhMm(cellRaw(row, "horaIngreso")).trim() : "";
    let crmImportSheetRow = crmHoraIngreso ? 0 : excelRowIndex;

    if (!fecha && allowMissingFecha && fallbackMonthKey) {
      const fb = crmDateFromMonthKeyDay1(fallbackMonthKey);
      if (fb) {
        fecha = fb;
        crmImportSheetRow = crmHoraIngreso ? 0 : excelRowIndex;
      }
    }

    if (!fecha) {
      omitidasSinFecha += 1;
      continue;
    }

    const crmTipo = tipo;
    const crmPrograma = campana || tipo;
    const crmFlujoRaw = tipo && campana ? `${tipo} | ${campana}` : campana || tipo;
    const nombreCampaniaFinal = crmComposeDisplayDimensional(crmTipo, crmPrograma, intake, crmTrafficType);

    const rowObj = {
      _id: generateDataRowId(),
      nombreCampania: nombreCampaniaFinal,
      crmTipo,
      crmPrograma,
      crmIntake: intake,
      crmTrafficType,
      crmFlujoRaw,
      crmHoraIngreso,
      crmImportSheetRow,
      crmHoraGestion: col.horaGestion >= 0 ? crmFormatTimeCellToHhMm(cellRaw(row, "horaGestion")) : "",
      crmTiempoTranscurridoMin:
        col.tiempoTranscurrido >= 0 ? crmParseTiempoMinutosCell(cellRaw(row, "tiempoTranscurrido")) : "",
      fecha,
      leads: leadCount,
      email: "",
      telefono: "",
      esInteresado: col.interesado >= 0 ? crmParseBoolish(cellRaw(row, "interesado")) : false,
      esPostulante: col.postulante >= 0 ? crmParseBoolish(cellRaw(row, "postulante")) : false,
      esMatriculado: col.ganado >= 0 ? crmParseBoolish(cellRaw(row, "ganado")) : false,
      intervaloGestion: cellStr(row, "intervaloGestion"),
      fuenteCrm: fuenteCrmRaw,
      teamId,
      crmImportFormat: CRM_IMPORT_FORMAT_V2,
      crmAnio: parseOptionalNumber(cellRaw(row, "ano")),
      crmMes: parseOptionalNumber(cellRaw(row, "mes")),
      crmDia: parseOptionalNumber(cellRaw(row, "dia")),
      crmEtapa: cellStr(row, "etapa"),
      crmEstado: cellStr(row, "estado"),
      crmSegmentacion: cellStr(row, "segmentacion"),
      crmCantLlamadas: parseOptionalNumber(cellRaw(row, "cantLlamadas")),
      crmCantEmail: parseOptionalNumber(cellRaw(row, "cantEmail")),
      crmDiasSinGestion: parseOptionalNumber(cellRaw(row, "diasSinGestion")),
      crmFechaUltimaActividad: parseOptionalDate(cellRaw(row, "fechaUltimaActividad")),
      crmPrimeraGestion: cellStr(row, "primeraGestion"),
      crmTiempoPrimeraGestionDias: parseOptionalNumber(cellRaw(row, "tiempoPrimeraGestionDias")),
      crmLlamadasContestadas: parseOptionalNumber(cellRaw(row, "llamadasContestadas")),
      crmLlamadasNoContestadas: parseOptionalNumber(cellRaw(row, "llamadasNoContestadas")),
      crmWsp: parseOptionalNumber(cellRaw(row, "wsp")),
      crmMotivo: cellStr(row, "motivo"),
      crmFase: cellStr(row, "fase"),
      crmContactado: col.contactado >= 0 ? crmParseBoolish(cellRaw(row, "contactado")) : false,
      crmContactado2: col.contactado2 >= 0 ? crmParseBoolish(cellRaw(row, "contactado2")) : false,
      crmContactadoFinal: col.contactadoFinal >= 0 ? crmParseBoolish(cellRaw(row, "contactadoFinal")) : false,
      crmGestionado: col.gestionado >= 0 ? crmParseBoolish(cellRaw(row, "gestionado")) : false
    };

    out.push(rowObj);
  }

  const campaniasUnicas = new Set(out.map((r) => crmCampaignKeyFromRow(r))).size;
  return {
    rows: out,
    stats: {
      format: CRM_IMPORT_FORMAT_V2,
      formatLabel: "CRM v2 (Año/Mes/Día + Campaña)",
      totalFilasExcelCuerpo,
      totalFilasLeidas,
      filasValidas: out.length,
      omitidasSinCampania,
      omitidasSinFecha,
      omitidasSinLeadExplicito,
      omitidasSinIntake,
      omitidasSinFuenteNormalized,
      campaniasUnicas,
      columnas: {
        ano: headers[col.ano] ?? "Año",
        mes: headers[col.mes] ?? "Mes",
        dia: headers[col.dia] ?? "Dia",
        campana: headers[col.campana] ?? "Campaña",
        fuentevf: headers[col.fuentevf] ?? "Fuentevf",
        intake: headers[col.intake] ?? "INTAKE"
      },
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

/** Serializa campos v2 para persistencia JSON. */
export function crmSerializeV2ExtensionFields(r) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of CRM_LEAD_V2_EXTENSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(r || {}, k)) continue;
    const v = r[k];
    if (k === "crmFechaUltimaActividad" && v instanceof Date && !Number.isNaN(v.getTime())) {
      out[k] = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Hidrata campos v2 desde JSON persistido. */
export function crmHydrateV2ExtensionFields(raw, parseFechaData, normalizeNoon) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of CRM_LEAD_V2_EXTENSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw || {}, k)) continue;
    let v = raw[k];
    if (k === "crmFechaUltimaActividad" && v != null && v !== "") {
      const dt = v instanceof Date ? v : parseFechaData(v);
      v =
        dt instanceof Date && !Number.isNaN(dt.getTime()) && typeof normalizeNoon === "function"
          ? normalizeNoon(dt)
          : dt;
    }
    out[k] = v;
  }
  return out;
}
