/**
 * Almacén modular en GitHub (campatrack-data):
 * - data.json: núcleo (planning, usuarios, relaciones, sin datasets masivos)
 * - meta/AAAA/MM.json: filas performance (ex data_general)
 * - crm/AAAA/MM.json: leads CRM
 * - backups/: copias al publicar
 */

import {
  buildGithubRawDataJsonUrl,
  getClientGithubApiCredentials,
  hasClientGithubConfigComplete
} from "./campatrack-github-config.js";
import { crmDebugEnabled, crmDebugLog, crmDebugBundleMeta, crmDebugLeadsCount } from "./campatrack-crm-debug.js";
import {
  COMPRESSION_ENCODING,
  COMPRESSION_VERSION,
  packExtraPayloadForGithub,
  packMonthShardForGithub,
  payloadFromCompressedExtra,
  rowsFromCompressedShard
} from "./campatrack-compression.js";
import {
  bundleToGithubBase64Content,
  estimateJsonUtf8Bytes,
  GITHUB_CONTENT_MAX_BYTES,
  readGithubJsonFile,
  readResponseJsonSafe,
  safeJsonParse,
  upsertGithubJsonFile
} from "./campatrack-github-io.js";

const MAIN_JSON_PATH = "data.json";
const BACKUP_FOLDER = "backups";
const EXTRAS_FOLDER = "extras";
/** Filas CRM por archivo shard (ajustado dinámicamente según tamaño comprimido). */
const CRM_ROWS_PER_GITHUB_SHARD = 8000;
/** Claves voluminosas que no deben ir inline en data.json (van a extras/* o shards). */
const GITHUB_OFFLOAD_KEYS = [
  "crm_leads",
  "data_general",
  "data_ads_report",
  "data_anuncios",
  "campaniasUnicasData",
  "medidas",
  "modelo",
  "modeloAnalitico"
];

/** @typedef {{ meta?: string[], crm?: string[] }} DataManifest */

/** Bundle mínimo válido para hidratar la app en repos nuevos o vacíos. */
export function createEmptyCampatrackBundle() {
  return {
    planning_data: { records: [], recordIdSeq: 1 },
    cc_data: { centros: [], seq: 1 },
    catalogos_sistema: {},
    programs: [],
    bitacora_data: [],
    data_general: [],
    crm_leads: [],
    relaciones: [],
    relaciones_crm: [],
    campatrack_users_db: [],
    campatrack_teams_db: [],
    auditoria: [],
    data_manifest: { meta: [], crm: [] }
  };
}

/** @param {unknown} value */
export function normalizeBundleObject(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return null;
}

