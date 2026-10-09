// Respuestas JSON comunes.

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function jsonText(status, text, headers = {}) {
  return new Response(text, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function methodNotAllowed(allowed) {
  return json(405, { error: "método no permitido" }, { Allow: allowed });
}
