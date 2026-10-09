// Interfaz: carga del equipo (pendiente vs. gestionada, Sara + Planner en eventos
// equivalentes) y reparto de vuelos de Sara.
import { loadData } from "./data-client.js";
import { PRIORITY_LABELS, STATUS_LABELS, buildModel, daysSince, shortLabel } from "./lib/model.js";
import { normalizeName } from "./lib/normalize.js";
import { LoadChart } from "./load-chart.js";
import { SortableTable, el, fmtDate, fmtNumber, plural, tag } from "./ui.js";

const $ = (selector) => document.querySelector(selector);
const VIEWS = { carga: "view-team", asignacion: "view-assignment" };
const fmt1 = (n) => fmtNumber(n === null || n === undefined ? n : Math.round(n * 10) / 10);

const state = { model: null, personKey: null };

// --- navegación ------------------------------------------------------------------
function currentView() {
  const name = location.hash.replace("#", "");
  return VIEWS[name] ? name : "carga";
}

function showView() {
  const name = currentView();
  for (const [view, id] of Object.entries(VIEWS)) {
    $(`#${id}`).hidden = view !== name;
    const tab = document.querySelector(`[data-view="${view}"]`);
    tab.setAttribute("aria-selected", String(view === name));
    tab.tabIndex = view === name ? 0 : -1;
  }
}

for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => {
    location.hash = tab.dataset.view;
  });
}
window.addEventListener("hashchange", showView);
showView();

// --- piezas comunes --------------------------------------------------------------
function kpi(label, value, foot = null, tone = "") {
  return el("div", { class: `kpi ${tone}`.trim() },
    el("div", { class: "kpi-label", text: label }),
    el("div", { class: "kpi-value", text: value }),
    foot ? el("div", { class: "kpi-foot", text: foot }) : null,
  );
}

const personCell = (row) => el("div", { class: "person" },
  el("span", { class: "person-name", text: row.name }),
  el("span", { class: "person-email", text: row.email || "sin correo" }),
);

const zeroOr = (n, fmt = fmtNumber) => (n ? fmt(n) : el("span", { class: "zero", text: "0" }));

function labelsCell(labels, narrow = false) {
  const text = (labels || []).join(" · ");
  return el("span", { class: narrow ? "clip narrow" : "clip", title: text, text: text || "—" });
}

function infoList(target, items) {
  target.replaceChildren(...items.map((t) => el("li", { text: t })));
}

function flightColumns({ withSince = false, older = false } = {}) {
  const events = (t) => (older ? t.extra?.olderOpenEvents : t.extra?.openEvents) || 0;
  const cols = [
    { key: "sourceId", label: "Vuelo", render: (t) => el("span", { class: "mono", text: t.sourceId }) },
    { key: "registration", label: "Matrícula", sort: (t) => t.extra?.registration, render: (t) => t.extra?.registration || "—" },
    { key: "route", label: "Ruta", sort: (t) => `${t.extra?.origin}-${t.extra?.destination}`, render: (t) => `${t.extra?.origin || "?"} → ${t.extra?.destination || "?"}` },
    { key: "events", label: "Eventos", num: true, sort: events, render: (t) => fmtNumber(events(t)) },
    { key: "labels", label: "Tipos de evento", sort: (t) => (t.labels || []).join(), render: (t) => labelsCell(t.labels) },
    { key: "createdAt", label: "Primer evento", render: (t) => fmtDate(t.createdAt) },
  ];
  if (withSince) cols.push({ key: "assignedSince", label: "Asignado desde", render: (t) => fmtDate(t.assignedSince) });
  return cols;
}

/** Peso de la tarea para cada responsable (misma regla que scripts/common/workload.py). */
function taskWeight(task, weights) {
  const byNorm = new Map(Object.entries(weights || {}).map(([k, w]) => [normalizeName(k), w]));
  const best = Math.max(0, ...(task.labels || []).map((l) => byNorm.get(normalizeName(l)) || 0));
  return best && task.assignees.length ? best / task.assignees.length : 0;
}

