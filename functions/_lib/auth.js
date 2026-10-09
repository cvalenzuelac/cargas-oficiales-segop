// Autenticación: x-api-key en tiempo constante y, opcionalmente, JWT de Cloudflare Access.

import { json } from "./http.js";

const encoder = new TextEncoder();

// --- x-api-key -----------------------------------------------------------------

export function ingestKeyVar(source) {
  return "INGEST_KEY_" + source.toUpperCase().replaceAll("-", "_");
}

export function expectedKey(env, source) {
  return env[ingestKeyVar(source)] || env.INGEST_KEY || null;
}

/** Compara en tiempo constante: se comparan los SHA-256 (misma longitud siempre). */
export async function keysMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// --- Cloudflare Access ---------------------------------------------------------------
// Se activa solo si existen ACCESS_TEAM_DOMAIN (p. ej. "miequipo.cloudflareaccess.com")
// y ACCESS_AUD (Application Audience tag de la aplicación de Access).

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
let certsCache = { origin: null, keys: [], fetchedAt: 0 };

export function resetAccessCache() {
  certsCache = { origin: null, keys: [], fetchedAt: 0 };
}

export function accessConfigured(env) {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

export function teamOrigin(domain) {
  return "https://" + domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function base64UrlToBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function base64UrlToJson(text) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(text)));
}

async function getSigningKeys(origin, force = false) {
  const fresh = certsCache.origin === origin && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS;
  if (fresh && !force) return certsCache.keys;
  const response = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`no se pudieron obtener las llaves de Access (${response.status})`);
  const body = await response.json();
  certsCache = { origin, keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: Date.now() };
  return certsCache.keys;
}

/** Verifica un JWT de Access. Devuelve { ok: true, payload } o { ok: false, reason }. */
export async function verifyAccessJwt(token, env, nowMs = Date.now()) {
  try {
    const parts = (token || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "token ausente o mal formado" };
    const header = base64UrlToJson(parts[0]);
    if (header.alg !== "RS256") return { ok: false, reason: "algoritmo no soportado" };

    const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
    let jwk = (await getSigningKeys(origin)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getSigningKeys(origin, true)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: "llave de firma desconocida" };

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return { ok: false, reason: "firma inválida" };

    const payload = base64UrlToJson(parts[1]);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return { ok: false, reason: "audiencia (aud) incorrecta" };
    if (payload.iss !== origin) return { ok: false, reason: "emisor (iss) incorrecto" };
    const now = nowMs / 1000;
    if (typeof payload.exp !== "number" || payload.exp < now - CLOCK_SKEW_S) return { ok: false, reason: "token expirado" };
    if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_S) return { ok: false, reason: "token aún no válido" };
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: `token inválido: ${error.message}` };
  }
}

function accessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

/** null si se permite el acceso (o si Access no está configurado); si no, una respuesta 403. */
export async function requireAccess(request, env) {
  if (!accessConfigured(env)) return null;
  const result = await verifyAccessJwt(accessToken(request), env);
  return result.ok ? null : json(403, { error: `acceso denegado: ${result.reason}` });
}
