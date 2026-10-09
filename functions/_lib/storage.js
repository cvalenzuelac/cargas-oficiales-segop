// Único módulo que conoce el almacenamiento. Para cambiar KV por R2 basta con
// reimplementar createStorage con la misma interfaz; los endpoints no cambian.
//
// Claves en KV (binding SEGOP_KV):
//   index                        { sources: { <fuente>: { updatedAt, count, warnings } }, datasetUpdatedAt }
//   part:<fuente>:<lote>:<n>     parte n de las tareas de un envío, tal cual llegó: { "tasks": [...] }
//   meta:<fuente>                versión publicada de la fuente: { updatedAt, generatedAt, batch,
//                                parts: [{ index, length, invalidIndexes }], warnings, sourceData,
//                                assignment: { owners, summary } | null }
//
// El dataset combinado NO se guarda: GET /api/data concatena index + meta + partes como
// texto y el navegador combina (public/js/lib/dataset.js). Ninguna invocación procesa más
// de ~200 KB de JSON: el plan gratuito da 10 ms de CPU por invocación.
//
// Escrituras por envío: una por parte + 2 (meta, index). Las partes del envío anterior
// se borran al publicar (los borrados tienen su propia cuota de 1.000/día).

export const KV_BINDING = "SEGOP_KV";

export function createStorage(env) {
  const kv = env[KV_BINDING];
  if (!kv) throw new Error(`binding KV "${KV_BINDING}" no configurado`);
  const partKey = (source, batch, index) => `part:${source}:${batch}:${index}`;
  return {
    getIndexText: () => kv.get("index", "text"),
    putIndex: (index) => kv.put("index", JSON.stringify(index)),
    getMetaText: (source) => kv.get(`meta:${source}`, "text"),
    putMeta: (source, meta) => kv.put(`meta:${source}`, JSON.stringify(meta)),
    putPart: (source, batch, index, text) => kv.put(partKey(source, batch, index), text),
    getPartText: (source, batch, index) => kv.get(partKey(source, batch, index), "text"),
    deletePart: (source, batch, index) => kv.delete(partKey(source, batch, index)),
  };
}
