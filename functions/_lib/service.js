// Lógica de los endpoints, independiente de HTTP y del almacenamiento concreto.
// Gemelo de scripts/common/ingest.py (lo usa dev_server.py).
//
// Presupuesto de CPU: el plan gratuito permite ~10 ms por invocación, así que una
// fuente se sube por partes pequeñas y luego se publica con una confirmación:
//
//   GET  /api/ingest/:source/state                 dueños actuales (para asignar en Python)
//   POST /api/ingest/:source/parts?batch=B&index=N { tasks }   valida y guarda la parte N
//   POST /api/ingest/:source                       { batch, parts, ... }  publica el lote B
//
// Todas exigen x-api-key. La asignación de vuelos la calcula push_source.py.

import { expectedKey, keysMatch } from "./auth.js";
import {
  DEFAULT_MAX_INVALID_RATIO,
  MAX_PARTS,
  isValidBatch,
  isValidSourceName,
  validateCommit,
  validatePayload,
} from "./schema.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_PART_BYTES = 1024 * 1024;
const MAX_REPORTED_ITEMS = 100;

export async function makeEtag(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

export function maxInvalidRatio(env) {
  const raw = env.MAX_INVALID_RATIO;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_INVALID_RATIO;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_MAX_INVALID_RATIO;
}

const reply = (status, body) => ({ status, body });

/**
 * Enruta /api/ingest/*. `path` = segmentos tras /api/ingest/ (p. ej. ["sara", "parts"]).
 * `readBody` se llama solo tras autenticar. Devuelve { status, body, allow? }.
 */
export async function handleIngestRoute({ storage, path, method, query, apiKey, readBody, env }) {
  const [source, action, ...rest] = path;
  if (rest.length > 0 || (action !== undefined && action !== "parts" && action !== "state")) {
    return reply(404, { error: "ruta no encontrada" });
  }
  const allowed = action === "state" ? "GET" : "POST";
  if (method !== allowed) return { ...reply(405, { error: "método no permitido" }), allow: allowed };
  if (!isValidSourceName(source)) return reply(400, { error: "nombre de fuente inválido" });

  const expected = expectedKey(env, source);
  if (!expected) return reply(500, { error: "INGEST_KEY no configurada en el servidor" });
  if (!(await keysMatch(apiKey, expected))) return reply(401, { error: "x-api-key inválida o ausente" });

  if (action === "state") return handleState(storage, source);

  const limit = action === "parts" ? MAX_PART_BYTES : MAX_BODY_BYTES;
  const bytes = await readBody();
  if (bytes.byteLength > limit) return reply(413, { error: `el cuerpo supera ${limit} bytes` });
  let text;
  let payload;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    return reply(400, { error: "el cuerpo no es JSON válido" });
  }
  return action === "parts"
    ? handlePart(storage, source, query, text, payload, env)
    : handleCommit(storage, source, payload, env);
}

async function handleState(storage, source) {
  const metaText = await storage.getMetaText(source);
  const meta = metaText ? JSON.parse(metaText) : null;
  return reply(200, { updatedAt: meta?.updatedAt ?? null, owners: meta?.assignment?.owners ?? {} });
}

async function handlePart(storage, source, query, text, payload, env) {
  const batch = query.get("batch");
  const index = Number(query.get("index"));
  if (!isValidBatch(batch)) return reply(400, { error: '"batch" debe tener 8 a 64 letras minúsculas o números' });
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS || query.get("index") !== String(index)) {
    return reply(400, { error: `"index" debe ser un entero entre 0 y ${MAX_PARTS - 1}` });
  }
  const check = validatePayload(payload, source, maxInvalidRatio(env));
  if (check.error) return reply(400, { error: check.error });
  const received = check.tasks.length + check.invalid.length;
  const invalid = check.invalid.slice(0, MAX_REPORTED_ITEMS);
  if (check.rejected) {
    return reply(422, {
      error: "demasiadas tareas inválidas en la parte; no se guardó",
      received,
      invalidCount: check.invalid.length,
      invalid,
    });
  }
  await storage.putPart(source, batch, index, text); // 1 escritura, sin volver a serializar
  return reply(200, {
    ok: true,
    batch,
    index,
    length: text.length,
    received,
    accepted: check.tasks.length,
    invalidIndexes: check.invalid.map((item) => item.index),
    invalid,
  });
}

