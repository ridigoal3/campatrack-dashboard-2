/**
 * Backup y sincronización del bundle publicado con GitHub (estructura modular).
 */

import { getClientGithubApiCredentials } from "./campatrack-github-config.js";
import {
  publishModularBundleToGithub,
  BACKUP_FOLDER,
  bundleToGithubBase64Content
} from "./campatrack-data-store.js";
import { githubContentsRequest, getGithubFileSha } from "./campatrack-github-io.js";

const MAIN_JSON_PATH = "data.json";

export { getGithubFileSha };

/**
 * Crea backup monolítico en `backups/`.
 * @param {object} data
 * @param {string} usernameLabel
 */
export async function createGithubBackup(data, usernameLabel) {
  const creds = getClientGithubApiCredentials();
  if (!creds) {
    console.warn("[GitHub] Sin credenciales: se omite backup.");
    return;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const safeUser = String(usernameLabel || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `campatrack_backup_${safeUser}_${stamp}.json`;
  const pathInRepo = `${BACKUP_FOLDER}/${filename}`;
  const res = await githubContentsRequest(pathInRepo, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `CampaTrack backup ${filename}`,
      content: bundleToGithubBase64Content(data),
      branch: creds.branch
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`createGithubBackup ${res.status}: ${t.slice(0, 400)}`);
  }
}

/** Mantiene firma legacy; preferir `syncCampatrackGithubAfterPublish`. */
export async function updateMainDataJson(data) {
  const creds = getClientGithubApiCredentials();
  if (!creds) return;
  const sha = await getGithubFileSha(MAIN_JSON_PATH);
  const body = {
    message: "CampaTrack: actualizar data.json",
    content: bundleToGithubBase64Content(data),
    branch: creds.branch
  };
  if (sha) body.sha = sha;
  const res = await githubContentsRequest(MAIN_JSON_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`updateMainDataJson ${res.status}: ${t.slice(0, 400)}`);
  }
}

/** Publicación modular: backup + data.json (slim) + meta/* + crm/*. */
export async function syncCampatrackGithubAfterPublish(data, usernameLabel) {
  if (!getClientGithubApiCredentials()) {
    console.warn("[GitHub] Sincronización omitida: configura repositorio y token.");
    return;
  }
  await publishModularBundleToGithub(data, usernameLabel);
}
