// Pruebas de functions/ y de public/js/lib/ en el navegador, servidas por dev_server.py
// en /__tests__/. tests/test_js_functions.py las ejecuta con Edge/Chrome headless.

import { normalizeName } from "/js/lib/normalize.js";
import { buildDataset } from "/js/lib/merge.js";
import { assembleDataset } from "/js/lib/dataset.js";
import { buildModel, daysSince, shortLabel } from "/js/lib/model.js";
import { divergingScale, niceStep } from "/js/load-chart.js";
import {
  DEFAULT_MAX_INVALID_RATIO,
  isValidBatch,
  isValidSourceName,
  validateCommit,
  validatePayload,
  validateTask,
} from "/__functions__/_lib/schema.js";
import { keysMatch, ingestKeyVar, resetAccessCache, verifyAccessJwt } from "/__functions__/_lib/auth.js";
import { etagMatches, maxInvalidRatio } from "/__functions__/_lib/service.js";
import { onRequest as ingestRoute } from "/__functions__/api/ingest/%5B%5Bpath%5D%5D.js";
import { onRequest as dataRoute } from "/__functions__/api/data.js";
import { onRequest as healthRoute } from "/__functions__/api/health.js";
import { onRequest as notFoundRoute } from "/__functions__/api/%5B%5Bpath%5D%5D.js";

// --- mini harness ---------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
function assertEqual(actual, expected, label = "") {
  const a = JSON.stringify(canonical(actual));
  const e = JSON.stringify(canonical(expected));
  if (a !== e) throw new Error(`${label}\n  esperado: ${e}\n  obtenido: ${a}`);
}
function assert(condition, label) {
  if (!condition) throw new Error(label || "aserción falsa");
}

// --- datos compartidos ------------------------------------------------------------
const loadJson = (path) => fetch(path).then((r) => r.json());
const [MERGE, SCHEMA] = await Promise.all([
  loadJson("/__fixtures__/merge_cases.json"),
  loadJson("/__fixtures__/schema_cases.json"),
]);
const clone = (v) => structuredClone(v);
function applyPatch(patch) {
  const task = clone(SCHEMA.baseTask);
  for (const [key, value] of Object.entries(patch)) {
    if (value === "__delete__") delete task[key];
    else task[key] = value;
  }
  return task;
}
function makeTask(source, sourceId, overrides = {}) {
  return { ...clone(SCHEMA.baseTask), uid: `${source}:${sourceId}`, source, sourceId, ...overrides };
}

// --- casos compartidos con Python ---------------------------------------------------
test("normalizeName: casos compartidos", () => {
  for (const [raw, expected] of MERGE.normalizeName) assertEqual(normalizeName(raw), expected, JSON.stringify(raw));
});

for (const c of MERGE.cases) {
  test(`merge: ${c.name}`, () => {
    const ds = buildDataset(clone(c.snapshots), "2026-10-08T12:00:00Z");
    assertEqual(ds.generatedAt, "2026-10-08T12:00:00Z", "generatedAt");
    assertEqual(ds.sources, c.expected.sources, "sources");
    assertEqual(ds.people, c.expected.people, "people");
    assertEqual(ds.tasks.map((t) => t.uid), c.expected.taskOrder, "orden de tareas");
    assertEqual(Object.fromEntries(ds.tasks.map((t) => [t.uid, t.assignees])), c.expected.assignees, "assignees");
    assertEqual(ds.warnings, c.expected.warnings, "warnings");
    assertEqual(ds.sourceData, c.expected.sourceData ?? {}, "sourceData");
  });
}

test("merge: no modifica la entrada y conserva campos", () => {
  const ref = { key: "ana perez", name: "Ana", email: null };
  const task = { uid: "s:1", sourceId: "1", title: "T", assignees: [ref], extra: { a: 1 }, status: "x" };
  const ds = buildDataset([{ source: "s", updatedAt: "u", tasks: [task] }], "g");
  assertEqual(Object.keys(ds.tasks[0]), Object.keys(task), "orden de campos");
  assertEqual(ds.tasks[0].extra, { a: 1 });
  assert(task.assignees[0] === ref, "la entrada no debe cambiar");
});

test("schema: nombres de fuente y de lote", () => {
  for (const name of SCHEMA.sourceNames.valid) assert(isValidSourceName(name), `válido: ${name}`);
  for (const name of SCHEMA.sourceNames.invalid) assert(!isValidSourceName(name), `inválido: ${name}`);
  for (const b of SCHEMA.batches.valid) assert(isValidBatch(b), `lote válido: ${b}`);
  for (const b of SCHEMA.batches.invalid) assert(!isValidBatch(b), `lote inválido: ${b}`);
});