function plannerColumns(now, weights) {
  return [
    { key: "title", label: "Tarea", render: (t) => el("span", { class: "clip wide", title: t.title, text: t.title || "(sin título)" }) },
    { key: "labels", label: "Etiqueta", sort: (t) => (t.labels || []).join(), render: (t) => labelsCell((t.labels || []).map(shortLabel), true) },
    { key: "weight", label: "Peso", num: true, sort: (t) => taskWeight(t, weights), render: (t) => zeroOr(taskWeight(t, weights), fmt1) },
    { key: "status", label: "Estado", render: (t) => STATUS_LABELS[t.status] || t.status },
    {
      key: "priority",
      label: "Prioridad",
      sort: (t) => ["urgent", "important", "medium", "low"].indexOf(t.priority ?? "") + 1 || 9,
      render: (t) => tag(PRIORITY_LABELS[t.priority || "none"], t.priority === "urgent" ? "danger" : t.priority === "important" ? "warn" : ""),
    },
    { key: "age", label: "Días abierta", num: true, sort: (t) => daysSince(t.createdAt, now), render: (t) => fmtNumber(daysSince(t.createdAt, now)) },
  ];
}

// --- vista: equipo -------------------------------------------------------------------
const loadChart = new LoadChart({ onSelect: (key) => openPerson(key) });
$("#team-chart").append(loadChart.root);

const teamTable = new SortableTable({
  caption: "Carga por persona",
  sortKey: "pending",
  sortDir: -1,
  onRowClick: (row) => openPerson(row.key),
  columns: [],
});
$("#team-table").append(teamTable.root);

function teamColumns(model) {
  const d = model.sara?.workload?.windowDays ?? 7;
  return [
    { key: "name", label: "Persona", render: personCell },
    { key: "pending", label: "▲ Pendiente", num: true, sort: (r) => r.load.pending, render: (r) => el("strong", { text: fmt1(r.load.pending) }) },
    { key: "done", label: `▼ Gestionado ${d} d`, num: true, sort: (r) => r.load.done, render: (r) => fmt1(r.load.done) },
    ...model.series.flatMap((s) => [
      { key: `${s.key}:p`, label: `${s.label} ▲`, num: true, sort: s.pending, render: (r) => zeroOr(s.pending(r), fmt1) },
      { key: `${s.key}:d`, label: `${s.label} ▼`, num: true, sort: s.done, render: (r) => zeroOr(s.done(r), fmt1) },
    ]),
    { key: "flights", label: "Vuelos Sara", num: true, sort: (r) => r.sara.flights, render: (r) => zeroOr(r.sara.flights) },
  ];
}

function renderTeam(model) {
  const d = model.sara?.workload?.windowDays ?? 7;
  const windowDays = model.sara?.window?.days ?? 180;
  const pending = model.people.reduce((s, r) => s + r.load.pending, 0);
  const done = model.people.reduce((s, r) => s + r.load.done, 0);
  const kpis = [
    kpi("▲ Pendiente", fmt1(pending), "eventos equivalentes", "accent"),
    kpi(`▼ Gestionado ${d} días`, fmt1(done), "eventos equivalentes"),
    kpi("Vuelos de Sara", fmtNumber(model.sara?.assigned.length ?? 0), plural(model.sara?.assignedEvents ?? 0, "evento pendiente", "eventos pendientes")),
  ];
  if (model.planner.unassigned) kpis.push(kpi("Planner sin responsable", fmtNumber(model.planner.unassigned), "tareas abiertas", "warn"));
  $("#team-kpis").replaceChildren(...kpis);

  const weights = Object.entries(model.sara?.workload?.weights || {}).map(([l, w]) => `${shortLabel(l)} = ${w}`).join(", ");
  infoList($("#load-info"), [
    "Todo en eventos equivalentes: 1 evento de Sara = 1.",
    `Planner por tarea: ${weights || "sin pesos"}; si tiene varios responsables, se divide.`,
    `▲ Pendiente: eventos de Sara abiertos (últimos ${windowDays} días) en sus vuelos + tareas de Planner abiertas.`,
    `▼ Gestionado: eventos de Sara cerrados por la persona y tareas de Planner cerradas en los últimos ${d} días.`,
    "Clic en una columna para ver el detalle.",
  ]);

  const rows = [...model.people].sort((a, b) => b.load.pending - a.load.pending || b.load.done - a.load.done || a.name.localeCompare(b.name, "es"));
  loadChart.render(rows, model.series, { workDays: d });
  teamTable.columns = teamColumns(model);
  teamTable.setRows(model.people);
}

