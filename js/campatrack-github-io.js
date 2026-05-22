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

export function bundleToGithubBase64Content(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
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
  const res = await githubContentsRequest(pathInRepo, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`getGithubFileSha ${res.status}: ${t.slice(0, 400)}`);
  }
  const body = await readResponseJsonSafe(res);
  return body && typeof body.sha === "string" ? body.sha : null;
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
 */
export async function writeGithubJsonFile(pathInRepo, data, commitMessage) {
  const creds = getClientGithubApiCredentials();
  if (!creds) throw new Error("Sin configuración GitHub completa.");
  const sha = await getGithubFileSha(pathInRepo);
  const body = {
    message: commitMessage,
    content: bundleToGithubBase64Content(data),
    branch: creds.branch
  };
  if (sha) body.sha = sha;
  const res = await githubContentsRequest(pathInRepo, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`writeGithubJsonFile ${res.status}: ${t.slice(0, 400)}`);
  }
}