for (const c of SCHEMA.taskCases) {
  test(`schema task: ${c.name}`, () => {
    const task = "task" in c ? c.task : applyPatch(c.patch);
    assertEqual(validateTask(task, SCHEMA.source).map((e) => e.field).sort(), c.fields);
  });
}

for (const c of SCHEMA.payloadCases) {
  test(`schema payload: ${c.name}`, () => {
    const body = clone(c.body);
    if (c.tasksArePatches) body.tasks = body.tasks.map(applyPatch);
    const r = validatePayload(body, SCHEMA.source, c.maxInvalidRatio ?? DEFAULT_MAX_INVALID_RATIO);
    assertEqual(r.error !== null, c.expect.error, "error");
    if (c.expect.error) return;
    assertEqual(r.rejected, c.expect.rejected, "rejected");
    assertEqual(r.tasks.length, c.expect.valid, "válidas");
    assertEqual(r.invalid.length, c.expect.invalid, "inválidas");
    if (c.expect.invalidFields) {
      assertEqual(r.invalid.map((i) => i.errors.map((e) => e.field).sort()), c.expect.invalidFields, "campos");
    }
  });
}

for (const c of SCHEMA.commitCases) {
  test(`schema commit: ${c.name}`, () => {
    const r = validateCommit(clone(c.body), c.maxInvalidRatio ?? DEFAULT_MAX_INVALID_RATIO);
    assertEqual(r.error !== null, c.expect.error, `error: ${r.error}`);
    if (c.expect.error) return;
    assertEqual([r.rejected, r.received, r.invalidCount], [c.expect.rejected, c.expect.received, c.expect.invalidCount]);
  });
}

// --- modelo de la interfaz (public/js/lib/model.js) -----------------------------------
function modelFixture() {
  const ana = { key: "ana@x.com", name: "Ana", email: "ana@x.com" };
  const luis = { key: "luis@x.com", name: "Luis", email: "luis@x.com" };
  const flight = (id, events, assignees, older = 0, createdAt = "2026-09-01T00:00:00Z") => ({
    uid: `sara:${id}`, source: "sara", sourceId: id, title: id, assignees, labels: ["E1"], status: "pending",
    priority: null, createdAt, closedAt: null, extra: { openEvents: events, olderOpenEvents: older },
  });
  const planner = (id, status, priority, assignees, closedAt = null) => ({
    uid: `planner:${id}`, source: "planner", sourceId: id, title: id, assignees, labels: [], status, priority,
    createdAt: "2026-09-01T00:00:00Z", closedAt, extra: {},
  });
  return {
    generatedAt: "g",
    sources: {},
    people: [ana, luis],
    warnings: [],
    tasks: [
      planner("P1", "in_progress", "urgent", [ana]),
      planner("P2", "not_started", "low", [ana, luis]),
      planner("P3", "completed", "medium", [ana], "2026-09-05T00:00:00Z"),
      planner("P4", "not_started", null, [luis]),
      planner("P5", "not_started", "low", []), // sin responsable: no es carga de nadie
      flight("F1", 3, [ana]),
      flight("F2", 5, [ana]),
      flight("F3", 1, [luis]),
      flight("F3b", 0, [], 0),
      flight("C1", 2, []),
      flight("B1", 0, [], 4, "2025-01-01T00:00:00Z"),
    ],
    sourceData: {
      sara: {
        window: { days: 180, from: "2026-04-11T00:00:00Z" },
        workload: {
          windowDays: 7,
          to: "2026-10-08T12:00:00Z",
          weights: { Logged: 5, Assessment: 15 },
          byPerson: {
            "ana@x.com": {
              name: "Ana", email: "ana@x.com", saraDone: 7, saraInvalidated: 2,
              planner: { pending: 15, done: 2.5, byLabel: { Assessment: { pending: 15, done: 0, tasks: 1 }, Logged: { pending: 0, done: 2.5, tasks: 1 } } },
            },
            "luis@x.com": {
              name: "Luis", email: "luis@x.com", saraDone: 0, saraInvalidated: 0,
              planner: { pending: 2.5, done: 0, byLabel: { Logged: { pending: 2.5, done: 0, tasks: 1 } } },
            },
            // no valida en Sara, pero tiene carga de Planner
            "maria@x.com": {
              name: "María", email: "maria@x.com", saraDone: 0, saraInvalidated: 0,
              planner: { pending: 5, done: 0, byLabel: { Logged: { pending: 5, done: 0, tasks: 1 } } },
            },
          },
        },
        assignment: {
          validators: [
            { email: "ana@x.com", name: "Ana", active: true, capacity: 1, flights: 2, openEvents: 8, restrictedTypes: [] },
            { email: "luis@x.com", name: null, active: true, capacity: 0.5, flights: 1, openEvents: 1, restrictedTypes: ["E9"] },
            { email: "zoe@x.com", name: "Zoe", active: false, capacity: 1, flights: 0, openEvents: 0, restrictedTypes: [] },
          ],
          conflicts: ["C1"],
          backlog: { flights: 1, openEvents: 4 },
          counts: { kept: 0, assigned: 3, reassigned: 0, released: 0 },
        },
      },
    },
  };
}