// --- vista: vuelos de Sara ----------------------------------------------------------------
const assignmentTable = new SortableTable({
  caption: "Validadores",
  sortKey: "events",
  sortDir: -1,
  onRowClick: (row) => openPerson(row.key),
  empty: "No hay validadores configurados (config.json → sources.sara.assignment).",
  columns: [
    { key: "name", label: "Validador", render: personCell },
    { key: "flights", label: "Vuelos", num: true, sort: (r) => r.sara.flights, render: (r) => fmtNumber(r.sara.flights) },
    { key: "events", label: "Eventos pendientes", num: true, sort: (r) => r.load.saraPending, render: (r) => fmtNumber(r.load.saraPending) },
    { key: "pending", label: "▲ Carga pendiente", num: true, sort: (r) => r.load.pending, render: (r) => fmt1(r.load.pending) },
    { key: "done", label: "▼ Gestionado", num: true, sort: (r) => r.load.done, render: (r) => fmt1(r.load.done) },
    {
      key: "rules",
      label: "Reglas",
      sort: (r) => (r.validator.registrations || []).length,
      render: (r) => {
        const tags = [
          ...(r.validator.active ? (r.validator.capacity !== 1 ? [tag(`capacidad ${r.validator.capacity}`)] : []) : [tag("inactivo")]),
          ...(r.validator.registrations || []).map((reg) => tag(reg, "ok")),
          ...(r.validator.restrictedTypes || []).map((t) => tag(t)),
        ];
        return tags.length ? el("span", { class: "tags" }, tags) : el("span", { class: "zero", text: "—" });
      },
    },
  ],
});
$("#assignment-table").append(assignmentTable.root);

const conflictsTable = new SortableTable({ caption: "Sin validador habilitado", sortKey: "events", sortDir: -1, columns: flightColumns(), pageSize: 50 });
const backlogTable = new SortableTable({ caption: "Rezagados", sortKey: "createdAt", columns: flightColumns({ older: true }), pageSize: 50 });
$("#assignment-conflicts .panel-body").append(conflictsTable.root);
$("#assignment-backlog .panel-body").append(backlogTable.root);

function renderAssignment(model) {
  const sara = model.sara;
  if (!sara || !sara.summary) {
    $("#assignment-kpis").replaceChildren(kpi("Vuelos de Sara", "—", sara ? "falta la lista de validadores" : "sin datos"));
    assignmentTable.setRows([]);
    $("#assignment-conflicts").hidden = true;
    $("#assignment-backlog").hidden = true;
    return;
  }
  const c = sara.summary.counts || {};
  const days = sara.window?.days ?? 180;
  const d = sara.workload?.windowDays ?? 7;
  $("#assignment-kpis").replaceChildren(
    kpi("Vuelos asignados", fmtNumber(sara.assigned.length), plural(sara.assignedEvents, "evento pendiente", "eventos pendientes"), "accent"),
    kpi("Nuevos repartidos", fmtNumber((c.assigned || 0) + (c.reassigned || 0)), `${fmtNumber(c.kept || 0)} conservan su dueño`),
    kpi("Sin validador", fmtNumber(sara.conflicts.length), "vuelos", sara.conflicts.length ? "warn" : ""),
    kpi(`Rezagados > ${days} d`, fmtNumber(sara.backlog.length), "vuelos sin dueño"),
  );
  infoList($("#assignment-info"), [
    "Lo ya asignado no se mueve: un vuelo conserva a su dueño hasta que no le quedan eventos pendientes.",
    `Cada vuelo nuevo va a quien tenga menos carga (▲ pendiente + ▼ gestionado ${d} días), según su capacidad.`,
    "Las matrículas dedicadas siempre van a su responsable y le cuentan como carga.",
    `Solo cuentan eventos isopen de los últimos ${days} días; los más antiguos son rezagados.`,
    `Última actualización: ${fmtDate(model.sourcesUpdated?.sara, true)}.`,
  ]);
  assignmentTable.setRows(model.people.filter((r) => r.validator));

  $("#assignment-conflicts").hidden = sara.conflicts.length === 0;
  $("#assignment-conflicts summary").textContent = `Sin validador habilitado (${fmtNumber(sara.conflicts.length)})`;
  conflictsTable.setRows(sara.conflicts);
  $("#assignment-backlog").hidden = false;
  $("#assignment-backlog summary").textContent = `Rezagados: eventos de más de ${days} días (${fmtNumber(sara.backlog.length)} vuelos)`;
  backlogTable.setRows(sara.backlog);
}

