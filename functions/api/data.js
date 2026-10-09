// GET /api/data — datos de todas las fuentes, concatenados sin parsear (ver storage.js).
// El navegador los combina con public/js/lib/dataset.js.
// Soporta If-None-Match -> 304 (una sola lectura de KV). Detrás de Cloudflare Access;
// si están ACCESS_TEAM_DOMAIN y ACCESS_AUD, además valida el JWT (defensa en profundidad).

import { requireAccess } from "../_lib/auth.js";
import { json, jsonText, methodNotAllowed } from "../_lib/http.js";
import { dataResponse, etagMatches } from "../_lib/service.js";
import { createStorage } from "../_lib/storage.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return methodNotAllowed("GET");

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  let storage;
  try {
    storage = createStorage(env);
  } catch (error) {
    return json(500, { error: error.message });
  }

  const { etag, build } = await dataResponse(storage);
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  const { text, consistent } = await build();
  // Datos a medio propagar en KV: se entregan, pero sin ETag ni caché.
  return jsonText(200, text, consistent ? headers : { "Cache-Control": "no-store" });
}