test("modelo: carga justa en eventos equivalentes", () => {
  const model = buildModel(modelFixture());
  assertEqual(model.people.map((p) => p.key), ["ana@x.com", "luis@x.com", "maria@x.com", "zoe@x.com"]);
  const [ana, luis, maria, zoe] = model.people;
  // Ana: 8 pendientes (F1 + F2) + 7 gestionados + Planner 15 + 2,5
  assertEqual(ana.load, {
    saraPending: 8, saraDone: 7, saraInvalidated: 2, plannerPending: 15, plannerDone: 2.5,
    plannerByLabel: { Assessment: { pending: 15, done: 0, tasks: 1 }, Logged: { pending: 0, done: 2.5, tasks: 1 } },
    pending: 23, done: 9.5, total: 32.5,
  });
  assertEqual([luis.load.total, maria.load.total, zoe.load.total], [3.5, 5, 0]);
  assertEqual([luis.load.pending, luis.load.done], [3.5, 0]);
  assertEqual([maria.validator, zoe.validator.active], [null, false]); // María: solo Planner
  assertEqual([ana.planner.open, ana.planner.completed], [2, 1]);
  assertEqual(ana.planner.tasks.map((t) => t.sourceId), ["P1", "P2"]); // urgente primero
  assertEqual(ana.sara.tasks.map((t) => t.sourceId), ["F2", "F1"]); // más eventos primero
  assertEqual([model.planner.open, model.planner.completed, model.planner.unassigned], [4, 1, 1]);
});

test("modelo: categorías de la visual (orden y color fijos; pendiente y gestionado)", () => {
  const model = buildModel(modelFixture());
  assertEqual(model.series.map((s) => [s.key, s.label, s.slot]), [
    ["sara", "Sara", 1], ["planner:Logged", "Logged", 2], ["planner:Assessment", "Assessment", 3],
  ]);
  const ana = model.people[0];
  assertEqual(model.series.map((s) => [s.pending(ana), s.done(ana)]), [[8, 7], [0, 2.5], [15, 0]]);
  assertEqual(shortLabel("FULL INVESTIGATION (UR 500-2500))"), "FULL INVESTIGATION");
});

test("modelo: la lista del equipo decide quién se muestra", () => {
  const data = modelFixture();
  data.sourceData.sara.team = ["luis@x.com", "nuevo@x.com"];
  const model = buildModel(data);
  assertEqual(model.people.map((p) => p.key), ["luis@x.com", "nuevo@x.com"]);
  assertEqual(model.people[1].load.total, 0); // en la lista, sin carga todavía
});

test("visual: escala con cero (arriba pendiente, abajo gestionado)", () => {
  assertEqual(niceStep(0), 1);
  assertEqual(divergingScale(257.5, 135), { step: 100, up: 300, down: 200 });
  assertEqual(divergingScale(23, 9.5), { step: 10, up: 30, down: 10 });
  assertEqual(divergingScale(12, 0), { step: 2, up: 12, down: 0 });
});

test("modelo: asignación, conflictos, rezagados y objetivo de carga justa por capacidad", () => {
  const { sara, people } = buildModel(modelFixture());
  assertEqual([sara.flights, sara.assigned.length, sara.assignedEvents], [6, 3, 9]);
  assertEqual(sara.conflicts.map((t) => t.sourceId), ["C1"]);
  assertEqual(sara.backlog.map((t) => t.sourceId), ["B1"]); // solo eventos antiguos
  assertEqual(sara.backlogEvents, 4);
  const [ana, luis, , zoe] = people;
  // activos: Ana (32,5; capacidad 1) y Luis (3,5; capacidad 0,5) -> 36 repartidos 2:1
  assertEqual(sara.targetFor(ana.validator), 24);
  assertEqual(sara.targetFor(luis.validator), 12);
  assertEqual(sara.targetFor(zoe.validator), 0);
});

