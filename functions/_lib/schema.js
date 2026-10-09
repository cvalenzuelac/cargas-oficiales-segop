// Validación del payload de ingesta y de cada Task del modelo común.
// Gemelo de scripts/common/schema.py; casos compartidos en fixtures/schema_cases.json.
// Cada error es { field, message }.

export const DEFAULT_MAX_INVALID_RATIO = 0.1;
export const PRIORITIES = ["urgent", "important", "medium", "low"];
export const MAX_PARTS = 200;
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const BATCH_RE = /^[a-z0-9]{8,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isStr = (v) => typeof v === "string";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNullish = (v) => v === null || v === undefined;

export function isValidSourceName(name) {
  return isStr(name) && SOURCE_NAME_RE.test(name);
}

export function isValidBatch(batch) {
  return isStr(batch) && BATCH_RE.test(batch);
}

const isInt = (v) => Number.isInteger(v);

/**
 * Valida el cuerpo de la confirmación (POST /api/ingest/:source) que publica una
 * versión subida por partes. Devuelve { error, rejected, received, invalidCount }.
 *   { batch, parts: [{ index, length, received, invalidIndexes }], generatedAt?,
 *     warnings?, sourceData?, assignment?: { owners: { id: { owner, since } }, summary } }
 */
export function validateCommit(body, maxInvalidRatio = DEFAULT_MAX_INVALID_RATIO) {
  const fail = (error) => ({ error, rejected: false, received: 0, invalidCount: 0 });
  if (!isObj(body)) return fail("el cuerpo debe ser un objeto JSON");
  if (!isValidBatch(body.batch)) return fail('"batch" debe tener 8 a 64 letras minúsculas o números');
  const { parts } = body;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    return fail(`"parts" debe ser una lista de 1 a ${MAX_PARTS} partes`);
  }
  let received = 0;
  let invalidCount = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!isObj(p) || p.index !== i) return fail(`parts[${i}].index debe ser ${i}`);
    if (!isInt(p.length) || p.length < 2) return fail(`parts[${i}].length debe ser un entero`);
    if (!isInt(p.received) || p.received < 0) return fail(`parts[${i}].received debe ser un entero >= 0`);
    if (!Array.isArray(p.invalidIndexes) || !p.invalidIndexes.every((x) => isInt(x) && x >= 0 && x < p.received)) {
      return fail(`parts[${i}].invalidIndexes debe ser una lista de posiciones válidas`);
    }
    received += p.received;
    invalidCount += p.invalidIndexes.length;
  }
  const warnings = isNullish(body.warnings) ? [] : body.warnings;
  if (!Array.isArray(warnings) || !warnings.every(isObj)) return fail('"warnings" debe ser una lista de objetos');
  if (!isNullish(body.generatedAt) && !isStr(body.generatedAt)) return fail('"generatedAt" debe ser texto');
  if (!isNullish(body.sourceData) && !isObj(body.sourceData)) return fail('"sourceData" debe ser un objeto');
  if (!isNullish(body.assignment)) {
    const { assignment } = body;
    if (!isObj(assignment) || !isObj(assignment.owners) || !isObj(assignment.summary)) {
      return fail('"assignment" debe ser { owners, summary }');
    }
    for (const [id, o] of Object.entries(assignment.owners)) {
      if (!isObj(o) || !isStr(o.owner) || !o.owner.includes("@") || !isStr(o.since)) {
        return fail(`assignment.owners["${id}"] debe ser { owner: correo, since: fecha }`);
      }
    }
  }
  const rejected = received > 0 && invalidCount / received > maxInvalidRatio;
  return { error: null, rejected, received, invalidCount };
}

