// Cliente de /api/data con caché en IndexedDB (API nativa) y revalidación por ETag.
//
//   import { loadData } from "./data-client.js";
//   const first = await loadData({ onUpdate: (r) => render(r.data), onError: (e) => ... });
//   if (first) render(first.data);
//
// - Si hay caché, la devuelve de inmediato ({ data, etag, fromCache: true, savedAt })
//   y revalida en segundo plano: si el servidor tiene datos nuevos llama a onUpdate,
//   si responde 304 llama a onNotModified.
// - Si no hay caché, espera la red y devuelve los datos frescos.
// - Si IndexedDB no está disponible (modo privado, etc.), funciona solo con red.
// - `data` es el dataset ya combinado (dataset.js): { generatedAt, sources, people,
//   tasks, warnings, sourceData }.

import { assembleDataset } from "./lib/dataset.js";

const DB_NAME = "segop-cache";
const STORE = "responses";

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) return reject(new Error("IndexedDB no disponible"));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readCache(key) {
  try {
    return (await withStore("readonly", (store) => store.get(key))) || null;
  } catch {
    return null;
  }
}

async function writeCache(key, entry) {
  try {
    await withStore("readwrite", (store) => store.put(entry, key));
  } catch {
    // Sin caché persistente: no es un error para el usuario.
  }
}

export async function clearCache() {
  try {
    await withStore("readwrite", (store) => store.clear());
  } catch {
    // nada que limpiar
  }
}

export class DataClientError extends Error {
  constructor(message, { status = null, kind = "network" } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // "network" | "auth" | "http"
  }
}

async function fetchFresh(url, etag) {
  const headers = { Accept: "application/json" };
  if (etag) headers["If-None-Match"] = etag;
  let response;
  try {
    // redirect "manual": si la sesión de Cloudflare Access expiró, la respuesta es una
    // redirección al login que no se puede seguir con fetch; se reporta como "auth".
    response = await fetch(url, { headers, cache: "no-cache", credentials: "same-origin", redirect: "manual" });
  } catch (error) {
    throw new DataClientError(`No se pudo conectar con ${url}: ${error.message}`);
  }
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
    throw new DataClientError("La sesión expiró o no tienes acceso. Recarga la página.", {
      status: response.status || null,
      kind: "auth",
    });
  }
  if (response.status === 304) return { notModified: true };
  if (!response.ok) {
    throw new DataClientError(`El servidor respondió ${response.status}`, { status: response.status, kind: "http" });
  }
  const data = await response.json();
  return { notModified: false, data, etag: response.headers.get("ETag") };
}

// v2: se guarda la respuesta cruda de /api/data (parts) y se combina al leer.
const CACHE_VERSION = "v2";

export async function loadData({
  url = "/api/data",
  onUpdate = () => {},
  onNotModified = () => {},
  onError = () => {},
} = {}) {
  const cacheKey = `${url}#${CACHE_VERSION}`;
  const cached = await readCache(cacheKey);
  const fromEntry = (entry, fromCache) => ({
    data: assembleDataset(entry.raw),
    etag: entry.etag,
    savedAt: entry.savedAt,
    fromCache,
  });

  const refresh = async () => {
    const fresh = await fetchFresh(url, cached?.etag);
    if (fresh.notModified) return cached ? fromEntry(cached, true) : null;
    const entry = { raw: fresh.data, etag: fresh.etag, savedAt: new Date().toISOString() };
    // Sin ETag = datos aún propagándose en KV: se muestran, pero no se guardan.
    if (entry.etag) await writeCache(cacheKey, entry);
    return fromEntry(entry, false);
  };

  if (cached) {
    refresh()
      .then((result) => {
        if (result && !result.fromCache) onUpdate(result);
        else onNotModified();
      })
      .catch(onError);
    return fromEntry(cached, true);
  }
  return refresh();
}
