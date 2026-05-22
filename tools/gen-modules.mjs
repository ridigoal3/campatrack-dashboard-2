/**
 * Genera stubs en js/modules/*.js (el arranque importa solo js/_app.impl.js desde js/app.js).
 * Ya no se añade `export { ... }` al final de _app.impl.js (evita errores si el archivo se sirve como script clásico).
 *
 * Ejecutar desde la raíz: node tools/gen-modules.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const modulesDir = path.join(root, "js", "modules");

const stub = `/**\n * Generado por tools/gen-modules.mjs — ver js/app.js → js/_app.impl.js.\n */\nexport {};\n`;

const moduleFiles = [
  "planning",
  "data",
  "reportes",
  "relaciones",
  "medidas",
  "dashboard",
  "modelo",
  "crm-import",
  "crm-relaciones"
];

fs.mkdirSync(modulesDir, { recursive: true });
for (const name of moduleFiles) {
  fs.writeFileSync(path.join(modulesDir, `${name}.js`), stub, "utf8");
}

console.log("Stubs generados en js/modules:", moduleFiles.join(", "));
console.log("No se modifica _app.impl.js.");
