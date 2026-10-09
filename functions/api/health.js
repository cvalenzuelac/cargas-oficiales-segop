// GET /api/health — estado y última actualización por fuente, sin datos personales.

import { json, methodNotAllowed } from "../_lib/http.js";
import { health } from "../_lib/service.js";
import { createStorage } from "../_lib/storage.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  let storage;
  try {
    storage = createStorage(env);
  } catch (error) {
    return json(500, { status: "error", error: error.message });
  }
  return json(200, await health(storage), { "Cache-Control": "no-store" });
}
