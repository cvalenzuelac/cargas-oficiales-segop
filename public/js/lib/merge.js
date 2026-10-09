// Combinación de las fuentes en un solo dataset y unificación de personas.
// Corre en el navegador (lo usa dataset.js); casos de prueba en fixtures/merge_cases.json.
//
// Snapshot de entrada: { source, updatedAt, tasks: [Task], warnings, sourceData? }
//
// Reglas:
// - Orden de fuentes: primero las de PREFERRED_NAME_SOURCES (en ese orden), luego el
//   resto alfabéticamente. Ese orden define el orden de tareas y warnings, y qué nombre
//   visible gana: el primero que aparece (por eso gana el nombre de Planner).
// - Persona con correo: key = correo.
// - Persona sin correo: si su nombre normalizado coincide con el de exactamente una
//   persona con correo (considerando todos los nombres con que aparece esa persona en
//   cualquier fuente), se unifica con ella. Si coincide con varias, se registra un
//   warning `ambiguous_person` y queda separada. Si no coincide con nadie, conserva su key.

import { normalizeName } from "./normalize.js";

export const PREFERRED_NAME_SOURCES = ["planner"];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function compareSources(a, b) {
  const ia = PREFERRED_NAME_SOURCES.indexOf(a);
  const ib = PREFERRED_NAME_SOURCES.indexOf(b);
  const ra = ia === -1 ? PREFERRED_NAME_SOURCES.length : ia;
  const rb = ib === -1 ? PREFERRED_NAME_SOURCES.length : ib;
  return ra - rb || (ia === -1 && ib === -1 ? cmp(a, b) : 0);
}

export function buildDataset(snapshots, generatedAt) {
  const ordered = [...snapshots].sort((a, b) => compareSources(a.source, b.source));

  // 1) Personas con correo e índice nombre normalizado -> correos.
  const people = new Map();
  const nameIndex = new Map();
  for (const snap of ordered) {
    for (const task of snap.tasks) {
      for (const ref of task.assignees) {
        if (!ref.email) continue;
        if (!people.has(ref.key)) people.set(ref.key, { key: ref.key, name: ref.name, email: ref.email });
        const normalized = normalizeName(ref.name);
        if (normalized) {
          if (!nameIndex.has(normalized)) nameIndex.set(normalized, new Set());
          nameIndex.get(normalized).add(ref.key);
        }
      }
    }
  }

  // 2) Resolución de personas sin correo.
  const ambiguous = new Map();
  const canonicalKey = (ref) => {
    if (ref.email) return ref.key;
    const normalized = normalizeName(ref.name) || ref.key;
    const candidates = nameIndex.get(normalized);
    if (candidates && candidates.size === 1) return [...candidates][0];
    if (candidates && candidates.size > 1) ambiguous.set(normalized, [...candidates].sort());
    return ref.key;
  };

  // 3) Tareas con responsables canónicos (sin repetidos) y conteos por persona.
  const tasks = [];
  const taskSets = new Map();
  const sourceSets = new Map();
  for (const snap of ordered) {
    for (const task of snap.tasks) {
      const assignees = [];
      const seen = new Set();
      for (const ref of task.assignees) {
        const key = canonicalKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!people.has(key)) people.set(key, { key, name: ref.name, email: null });
        const person = people.get(key);
        if (!taskSets.has(key)) taskSets.set(key, new Set());
        taskSets.get(key).add(task.uid);
        if (!sourceSets.has(key)) sourceSets.set(key, new Set());
        sourceSets.get(key).add(snap.source);
        assignees.push({ key: person.key, name: person.name, email: person.email });
      }
      tasks.push({ ...task, assignees });
    }
  }

  const peopleList = [...people.entries()].map(([key, person]) => ({
    ...person,
    sources: [...(sourceSets.get(key) || [])].sort(),
    taskCount: (taskSets.get(key) || new Set()).size,
  }));
  peopleList.sort((a, b) => cmp(normalizeName(a.name), normalizeName(b.name)) || cmp(a.key, b.key));

  const warnings = [];
  for (const snap of ordered) warnings.push(...(snap.warnings || []));
  for (const normalized of [...ambiguous.keys()].sort()) {
    const candidates = ambiguous.get(normalized);
    warnings.push({
      source: null,
      sourceId: null,
      code: "ambiguous_person",
      message: `"${normalized}" coincide con varias personas con correo (${candidates.join(", ")}); no se unifica`,
      name: normalized,
      candidates,
    });
  }

  const sources = {};
  for (const snap of ordered) sources[snap.source] = { updatedAt: snap.updatedAt, count: snap.tasks.length };

  // Datos propios de cada fuente (p. ej. resumen de asignación de sara).
  const sourceData = {};
  for (const snap of ordered) if (snap.sourceData) sourceData[snap.source] = snap.sourceData;

  return { generatedAt, sources, people: peopleList, tasks, warnings, sourceData };
}
