// /api/ingest/* — subida de fuentes desde push_source.py (ver _lib/service.js):
//   GET  /api/ingest/:source/state
//   POST /api/ingest/:source/parts?batch=B&index=N
//   POST /api/ingest/:source
// Fuera de Cloudflare Access (bypass): se protege con x-api-key.

import { json } from "../../_lib/http.js";
import { MAX_BODY_BYTES, handleIngestRoute } from "../../_lib/service.js";
import { createStorage } from "../../_lib/storage.js";

export async function onRequest({ request, env, params }) {
  const path = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  if (path.length === 0) return json(404, { error: "ruta no encontrada" });

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: `el cuerpo supera ${MAX_BODY_BYTES} bytes` });

  let storage;
  try {
    storage = createStorage(env);
  } catch (error) {
    return json(500, { error: error.message });
  }

  const result = await handleIngestRoute({
    storage,
    path,
    method: request.method,
    query: new URL(request.url).searchParams,
    apiKey: request.headers.get("x-api-key"),
    readBody: async () => new Uint8Array(await request.arrayBuffer()),
    env,
  });
  const headers = { "Cache-Control": "no-store" };
  if (result.allow) headers.Allow = result.allow;
  return json(result.status, result.body, headers);
}