test("modelo: sin datos de Sara", () => {
  const data = modelFixture();
  data.tasks = data.tasks.filter((t) => t.source === "planner");
  delete data.sourceData.sara;
  const model = buildModel(data);
  assertEqual(model.sara, null);
  assertEqual(model.people.map((p) => p.validator), [null, null]);
  assertEqual(model.series.map((s) => s.key), ["sara"]);
  assertEqual(model.people.map((p) => p.load.total), [0, 0]);
});

test("modelo: daysSince", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assertEqual([daysSince("2026-10-01T12:00:00Z", now), daysSince(null, now), daysSince("x", now)], [7, null, null]);
});

// --- utilidades --------------------------------------------------------------
test("auth: keysMatch e ingestKeyVar", async () => {
  assert(await keysMatch("abc", "abc"), "iguales");
  assert(!(await keysMatch("abc", "abd")), "distintas");
  assert(!(await keysMatch("abc", "abcd")), "longitudes distintas");
  assert(!(await keysMatch(null, "abc")), "ausente");
  assertEqual(ingestKeyVar("mi-fuente_2"), "INGEST_KEY_MI_FUENTE_2");
});

test("service: etagMatches y maxInvalidRatio", () => {
  assert(etagMatches('"a"', '"a"') && etagMatches('W/"a"', '"a"') && etagMatches('"x", W/"a"', '"a"'), "coincide");
  assert(etagMatches("*", '"a"'), "comodín");
  assert(!etagMatches('"b"', '"a"') && !etagMatches(null, '"a"'), "no coincide");
  assertEqual(maxInvalidRatio({}), 0.1);
  assertEqual(maxInvalidRatio({ MAX_INVALID_RATIO: "" }), 0.1);
  assertEqual(maxInvalidRatio({ MAX_INVALID_RATIO: "0.25" }), 0.25);
  assertEqual(maxInvalidRatio({ MAX_INVALID_RATIO: "abc" }), 0.1);
  assertEqual(maxInvalidRatio({ MAX_INVALID_RATIO: "2" }), 0.1);
});

// --- endpoints con KV en memoria -----------------------------------------------------
class MemoryKV {
  constructor() { this.map = new Map(); this.writes = 0; this.deletes = 0; }
  async get(key, type) {
    const entry = this.map.get(key);
    if (entry === undefined) return null;
    return type === "json" ? JSON.parse(entry) : entry;
  }
  async put(key, value) {
    if (typeof value !== "string") throw new Error("KV de prueba: solo texto");
    this.map.set(key, value);
    this.writes += 1;
  }
  async delete(key) {
    this.map.delete(key);
    this.deletes += 1;
  }
  keys() { return [...this.map.keys()].sort(); }
}

// Petición simulada: new Request() del navegador descarta headers como Cookie o
// Content-Length, que en Workers sí llegan. Los handlers solo usan url, method, headers y arrayBuffer().
function fakeRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  const bytes = body === null ? new Uint8Array() : new TextEncoder().encode(body);
  return { url, method, headers: new Headers(headers), arrayBuffer: async () => bytes.buffer };
}

