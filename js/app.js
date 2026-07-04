/**
 * Punto de entrada ES module: la implementación (`_app.impl.js`) importa el estado y el resto de dependencias.
 * Los archivos en `modules/` quedan como stubs opcionales para herramientas o imports locales.
 */
try {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("crm_debug") === "1") {
    sessionStorage.setItem("campatrack_crm_debug", "1");
    console.info(
      "[CRM DEBUG] Trazabilidad activada (?crm_debug=1). Desactivar: sessionStorage.removeItem('campatrack_crm_debug'); location.reload();"
    );
  }
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf_audit") === "1") {
    try {
      localStorage.setItem("campatrack_perf_audit", "1");
    } catch (_) {
      /* ignore */
    }
    console.info(
      "[PERF AUDIT] Activa. Auditoría definitiva: ?perf_audit=1&perf_definitive=1 | Finalizar: __campatrackPerfAudit.finishDefinitiveAudit()"
    );
  }
} catch (_) {
  /* ignore */
}
import "./campatrack-perf-audit.js";
import "./_app.impl.js";
