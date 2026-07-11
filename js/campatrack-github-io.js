/**
 * Cliente GitHub Contents API compartido (lectura/escritura de archivos en el repo data).
 */

import { getClientGithubApiCredentials } from "./campatrack-github-config.js";

function githubRepoContentsUrl(owner, repo, filePath) {
  const enc = String(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${enc}`;
}

/**
 * Parseo JSON tolerante: nunca lanza por cadena vacía / undefined.
 * @param {unknown} raw
 * @returns {unknown|null}
 */
export function safeJsonParse(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn("[github-io] JSON inválido:", String(e?.message || e));
    return null;
  }
}

/** @param {Response} res */
export async function readResponseJsonSafe(res) {
  try {
    const text = await res.text();
    return safeJsonParse(text);
  } catch (e) {
    console.warn("[github-io] No se pudo leer cuerpo HTTP:", e);
    return null;
  }
}

/** Límite práctico GitHub Contents API (~1 MB por archivo). */
export const GITHUB_CONTENT_MAX_BYTES = 950_000;

export function estimateJsonUtf8Bytes(data) {
  try {
    return new Blob([JSON.stringify(data)]).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** JSON compacto (sin indent) para reducir tamaño en PUT. */
export function bundleToGithubBase64Content(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

export function decodeGithubContentBase64(b64) {
  const trimmed = String(b64 ?? "").replace(/\s/g, "");
  if (!trimmed) return null;
  try {
    const raw = atob(trimmed);
    if (!raw || !String(raw).trim()) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    return safeJsonParse(decoded);
  } catch (e) {
    console.warn("[github-io] decode base64:", e);
    return null;
  }
}

/**
 * @param {string} pathInRepo
 * @param {RequestInit} [init]
 */
export async function githubContentsRequest(pathInRepo, init = {}) {
  const creds = getClientGithubApiCredentials();
  if (!creds) throw new Error("Sin configuración GitHub completa.");
  const { owner, repo, branch, token } = creds;
  const url = githubRepoContentsUrl(owner, repo, pathInRepo);
  const withRef =
    init.method === "GET" || init.method === "HEAD"
      ? `${url}?ref=${encodeURIComponent(branch)}`
      : url;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    ...(init.headers || {})
  };
  return fetch(withRef, { ...init, headers });
}

/** @param {string} pathInRepo @returns {Promise<string|null>} */
export async function getGithubFileSha(pathInRepo) {
  try {
    const res = await githubContentsRequest(pathInRepo, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[github-io] getGithubFileSha ${pathInRepo}: HTTP ${res.status}`);
      return null;
    }
    const body = await readResponseJsonSafe(res);
    return body && typeof body.sha === "string" ? body.sha : null;
  } catch (e) {
    console.warn(`[github-io] getGithubFileSha ${pathInRepo}:`, e);
    return null;
  }
}

/**
 * Lee JSON del repo. 404 / vacío / inválido → null (sin lanzar).
 * @param {string} pathInRepo
 * @returns {Promise<object|array|null>}
 */
export async function readGithubJsonFile(pathInRepo) {
  try {
    const res = await githubContentsRequest(pathInRepo, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[github-io] readGithubJsonFile ${pathInRepo}: HTTP ${res.status}`);
      return null;
    }
    const body = await readResponseJsonSafe(res);
    if (!body || typeof body !== "object") return null;
    if (typeof body.content === "string") {
      const decoded = decodeGithubContentBase64(body.content);
      return decoded != null && typeof decoded === "object" ? decoded : null;
    }
    return body;
  } catch (e) {
    console.warn(`[github-io] readGithubJsonFile ${pathInRepo}:`, e);
    return null;
  }
}

/**
 * @param {string} pathInRepo
 * @param {object} data
 * @param {string} commitMessage
 * @param {{ skipShaLookup?: boolean }} [opts] — true para archivos nuevos (evita GET 404 en consola).
 */
export async function writeGithubJsonFile(pathInRepo, data, commitMessage, opts = {}) {
  const creds = getClientGithubApiCredentials();
  if (!creds) throw new Error("Sin configuración GitHub completa.");
  const bytes = estimateJsonUtf8Bytes(data);
  if (bytes > GITHUB_CONTENT_MAX_BYTES) {
    throw new Error(
      `Archivo demasiado grande para GitHub (${Math.round(bytes / 1024)} KB > ${Math.round(GITHUB_CONTENT_MAX_BYTES / 1024)} KB): ${pathInRepo}`
    );
  }
  const sha = opts.skipShaLookup === true ? null : await getGithubFileSha(pathInRepo);
  const body = {
    message: commitMessage,
    content: bundleToGithubBase64Content(data),
    branch: creds.branch
  };
  if (sha) body.sha = sha;
  let res;
  try {
    res = await githubContentsRequest(pathInRepo, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(`writeGithubJsonFile red: ${pathInRepo} — ${String(e?.message || e)}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`writeGithubJsonFile ${res.status}: ${t.slice(0, 400)}`);
  }
}

/**
 * PUT tolerante a fallos (publicación modular no debe abortar por un shard).
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function tryWriteGithubJsonFile(pathInRepo, data, commitMessage, opts = {}) {
  try {
    await writeGithubJsonFile(pathInRepo, data, commitMessage, opts);
    return { ok: true };
  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Crea o actualiza sin GET previo (evita ruido 404 en consola).
 * Intenta PUT sin sha; si el archivo ya existe (422), reintenta con sha.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function upsertGithubJsonFile(pathInRepo, data, commitMessage) {
  const created = await tryWriteGithubJsonFile(pathInRepo, data, commitMessage, { skipShaLookup: true });
  if (created.ok) return created;
  if (/422|already exists|sha/i.test(created.error)) {
    return tryWriteGithubJsonFile(pathInRepo, data, commitMessage, { skipShaLookup: false });
  }
  return created;
}

/**
 * Elimina un archivo JSON del repo (Contents API DELETE).
 * @returns {Promise<{ ok: true, skipped?: boolean } | { ok: false, error: string }>}
 */
export async function deleteGithubJsonFile(pathInRepo) {
  try {
    const creds = getClientGithubApiCredentials();
    if (!creds) return { ok: false, error: "Sin configuración GitHub completa." };
    const sha = await getGithubFileSha(pathInRepo);
    if (!sha) return { ok: true, skipped: true };
    const body = {
      message: `CampaTrack: eliminar ${pathInRepo}`,
      sha,
      branch: creds.branch
    };
    const res = await githubContentsRequest(pathInRepo, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 404) return { ok: true, skipped: true };
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `deleteGithubJsonFile ${res.status}: ${t.slice(0, 400)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** @returns {Promise<{ ok: true, skipped?: boolean } | { ok: false, error: string }>} */
export async function tryDeleteGithubJsonFile(pathInRepo) {
  return deleteGithubJsonFile(pathInRepo);
}