const KEY = "clave-de-prueba";
function setup(extraEnv = {}) {
  const kv = new MemoryKV();
  const env = { SEGOP_KV: kv, INGEST_KEY: KEY, ...extraEnv };

  // /api/ingest/<path>[?query]: params.path como lo entrega Pages para [[path]].js
  const call = (method, pathAndQuery, body = null, key = KEY, headers = {}) => {
    const [pathname] = pathAndQuery.split("?");
    return ingestRoute({
      request: fakeRequest(`https://x/api/ingest/${pathAndQuery}`, {
        method,
        headers: { "Content-Type": "application/json", ...(key === null ? {} : { "x-api-key": key }), ...headers },
        body: body === null ? null : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      params: { path: pathname.split("/").filter(Boolean) },
    });
  };
  const part = (source, tasks, batch = "lote0001", index = 0, key = KEY) =>
    call("POST", `${source}/parts?batch=${batch}&index=${index}`, { tasks }, key);
  const commit = (source, body, key = KEY) => call("POST", source, body, key);

  // Sube las partes y publica, como push_source.py.
  const publish = async (source, chunks, extra = {}, batch = "lote0001") => {
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const res = await part(source, chunks[i], batch, i);
      const body = await res.json();
      assertEqual(res.status, 200, JSON.stringify(body));
      parts.push({ index: i, length: body.length, received: body.received, invalidIndexes: body.invalidIndexes });
    }
    const res = await commit(source, { batch, parts, ...extra });
    const body = await res.json();
    assertEqual(res.status, 200, JSON.stringify(body));
    return body;
  };
  const get = (route, path, headers = {}) => route({ request: fakeRequest(`https://x${path}`, { headers }), env, params: {} });
  return { kv, env, call, part, commit, publish, get };
}

// GET /api/data + lo que hace el navegador (dataset.js), como en la página real.
const fetchDataset = async (get) => assembleDataset(await (await get(dataRoute, "/api/data")).json());

test("ingest: todas las rutas exigen x-api-key; sin escrituras", async () => {
  const { kv, call, part, commit } = setup();
  assertEqual((await part("planner", [], "lote0001", 0, null)).status, 401);
  assertEqual((await part("planner", [], "lote0001", 0, "otra")).status, 401);
  assertEqual((await commit("planner", {}, null)).status, 401);
  assertEqual((await call("GET", "planner/state", null, null)).status, 401);
  assertEqual(kv.writes, 0);
});

test("ingest: clave por fuente tiene prioridad", async () => {
  const { part } = setup({ INGEST_KEY_PLANNER: "solo-planner" });
  assertEqual((await part("planner", [])).status, 401);
  assertEqual((await part("planner", [], "lote0001", 0, "solo-planner")).status, 200);
  assertEqual((await part("otra", [])).status, 200);
});

test("ingest: 500 sin binding KV o sin INGEST_KEY", async () => {
  const req = () => fakeRequest("https://x/api/ingest/planner", { method: "POST", body: "{}" });
  assertEqual((await ingestRoute({ request: req(), env: {}, params: { path: ["planner"] } })).status, 500);
  const { env } = setup();
  delete env.INGEST_KEY;
  assertEqual((await ingestRoute({ request: req(), env, params: { path: ["planner"] } })).status, 500);
});

test("ingest: rutas y métodos (404/405)", async () => {
  const { call } = setup();
  let res = await call("GET", "planner");
  assertEqual([res.status, res.headers.get("Allow")], [405, "POST"]);
  res = await call("POST", "planner/state", {});
  assertEqual([res.status, res.headers.get("Allow")], [405, "GET"]);
  assertEqual((await call("POST", "planner/otra", {})).status, 404);
  assertEqual((await call("POST", "planner/parts/extra", {})).status, 404);
});

test("parte: se valida y se guarda tal cual; 1 escritura", async () => {
  const { kv, part } = setup();
  const tasks = Array.from({ length: 10 }, (_, i) => makeTask("planner", `T${i}`));
  tasks.push(makeTask("planner", "X", { priority: "alta" }));
  const res = await part("planner", tasks);
  const body = await res.json();
  assertEqual(res.status, 200, JSON.stringify(body));
  assertEqual([body.received, body.accepted, body.invalidIndexes, body.invalid[0].errors[0].field], [11, 10, [10], "priority"]);
  assertEqual([kv.writes, kv.keys()], [1, ["part:planner:lote0001:0"]]);
  const stored = await kv.get("part:planner:lote0001:0", "text");
  assertEqual(JSON.parse(stored), { tasks });
  assertEqual(body.length, stored.length);
});

test("parte: 400 por fuente, lote, índice o JSON inválidos; 422 sobre el umbral", async () => {
  const { kv, call, part } = setup();
  assertEqual((await part("Planner", [])).status, 400);
  assertEqual((await part("planner", [], "x")).status, 400);
  for (const index of ["-1", "01", "abc", "200", ""]) {
    assertEqual((await call("POST", `planner/parts?batch=lote0001&index=${index}`, { tasks: [] })).status, 400, index);
  }
  assertEqual((await call("POST", "planner/parts?batch=lote0001&index=0", "{no json")).status, 400);
  const res = await part("planner", [makeTask("planner", "T1"), makeTask("planner", "T2", { status: "" })]);
  assertEqual(res.status, 422);
  assertEqual((await res.json()).invalidCount, 1);
  assertEqual(kv.writes, 0);
});

test("413: parte > 1 MB y Content-Length declarado > 5 MB", async () => {
  const { call } = setup();
  const big = '{"tasks":[],"x":"' + "a".repeat(1024 * 1024) + '"}';
  assertEqual((await call("POST", "planner/parts?batch=lote0001&index=0", big)).status, 413);
  const declared = await call("POST", "planner", "{}", KEY, { "Content-Length": String(6 * 1024 * 1024) });
  assertEqual(declared.status, 413);
});

test("publicación: 400/422 sin escrituras; ok escribe meta e índice", async () => {
  const { kv, part, commit } = setup();
  assertEqual((await commit("planner", { batch: "lote0001", parts: [] })).status, 400);
  const over = await commit("planner", { batch: "lote0001", parts: [{ index: 0, length: 20, received: 5, invalidIndexes: [0, 1] }] });
  assertEqual(over.status, 422);
  assertEqual(kv.writes, 0);

  const p = await (await part("planner", [makeTask("planner", "T1")])).json();
  const res = await commit("planner", {
    batch: "lote0001",
    parts: [{ index: 0, length: p.length, received: 1, invalidIndexes: [] }],
    warnings: [{ source: "planner", sourceId: "T1", code: "x", message: "m" }],
  });
  const body = await res.json();
  assertEqual([res.status, body.accepted, body.warningCount, body.kvWrites], [200, 1, 1, 2]);
  assertEqual(kv.keys(), ["index", "meta:planner", "part:planner:lote0001:0"]);
});

test("publicación: la versión nueva borra las partes de la anterior", async () => {
  const { kv, publish } = setup();
  await publish("planner", [[makeTask("planner", "T1")], [makeTask("planner", "T2")]], {}, "lote0001");
  await publish("planner", [[makeTask("planner", "T3")]], {}, "lote0002");
  assertEqual(kv.deletes, 2);
  assertEqual(kv.keys(), ["index", "meta:planner", "part:planner:lote0002:0"]);
});

test("state: devuelve los dueños publicados", async () => {
  const { call, publish } = setup();
  assertEqual(await (await call("GET", "sara/state")).json(), { updatedAt: null, owners: {} });
  const owners = { F1: { owner: "a@x.com", since: "t" } };
  await publish("sara", [[]], { assignment: { owners, summary: { counts: {} } } });
  assertEqual((await (await call("GET", "sara/state")).json()).owners, owners);
});

test("data: vacío antes de ingerir, ETag y 304", async () => {
  const { publish, get } = setup();
  let res = await get(dataRoute, "/api/data");
  assertEqual(res.status, 200);
  const empty = await res.json();
  assertEqual(empty, { generatedAt: null, sources: {}, parts: {} });
  assertEqual(assembleDataset(empty), { generatedAt: null, sources: {}, people: [], tasks: [], warnings: [], sourceData: {} });

  await publish("planner", [[makeTask("planner", "T1")]]);
  res = await get(dataRoute, "/api/data");
  const etag = res.headers.get("ETag");
  assert(/^"[0-9a-f]{64}"$/.test(etag), "ETag sha256");
  assertEqual(res.headers.get("Cache-Control"), "private, no-cache");
  assertEqual(assembleDataset(await res.json()).tasks.length, 1);

  res = await get(dataRoute, "/api/data", { "If-None-Match": etag });
  assertEqual([res.status, res.headers.get("ETag")], [304, etag]);
  assertEqual((await get(dataRoute, "/api/data", { "If-None-Match": `W/${etag}` })).status, 304);

  await publish("planner", [[makeTask("planner", "T2")]], {}, "lote0002");
  res = await get(dataRoute, "/api/data", { "If-None-Match": etag });
  assertEqual(res.status, 200);
  assert(res.headers.get("ETag") !== etag, "ETag cambia");
});

test("data: partes a medio propagar en KV -> sin ETag y no-store", async () => {
  const { kv, publish, get } = setup();
  await publish("planner", [[makeTask("planner", "T1")]]);
  await kv.put("part:planner:lote0001:0", '{"tasks":[]}'); // parte de otra versión
  const res = await get(dataRoute, "/api/data");
  assertEqual([res.status, res.headers.get("ETag"), res.headers.get("Cache-Control")], [200, null, "no-store"]);
});

test("data + navegador: combina dos fuentes y unifica personas; republicar reemplaza la fuente", async () => {
  const { publish, get } = setup();
  const ana = { key: "ana@example.com", name: "Ana Pérez", email: "ana@example.com" };
  await publish("planner", [[makeTask("planner", "T1", { assignees: [ana] })]]);
  await publish("auditorias", [[makeTask("auditorias", "A1", { assignees: [{ key: "ana perez", name: "ANA PEREZ", email: null }] })]]);
  let data = await fetchDataset(get);
  assertEqual(Object.keys(data.sources).sort(), ["auditorias", "planner"]);
  assertEqual(data.tasks.map((t) => t.uid), ["planner:T1", "auditorias:A1"]);
  assertEqual([data.people.length, data.people[0].taskCount], [1, 2]);
  assertEqual(data.tasks[1].assignees, [ana]);

  await publish("planner", [[]], {}, "lote0002");
  data = await fetchDataset(get);
  assertEqual(data.sources.planner.count, 0);
  assertEqual(data.tasks.map((t) => t.uid), ["auditorias:A1"]);
  assertEqual(data.people[0].key, "ana perez");
});

test("data + navegador: varias partes, inválidas fuera y warnings publicados", async () => {
  const { publish, get } = setup();
  const first = Array.from({ length: 10 }, (_, i) => makeTask("planner", `T${i}`));
  first.splice(3, 0, makeTask("planner", "X", { priority: "alta" }));
  await publish("planner", [first, [makeTask("planner", "Z")]], {
    warnings: [{ source: "planner", sourceId: "T1", code: "x", message: "m" }],
    sourceData: { k: 1 },
  });
  const data = await fetchDataset(get);
  assert(!data.tasks.some((t) => t.sourceId === "X"), "la inválida no aparece");
  assertEqual(data.tasks.map((t) => t.sourceId), ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "Z"]);
  assertEqual(data.warnings.map((w) => w.code), ["x"]);
  assertEqual(data.sources.planner.count, 11);
  assertEqual(data.sourceData.planner, { k: 1 });
});

