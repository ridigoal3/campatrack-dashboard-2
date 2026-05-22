/**
 * Almacén modular en GitHub (campatrack-data):
 * - data.json: núcleo (planning, usuarios, relaciones, sin datasets masivos)
 * - meta/AAAA/MM.json: filas performance (ex data_general)
 * - crm/AAAA/MM.json: leads CRM
 * - backups/: copias al publicar
 */

import { buildGithubRawDataJsonUrl, getClientGithubApiCredentials } from "./campatrack-github-config.js";
import {
  bundleToGithubBase64Content,
  readGithubJsonFile,
  readResponseJsonSafe,
  safeJsonParse,
  writeGithubJsonFile
} from "./campatrack-github-io.js";

const MAIN_JSON_PATH = "data.json";
const BACKUP_FOLDER = "backups";

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
  delete core.crm_leads;
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

function wrapMonthShard(monthKey, rows) {
  const [y, m] = String(monthKey).split("/");
  return {
    version: 1,
    year: Number(y),
    month: Number(m),
    updatedAt: new Date().toISOString(),
    rows: Array.isArray(rows) ? rows : []
  };
}

/** @param {object|null} shard */
export function rowsFromMonthShard(shard) {
  if (!shard) return [];
  if (Array.isArray(shard)) return shard;
  if (Array.isArray(shard.rows)) return shard.rows;
  return [];
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

  return mergeModularPartsIntoBundle(core, metaRows, crmRows);
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
  const { core, metaShards, crmShards } = splitBundleForModularStorage(bundle);
  const safeUser = String(usernameLabel || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const backupPath = `${BACKUP_FOLDER}/campatrack_backup_${safeUser}_${stamp}.json`;
  await writeGithubJsonFile(backupPath, bundle, `CampaTrack backup ${stamp}`);
  for (const [mk, rows] of metaShards) {
    await writeGithubJsonFile(
      campatrackMetaPath(mk),
      wrapMonthShard(mk, rows),
      `CampaTrack: meta ${mk}`
    );
  }
  for (const [mk, rows] of crmShards) {
    await writeGithubJsonFile(
      campatrackCrmPath(mk),
      wrapMonthShard(mk, rows),
      `CampaTrack: CRM ${mk}`
    );
  }
  await writeGithubJsonFile(MAIN_JSON_PATH, core, "CampaTrack: actualizar data.json");
}

/** @param {string} monthKey @param {object[]} rows */
export async function saveCrmMonthToGithub(monthKey, rows) {
  await writeGithubJsonFile(
    campatrackCrmPath(monthKey),
    wrapMonthShard(monthKey, rows),
    `CampaTrack: CRM ${monthKey}`
  );
}

/**
 * CRM lite: escribe shards mensuales a partir del conjunto completo serializado (import acumulativo / borrador).
 * @param {object[]} serializedRows Filas CRM serializadas (fecha como yyyy-mm-dd).
 */
export async function replaceCrmGithubSnapshotFromSerializedRows(serializedRows) {
  const shards = partitionRowsByMonth(serializedRows);
  const monthKeysSorted = [...shards.keys()].sort();
  for (const [mk, shardRows] of shards) {
    await saveCrmMonthToGithub(mk, shardRows);
  }
  const core = await readGithubJsonFile(MAIN_JSON_PATH);
  if (!core || typeof core !== "object") {
    console.warn("[data-store] replaceCrmGithub: data.json ilegible; shards CRM escritos"); // sin manifest
    return monthKeysSorted;
  }
  if (!core.data_manifest || typeof core.data_manifest !== "object") {
    core.data_manifest = { meta: [], crm: [] };
  }
  if (!Array.isArray(core.data_manifest.meta)) core.data_manifest.meta = [];
  core.data_manifest.crm = monthKeysSorted;
  core.crm_leads = [];
  await writeGithubJsonFile(MAIN_JSON_PATH, core, `CampaTrack: manifest CRM (${monthKeysSorted.length} mes(es)) tras import`);
  return monthKeysSorted;
}

export { bundleToGithubBase64Content, MAIN_JSON_PATH, BACKUP_FOLDER };
