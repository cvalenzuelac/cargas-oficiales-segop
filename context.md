# Contexto

Soy Data Engineer. Necesito el backend en Cloudflare para una app web de seguimiento de actividades de un equipo. Restricciones duras:

- NO tengo credenciales de Microsoft Graph ni Azure. Los datos NO se extraen desde Cloudflare: se EMPUJAN hacia Cloudflare.
- Flujo actual: Power Automate extrae tareas de Planner y guarda un CSV en SharePoint → la biblioteca está sincronizada con OneDrive en mi PC → un script Python local lee el CSV y hace POST a Cloudflare (programado con el Programador de tareas de Windows).
- Solo plan gratuito de Cloudflare: Pages + Pages Functions + Workers KV.
- **Sin Node, npm, wrangler, TypeScript ni ningún paso de build.** Solo HTML, CSS, JavaScript plano (ES modules) y Python con librería estándar (sin pip). Las Functions se escriben en JS plano en `/functions` y Cloudflare las despliega desde GitHub (integración Git de Pages, sin comando de build, directorio de salida `public`). Bindings y secretos se configuran en el dashboard de Cloudflare.
- Los datos contienen nombres y correos de personas: todo excepto el endpoint de ingesta irá detrás de Cloudflare Access.
- **Sin CLI de git.** Todas las acciones de git (commits, push, ramas) las hago yo manualmente con GitHub Desktop. No ejecutes comandos `git`.

# Fuentes de datos

## Fuente 1: `planner` (ya existe)
Archivo local (sincronizado por OneDrive), exactamente el mismo que se enviará por POST:
`C:\Users\cdcruz\OneDrive - Aerovias del Continente Americano S.A. AVIANCA\Shortcuts\Team Channel - SOP - Control Interno - Gerencia FLT Safety\asignaciones_aqd_oficiales.csv`

Esta ruta va en `config.json` (ignorado por git), no en el código ni en `config.example.json`.

CSV UTF-8 con BOM, delimitador coma, campos con comas entre comillas. Columnas:

| Columna | Formato |
|---|---|
| Id | id de tarea de Planner |
| Titulo | texto |
| Responsables | nombres separados por "; " (vacío si no hay responsables) |
| Correos | correos separados por "; ", mismo orden que Responsables (vacío si no hay responsables) |
| Etiquetas | nombres separados por "; " (puede estar vacío) |
| Estado | "No iniciada" / "En curso" / "Completada" |
| Prioridad | "Urgente" / "Importante" / "Media" / "Baja" |
| FechaCreacion | "yyyy-MM-dd HH:mm", hora de Bogotá (UTC-5) |
| FechaCierre | mismo formato, vacío si no está cerrada |

## Fuente 2+: por definir
Habrá al menos otro proceso con tareas de las MISMAS personas, con un esquema que aún no conozco. Agregar una fuente nueva debe requerir solo escribir un adaptador en Python y registrarlo, sin tocar las Functions. No inventes el esquema de la fuente 2: deja un adaptador plantilla documentado.

# Reparto de responsabilidades

- **Python (local)**: lee el CSV, aplica el adaptador de la fuente, normaliza al modelo común, valida y envía las tareas ya normalizadas.
- **Functions (Cloudflare)**: autentican, validan la estructura del payload, guardan el snapshot de la fuente, combinan todas las fuentes, unifican personas entre fuentes y sirven el dataset.

# Modelo común (lo produce Python, lo valida la Function)

```
Task {
  uid: string            // "<source>:<sourceId>"
  source: string
  sourceId: string
  title: string
  assignees: PersonRef[]
  labels: string[]
  status: "not_started" | "in_progress" | "completed" | string
  priority: "urgent" | "important" | "medium" | "low" | null
  createdAt: string | null   // ISO 8601 con offset -05:00
  closedAt: string | null
  extra: object              // campos propios de la fuente
}
PersonRef { key: string, name: string, email: string | null }
```

Identidad de persona (`key`): correo en minúsculas. En `planner` el correo siempre viene; si Responsables y Correos no tienen la misma cantidad de elementos, o un correo está vacío, el adaptador emite un warning para esa tarea y usa el nombre normalizado (sin tildes, minúsculas, espacios colapsados) como key de respaldo. Otras fuentes podrían no traer correo: al combinar, la Function unifica a esa persona con una existente cuando el nombre normalizado coincide de forma inequívoca con el `name` de alguien que tiene correo, y registra los casos ambiguos en `warnings` en lugar de adivinar.

# Functions (JS plano, ES modules, sin dependencias)

- `POST /api/ingest/:source`
  - Header `x-api-key`, comparado en tiempo constante contra el secreto `INGEST_KEY`. Soporta opcionalmente un secreto por fuente (`INGEST_KEY_<SOURCE>`).
  - Body: `{ "tasks": [Task...], "warnings": [...], "generatedAt": "..." }`.
  - Rechaza payloads > 5 MB y tareas con estructura inválida (reporta cuáles). Rechaza la carga completa si las inválidas superan un umbral configurable.
  - Guarda el snapshot de la fuente en KV y RECONSTRUYE el dataset combinado, que queda precalculado para que la lectura sea un solo GET a KV. Para saber qué fuentes existen, mantén un índice de fuentes en KV.
  - Responde con conteos, warnings y `updatedAt`.