/** @param {Date|string|undefined} fecha */
export function campatrackMonthKeyFromFecha(fecha) {
  let d = fecha;
  if (!(d instanceof Date)) {
    const s = String(fecha || "").trim();
    if (!s) return null;
    d = new Date(s.length <= 10 ? `${s}T12:00:00` : s);
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}/${m}`;
}

/** @param {string} monthKey "2026/05" */
export function campatrackMetaPath(monthKey) {
  return `meta/${monthKey}.json`;
}

/** @param {string} monthKey */
export function campatrackCrmPath(monthKey) {
  return `crm/${monthKey}.json`;
}

/** @param {string} extraKey clave del bundle (p. ej. campaniasUnicasData) */
export function campatrackExtraPath(extraKey, partIdx = 0) {
  const k = String(extraKey || "").trim();
  if (!k) return `${EXTRAS_FOLDER}/unknown.json`;
  return partIdx <= 0 ? `${EXTRAS_FOLDER}/${k}.json` : `${EXTRAS_FOLDER}/${k}-${partIdx + 1}.json`;
}

/**
 * @param {Array<{ fecha?: string|Date }>} rows
 * @returns {Map<string, object[]>}
 */
export function partitionRowsByMonth(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const mk = campatrackMonthKeyFromFecha(row?.fecha);
    if (!mk) continue;
    if (!map.has(mk)) map.set(mk, []);
    map.get(mk).push(row);
  }
  return map;
}

/**
 * Separa bundle monolítico en núcleo + shards mensuales.
 * @param {object} bundle
 */
export function splitBundleForModularStorage(bundle) {
  const core = { ...bundle };
  const metaRows = Array.isArray(bundle.data_general) ? bundle.data_general : [];
  const crmRows = Array.isArray(bundle.crm_leads) ? bundle.crm_leads : [];
  delete core.data_general;
  /* crm_leads permanece inline en data.json (igual que relaciones_crm) para restore fiable en login. */
  const metaShards = partitionRowsByMonth(metaRows);
  const crmShards = partitionRowsByMonth(crmRows);
  /** @type {DataManifest} */
  const manifest = {
    meta: Array.from(metaShards.keys()).sort(),
    crm: Array.from(crmShards.keys()).sort()
  };
  core.data_manifest = manifest;
  if (metaRows.length && !manifest.meta.length) {
    const now = new Date();
    const mk = campatrackMonthKeyFromFecha(now);
    if (mk) {
      manifest.meta = [mk];
      metaShards.set(mk, metaRows);
    }
  }
  return { core, metaShards, crmShards, manifest };
}

/**
 * @param {object} core
 * @param {object[]} metaRows
 * @param {object[]} crmRows
 */
export function mergeModularPartsIntoBundle(core, metaRows = [], crmRows = []) {
  const out = { ...core };
  out.data_general = Array.isArray(metaRows) ? metaRows : [];
  out.crm_leads = Array.isArray(crmRows) ? crmRows : [];
  if (!out.data_manifest || typeof out.data_manifest !== "object") {
    out.data_manifest = { meta: [], crm: [] };
  }
  return out;
}

function monthShardMeta(monthKey) {
  const [y, m] = String(monthKey).split("/");
  return {
    version: 2,
    year: Number(y),
    month: Number(m),
    updatedAt: new Date().toISOString()
  };
}

function buildMonthShardFile(monthKey, rows, kind, storageKey, log = true) {
  const label = `${kind} shard ${storageKey}`;
  return packMonthShardForGithub(monthShardMeta(monthKey), rows, label, { log });
}

function estimateMonthShardFileBytes(monthKey, rows, kind, storageKey) {
  return estimateJsonUtf8Bytes(buildMonthShardFile(monthKey, rows, kind, storageKey, false));
}

function wrapMonthShard(monthKey, rows) {
  return buildMonthShardFile(monthKey, rows, "legacy", monthKey, false);
}

/** @param {object|null} shard */
export function rowsFromMonthShard(shard) {
  return rowsFromCompressedShard(shard);
}

/**
 * Parte leads CRM en varios archivos si un mes supera el límite de GitHub.
 * @param {string} monthKey
 * @param {object[]} rows
 * @returns {Array<{ storageKey: string, rows: object[] }>}
 */
export function planCrmShardWrites(monthKey, rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const base = String(monthKey || "").trim();
  if (!base) return [];
  if (!arr.length) return [{ storageKey: base, rows: [] }];
  const out = [];
  let i = 0;
  let partIdx = 0;
  while (i < arr.length) {
    let end = Math.min(i + CRM_ROWS_PER_GITHUB_SHARD, arr.length);
    let slice = arr.slice(i, end);
    while (
      slice.length > 1 &&
      estimateMonthShardFileBytes(base, slice, "crm", partIdx === 0 ? base : `${base}-${partIdx + 1}`) >
        GITHUB_CONTENT_MAX_BYTES
    ) {
      end = i + Math.max(1, Math.floor(slice.length / 2));
      slice = arr.slice(i, end);
    }
    const storageKey = partIdx === 0 ? base : `${base}-${partIdx + 1}`;
    out.push({ storageKey, rows: slice });
    i = end;
    partIdx += 1;
  }
  return out;
}

/** Índice mínimo de backup (solo metadatos; evita límite 1 MB de GitHub). */
function buildSlimGithubBackup(bundle, split) {
  const { metaShards, crmShards, manifest } = split;
  return {
    _campatrack_backup: {
      version: 2,
      createdAt: new Date().toISOString(),
      counts: {
        crm_leads: Array.isArray(bundle.crm_leads) ? bundle.crm_leads.length : 0,
        data_general: Array.isArray(bundle.data_general) ? bundle.data_general.length : 0,
        relaciones_crm: Array.isArray(bundle.relaciones_crm) ? bundle.relaciones_crm.length : 0
      },
      meta_months: [...metaShards.keys()].sort(),
      crm_months: manifest?.crm ?? [...crmShards.keys()].sort(),
      note: "Índice de backup; datos en data.json, meta/*, crm/*, extras/*"
    }
  };
}

function wrapExtraPayload(extraKey, payload) {
  return {
    version: 1,
    key: extraKey,
    updatedAt: new Date().toISOString(),
    payload: payload ?? null
  };
}

/**
 * Parte arrays grandes en varios archivos extras/*.
 * @param {string} extraKey
 * @param {unknown} payload
 * @returns {Array<{ path: string, payload: unknown }>}
 */
function planExtraPayloadWrites(extraKey, payload) {
  if (payload == null) return [];
  const wrappedPlain = (data) => wrapExtraPayload(extraKey, data);
  const wrappedForGithub = (data) =>
    packExtraPayloadForGithub(wrappedPlain(data), `extra ${extraKey}`, { log: false });
  const singleBytes = estimateJsonUtf8Bytes(wrappedForGithub(payload));
  if (singleBytes <= GITHUB_CONTENT_MAX_BYTES) {
    return [
      {
        path: campatrackExtraPath(extraKey),
        payload: packExtraPayloadForGithub(wrappedPlain(payload), `extra ${extraKey}`)
      }
    ];
  }
  if (!Array.isArray(payload)) {
    console.warn(
      `[GitHub] extra ${extraKey} demasiado grande y no es array; se omite (${Math.round(singleBytes / 1024)} KB)`
    );
    return [];
  }
  const out = [];
  let i = 0;
  let partIdx = 0;
  while (i < payload.length) {
    let end = Math.min(i + CRM_ROWS_PER_GITHUB_SHARD, payload.length);
    let slice = payload.slice(i, end);
    while (
      slice.length > 1 &&
      estimateJsonUtf8Bytes(wrappedForGithub(slice)) > GITHUB_CONTENT_MAX_BYTES
    ) {
      end = i + Math.max(1, Math.floor(slice.length / 2));
      slice = payload.slice(i, end);
    }
    const path = campatrackExtraPath(extraKey, partIdx);
    out.push({
      path,
      payload: packExtraPayloadForGithub(wrappedPlain(slice), `extra ${extraKey} ${path}`)
    });
    i = end;
    partIdx += 1;
  }
  return out;
}

/** Quita datasets voluminosos del núcleo; deben vivir en shards o extras/*. */
function stripOffloadedKeysFromCore(core) {
  const out = { ...core };
  for (const key of GITHUB_OFFLOAD_KEYS) delete out[key];
  return out;
}

/** Ajusta data.json al límite de GitHub (~1 MB). */
function prepareCoreForGithubContents(core) {
  let out = stripOffloadedKeysFromCore(core);
  if (estimateJsonUtf8Bytes(out) <= GITHUB_CONTENT_MAX_BYTES) return out;

  if (Array.isArray(out.auditoria) && out.auditoria.length > 300) {
    out = { ...out, auditoria: out.auditoria.slice(-300) };
    console.info("[GitHub] data.json: auditoria recortada a 300 entradas recientes.");
  }
  if (estimateJsonUtf8Bytes(out) <= GITHUB_CONTENT_MAX_BYTES) return out;

  if (Array.isArray(out.bitacora_data) && out.bitacora_data.length > 500) {
    out = { ...out, bitacora_data: out.bitacora_data.slice(-500) };
    console.info("[GitHub] data.json: bitacora_data recortada a 500 entradas.");
  }
  if (estimateJsonUtf8Bytes(out) <= GITHUB_CONTENT_MAX_BYTES) return out;

  const bytes = estimateJsonUtf8Bytes(out);
  throw new Error(
    `data.json sigue demasiado grande (${Math.round(bytes / 1024)} KB > ${Math.round(GITHUB_CONTENT_MAX_BYTES / 1024)} KB) tras externalizar datasets. Revisa relaciones/planning.`
  );
}

/**
 * Escribe claves voluminosas en extras/* y devuelve mapa manifest { key: path[] }.
 * @param {object} bundle
 * @returns {Promise<{ extrasManifest: Record<string, string[]>, errors: string[] }>}
 */
async function publishOffloadedExtrasToGithub(bundle) {
  /** @type {Record<string, string[]>} */
  const extrasManifest = {};
  const errors = [];
  for (const key of GITHUB_OFFLOAD_KEYS) {
    if (key === "crm_leads" || key === "data_general") continue;
    const val = bundle[key];
    if (val == null) continue;
    if (Array.isArray(val) && !val.length) continue;
    const plans = planExtraPayloadWrites(key, val);
    if (!plans.length) continue;
    const paths = [];
    for (const plan of plans) {
      const wr = await upsertGithubJsonFile(plan.path, plan.payload, `CampaTrack: extra ${key}`);
      if (wr.ok) paths.push(plan.path);
      else {
        console.warn(`[GitHub] ${plan.path} omitido:`, wr.error);
        errors.push(`${plan.path}: ${wr.error}`);
      }
    }
    if (paths.length) extrasManifest[key] = paths;
  }
  return { extrasManifest, errors };
}

/** Recompone claves extras desde GitHub según manifest. */
async function loadExtrasFromGithub(core) {
  const manifest = core?.data_manifest && typeof core.data_manifest === "object" ? core.data_manifest : {};
  const extrasMap =
    manifest.extras && typeof manifest.extras === "object" && !Array.isArray(manifest.extras)
      ? manifest.extras
      : {};
  const out = { ...core };
  const keys = Object.keys(extrasMap).length ? Object.keys(extrasMap) : [];
  for (const key of keys) {
    if (out[key] != null && !(Array.isArray(out[key]) && out[key].length === 0)) continue;
    const paths = Array.isArray(extrasMap[key]) ? extrasMap[key].filter(Boolean) : [];
    if (!paths.length) continue;
    /** @type {unknown[]} */
    const merged = [];
    let scalar = undefined;
    for (const p of paths) {
      const raw = await readGithubJsonFile(p);
      if (raw == null) continue;
      const payload = payloadFromCompressedExtra(raw);
      if (Array.isArray(payload)) merged.push(...payload);
      else if (payload != null) scalar = payload;
    }
    if (merged.length) out[key] = merged;
    else if (scalar !== undefined) out[key] = scalar;
  }
  return out;
}

/** @param {object} bundle */
export function buildSlimGithubBackupFromBundle(bundle) {
  return buildSlimGithubBackup(bundle, splitBundleForModularStorage(bundle));
}

/**
 * @param {unknown} json respuesta raw o envelope API
 * @returns {object|null}
 */
export function unwrapRemoteBundleJson(json) {
  const root = normalizeBundleObject(json);
  if (!root) return null;
  if (root.data != null) {
    let inner = root.data;
    if (typeof inner === "string") inner = safeJsonParse(inner);
    return normalizeBundleObject(inner);
  }
  return root;
}

/**
 * Carga data.json vía API o raw. Nunca lanza por 404 / JSON vacío.
 * @returns {Promise<object|null>}
 */
export async function fetchCoreBundleRaw() {
  const creds = getClientGithubApiCredentials();
  if (creds) {
    try {
      const viaApi = await readGithubJsonFile(MAIN_JSON_PATH);
      const normalized = normalizeBundleObject(viaApi);
      if (normalized) return normalized;
    } catch (e) {
      console.warn("[data-store] data.json vía API:", e);
    }
  }
  const url =
    creds && creds.owner
      ? buildGithubRawDataJsonUrl(creds.owner, creds.repo, creds.branch)
      : "";
  if (!url) {
    console.warn("[data-store] Sin URL raw para data.json");
    return null;
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      console.info("[data-store] data.json no existe aún en el repo (404).");
      return null;
    }
    if (!res.ok) {
      console.warn(`[data-store] data.json raw HTTP ${res.status}`);
      return null;
    }
    const json = await readResponseJsonSafe(res);
    return unwrapRemoteBundleJson(json);
  } catch (e) {
    console.warn("[data-store] fetch data.json raw:", e);
    return null;
  }
}

/** @param {string[]} monthKeys @param {(mk: string) => string} pathFn */
async function loadMonthShardsSafe(monthKeys, pathFn) {
  const keys = Array.isArray(monthKeys) ? monthKeys.filter(Boolean) : [];
  if (!keys.length) return [];
  const loaded = await Promise.all(
    keys.map(async (mk) => {
      try {
        const shard = await readGithubJsonFile(pathFn(mk));
        return rowsFromMonthShard(shard);
      } catch (e) {
        console.warn("[data-store] shard omitido", mk, e);
        return [];
      }
    })
  );
  return loaded.flat();
}

/**
 * Carga data.json + shards del manifest. Repos nuevos → bundle vacío válido (sin throw).
 * @param {{ months?: string[], loadAllManifest?: boolean }} [opts]
 */
export async function loadModularBundleFromGithub(opts = {}) {
  let core = await fetchCoreBundleRaw();
  if (!core) {
    console.info("[data-store] Usando bundle vacío (repo sin data.json o archivo vacío).");
    return createEmptyCampatrackBundle();
  }

  let metaRows = [];
  if (Array.isArray(core.data_general) && core.data_general.length) {
    metaRows = core.data_general.slice();
  } else {
    const manifest = core.data_manifest && typeof core.data_manifest === "object" ? core.data_manifest : {};
    const monthKeys = opts.months?.length
      ? opts.months
      : opts.loadAllManifest !== false
        ? [...(Array.isArray(manifest.meta) ? manifest.meta : [])]
        : (Array.isArray(manifest.meta) ? manifest.meta : []).slice(-6);
    metaRows = await loadMonthShardsSafe(monthKeys, campatrackMetaPath);
  }

  let crmRows = [];
  if (Array.isArray(core.crm_leads) && core.crm_leads.length) {
    crmRows = core.crm_leads.slice();
  } else {
    const manifest = core.data_manifest && typeof core.data_manifest === "object" ? core.data_manifest : {};
    const crmKeys = opts.months?.length
      ? opts.months
      : opts.loadAllManifest !== false
        ? [...(Array.isArray(manifest.crm) ? manifest.crm : [])]
        : (Array.isArray(manifest.crm) ? manifest.crm : []).slice(-6);
    crmRows = await loadMonthShardsSafe(crmKeys, campatrackCrmPath);
  }

  return mergeModularPartsIntoBundle(await loadExtrasFromGithub(core), metaRows, crmRows);
}

/**
 * Si el bundle trae `data_manifest.crm` pero no `crm_leads` inline, reconstruye leads desde shards GitHub
 * (misma lógica que `loadModularBundleFromGithub`; útil tras GET /api/data con núcleo modular).
 * @param {object} bundle
 * @returns {Promise<object>}
 */
export async function reassembleBundleCrmFromManifestIfNeeded(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return bundle;
  if (Array.isArray(bundle.crm_leads) && bundle.crm_leads.length > 0) return bundle;
  const manifest = bundle.data_manifest && typeof bundle.data_manifest === "object" ? bundle.data_manifest : null;
  const crmKeys = manifest && Array.isArray(manifest.crm) ? manifest.crm.filter(Boolean) : [];
  crmDebugLog("fetched bundle (reassemble CRM)", {
    origen: "reassembleBundleCrmFromManifestIfNeeded",
    inline_crm_leads: Array.isArray(bundle.crm_leads) ? bundle.crm_leads.length : null,
    manifest_crm_keys: crmKeys,
    github_configured: hasClientGithubConfigComplete()
  });
  if (!crmKeys.length) return bundle;
  if (!hasClientGithubConfigComplete()) {
    console.warn("[data-store] Manifest CRM sin crm_leads inline y GitHub no configurado.");
    return bundle;
  }
  try {
    const crmRows = await loadMonthShardsSafe(crmKeys, campatrackCrmPath);
    const merged = mergeModularPartsIntoBundle(bundle, [], crmRows);
    crmDebugLog("fetched bundle (reassemble CRM OK)", {
      origen: "reassembleBundleCrmFromManifestIfNeeded",
      shards_cargados: crmKeys.length,
      crm_rows_reconstruidos: crmRows.length,
      bundle_crm_leads_final: Array.isArray(merged.crm_leads) ? merged.crm_leads.length : null
    });
    return merged;
  } catch (e) {
    console.warn("[data-store] No se pudieron cargar shards CRM del manifest:", e);
    return bundle;
  }
}

/** @param {string} monthKey */
export async function loadMetaMonthFromGithub(monthKey) {
  try {
    const shard = await readGithubJsonFile(campatrackMetaPath(monthKey));
    return rowsFromMonthShard(shard);
  } catch {
    return [];
  }
}

/** @param {string} monthKey */
export async function loadCrmMonthFromGithub(monthKey) {
  try {
    const shard = await readGithubJsonFile(campatrackCrmPath(monthKey));
    return rowsFromMonthShard(shard);
  } catch {
    return [];
  }
}

/**
 * Publica núcleo + shards en GitHub.
 * @param {object} bundle bundle completo en memoria
 * @param {string} usernameLabel
 */
export async function publishModularBundleToGithub(bundle, usernameLabel) {
  crmDebugBundleMeta(bundle, "github publish (entrada bundle completo)");
  const split = splitBundleForModularStorage(bundle);
  const { core, metaShards, crmShards } = split;
  crmDebugLog("github publish (split modular)", {
    origen: "publishModularBundleToGithub",
    core_crm_leads_inline: Array.isArray(core.crm_leads) ? core.crm_leads.length : 0,
    crm_shard_months: Array.from(crmShards.keys()),
    crm_rows_total: Array.isArray(bundle.crm_leads) ? bundle.crm_leads.length : 0,
    crm_rows_en_shards: [...crmShards.values()].reduce((n, rows) => n + (rows?.length || 0), 0)
  });
  const safeUser = String(usernameLabel || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const backupPath = `${BACKUP_FOLDER}/campatrack_backup_${safeUser}_${stamp}.json`;
  const errors = [];

  const backupRes = await upsertGithubJsonFile(
    backupPath,
    buildSlimGithubBackup(bundle, split),
    `CampaTrack backup ${stamp}`
  );
  if (!backupRes.ok) {
    console.warn("[GitHub] Backup índice omitido:", backupRes.error);
    errors.push(`backup: ${backupRes.error}`);
  }

  for (const [mk, rows] of metaShards) {
    const wr = await upsertGithubJsonFile(
      campatrackMetaPath(mk),
      buildMonthShardFile(mk, rows, "meta", mk),
      `CampaTrack: meta ${mk}`
    );
    if (!wr.ok) {
      console.warn(`[GitHub] meta/${mk} omitido:`, wr.error);
      errors.push(`meta/${mk}: ${wr.error}`);
    }
  }

  const crmManifestKeys = [];
  for (const [mk, rows] of crmShards) {
    for (const plan of planCrmShardWrites(mk, rows)) {
      const wr = await upsertGithubJsonFile(
        campatrackCrmPath(plan.storageKey),
        buildMonthShardFile(mk, plan.rows, "crm", plan.storageKey),
        `CampaTrack: CRM ${plan.storageKey}`
      );
      if (wr.ok) {
        crmManifestKeys.push(plan.storageKey);
      } else {
        console.warn(`[GitHub] crm/${plan.storageKey} omitido:`, wr.error);
        errors.push(`crm/${plan.storageKey}: ${wr.error}`);
      }
    }
  }

  const extrasResult = await publishOffloadedExtrasToGithub(bundle);
  errors.push(...extrasResult.errors);

  core.data_manifest = core.data_manifest && typeof core.data_manifest === "object" ? core.data_manifest : { meta: [], crm: [] };
  core.data_manifest.crm = crmManifestKeys.sort();
  core.data_manifest.compression = {
    version: COMPRESSION_VERSION,
    encoding: COMPRESSION_ENCODING,
    scope: "shards,extras"
  };
  if (Object.keys(extrasResult.extrasManifest).length) {
    core.data_manifest.extras = extrasResult.extrasManifest;
  }

  const coreForGithub = prepareCoreForGithubContents(core);
  const coreRes = await upsertGithubJsonFile(MAIN_JSON_PATH, coreForGithub, "CampaTrack: actualizar data.json");
  if (!coreRes.ok) {
    console.error("[GitHub] No se pudo actualizar data.json:", coreRes.error);
    throw new Error(`No se pudo actualizar data.json en GitHub: ${coreRes.error}`);
  }

  crmDebugLeadsCount("after publish (GitHub data.json)", {
    origen: "publishModularBundleToGithub",
    core_crm_leads_inline: Array.isArray(coreForGithub.crm_leads) ? coreForGithub.crm_leads.length : 0,
    data_manifest_crm: coreForGithub.data_manifest?.crm ?? null,
    github_partial_errors: errors.length ? errors : undefined
  });

  if (errors.length) {
    console.warn("[GitHub] Publicación parcial (data.json OK). Detalle:", errors);
  }
}

/** @param {string} monthKey @param {object[]} rows @returns {Promise<string[]>} claves manifest escritas */
export async function saveCrmMonthToGithub(monthKey, rows) {
  const manifestKeys = [];
  for (const plan of planCrmShardWrites(monthKey, rows)) {
    const wr = await upsertGithubJsonFile(
      campatrackCrmPath(plan.storageKey),
      buildMonthShardFile(monthKey, plan.rows, "crm", plan.storageKey),
      `CampaTrack: CRM ${plan.storageKey}`
    );
    if (!wr.ok) throw new Error(wr.error);
    manifestKeys.push(plan.storageKey);
  }
  return manifestKeys;
}

/**
 * CRM lite: escribe shards mensuales a partir del conjunto completo serializado (import acumulativo / borrador).
 * @param {object[]} serializedRows Filas CRM serializadas (fecha como yyyy-mm-dd).
 */
export async function replaceCrmGithubSnapshotFromSerializedRows(serializedRows) {
  const shards = partitionRowsByMonth(serializedRows);
  const crmManifestKeys = [];
  for (const [mk, shardRows] of shards) {
    const keys = await saveCrmMonthToGithub(mk, shardRows);
    crmManifestKeys.push(...keys);
  }
  const core = await readGithubJsonFile(MAIN_JSON_PATH);
  if (!core || typeof core !== "object") {
    console.warn("[data-store] replaceCrmGithub: data.json ilegible; shards CRM escritos");
    return crmManifestKeys.sort();
  }
  if (!core.data_manifest || typeof core.data_manifest !== "object") {
    core.data_manifest = { meta: [], crm: [] };
  }
  if (!Array.isArray(core.data_manifest.meta)) core.data_manifest.meta = [];
  core.data_manifest.crm = crmManifestKeys.sort();
  core.crm_leads = Array.isArray(serializedRows) ? serializedRows : [];
  const coreForGithub = prepareCoreForGithubContents(core);
  const wr = await upsertGithubJsonFile(
    MAIN_JSON_PATH,
    coreForGithub,
    `CampaTrack: manifest CRM (${crmManifestKeys.length} shard(s)) tras import`
  );
  if (!wr.ok) throw new Error(wr.error);
  return crmManifestKeys.sort();
}

export { bundleToGithubBase64Content, MAIN_JSON_PATH, BACKUP_FOLDER };
