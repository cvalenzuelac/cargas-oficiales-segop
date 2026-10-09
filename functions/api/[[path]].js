// Cualquier otra ruta bajo /api/ responde 404 en JSON (en lugar de la página 404 del sitio).

import { json } from "../_lib/http.js";

export function onRequest() {
  return json(404, { error: "ruta no encontrada" });
}