test("data + navegador: dueños de la asignación como responsables y resumen", async () => {
  const { publish, get } = setup();
  const flight = (id) => ({
    ...makeTask("sara", id, { assignees: [], labels: ["E1"], status: "pending", priority: null }),
    extra: { openEvents: 2, inWindow: true },
  });
  const owners = { F1: { owner: "a@x.com", since: "2026-10-01T00:00:00.000Z" } };
  const summary = {
    validators: [{ email: "a@x.com", name: "Ana", active: true, capacity: 1, flights: 1, openEvents: 2, restrictedTypes: [] }],
    conflicts: [], backlog: { flights: 1, openEvents: 2 }, counts: { kept: 0, assigned: 1, reassigned: 0, released: 0 },
  };
  await publish("sara", [[flight("F1"), flight("F2")]], {
    sourceData: { validationStats: { byPerson: {} } },
    assignment: { owners, summary },
  });
  await publish("planner", [[makeTask("planner", "T1", { assignees: [{ key: "a@x.com", name: "Ana Pérez", email: "a@x.com" }] })]]);
  const data = await fetchDataset(get);
  const f1 = data.tasks.find((t) => t.uid === "sara:F1");
  const f2 = data.tasks.find((t) => t.uid === "sara:F2");
  assertEqual(f1.assignees, [{ key: "a@x.com", name: "Ana Pérez", email: "a@x.com" }]); // nombre de Planner
  assertEqual(f1.assignedSince, "2026-10-01T00:00:00.000Z");
  assertEqual(f2.assignees, []);
  assertEqual(data.sourceData.sara.assignment, summary);
  assertEqual(data.sourceData.sara.validationStats, { byPerson: {} });
  assertEqual(data.people.find((p) => p.key === "a@x.com").taskCount, 2);
});