- `GET /api/data`: dataset combinado `{ generatedAt, sources: {name: {updatedAt, count}}, people, tasks, warnings }` con ETag y soporte de `If-None-Match` → 304.
- `GET /api/health`: estado y última actualización por fuente, sin datos personales.
- Aísla el acceso a KV en un módulo de almacenamiento (`functions/_lib/`), para poder cambiar KV por R2 sin tocar los endpoints.
- Límites del plan gratuito de KV: 1.000 escrituras/día y consistencia eventual (~60 s). Minimiza las escrituras por ingesta y documenta cuántas hace cada una.
- Defensa en profundidad opcional: si existen las variables `ACCESS_TEAM_DOMAIN` y `ACCESS_AUD`, `/api/data` valida el JWT de Cloudflare Access (`Cf-Access-Jwt-Assertion`) usando WebCrypto y las llaves públicas del team. Si no existen, se omite la validación.

# Python (solo librería estándar)

- `scripts/push_source.py`, genérico por fuente, configurado con un archivo JSON (ruta del CSV, nombre de fuente, delimitador, adaptador). Requisitos:
  - Lee con `utf-8-sig`.
  - Detecta cambios por hash SHA-256 con estado por fuente.
  - Lee URL y API key de variables de entorno.
  - Usa `urllib.request` con reintentos y backoff.
  - Lleva log a archivo rotativo (`logging.handlers`) y sale con código distinto de cero si falla.
  - Tiene modo `--dry-run` que muestra el payload normalizado sin enviarlo.
- `scripts/adapters/`: `planner.py` completo y `template.py` documentado, con un registro simple de adaptadores.
- Tests con `unittest`:
  - Unitarios: adaptadores, normalización de nombres, fechas a ISO -05:00 y desalineación Responsables/Correos. Usa un CSV ficticio en `fixtures/`.
  - De integración, opcionales: contra una URL de preview deployment pasada por variable de entorno. Verifican ingesta, 401 sin key, ETag/304 y la combinación de dos fuentes.
- Instrucciones para el Programador de tareas de Windows (pythonw, ejecutar solo con sesión iniciada).

# Desarrollo local

Aunque el proyecto se hospeda en Cloudflare, debo poder correrlo en local durante el desarrollo, sin Node ni wrangler:
- `scripts/dev_server.py` (solo librería estándar, `http.server`): sirve `public/` y emula `POST /api/ingest/:source`, `GET /api/data` y `GET /api/health` con el mismo contrato que las Functions (mismos payloads, respuestas, códigos de estado, ETag/304 y validación de `x-api-key`). La autenticación con Access no aplica en local.
- El almacenamiento local es una carpeta de archivos JSON (por ejemplo `.local-data/`, ignorada por git) que reemplaza a KV.
- Flujo local: `push_source.py` apuntando a `http://localhost:<puerto>` con el CSV real de la ruta de arriba → abrir `public/index.html` servido por `dev_server.py`.
- La lógica de combinación y unificación de personas quedará en JS (Functions) y en Python (servidor local): deben comportarse igual. Usa casos de prueba compartidos en `fixtures/` y tests de `unittest` que los verifiquen del lado de Python.
- Ni el dataset generado en local ni el CSV real se suben al repo.

# Cliente (sin build)

No construyas UI todavía. Solo:
- `public/js/data-client.js`: módulo ES que carga `/api/data`, cachea en IndexedDB con ETag (API nativa de IndexedDB o `idb-keyval` desde cdn.jsdelivr.net), devuelve el caché de inmediato y refresca en segundo plano.
- `public/index.html` mínimo que use el módulo y muestre conteos por fuente y persona, para probar el despliegue.

Solo se permiten scripts externos desde cdnjs.cloudflare.com y cdn.jsdelivr.net.

# Entregables

1. Estructura del repo: `public/`, `functions/`, `scripts/`, `fixtures/`, `tests/`.
2. Functions, módulo de almacenamiento y validación de esquema en JS plano.
3. Script Python, adaptadores, `dev_server.py` y tests.
4. README en español con:
   - Desarrollo local con `dev_server.py` y el CSV real.
   - Flujo de commits con GitHub Desktop (qué no subir: `config.json`, `.local-data/`, estado del script, logs).
   - Conexión del repo a Cloudflare Pages (sin comando de build, salida `public`).
   - Creación del namespace KV y binding en producción y preview.
   - Secretos y variables.
   - Configuración de Cloudflare Access (aplicación sobre todo el sitio + bypass para `/api/ingest/*`).
   - Cómo probar con preview deployments.
   - Cómo agregar una fuente nueva paso a paso.
5. Nada de secretos en el repo; `config.example.json` como plantilla.

# Forma de trabajo

- Antes de escribir código, presenta un plan breve (estructura, decisiones, dudas) y espera mi confirmación.
- Pregunta en lugar de asumir si algo es ambiguo.
- Avanza en partes pequeñas. Al cerrar cada parte, dime qué archivos incluir en el commit y un mensaje de commit sugerido para hacerlo en GitHub Desktop.
- Corre los tests de Python antes de dar cada parte por terminada. Para las Functions, explícame qué probar en local con `dev_server.py` y qué en el preview deployment.
- Pregúntame si va en un repo nuevo o dentro de uno existente.