export function validateTask(task, source) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!isObj(task)) {
    err("task", "debe ser un objeto");
    return errors;
  }

  const sourceId = task.sourceId;
  const sourceIdOk = isStr(sourceId) && sourceId !== "";
  if (!sourceIdOk) err("sourceId", "debe ser texto no vacío");
  if (task.source !== source) err("source", `debe ser "${source}"`);
  if (sourceIdOk && task.uid !== `${source}:${sourceId}`) err("uid", `debe ser "${source}:${sourceId}"`);
  if (!isStr(task.title)) err("title", "debe ser texto");

  if (!Array.isArray(task.assignees)) {
    err("assignees", "debe ser una lista");
  } else {
    task.assignees.forEach((ref, i) => {
      const prefix = `assignees[${i}]`;
      if (!isObj(ref)) {
        err(prefix, "debe ser un objeto");
        return;
      }
      const { key, name, email } = ref;
      if (!isStr(name)) err(`${prefix}.name`, "debe ser texto");
      if (!isNullish(email) && !(isStr(email) && email.includes("@"))) {
        err(`${prefix}.email`, "debe ser un correo o null");
      } else if (!(isStr(key) && key !== "")) {
        err(`${prefix}.key`, "debe ser texto no vacío");
      } else if (!isNullish(email) && key !== email.toLowerCase()) {
        err(`${prefix}.key`, "debe ser el correo en minúsculas");
      }
    });
  }

  if (!Array.isArray(task.labels)) {
    err("labels", "debe ser una lista");
  } else {
    task.labels.forEach((label, i) => {
      if (!isStr(label)) err(`labels[${i}]`, "debe ser texto");
    });
  }

  if (!(isStr(task.status) && task.status !== "")) err("status", "debe ser texto no vacío");
  if (!isNullish(task.priority) && !PRIORITIES.includes(task.priority)) {
    err("priority", `debe ser null o uno de: ${PRIORITIES.join(", ")}`);
  }
  for (const field of ["createdAt", "closedAt"]) {
    const value = task[field];
    if (!isNullish(value) && !(isStr(value) && ISO_DATE_RE.test(value))) {
      err(field, "debe ser null o fecha ISO 8601 con zona horaria");
    }
  }
  if (!isObj(task.extra)) err("extra", "debe ser un objeto");
  return errors;
}

/**
 * Valida el cuerpo de POST /api/ingest/:source.
 * Devuelve { error, rejected, tasks, invalid, warnings, generatedAt, sourceData }:
 * - error: texto si la estructura general es inválida (HTTP 400), si no null.
 * - rejected: true si las tareas inválidas superan maxInvalidRatio (HTTP 422).
 */
export function validatePayload(body, source, maxInvalidRatio = DEFAULT_MAX_INVALID_RATIO) {
  const result = {
    error: null, rejected: false, tasks: [], invalid: [], warnings: [], generatedAt: null, sourceData: null,
  };
  if (!isObj(body)) {
    result.error = "el cuerpo debe ser un objeto JSON";
    return result;
  }
  const { tasks } = body;
  if (!Array.isArray(tasks)) {
    result.error = '"tasks" debe ser una lista';
    return result;
  }
  const warnings = isNullish(body.warnings) ? [] : body.warnings;
  if (!Array.isArray(warnings) || !warnings.every(isObj)) {
    result.error = '"warnings" debe ser una lista de objetos';
    return result;
  }
  const generatedAt = isNullish(body.generatedAt) ? null : body.generatedAt;
  if (generatedAt !== null && !isStr(generatedAt)) {
    result.error = '"generatedAt" debe ser texto';
    return result;
  }
  const sourceData = isNullish(body.sourceData) ? null : body.sourceData;
  if (sourceData !== null && !isObj(sourceData)) {
    result.error = '"sourceData" debe ser un objeto';
    return result;
  }

  const seen = new Set();
  tasks.forEach((task, index) => {
    let errors = validateTask(task, source);
    const uid = isObj(task) && isStr(task.uid) ? task.uid : null;
    if (errors.length === 0 && seen.has(uid)) errors = [{ field: "uid", message: "repetido en el payload" }];
    if (errors.length) {
      result.invalid.push({ index, uid, errors });
    } else {
      seen.add(uid);
      result.tasks.push(task);
    }
  });

  const ratio = tasks.length ? result.invalid.length / tasks.length : 0;
  result.rejected = ratio > maxInvalidRatio;
  result.warnings = warnings;
  result.generatedAt = generatedAt;
  result.sourceData = sourceData;
  return result;
}
