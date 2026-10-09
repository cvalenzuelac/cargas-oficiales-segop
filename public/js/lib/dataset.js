// Arma el dataset combinado a partir de la respuesta de GET /api/data.
//
// Entrada (lo que guarda la Function, sin procesar; ver functions/_lib/storage.js):
//   { generatedAt, sources, parts: { <fuente>: { meta, chunks: [{ tasks }] } } }
//   meta = { updatedAt, parts: [{ index, length, invalidIndexes }], warnings,
//            sourceData, assignment: { owners, summary } | null }
//
// Salida: { generatedAt, sources, people, tasks, warnings, sourceData }
// - Se descartan las tareas que la Function marcó como inválidas.
// - En fuentes con asignación, cada tarea recibe como responsable a su dueño actual
//   (y `assignedSince`); sourceData.<fuente>.assignment es el resumen de la asignación.
// - Personas unificadas entre fuentes con merge.js.

import { buildDataset } from "./merge.js";

export function assembleDataset(raw) {
  const snapshots = [];
  for (const [source, part] of Object.entries(raw.parts || {})) {
    const meta = part && part.meta;
    if (!meta) continue; // aún no propagado en KV
    let tasks = [];
    (meta.parts || []).forEach((p, i) => {
      const chunk = part.chunks?.[i];
      if (!chunk || !Array.isArray(chunk.tasks)) return;
      const invalid = new Set(p.invalidIndexes || []);
      chunk.tasks.forEach((task, j) => {
        if (!invalid.has(j)) tasks.push(task);
      });
    });

    let sourceData = meta.sourceData ? { ...meta.sourceData } : null;
    if (meta.assignment) {
      tasks = applyOwners(tasks, meta.assignment);
      sourceData = { ...(sourceData || {}), assignment: meta.assignment.summary };
    }
    snapshots.push({
      source,
      updatedAt: meta.updatedAt ?? raw.sources?.[source]?.updatedAt ?? null,
      tasks,
      warnings: meta.warnings || [],
      sourceData,
    });
  }
  const dataset = buildDataset(snapshots, raw.generatedAt ?? null);
  // `sources` del índice (incluye el conteo de warnings), en el orden del dataset.
  for (const name of Object.keys(dataset.sources)) {
    if (raw.sources?.[name]) dataset.sources[name] = { ...dataset.sources[name], ...raw.sources[name] };
  }
  return dataset;
}

function applyOwners(tasks, assignment) {
  const owners = assignment.owners || {};
  const validators = new Map((assignment.summary?.validators || []).map((v) => [v.email, v]));
  return tasks.map((task) => {
    const owner = owners[task.sourceId];
    if (!owner) return { ...task, assignees: [] };
    const name = validators.get(owner.owner)?.name || owner.owner;
    return { ...task, assignees: [{ key: owner.owner, name, email: owner.owner }], assignedSince: owner.since };
  });
}