test("health: vacío, luego estado por fuente sin datos personales", async () => {
  const { publish, get } = setup();
  assertEqual((await (await get(healthRoute, "/api/health")).json()).status, "empty");
  await publish("planner", [[makeTask("planner", "T1")]]);
  const text = await (await get(healthRoute, "/api/health")).text();
  const body = JSON.parse(text);
  assertEqual([body.status, body.sources.planner.count], ["ok", 1]);
  assert(!text.includes("@"), "sin correos");
});

test("rutas: 405 en data/health con POST; 404 JSON en /api desconocida", async () => {
  const { env } = setup();
  assertEqual((await dataRoute({ request: fakeRequest("https://x/api/data", { method: "POST" }), env })).status, 405);
  assertEqual((await healthRoute({ request: fakeRequest("https://x/api/health", { method: "POST" }), env })).status, 405);
  const res = notFoundRoute();
  assertEqual(res.status, 404);
  assertEqual((await res.json()).error, "ruta no encontrada");
});

// --- Cloudflare Access (JWT RS256 con llaves generadas aquí) -------------------------------
const TEAM = "equipo-prueba.cloudflareaccess.com";
const AUD = "aud-de-prueba";
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function accessFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const sign = async (payload, header = { alg: "RS256", kid: "k1", typ: "JWT" }) => {
    const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(sig)}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, iat: now, email: "ana@example.com" };
  return { jwk, sign, claims, now };
}

