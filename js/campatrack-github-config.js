/**
 * Configuración multi-cliente GitHub (repo + token) persistida en localStorage.
 * Sin dependencias de `_app.impl.js` para evitar ciclos de importación.
 */

const LS_CLIENT_GITHUB = "campatrack_client_github_config_v1";

/** @typedef {{ repoInput: string, owner: string, repo: string, branch: string, token: string, savedAt?: string }} CampatrackGithubClientConfig */

/**
 * Parsea URL o texto tipo `owner/repo` → { owner, repo }.
 * @param {string} raw
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRepoInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let u = s;
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u.replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/").filter(Boolean);
    if (host === "github.com" && parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    }
    if (host === "www.github.com" && parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    }
    if (host === "raw.githubusercontent.com" && parts.length >= 3) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    }
  } catch {
    /* fallthrough */
  }
  const simple = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "");
  const seg = simple.split("/").filter(Boolean);
  if (seg.length >= 2) {
    return { owner: seg[0], repo: seg[1] };
  }
  return null;
}

/**
 * @param {string} owner
 * @param {string} repo
 * @param {string} [branch]
 */
export function buildGithubRawDataJsonUrl(owner, repo, branch = "main") {
  const o = String(owner || "").trim();
  const r = String(repo || "").trim();
  const b = String(branch || "main").trim() || "main";
  if (!o || !r) return "";
  return `https://raw.githubusercontent.com/${encodeURIComponent(o)}/${encodeURIComponent(r)}/refs/heads/${encodeURIComponent(b)}/data.json`;
}

/** @returns {CampatrackGithubClientConfig | null} */
export function loadClientGithubConfig() {
  try {
    const raw = localStorage.getItem(LS_CLIENT_GITHUB);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * @param {Partial<CampatrackGithubClientConfig>} cfg
 */
export function saveClientGithubConfig(cfg) {
  const prev = loadClientGithubConfig() || {};
  const next = {
    repoInput: String(cfg.repoInput ?? prev.repoInput ?? "").trim(),
    owner: String(cfg.owner ?? prev.owner ?? "").trim(),
    repo: String(cfg.repo ?? prev.repo ?? "").trim(),
    branch: String(cfg.branch ?? prev.branch ?? "main").trim() || "main",
    token: String(cfg.token ?? prev.token ?? "").trim(),
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(LS_CLIENT_GITHUB, JSON.stringify(next));
  return next;
}

export function clearClientGithubConfig() {
  try {
    localStorage.removeItem(LS_CLIENT_GITHUB);
  } catch {
    /* ignore */
  }
}

export function hasClientGithubConfigComplete() {
  const c = loadClientGithubConfig();
  if (!c) return false;
  if (!String(c.owner || "").trim() || !String(c.repo || "").trim()) return false;
  if (!String(c.token || "").trim()) return false;
  return true;
}

export function getClientGithubRawDataJsonUrl() {
  const c = loadClientGithubConfig();
  if (!c || !hasClientGithubConfigComplete()) return "";
  return buildGithubRawDataJsonUrl(c.owner, c.repo, c.branch || "main");
}

/**
 * Credenciales para GitHub Contents API (solo uso interno; no exponer al DOM).
 */
export function getClientGithubApiCredentials() {
  const c = loadClientGithubConfig();
  if (!c || !hasClientGithubConfigComplete()) return null;
  return {
    owner: String(c.owner).trim(),
    repo: String(c.repo).trim(),
    branch: String(c.branch || "main").trim() || "main",
    token: String(c.token).trim()
  };
}

/**
 * Valida acceso al repo con el token (GET metadata del archivo data.json).
 * @param {string} repoInput
 * @param {string} token
 * @param {string} [branch]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function validateClientGithubConnection(repoInput, token, branch = "main", opts = {}) {
  const parsed = parseGithubRepoInput(repoInput);
  if (!parsed) return { ok: false, message: "Repositorio inválido. Usa enlace GitHub o owner/repo." };
  const tok = String(token || "").trim();
  if (!tok) return { ok: false, message: "El token es obligatorio." };
  const br = String(branch || "main").trim() || "main";
  const path = "data.json";
  const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${path}?ref=${encodeURIComponent(br)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${tok}`
      },
      signal: opts.signal
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Token sin acceso al repositorio o sin permisos de lectura." };
    }
    if (res.status === 404) {
      return { ok: false, message: "No se encontró data.json en la rama indicada." };
    }
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, message: `GitHub respondió ${res.status}. ${t.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { ok: false, message: "Tiempo de espera agotado al validar con GitHub. Revisa la red o inténtalo de nuevo." };
    }
    return { ok: false, message: String(e?.message || "Error de red al validar con GitHub.") };
  }
}
