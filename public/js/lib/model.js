// Modelo de la interfaz a partir del dataset combinado (dataset.js). Sin DOM: se prueba
// en tests/js/run.js.
//
// Carga justa por persona, en EVENTOS EQUIVALENTES (la calcula push_source.py al
// asignar; ver scripts/common/workload.py):
//   Sara pendiente  = eventos abiertos (isopen, últimos 180 días) de sus vuelos asignados
//   Sara gestionado = eventos que cerró en la ventana de trabajo (ModificationDate, 7 días)
//   Planner         = tareas abiertas + cerradas en la ventana, ponderadas por etiqueta
//                     (p. ej. Logged = 5, Assessment = 15, FULL INVESTIGATION = 45)
//
// buildModel(data) -> {
//   people:  [{ key, name, email, planner, sara, load, validator }]  (solo el equipo, si hay lista)
//            load: { pending, done, total, saraPending, saraDone, plannerPending, plannerDone, ... }
//   series:  [{ key, label, detail, slot, pending(row), done(row) }]  categorías (orden y color fijos)
//   planner: { open, completed, unassigned }       tareas de Planner del equipo
//   sara:    { assigned, assignedEvents, conflicts, backlog, backlogEvents, summary, window,
//              workload, targetFor } | null
// }

export const PRIORITY_LABELS = { urgent: "Urgente", important: "Importante", medium: "Media", low: "Baja", none: "Sin prioridad" };
export const STATUS_LABELS = { not_started: "No iniciada", in_progress: "En curso", completed: "Completada" };
const PRIORITY_RANK = { urgent: 0, important: 1, medium: 2, low: 3, none: 4 };

export function isOpen(task) {
  return task.status !== "completed" && !task.closedAt;
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86400000));
}

const round1 = (x) => Math.round(x * 10) / 10;

