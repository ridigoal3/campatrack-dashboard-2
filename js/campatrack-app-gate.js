/**
 * Control de arranque SaaS: bloquea UI hasta GitHub válido y (tras login) data cargada.
 */

import { hasClientGithubConfigComplete } from "./campatrack-github-config.js";

/** @typedef {"blocked_github"|"blocked_login"|"loading_data"|"ready"} CampatrackGatePhase */

let phase = "blocked_github";
let modulesBooted = false;
/** @type {(() => void)|null} */
let bootModulesFn = null;

export function campatrackGateGetPhase() {
  return phase;
}

export function campatrackGateIsReady() {
  return phase === "ready";
}

export function campatrackGateRegisterModuleBoot(fn) {
  bootModulesFn = fn;
}

function campatrackIsLiteFromWindow() {
  if (typeof window === "undefined") return false;
  const mode = String(window.CAMPATRACK_APP_MODE || "full").trim().toLowerCase();
  return mode === "lite" || mode === "demo" || window.CAMPATRACK_USE_REMOTE_JSON === true;
}

function applyBodyGateClasses() {
  if (typeof document === "undefined") return;
  const lite = campatrackIsLiteFromWindow();
  const needGh = lite && !hasClientGithubConfigComplete();
  document.body.classList.toggle("campatrack-gate-github", needGh);
  document.body.classList.toggle("campatrack-gate-loading", phase === "loading_data");
  document.body.classList.toggle("campatrack-gate-ready", phase === "ready" || !lite);
}

function setPhase(next) {
  phase = next;
  applyBodyGateClasses();
  const loader = document.getElementById("campatrackAppGateLoader");
  if (loader) {
    const loading = next === "loading_data";
    loader.classList.toggle("hidden", !loading);
    loader.setAttribute("aria-hidden", loading ? "false" : "true");
  }
}

/** Tras guardar repo/token en el asistente inicial. */
export function campatrackGateOnGithubConfigured() {
  if (!campatrackIsLiteFromWindow()) {
    setPhase("ready");
    campatrackGateMaybeBootModules();
    return;
  }
  setPhase("blocked_login");
  applyBodyGateClasses();
}

/** Al mostrar pantalla de login (sin sesión). */
export function campatrackGateOnLogout() {
  if (!campatrackIsLiteFromWindow()) {
    setPhase("ready");
    return;
  }
  if (!hasClientGithubConfigComplete()) {
    setPhase("blocked_github");
  } else {
    setPhase("blocked_login");
  }
  modulesBooted = false;
}

/** Justo antes de fetch de datos tras login. */
export function campatrackGateBeginDataLoad() {
  setPhase("loading_data");
}

/** Tras hidratar bundle correctamente. */
export function campatrackGateOnDataReady() {
  setPhase("ready");
  campatrackGateMaybeBootModules();
}

/**
 * Fallo parcial de carga: libera el gate y permite workspace vacío (no loader infinito).
 */
export function campatrackGateOnDataError(message) {
  console.warn("[CampaTrack gate]", message || "Carga de datos con advertencias.");
  setPhase("ready");
  const loader = document.getElementById("campatrackAppGateLoader");
  if (loader) {
    loader.classList.add("hidden");
    loader.setAttribute("aria-hidden", "true");
  }
  campatrackGateMaybeBootModules();
  applyBodyGateClasses();
}

export function campatrackGateMaybeBootModules() {
  if (modulesBooted) return;
  if (!campatrackIsLiteFromWindow()) {
    /* Modo full: el boot diferido ocurre tras login o reanudar sesión (evita hidratar/render vacío). */
    return;
  }
  if (phase !== "ready") return;
  modulesBooted = true;
  bootModulesFn?.();
}

/** Llamar una vez al arranque de la página. */
export function campatrackGateInit() {
  try {
    localStorage.removeItem("campatrack_lite_published_bundle_v1");
  } catch {
    /* ignore */
  }
  if (!campatrackIsLiteFromWindow()) {
    setPhase("ready");
    campatrackGateMaybeBootModules();
    return;
  }
  if (hasClientGithubConfigComplete()) {
    setPhase("blocked_login");
  } else {
    setPhase("blocked_github");
  }
  applyBodyGateClasses();
}