async function withFakeCerts(jwk, fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`fetch inesperado: ${url}`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  };
  resetAccessCache();
  try {
    await fn(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    resetAccessCache();
  }
}

test("access: JWT válido, inválidos y caché de llaves", async () => {
  const { jwk, sign, claims, now } = await accessFixture();
  const env = { ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD };
  await withFakeCerts(jwk, async (calls) => {
    assert((await verifyAccessJwt(await sign(claims), env)).ok, "válido");
    assert((await verifyAccessJwt(await sign({ ...claims, aud: AUD }), env)).ok, "aud como texto");
    assertEqual((await verifyAccessJwt(await sign({ ...claims, aud: ["otra"] }), env)).reason, "audiencia (aud) incorrecta");
    assertEqual((await verifyAccessJwt(await sign({ ...claims, iss: "https://otro.cloudflareaccess.com" }), env)).reason, "emisor (iss) incorrecto");
    assertEqual((await verifyAccessJwt(await sign({ ...claims, exp: now - 3600 }), env)).reason, "token expirado");
    assertEqual((await verifyAccessJwt(await sign({ ...claims, nbf: now + 3600 }), env)).reason, "token aún no válido");
    assertEqual((await verifyAccessJwt(await sign(claims, { alg: "HS256", kid: "k1" }), env)).reason, "algoritmo no soportado");
    assertEqual((await verifyAccessJwt(await sign(claims, { alg: "RS256", kid: "otra" }), env)).reason, "llave de firma desconocida");
    const token = await sign(claims);
    const tampered = token.split(".");
    tampered[1] = b64urlJson({ ...claims, email: "otro@example.com" });
    assertEqual((await verifyAccessJwt(tampered.join("."), env)).reason, "firma inválida");
    assert(!(await verifyAccessJwt("no-es-jwt", env)).ok, "mal formado");
    assert(!(await verifyAccessJwt(null, env)).ok, "ausente");
    // 1 descarga inicial (luego caché) + 1 forzada por el kid desconocido = 2
    assertEqual(calls(), 2, "llamadas a /certs");
  });
});

test("access: /api/data exige JWT solo si ACCESS_* están configuradas", async () => {
  const { jwk, sign, claims } = await accessFixture();
  await withFakeCerts(jwk, async () => {
    const { get } = setup({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    const denied = await get(dataRoute, "/api/data");
    assertEqual(denied.status, 403);
    assertEqual((await get(dataRoute, "/api/data", { "Cf-Access-Jwt-Assertion": await sign(claims) })).status, 200);
    assertEqual((await get(dataRoute, "/api/data", { Cookie: `otra=1; CF_Authorization=${await sign(claims)}` })).status, 200);
    assertEqual((await get(dataRoute, "/api/data", { "Cf-Access-Jwt-Assertion": await sign({ ...claims, aud: ["x"] }) })).status, 403);
  });
  const { get } = setup();
  assertEqual((await get(dataRoute, "/api/data")).status, 200);
});

// --- ejecución -------------------------------------------------------------------
const list = document.getElementById("list");
const failures = [];
for (const { name, fn } of tests) {
  const li = document.createElement("li");
  try {
    await fn();
    li.className = "ok";
    li.textContent = `✔ ${name}`;
  } catch (error) {
    failures.push({ name, error: String(error && error.message ? error.message : error) });
    li.className = "fail";
    li.textContent = `✘ ${name}`;
    const pre = document.createElement("pre");
    pre.className = "err";
    pre.textContent = failures.at(-1).error;
    li.append(pre);
  }
  list.append(li);
}
const passed = tests.length - failures.length;
const summary = document.getElementById("summary");
summary.className = failures.length ? "fail" : "ok";
summary.textContent = `${passed}/${tests.length} pruebas OK`;
const results = { total: tests.length, passed, failures, userAgent: navigator.userAgent };
document.getElementById("results").textContent = JSON.stringify(results);
document.title = failures.length ? `FALLAN ${failures.length}` : `OK ${passed}`;
// Para tests/test_js_functions.py (ejecución headless).
fetch("/__tests__/results", { method: "POST", body: JSON.stringify(results) }).catch(() => {});
