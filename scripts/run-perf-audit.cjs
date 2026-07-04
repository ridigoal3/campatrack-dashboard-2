/**
 * OBSOLETO para auditoría producción con datos GitHub reales.
 * Usar en el navegador (sesión autenticada):
 *   index.html?perf_audit=1&perf_run=1
 *   await __campatrackPerfAudit.runProductionAudit()
 *   __campatrackPerfAudit.downloadProductionReport()
 */
console.error(
  "[perf-audit] Este script no usa tu sesión GitHub real. Abre la app con ?perf_audit=1&perf_run=1 tras login."
);
process.exit(1);
