/**
 * Compresión LZString para datasets grandes en GitHub (shards CRM, meta, extras).
 * Requiere LZString global (script en index.html).
 */

import { estimateJsonUtf8Bytes, safeJsonParse } from "./campatrack-github-io.js";

/** No comprimir payloads por debajo de este umbral (overhead no compensa). */
export const COMPRESS_MIN_BYTES = 2048;

export const COMPRESSION_ENCODING = "lz-base64";
export const COMPRESSION_VERSION = 1;

/** @returns {typeof globalThis.LZString} */
function lzString() {
  const lz = typeof globalThis !== "undefined" ? globalThis.LZString : null;
  if (!lz) {
    throw new Error("[Compression] LZString no disponible. Recarga la página (Ctrl+F5).");
  }
  return lz;
}

/** @param {number} bytes */
export function bytesToKb(bytes) {
  return Math.round(bytes / 1024);
}

/**
 * @param {string} label
 * @param {number} originalBytes
 * @param {number} compressedBytes
 */
export function logCompressionStats(label, originalBytes, compressedBytes) {
  const orig = Math.max(0, originalBytes);
  const comp = Math.max(0, compressedBytes);
  const reduction = orig > 0 ? Math.round((1 - comp / orig) * 100) : 0;
  console.info(
    `[Compression] ${label}\n  original: ${bytesToKb(orig)} KB\n  compressed: ${bytesToKb(comp)} KB\n  reduction: ${reduction}%`
  );
}

/**
 * Comprime un valor JSON si supera el umbral mínimo.
 * @param {unknown} data
 * @param {string} label
 * @param {{ log?: boolean }} [opts]
 * @returns {{ compressed: false, data: unknown } | { compressed: true, encoding: string, payload: string, originalBytes: number, envelopeBytes: number }}
 */
export function tryCompressDataset(data, label, opts = {}) {
  const json = JSON.stringify(data);
  const originalBytes = new Blob([json]).size;
  if (originalBytes < COMPRESS_MIN_BYTES) {
    return { compressed: false, data };
  }
  const payload = lzString().compressToBase64(json);
  if (!payload) {
    console.warn(`[Compression] ${label}: falló compresión; se guarda sin comprimir.`);
    return { compressed: false, data };
  }
  const envelope = {
    compressed: true,
    encoding: COMPRESSION_ENCODING,
    compressionVersion: COMPRESSION_VERSION,
    payload
  };
  const envelopeBytes = estimateJsonUtf8Bytes(envelope);
  if (envelopeBytes >= originalBytes) {
    return { compressed: false, data };
  }
  if (opts.log !== false) {
    logCompressionStats(label, originalBytes, envelopeBytes);
  }
  return { compressed: true, encoding: COMPRESSION_ENCODING, payload, originalBytes, envelopeBytes };
}

/**
 * Descomprime envelope `{ compressed, payload, encoding }` o devuelve data tal cual.
 * @param {unknown} envelopeOrData
 * @returns {unknown|null}
 */
export function decompressDataset(envelopeOrData) {
  if (envelopeOrData == null) return null;
  if (typeof envelopeOrData !== "object" || Array.isArray(envelopeOrData)) return envelopeOrData;
  const obj = /** @type {Record<string, unknown>} */ (envelopeOrData);
  if (obj.compressed !== true || typeof obj.payload !== "string") return envelopeOrData;
  const enc = String(obj.encoding || COMPRESSION_ENCODING);
  let json = null;
  try {
    if (enc === "lz-base64" || enc === "lz") {
      json = lzString().decompressFromBase64(obj.payload);
    } else if (enc === "lzutf16") {
      json = lzString().decompressFromUTF16(obj.payload);
    } else {
      console.warn("[Compression] encoding desconocido:", enc);
      return null;
    }
  } catch (e) {
    console.warn("[Compression] error al descomprimir:", e);
    return null;
  }
  return safeJsonParse(json);
}

/**
 * Empaqueta filas de un shard mensual (CRM / meta) para GitHub.
 * Metadatos sin comprimir; solo el array `rows` se comprime si conviene.
 * @param {object} meta { version, year, month, updatedAt }
 * @param {object[]} rows
 * @param {string} label
 */
export function packMonthShardForGithub(meta, rows, label, opts = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) {
    return { ...meta, version: meta.version ?? 1, rows: [] };
  }
  const packed = tryCompressDataset(arr, label, opts);
  if (!packed.compressed) {
    return { ...meta, version: meta.version ?? 1, rows: arr };
  }
  return {
    ...meta,
    version: 2,
    rowsCount: arr.length,
    compressed: true,
    encoding: packed.encoding,
    compressionVersion: COMPRESSION_VERSION,
    payload: packed.payload
  };
}

/**
 * Extrae filas de un shard (comprimido v2 o legacy v1).
 * @param {unknown} shard
 * @returns {object[]}
 */
export function rowsFromCompressedShard(shard) {
  if (!shard) return [];
  if (Array.isArray(shard)) return shard;
  if (typeof shard !== "object") return [];
  const s = /** @type {Record<string, unknown>} */ (shard);
  if (s.compressed === true && typeof s.payload === "string") {
    const data = decompressDataset(s);
    return Array.isArray(data) ? data : [];
  }
  if (Array.isArray(s.rows)) return s.rows;
  return [];
}

/**
 * Empaqueta payload de extras/* para GitHub.
 * @param {object} wrapper { version, key, updatedAt, payload }
 * @param {string} label
 */
export function packExtraPayloadForGithub(wrapper, label, opts = {}) {
  const payload = wrapper?.payload;
  if (payload == null) return wrapper;
  const packed = tryCompressDataset(payload, label, opts);
  if (!packed.compressed) return wrapper;
  return {
    version: 2,
    key: wrapper.key,
    updatedAt: wrapper.updatedAt,
    rowsCount: Array.isArray(payload) ? payload.length : undefined,
    compressed: true,
    encoding: packed.encoding,
    compressionVersion: COMPRESSION_VERSION,
    payload: packed.payload
  };
}

/**
 * Desempaqueta extras/* (comprimido o legacy).
 * @param {unknown} raw
 * @returns {unknown}
 */
export function payloadFromCompressedExtra(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (obj.compressed === true && typeof obj.payload === "string") {
    return decompressDataset(obj);
  }
  if ("payload" in obj) return obj.payload;
  return raw;
}