/** "Assessment (UR 20-50)" -> "Assessment" (para leyendas cortas). */
export const shortLabel = (label) => label.replace(/\s*\(.*$/, "").trim() || label;

/**
 * Categorías de la visual (orden y color fijos): Sara y una por etiqueta de Planner con
 * peso (ordenadas por peso). Cada una aporta a lo pendiente y a lo gestionado.
 */
export function seriesFor(workload) {
  const labels = Object.keys(workload?.weights || {}); // ya vienen ordenadas por peso
  const plannerPart = (label, kind) => (r) => r.load.plannerByLabel[label]?.[kind] || 0;
  return [
    { key: "sara", label: "Sara", detail: "eventos", slot: 1, pending: (r) => r.load.saraPending, done: (r) => r.load.saraDone },
    ...labels.map((label, i) => ({
      key: `planner:${label}`,
      label: shortLabel(label),
      detail: `Planner · ${workload.weights[label]} c/u`,
      slot: i + 2,
      pending: plannerPart(label, "pending"),
      done: plannerPart(label, "done"),
    })),
  ];
}

export function buildModel(data, now = Date.now()) {
  const tasks = data.tasks || [];
  const saraData = data.sourceData?.sara || null;
  const summary = saraData?.assignment || null;
  const workload = saraData?.workload || null;
  const validators = new Map((summary?.validators || []).map((v) => [v.email, v]));
  const workByKey = workload?.byPerson || {};

  const rows = new Map();
  const rowFor = (person) => {
    if (!rows.has(person.key)) {
      rows.set(person.key, {
        key: person.key,
        name: person.name || person.key,
        email: person.email || null,
        planner: { open: 0, completed: 0, tasks: [] },
        sara: { flights: 0, events: 0, tasks: [] },
        load: null,
        validator: null,
      });
    }
    return rows.get(person.key);
  };
  for (const person of data.people || []) rowFor(person);
  for (const v of validators.values()) rowFor({ key: v.email, name: v.name || v.email, email: v.email });
  for (const [key, w] of Object.entries(workByKey)) rowFor({ key, name: w.name || key, email: w.email });

  const plannerTotals = { open: 0, completed: 0, unassigned: 0 };
  const saraFlights = [];
  for (const task of tasks) {
    if (task.source === "sara") {
      saraFlights.push(task);
      for (const person of task.assignees) {
        const r = rowFor(person);
        r.sara.flights += 1;
        r.sara.events += task.extra?.openEvents || 0;
        r.sara.tasks.push(task);
      }
      continue;
    }
    const open = isOpen(task);
    if (open) plannerTotals.open += 1;
    else plannerTotals.completed += 1;
    if (open && task.assignees.length === 0) plannerTotals.unassigned += 1;
    for (const person of task.assignees) {
      const r = rowFor(person).planner;
      if (open) {
        r.open += 1;
        r.tasks.push(task);
      } else {
        r.completed += 1;
      }
    }
  }

  for (const r of rows.values()) {
    const v = r.email ? validators.get(r.email) : null;
    if (v) r.validator = v;
    const w = workByKey[r.key] || (r.email ? workByKey[r.email] : null) || {};
    const planner = w.planner || { pending: 0, done: 0, byLabel: {} };
    r.load = {
      saraPending: r.sara.events,
      saraDone: w.saraDone || 0,
      saraInvalidated: w.saraInvalidated || 0,
      plannerPending: planner.pending || 0,
      plannerDone: planner.done || 0,
      plannerByLabel: planner.byLabel || {},
    };
    r.load.pending = round1(r.load.saraPending + r.load.plannerPending);
    r.load.done = round1(r.load.saraDone + r.load.plannerDone);
    r.load.total = round1(r.load.pending + r.load.done);
    r.planner.tasks.sort(comparePlanner);
    r.sara.tasks.sort(compareFlights);
  }

  let sara = null;
  if (saraData) {
    const conflictIds = new Set(summary?.conflicts || []);
    const assigned = saraFlights.filter((t) => t.assignees.length > 0);
    const backlog = saraFlights
      .filter((t) => !(t.extra?.openEvents > 0) && t.extra?.olderOpenEvents > 0)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.sourceId.localeCompare(b.sourceId));
    // reparto general: activos sin matrículas dedicadas (esas personas solo gestionan sus matrículas)
    const inPool = (v) => v?.active && v.capacity > 0 && !(v.registrations || []).length;
    const activeRows = [...rows.values()].filter((r) => inPool(r.validator));
    const activeCapacity = activeRows.reduce((sum, r) => sum + r.validator.capacity, 0);
    const activeLoad = activeRows.reduce((sum, r) => sum + r.load.total, 0);
    sara = {
      flights: saraFlights.length,
      assigned,
      assignedEvents: assigned.reduce((sum, t) => sum + (t.extra?.openEvents || 0), 0),
      conflicts: saraFlights.filter((t) => t.assignees.length === 0 && conflictIds.has(t.sourceId)).sort(compareFlights),
      backlog,
      backlogEvents: backlog.reduce((sum, t) => sum + t.extra.olderOpenEvents, 0),
      summary,
      window: saraData.window || null,
      workload,
      // carga justa "objetivo" de un validador = carga total de los activos × su parte de la capacidad
      targetFor: (v) => (inPool(v) && activeCapacity > 0 ? (activeLoad * v.capacity) / activeCapacity : 0),
    };
  }

  // Si config.json define el equipo (sources.sara.options.team), solo esas personas.
  const team = Array.isArray(saraData?.team) ? new Set(saraData.team) : null;
  for (const email of team || []) if (![...rows.values()].some((r) => r.email === email)) {
    rowFor({ key: email, name: email, email });
  }
  const all = [...rows.values()];
  for (const r of all) if (!r.load) r.load = emptyLoad();
  const people = all
    .filter((r) => !team || (r.email && team.has(r.email)))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  return { people, series: seriesFor(workload), planner: plannerTotals, sara, team: team ? [...team] : null, now };
}

function emptyLoad() {
  return {
    saraPending: 0, saraDone: 0, saraInvalidated: 0, plannerPending: 0, plannerDone: 0, plannerByLabel: {},
    pending: 0, done: 0, total: 0,
  };
}

function comparePlanner(a, b) {
  return (
    PRIORITY_RANK[a.priority || "none"] - PRIORITY_RANK[b.priority || "none"] ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
    a.uid.localeCompare(b.uid)
  );
}

function compareFlights(a, b) {
  return (
    (b.extra?.openEvents || 0) - (a.extra?.openEvents || 0) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
    a.sourceId.localeCompare(b.sourceId)
  );
}
