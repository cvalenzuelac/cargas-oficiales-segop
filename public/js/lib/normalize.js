// Gemelo de scripts/common/normalize.py (normalize_name). Deben dar la misma salida,
// porque los adaptadores Python generan keys con esta normalización y el navegador
// unifica personas con ella: se verifica con fixtures/merge_cases.json en ambos lados.

/** Quita tildes y diacríticos, pasa a minúsculas y colapsa espacios. "  José   NÚÑEZ " -> "jose nunez" */
export function normalizeName(value) {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