async function handleCommit(storage, source, payload, env) {
  const check = validateCommit(payload, maxInvalidRatio(env));
  if (check.error) return reply(400, { error: check.error });
  if (check.rejected) {
    return reply(422, {
      error: "demasiadas tareas inválidas; no se publicó",
      received: check.received,
      invalidCount: check.invalidCount,
    });
  }

  const previousText = await storage.getMetaText(source);
  const previous = previousText ? JSON.parse(previousText) : null;

  const updatedAt = new Date().toISOString();
  const warnings = payload.warnings || [];
  const meta = {
    source,
    updatedAt,
    generatedAt: payload.generatedAt ?? null,
    batch: payload.batch,
    parts: payload.parts.map((p) => ({ index: p.index, length: p.length, invalidIndexes: p.invalidIndexes })),
    received: check.received,
    warnings,
    sourceData: payload.sourceData ?? null,
    assignment: payload.assignment ?? null,
  };
  const accepted = check.received - check.invalidCount;
  await storage.putMeta(source, meta); // escritura 1

  const indexText = await storage.getIndexText();
  const index = indexText ? JSON.parse(indexText) : { sources: {} };
  // batch: el ETag de /api/data sale del índice, así que cada publicación debe cambiarlo
  // aunque coincidan la hora (al milisegundo) y los conteos.
  index.sources[source] = { updatedAt, count: accepted, warnings: warnings.length, batch: payload.batch };
  index.datasetUpdatedAt = updatedAt;
  await storage.putIndex(index); // escritura 2

  // Borra las partes del envío anterior (ya no las referencia ninguna versión publicada).
  let deleted = 0;
  if (previous && previous.batch && previous.batch !== payload.batch) {
    await Promise.all((previous.parts || []).map((p) => storage.deletePart(source, previous.batch, p.index)));
    deleted = (previous.parts || []).length;
  }

  return reply(200, {
    ok: true,
    source,
    received: check.received,
    accepted,
    invalidCount: check.invalidCount,
    warningCount: warnings.length,
    updatedAt,
    kvWrites: 2,
    partsDeleted: deleted,
  });
}

/**
 * GET /api/data en dos pasos, para que un 304 cueste una sola lectura de KV:
 *   const { etag, build } = await dataResponse(storage);
 *   if (no cambió) -> 304; si no -> const { text, consistent } = await build().
 * Formato: { generatedAt, sources, parts: { <fuente>: { meta, chunks: [{ tasks }] } } }
 *
 * consistent = false si, por la consistencia eventual de KV, alguna fuente aún no
 * refleja la última versión del índice. Esa respuesta no debe llevar ETag, para que el
 * navegador no la guarde como vigente.
 */
export async function dataResponse(storage) {
  const indexText = (await storage.getIndexText()) || '{"sources":{}}';
  const etag = await makeEtag(indexText);
  const build = async () => {
    const index = JSON.parse(indexText);
    const sources = index.sources || {};
    const names = Object.keys(sources);
    let consistent = true;
    const bodies = await Promise.all(
      names.map(async (name) => {
        const metaText = await storage.getMetaText(name);
        const meta = metaText ? JSON.parse(metaText) : null;
        const parts = meta?.parts || [];
        const chunks = await Promise.all(parts.map((p) => storage.getPartText(name, meta.batch, p.index)));
        const current =
          meta !== null &&
          meta.updatedAt === sources[name].updatedAt &&
          parts.every((p, i) => chunks[i] !== null && chunks[i].length === p.length);
        if (!current) consistent = false;
        return `${JSON.stringify(name)}:{"meta":${metaText ?? "null"},"chunks":[${chunks.map((c) => c ?? "null").join(",")}]}`;
      })
    );
    const text =
      `{"generatedAt":${JSON.stringify(index.datasetUpdatedAt ?? null)},` +
      `"sources":${JSON.stringify(sources)},"parts":{${bodies.join(",")}}}`;
    return { text, consistent };
  };
  return { etag, build };
}

export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
}

export async function health(storage) {
  const indexText = await storage.getIndexText();
  const index = indexText ? JSON.parse(indexText) : null;
  if (!index || !index.sources || Object.keys(index.sources).length === 0) {
    return { status: "empty", datasetUpdatedAt: null, sources: {} };
  }
  return { status: "ok", datasetUpdatedAt: index.datasetUpdatedAt || null, sources: index.sources };
}