// --- detalle de una persona ----------------------------------------------------------
const personPlanner = new SortableTable({ caption: "Tareas abiertas de Planner", sortKey: "weight", sortDir: -1, columns: [], empty: "Sin tareas abiertas." });
const personSara = new SortableTable({ caption: "Vuelos de Sara", sortKey: "events", sortDir: -1, columns: flightColumns({ withSince: true }), empty: "Sin vuelos asignados.", pageSize: 50 });
$("#person-planner").append(personPlanner.root);
$("#person-sara").append(personSara.root);
$("#person-close").addEventListener("click", () => $("#person").close());
$("#person").addEventListener("close", () => {
  state.personKey = null;
});

function openPerson(key) {
  state.personKey = key;
  renderPerson();
  const dialog = $("#person");
  if (!dialog.open) dialog.showModal();
}

function renderPerson() {
  const model = state.model;
  const row = model?.people.find((r) => r.key === state.personKey);
  if (!row) {
    if ($("#person").open) $("#person").close();
    return;
  }
  const v = row.validator;
  const d = model.sara?.workload?.windowDays ?? 7;
  $("#person-name").textContent = row.name;
  $("#person-meta").textContent = [
    row.email || "sin correo",
    v ? (v.active ? "valida en Sara" : "validador inactivo") : null,
    v?.registrations?.length ? `solo sus matrículas: ${v.registrations.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
  $("#person-kpis").replaceChildren(
    kpi("▲ Pendiente", fmt1(row.load.pending), `Sara ${fmt1(row.load.saraPending)} · Planner ${fmt1(row.load.plannerPending)}`, "accent"),
    kpi(`▼ Gestionado ${d} días`, fmt1(row.load.done), `Sara ${fmt1(row.load.saraDone)} · Planner ${fmt1(row.load.plannerDone)}`),
  );
  personPlanner.columns = plannerColumns(Date.now(), model.sara?.workload?.weights);
  personPlanner.setRows(row.planner.tasks);
  personSara.setRows(row.sara.tasks);
}

// --- estado de los datos ------------------------------------------------------------------
function renderDataStatus(data) {
  const sources = Object.entries(data.sources || {});
  $("#data-sources").replaceChildren(
    sources.length
      ? el("table", { class: "compact-table" },
          el("thead", {}, el("tr", {}, el("th", { text: "Fuente" }), el("th", { text: "Actualizada" }), el("th", { class: "num", text: "Registros" }))),
          el("tbody", {}, sources.map(([name, info]) =>
            el("tr", {}, el("td", { text: name }), el("td", { text: fmtDate(info.updatedAt, true) }), el("td", { class: "num", text: fmtNumber(info.count) })))),
        )
      : el("p", { class: "muted", text: "Aún no hay datos." }),
  );
  const warnings = data.warnings || [];
  $("#data-warnings").replaceChildren(
    el("p", { class: "muted", text: warnings.length ? `${fmtNumber(warnings.length)} advertencias:` : "Sin advertencias." }),
    warnings.length
      ? el("ul", { class: "warnings" }, warnings.slice(0, 200).map((w) =>
          el("li", {}, el("code", { text: `${w.source ?? "combinación"}${w.sourceId ? ":" + w.sourceId : ""} · ${w.code}` }), " ", w.message)))
      : null,
  );
}

// --- carga ------------------------------------------------------------------------
function render(result) {
  const { data } = result;
  const model = buildModel(data);
  model.sourcesUpdated = Object.fromEntries(Object.entries(data.sources || {}).map(([k, v]) => [k, v.updatedAt]));
  state.model = model;
  renderTeam(model);
  renderAssignment(model);
  renderDataStatus(data);
  if (state.personKey) renderPerson();
  $("#status").className = "muted small";
  $("#status").textContent = `Actualizado ${fmtDate(data.generatedAt, true)}${result.fromCache ? " · revisando…" : ""}`;
}

function showError(error) {
  const status = $("#status");
  status.className = "error small";
  status.textContent = error.kind === "network" ? `${error.message}. ¿Está corriendo scripts/dev_server.py?` : error.message;
}

function markFresh() {
  $("#status").textContent = $("#status").textContent.replace(" · revisando…", "");
}

loadData({ onUpdate: render, onNotModified: markFresh, onError: showError })
  .then((result) => {
    if (result) render(result);
  })
  .catch(showError);
