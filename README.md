# Seguimiento de actividades — backend en Cloudflare

App web para ver la carga de trabajo de cada persona del equipo y repartir de forma equilibrada la validación de eventos:

1. **Carga por persona:** tareas de Planner y vuelos con eventos de severidad alta pendientes de validar en Sara, unidos por el correo.
2. **Asignación equilibrada y persistente:** los vuelos con eventos abiertos se reparten entre los validadores. Un vuelo conserva a su dueño hasta que se gestionan todos sus eventos.

Los datos **se empujan** a Cloudflare desde un PC con Windows; Cloudflare nunca los extrae (no hay credenciales de Microsoft Graph ni Azure).

```
Planner ─Power Automate─▶ CSV en SharePoint ─OneDrive─▶ ┐
API de Sara (CSV de eventos, clave en el PC) ─────────▶ ┤ PC: scripts/push_source.py --all
                                                        │ (Programador de tareas, 8:00 y 13:00)
                                                        │ lee → adaptador → modelo común → valida
                                                        │ Sara: calcula la asignación con los dueños
                                                        │       vigentes (GET .../state)
                                                        ▼ sube por partes y publica (x-api-key)
                 Cloudflare Pages Functions ── Workers KV (partes, versión publicada por fuente, índice)
                                                        │ GET /api/data (detrás de Cloudflare Access)
                                                        ▼
            navegador: public/ — combina fuentes, unifica personas, caché IndexedDB + ETag
```

Restricciones del proyecto: plan gratuito de Cloudflare (Pages + Functions + KV); sin Node, npm, wrangler ni paso de build; solo HTML/CSS/JS plano y Python con librería estándar; git solo con GitHub Desktop.

## Contenido

1. [Estructura del repo](#1-estructura-del-repo)
2. [Desarrollo local](#2-desarrollo-local)
3. [Fuentes y lista de validadores](#3-fuentes-y-lista-de-validadores)
4. [Commits con GitHub Desktop](#4-commits-con-github-desktop)
5. [Conectar el repo a Cloudflare Pages](#5-conectar-el-repo-a-cloudflare-pages)
6. [Namespace KV y binding](#6-namespace-kv-y-binding)
7. [Secretos y variables](#7-secretos-y-variables)
8. [Cloudflare Access](#8-cloudflare-access)
9. [Probar con preview deployments](#9-probar-con-preview-deployments)
10. [Envío automático con el Programador de tareas](#10-envío-automático-con-el-programador-de-tareas)
11. [Agregar una fuente nueva](#11-agregar-una-fuente-nueva)
12. [Referencia: contrato de la API](#12-referencia-contrato-de-la-api)
13. [Límites del plan gratuito](#13-límites-del-plan-gratuito)
14. [Problemas frecuentes](#14-problemas-frecuentes)

---

## 1. Estructura del repo

```
public/                       Sitio estático (salida de Pages, sin build)
  index.html, js/index.js     Interfaz: "Carga del equipo", "Asignación Sara" y detalle por persona
  js/ui.js                    Utilidades de interfaz (tabla ordenable, barras, formatos)
  js/load-chart.js            Visual de carga por persona (Planner por etiqueta + Sara)
  js/data-client.js           Carga /api/data con caché IndexedDB + ETag y entrega el dataset combinado
  js/lib/model.js             Cálculos de la interfaz (carga por persona, objetivo, conflictos, rezagados)
  js/lib/dataset.js           Arma el dataset a partir de /api/data (partes, inválidas, dueños)
  js/lib/merge.js             Combina fuentes y unifica personas
  js/lib/normalize.js         Normalización de nombres (gemelo de scripts/common/normalize.py)
  _headers                    Cabeceras de seguridad (CSP) para Pages
functions/                    Pages Functions (JS plano, ES modules, sin dependencias)
  api/ingest/[[path]].js      /api/ingest/:fuente, /parts y /state
  api/data.js                 GET /api/data
  api/health.js               GET /api/health
  api/[[path]].js             404 JSON para cualquier otra ruta /api/*
  _lib/storage.js             Único módulo que toca KV (cambiar a R2 = reescribir este archivo)
  _lib/service.js             Lógica de ingesta, lectura y health
  _lib/schema.js              Validación de tareas, partes y publicación (gemelo de schema.py)
  _lib/auth.js                x-api-key en tiempo constante + JWT de Cloudflare Access
  _lib/http.js                Respuestas JSON
scripts/
  push_source.py              Lee cada fuente, normaliza, asigna (Sara) y envía (Programador de tareas)
  dev_server.py               Emula Pages + Functions + KV en local
  adapters/                   Un adaptador por fuente: planner.py, sara.py, template.py (+ registro)
  common/                     normalize, schema, ingest (gemelos de functions/), assignment, csv_source
fixtures/                     CSV ficticios y casos compartidos JS/Python
tests/                        unittest (Python) + tests/js/ (pruebas JS en el navegador)
config.example.json           Plantilla de config.json (fuentes, rutas, validadores)
.env.example                  Plantilla de .env (URL, claves)
.vscode/                      Live Server (Go Live) con proxy a dev_server y tareas de VS Code
```

**Dónde vive cada lógica:**

| Lógica | Dónde | Por qué |
|---|---|---|
| Adaptadores, validación previa, **asignación** | Python (`scripts/`) | Corre en el PC, sin límite de CPU |
| Validación de lo que llega, almacenamiento | Functions (`functions/_lib/`) + gemelo Python para `dev_server.py` | Defensa en el servidor |
| Combinación de fuentes y **unificación de personas** | Navegador (`public/js/lib/`) | El plan gratuito da 10 ms de CPU por invocación ([sección 13](#13-límites-del-plan-gratuito)) |

Las piezas que existen en dos lenguajes (`normalize`, `schema`, `ingest`) se prueban contra los mismos casos de `fixtures/`. Si cambias una regla, cambia los dos lados y agrega el caso al fixture.

## 2. Desarrollo local

Requisitos: Python 3.10+ (probado con 3.12) y VS Code con la extensión **Live Server**. Edge o Chrome para las pruebas JS.

### Primera vez

1. Copia `config.example.json` como `config.json` (ignorado por git) y completa:
   - `sources.planner.csvPath`: ruta real del CSV de Planner.
   - `sources.sara.assignment.validators`: la lista de validadores ([sección 3](#3-fuentes-y-lista-de-validadores)).
2. Copia `.env.example` como `.env` (ignorado por git):
   - `INGEST_URL=http://127.0.0.1:8787`
   - `INGEST_KEY=` una clave cualquiera (solo local)
   - `SARA_API_KEY=` la clave de la API de Sara

### Día a día

1. **Servidor local.** Se inicia solo al abrir la carpeta en VS Code (tarea `dev_server`; la primera vez VS Code pide *Allow Automatic Tasks*). O en una terminal:
   ```powershell
   python scripts/dev_server.py
   ```
   Sirve `public/` y emula `/api/ingest/*`, `/api/data` y `/api/health` en `http://127.0.0.1:8787` con el mismo contrato que las Functions. Guarda los datos en `.local-data/` (ignorada por git). Cloudflare Access no aplica en local.
2. **Cargar los datos reales** en el servidor local:
   ```powershell
   python scripts/push_source.py --all            # Planner y Sara (solo lo que cambió)
   python scripts/push_source.py sara --force     # envía aunque no haya cambios
   python scripts/push_source.py planner --dry-run > payload.json   # ver el payload sin enviarlo
   ```
   (`payload*.json` está ignorado por git porque contiene datos reales.)
3. **Ver la página:** abre `public/index.html` y pulsa **Go Live**. Live Server sirve `public/` como raíz (igual que Pages) y reenvía `/api/*` al servidor local (`.vscode/settings.json`). También funciona `http://127.0.0.1:8787/`.

### Tests

```powershell
python -m unittest discover -s tests
```

- Adaptadores (Planner y Sara, con un CSV ficticio que reproduce las rarezas reales), normalización, fechas, esquema, asignación (casos en `fixtures/assignment_cases.json`).
- Servidor local y `push_source.py` de punta a punta: partes, publicación, estado de la asignación, hash, reintentos, dry-run, log, clave de Sara oculta.
- **JS:** `test_js_functions.py` abre `tests/js/` en Edge/Chrome headless. Esa página importa los módulos reales de `functions/` y `public/js/lib/` y prueba los casos compartidos, los endpoints con un KV en memoria, la combinación en el navegador y la validación del JWT de Access. Para verla a mano: `http://127.0.0.1:8787/__tests__/` (solo existe en `dev_server.py`).
- Integración contra un preview (se omiten sin `PREVIEW_URL`): [sección 9](#9-probar-con-preview-deployments).

## 3. Fuentes y lista de validadores

### Planner (`adapter: planner`)

CSV UTF-8 con BOM de Power Automate: `Id, Titulo, Responsables, Correos, Etiquetas, Estado, Prioridad, FechaCreacion, FechaCierre`. Los nombres de `Responsables` pueden venir como texto o como `{"displayName":"..."}` (el flujo escribe el objeto del usuario); el adaptador acepta ambos.

### Sara (`adapter: sara`, `type: http`)

`push_source.py` descarga el CSV de la API `@eventsl12m/dataset/@EventsL12M` (`url` + la clave de `SARA_API_KEY` en el parámetro `erg-api-key`; la clave nunca sale del PC ni aparece en los logs). La consulta trae los eventos de severidad 3 de los vuelos desde el primer día de hace 11 meses, con `flightId, takeoffdate, originICAO, destinationICAO, Registration, eventId, eventDate, eventName, severity, isInvalid, isopen, LastModifiedBy, ModificationDate`. Detalles que maneja el adaptador:

- Fechas `mm/dd/yyyy hh:mm:ss` en **UTC**. Columnas sin distinguir mayúsculas.
- Algunos `eventName` traen comas sin comillas; `repairColumn: "eventname"` las repara.
- `LastModifiedBy` sin `@` (cuenta del sistema) no cuenta como persona.

**Evento abierto = `isopen` verdadero y fecha dentro de los últimos `windowDays` (180) días.** Solo esos son carga pendiente. Los `isopen` más antiguos no se reparten ni suman carga: se informan aparte (`olderOpenEvents`) y un vuelo que solo tiene eventos antiguos aparece en la lista de **rezagados**.

**Evento gestionado = `isopen` falso, con `LastModifiedBy` (correo) y `ModificationDate` en los últimos `workWindowDays` (7) días.** Es el trabajo hecho que entra en la carga justa. La API deja vacía `ModificationDate` en la mayoría de los eventos cerrados; en ese caso se toma la fecha del evento (`eventDate`, o `takeoffdate` si falta) + 1 día, en UTC.

### Carga justa (en eventos equivalentes)

```
carga justa = eventos de Sara pendientes en sus vuelos asignados
            + eventos de Sara que gestionó en los últimos 7 días
            + tareas de Planner abiertas + cerradas en los últimos 7 días, ponderadas por etiqueta
```

Pesos (`options.plannerWeights`): **Logged for Statistics (UR 1-10) = 5, Assessment (UR 20-50) = 15, FULL INVESTIGATION (UR 500-2500)) = 45**. Otras etiquetas no cuentan; si una tarea tiene varias etiquetas con peso, vale la mayor; si tiene varios responsables, el peso se divide entre ellos. Una tarea de Planner cuenta como "cerrada en la ventana" por su `FechaCierre`.

El reparto busca igualar esta carga, no solo lo pendiente: quien gestiona más rápido no recibe más trabajo por haber vaciado su bandeja. `push_source.py` lee Planner (`options.plannerSource`) al enviar Sara, así que un cambio en el CSV de Planner también provoca el reenvío de Sara. Cálculo en `scripts/common/workload.py`.

```json
"options": {
  "windowDays": 180,
  "workWindowDays": 7,
  "plannerSource": "planner",
  "plannerWeights": { "Logged for Statistics (UR 1-10)": 5, "Assessment (UR 20-50)": 15, "FULL INVESTIGATION (UR 500-2500))": 45 }
}
```

### Lista de validadores y reglas de asignación

Se edita en `config.json` (no se sube al repo; aplica en el siguiente envío, sin commit ni despliegue):

```json
"assignment": {
  "validators": [
    { "email": "persona.uno@avianca.com", "active": true, "capacity": 1 },
    { "email": "persona.dos@avianca.com", "active": true, "capacity": 0.5 },
    { "email": "persona.tres@avianca.com", "active": false }
  ],
  "restrictions": {
    "NOMBRE EXACTO DEL EVENTO": ["persona.uno@avianca.com"]
  },
  "registrationOwners": {
    "N337QT": "persona.uno@avianca.com",
    "N338QT": "persona.uno@avianca.com"
  }
}
```

- `email`: el mismo correo de Planner y de `lastmodifiedby` en Sara.
- `active: false`: fuera del reparto (vacaciones, baja). Sus vuelos se reparten entre los demás en el siguiente envío.
- `capacity`: peso relativo (1 = normal, 0,5 = media jornada).
- `restrictions`: tipos de evento que solo puede gestionar un subgrupo. Un vuelo va completo a una persona, que debe estar habilitada para **todos** sus tipos; si nadie lo está, el vuelo aparece como conflicto.
- `registrationOwners`: **matrículas dedicadas** (`"MATRÍCULA": "correo"`). Sus vuelos siempre van a esa persona (que debe estar en `validators`), y esa persona **solo gestiona sus matrículas**: no recibe vuelos de otras matrículas y, si tenía alguno, se reparte entre los demás en el siguiente envío. Si la persona está inactiva, el vuelo aparece como conflicto.

**Quién aparece en el dashboard:** la lista `team` en `sources.sara.options` de `config.json` (correos). Si no existe, se muestran todas las personas de Planner y los validadores.

Reglas (en `scripts/common/assignment.py`):

0. Matrículas dedicadas: siempre a su responsable, que queda fuera del reparto general.
1. **La carga ya atribuida no se redistribuye**: un vuelo con dueño lo conserva mientras tenga eventos abiertos (de los últimos 180 días) y su dueño siga activo y habilitado. Las tareas de Planner nunca se reasignan.
2. Los vuelos nuevos (y los que perdieron a su dueño) se reparten de mayor a menor número de eventos; cada uno va a quien quede con menor **carga justa** relativa a su capacidad. Los empates se resuelven con un hash determinista: los mismos datos dan siempre el mismo reparto.
3. Un vuelo sin eventos abiertos (gestionado, o con todos sus eventos ya fuera de la ventana) libera a su dueño.
4. Vuelos con eventos `isopen` todos anteriores a la ventana: lista de **rezagados**, no se reparten.

### Interfaz

- **Equipo:** una columna por persona, en eventos equivalentes, sobre una línea de **cero**: **arriba lo pendiente**, **abajo lo gestionado en los últimos 7 días**. Cada categoría (Sara y cada etiqueta de Planner) tiene el mismo color arriba y abajo. Tooltip por columna; clic abre el detalle. La tabla con los mismos números está en "Ver tabla"; la explicación, en el botón ⓘ.
  - Las tareas abiertas **sin responsable** no son carga de nadie: se cuentan en un indicador aparte.
  - Colores: paleta categórica validada (claro y oscuro) en `public/css/base.css` (`--series-*`).
- **Vuelos de Sara:** por validador, vuelos y eventos pendientes, carga pendiente y gestionada, y reglas (capacidad, matrículas dedicadas, restricciones); vuelos sin validador habilitado y rezagados.

El estado (dueño de cada vuelo) vive en Cloudflare KV: en cada envío `push_source.py` lo lee (`GET /api/ingest/sara/state`), calcula y publica el resultado.

## 4. Commits con GitHub Desktop

1. Abre el repo en GitHub Desktop; en **Changes** revisa la lista.
2. Marca solo los archivos del cambio, escribe el resumen y pulsa **Commit to main** (o a una rama, [sección 9](#9-probar-con-preview-deployments)).
3. **Push origin**. Cloudflare Pages despliega automáticamente.

**Nunca deben aparecer en Changes** (están en `.gitignore`):

| Archivo / carpeta | Qué contiene |
|---|---|
| `config.json` | Rutas reales y la lista de validadores (correos) |
| `.env`, `.env.production`, `.env.*` | URL y claves (ingesta y Sara) |
| `.local-data/` | Datos del servidor local (datos personales) |
| `.state/` | Estado del script (hash del último envío por destino) |
| `logs/` | Logs de `push_source.py` |
| `*.csv` (salvo `fixtures/*.csv`), `payload*.json` | Datos reales |

## 5. Conectar el repo a Cloudflare Pages

1. Dashboard de Cloudflare → **Workers & Pages** → **Create** → pestaña **Pages** → **Connect to Git**.
2. Autoriza GitHub y elige este repositorio.
3. Configuración de build:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** *(vacío)*
   - **Build output directory:** `public`
   - **Root directory:** *(vacío)*
4. **Save and Deploy.** Pages detecta `functions/` y despliega las Functions sin build.
5. El sitio queda en `https://<proyecto>.pages.dev`. Faltan el KV ([sección 6](#6-namespace-kv-y-binding)) y el secreto `INGEST_KEY` ([sección 7](#7-secretos-y-variables)); después de configurarlos vuelve a desplegar (**Deployments** → último → **Retry deployment**, o un nuevo push).

## 6. Namespace KV y binding

Usa **dos namespaces**, para que las pruebas no toquen los datos reales.

1. **Workers & Pages** → **KV** (*Storage & Databases*) → **Create a namespace**: `segop-prod` y `segop-preview`.
2. Proyecto de Pages → **Settings** → **Bindings** → **Add** → **KV namespace**:
   - Entorno **Production**: variable `SEGOP_KV` → `segop-prod`.
   - Entorno **Preview**: variable `SEGOP_KV` → `segop-preview`.
3. Vuelve a desplegar.

Claves que se guardan (detalle en `functions/_lib/storage.js`):

| Clave | Contenido |
|---|---|
| `index` | Fuentes con `updatedAt`, `count`, `warnings` (lo lee `/api/health`) |
| `meta:<fuente>` | Versión publicada: lote, partes, warnings, datos de la fuente y, en Sara, la asignación (dueños + resumen) |
| `part:<fuente>:<lote>:<n>` | Parte `n` de las tareas, tal cual llegó |

## 7. Secretos y variables

Proyecto de Pages → **Settings** → **Variables and Secrets** → **Add**, en **Production** y en **Preview** (valores distintos):

| Nombre | Tipo | Obligatoria | Descripción |
|---|---|---|---|
| `INGEST_KEY` | Secret | Sí | Clave del header `x-api-key` de `/api/ingest/*`. Genera una larga: `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `INGEST_KEY_<FUENTE>` | Secret | No | Clave propia de una fuente (`INGEST_KEY_PLANNER`, `INGEST_KEY_SARA`); tiene prioridad sobre `INGEST_KEY` |
| `MAX_INVALID_RATIO` | Text | No | Proporción máxima de tareas inválidas antes de rechazar (por defecto `0.1`) |
| `ACCESS_TEAM_DOMAIN` | Text | No | Dominio del equipo de Zero Trust, p. ej. `miequipo.cloudflareaccess.com` |
| `ACCESS_AUD` | Text | No | *Application Audience (AUD) Tag* de la aplicación de Access ([sección 8](#8-cloudflare-access)) |

Si existen **ambas** `ACCESS_TEAM_DOMAIN` y `ACCESS_AUD`, `/api/data` valida además el JWT de Access (defensa en profundidad).

La clave de Sara **no** va a Cloudflare: solo la usa el PC. En el PC, los valores de producción van en **`.env.production`** (ignorado por git), separado del `.env` local:

```
INGEST_URL=https://<proyecto>.pages.dev
INGEST_KEY=<el secreto INGEST_KEY de Production>
SARA_API_KEY=<clave de la API de Sara>
```

> No definas estas variables como variables de entorno de Windows: tienen prioridad sobre los archivos y mezclarían local con producción.

## 8. Cloudflare Access

Todo el sitio queda detrás de Access **excepto** `/api/ingest/*`, que se protege con `x-api-key` (el script no puede iniciar sesión).

En **Zero Trust** → **Access** → **Applications**:

1. **Aplicación del sitio** → **Add an application** → **Self-hosted**:
   - Dominios: `<proyecto>.pages.dev` y `*.<proyecto>.pages.dev` (previews).
   - Política: **Allow**, *Include → Emails* (o *Emails ending in* `@avianca.com`, o un grupo).
   - Copia el **Application Audience (AUD) Tag** → variable `ACCESS_AUD`.
2. **Aplicación de bypass para la ingesta** → **Self-hosted**:
   - Dominios: `<proyecto>.pages.dev` con ruta `api/ingest`, y lo mismo con `*.<proyecto>.pages.dev`.
   - Política: **Bypass**, *Include → Everyone*. Access aplica la ruta más específica: `/api/ingest/*` queda fuera del login.
3. El dominio del equipo (`<equipo>.cloudflareaccess.com`) → variable `ACCESS_TEAM_DOMAIN`.
4. (Opcional, para las pruebas de integración) **Access → Service Auth → Create Service Token** y una política **Service Auth** en la aplicación del sitio con ese token.

Comprobación: en una ventana privada `https://<proyecto>.pages.dev/` pide login; `curl -X POST https://<proyecto>.pages.dev/api/ingest/planner` responde **401** en JSON (de la Function, no una página de login).

## 9. Probar con preview deployments

Cada push a una rama distinta de `main` genera un preview (`https://<rama>.<proyecto>.pages.dev`) con los bindings y variables del entorno **Preview** (`segop-preview`).

1. GitHub Desktop: **Current branch → New branch**, commit y **Publish branch**.
2. Cloudflare → proyecto → **Deployments**: copia la URL del preview.
3. Abre la URL (login de Access) y `.../api/health`.
4. Envía los datos reales al preview con su propio archivo de variables (`.env.preview`, ignorado):
   ```powershell
   python scripts/push_source.py --all --force --env-file .env.preview
   ```
5. Pruebas de integración (fuentes ficticias `itest-a` / `itest-b`; **solo contra el preview**):
   ```powershell
   $env:PREVIEW_URL = "https://<rama>.<proyecto>.pages.dev"
   $env:PREVIEW_INGEST_KEY = "<INGEST_KEY de Preview>"
   $env:PREVIEW_ACCESS_CLIENT_ID = "<client id>"          # si el preview está detrás de Access
   $env:PREVIEW_ACCESS_CLIENT_SECRET = "<client secret>"
   python -m unittest discover -s tests -p "test_integration.py" -v
   ```
   Verifican: 401 sin clave, subida por partes y publicación, asignación persistente (los dueños se conservan en la segunda publicación) y ETag/304. Esperan hasta 90 s por la consistencia eventual de KV.
6. Si todo está bien, **Branch → Create pull request** (o *Merge into current branch* sobre `main`) y push.

| Qué | Local (`dev_server.py`) | Preview |
|---|---|---|
| Contrato de la API, validación, asignación, ETag/304 | ✔ | ✔ |
| Código JS real de Functions y navegador | ✔ (`/__tests__/`, KV en memoria) | ✔ |
| Bindings KV, secretos, variables | — | ✔ |
| Cloudflare Access (login, bypass, JWT) | — (JWT de prueba en `/__tests__/`) | ✔ |
| Consistencia eventual de KV, CPU real | — | ✔ |

## 10. Envío automático con el Programador de tareas

Una sola tarea envía Planner y Sara (`--all`) a las **8:00 y 13:00** (hora de Bogotá). Debe correr **con la sesión iniciada** (OneDrive sincroniza el CSV de Planner con tu usuario) y con `pythonw.exe` (sin ventana).

1. Crea `.env.production` ([sección 7](#7-secretos-y-variables)) y prueba a mano:
   ```powershell
   python scripts/push_source.py --all --env-file .env.production
   ```
2. Ruta de `pythonw.exe`: `(Get-Command pythonw).Source`
3. **Programador de tareas** → **Crear tarea…**:
   - **General:** `Seguimiento - push fuentes`; **Ejecutar solo cuando el usuario haya iniciado sesión**.
   - **Desencadenadores:** dos *Diariamente*, 8:00 y 13:00. Deja margen después del flujo de Power Automate que genera el CSV de Planner.
   - **Acciones:** *Iniciar un programa* → Programa: la ruta de `pythonw.exe`; Argumentos: `scripts\push_source.py --all --env-file .env.production`; Iniciar en: la carpeta del repo (sin comillas).
   - **Condiciones:** desmarca *solo si el equipo está conectado a la corriente alterna* si es portátil.
   - **Configuración:** *Ejecutar la tarea lo antes posible si no se inició una ejecución programada* y *Si la tarea no se puede completar, reiniciar cada 30 minutos, 2 veces*.

   Equivalente en PowerShell:
   ```powershell
   $repo = "C:\ruta\al\repo\cargas_oficiales_segop"
   $action = New-ScheduledTaskAction -Execute (Get-Command pythonw).Source `
     -Argument "scripts\push_source.py --all --env-file .env.production" -WorkingDirectory $repo
   $triggers = @((New-ScheduledTaskTrigger -Daily -At 8:00am), (New-ScheduledTaskTrigger -Daily -At 1:00pm))
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
     -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 30)
   $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
   Register-ScheduledTask -TaskName "Seguimiento - push fuentes" -Action $action -Trigger $triggers `
     -Settings $settings -Principal $principal
   ```
4. Revisión: `logs/push_source.log` (rotativo, 1 MB × 5). Código de salida en el Programador: `0x0` enviado o sin cambios; `0x1` fallo de red/HTTP tras reintentos; `0x2` error de configuración o datos.

Cada fuente solo se envía si cambiaron sus datos o su configuración (SHA-256 en `.state/<fuente>.json`, por URL de destino). Si un envío falla a mitad, no se publica nada: el sitio sigue mostrando la versión anterior completa.

## 11. Agregar una fuente nueva

No requiere tocar las Functions.

1. **Adaptador.** Copia `scripts/adapters/template.py` como `scripts/adapters/<nombre>.py` y completa los `TODO` (columnas, mapas de estado y prioridad, fechas, `extra`). Personas sin correo: `email` en `None`; el navegador las unifica con alguien de otra fuente si el nombre normalizado coincide sin ambigüedad (si no, warning `ambiguous_person`).
2. **Registro.** En `scripts/adapters/__init__.py` agrega `"<nombre>": "adapters.<nombre>"` a `REGISTRY`.
3. **Pruebas.** `fixtures/<nombre>_sample.csv` ficticio y un test en `tests/` (patrón de `PlannerAdapterTest`, con el chequeo de `validate_payload`).
4. **Configuración** en `config.json` (y un ejemplo ficticio en `config.example.json`):
   ```json
   "auditorias": { "csvPath": "C:\\ruta\\al\\csv.csv", "adapter": "auditorias", "delimiter": ";" }
   ```
   Para una API: `"type": "http", "url": "...", "apiKeyEnv": "VARIABLE", "apiKeyParam": "parametro"`. El nombre de la fuente debe cumplir `^[a-z0-9][a-z0-9_-]{0,39}$`.
5. **Asignación (opcional).** Si la fuente reparte trabajo como Sara, el adaptador debe emitir una tarea por unidad de asignación con `extra.openEvents` (carga) y, si aplica, `extra.olderOpenEvents` (pendientes fuera de la ventana), y la fuente lleva una sección `assignment` en `config.json`.
6. **Local:** `--dry-run`, luego envío a `dev_server.py` y revisión en la página.
7. **Producción:** commit y push; el Programador de tareas ya usa `--all`.
8. Si la fuente debe ganar en el nombre visible de las personas, agrégala a `PREFERRED_NAME_SOURCES` en `public/js/lib/merge.js` (y un caso en `fixtures/merge_cases.json`).

## 12. Referencia: contrato de la API

### Modelo común

```
Task {
  uid: "<source>:<sourceId>", source, sourceId, title,
  assignees: [ { key, name, email | null } ],   // key = correo en minúsculas o nombre normalizado
  labels: [string],
  status: "not_started" | "in_progress" | "completed" | otro texto no vacío,
  priority: "urgent" | "important" | "medium" | "low" | null,
  createdAt, closedAt: ISO 8601 con zona | null,
  extra: {}
}
```

### Ingesta (`x-api-key`; fuera de Access)

Una fuente se publica en dos pasos para que ninguna invocación procese mucho JSON:

1. `POST /api/ingest/:fuente/parts?batch=<lote>&index=<n>` — cuerpo `{ "tasks": [Task] }` (máx. 1 MB; `push_source.py` usa ~200 KB). Valida y guarda la parte. Responde `{ length, received, accepted, invalidIndexes, invalid[] }`. 422 si las inválidas superan `MAX_INVALID_RATIO`.
2. `POST /api/ingest/:fuente` — publica el lote:
   ```
   { batch, parts: [{ index, length, received, invalidIndexes }], generatedAt?, warnings?,
     sourceData?, assignment?: { owners: { <id>: { owner, since } }, summary } }
   ```
   Responde `{ ok, received, accepted, invalidCount, warningCount, updatedAt, kvWrites, partsDeleted }`. Las partes de la versión anterior se borran.

`GET /api/ingest/:fuente/state` → `{ updatedAt, owners }`: dueños vigentes (los usa `push_source.py` para asignar).

| Código | Cuándo |
|---|---|
| 400 | Fuente, lote, índice o JSON inválidos; estructura inválida |
| 401 | `x-api-key` ausente o incorrecta |
| 404 / 405 | Ruta o método no válidos (`Allow` indica el correcto) |
| 413 | Parte > 1 MB o cuerpo > 5 MB |
| 422 | Demasiadas tareas inválidas; no se guardó / no se publicó |
| 500 | Falta el binding `SEGOP_KV` o el secreto `INGEST_KEY` |

### `GET /api/data` (detrás de Access)

Los datos publicados de todas las fuentes, sin procesar: `{ generatedAt, sources, parts: { <fuente>: { meta, chunks: [{ tasks }] } } }`. El navegador los combina con `public/js/lib/dataset.js` en `{ generatedAt, sources, people, tasks, warnings, sourceData }`; en Sara, cada vuelo trae a su dueño como responsable y `sourceData.sara` tiene `assignment` (resumen: validadores con su carga, conflictos, rezagados, conteos) y `workload` (carga de trabajo por persona: Sara gestionado y Planner ponderado, con los pesos y la ventana).

`ETag` + `Cache-Control: private, no-cache`; `If-None-Match` → 304 (una sola lectura de KV). Si KV aún está propagando una publicación, la respuesta sale sin ETag (`no-store`). Con `ACCESS_*` configuradas y JWT inválido: 403.

### `GET /api/health`

`{ status: "ok" | "empty", datasetUpdatedAt, sources: { <fuente>: { updatedAt, count, warnings } } }`. Sin datos personales.

### Códigos de warning

| Código | Origen | Significado |
|---|---|---|
| `missing_id`, `duplicate_id` | Planner | Fila sin Id / Id repetido |
| `assignee_email_mismatch`, `assignee_email_missing` | Planner | Responsables y correos no cuadran; se usa el nombre normalizado como key |
| `unknown_status`, `unknown_priority`, `invalid_date` | Planner | Valor no mapeado o fecha inválida |
| `invalid_flag`, `missing_flight`, `duplicate_event` | Sara | Filas descartadas (resumen con el conteo) |
| `invalid_task` | push_source | Tarea que no cumple el esquema |
| `ambiguous_person` | navegador | Persona sin correo cuyo nombre coincide con varias personas con correo |

## 13. Límites del plan gratuito

- **CPU de las Functions: 10 ms por invocación.** Esto definió la arquitectura. Con los datos reales (400 tareas de Planner, ~2.300 vuelos de Sara, 1,1 MB), procesar todo en una sola invocación tomaba 55–75 ms. Con el diseño actual (medido en Edge con el código real):

  | Invocación | Tiempo |
  |---|---|
  | Cada parte (~200 KB) | 1,5–3 ms |
  | Publicación de Sara (con ~1.900 dueños) | 2–4 ms |
  | `GET /api/data` 304 / 200 | 0,8 / 5,6 ms |

  Si el volumen crece mucho, vigila errores 1102 en *Deployments → Functions → logs*; `PART_TARGET_BYTES` en `push_source.py` controla el tamaño de las partes.
- **Escrituras KV: 1.000/día.** Un envío escribe una clave por parte + 2: Planner ~4 y Sara ~8, es decir ~24 al día con dos ejecuciones (solo si hubo cambios). Los borrados de partes viejas tienen su propia cuota de 1.000/día.
- **Lecturas KV: 100.000/día.** `GET /api/data` con 304 = 1 lectura; con datos = 1 + (1 + partes) por fuente (~11). El navegador revalida con ETag.
- **Consistencia eventual (~60 s).** Tras publicar, `/api/data` puede tardar hasta un minuto en reflejarlo en otras ubicaciones; mientras tanto se entrega sin ETag para no dejarlo en caché.
- **Tamaño:** parte ≤ 1 MB, publicación ≤ 5 MB; valor máximo en KV 25 MB.

## 14. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| La página dice "No se pudo conectar… ¿Está corriendo dev_server.py?" | El servidor local no está corriendo (tarea `dev_server` o `python scripts/dev_server.py`). |
| `HTTP 401` | La clave del archivo de variables no coincide con `INGEST_KEY` del entorno (Production/Preview). |
| Respuesta HTML de login al enviar | Falta la aplicación de bypass de Access para `/api/ingest` ([sección 8](#8-cloudflare-access)). |
| `HTTP 403` con `error code: 1010` | Reglas de bots de Cloudflare; el script ya envía un User-Agent propio. Revisa *Security → Bots* si persiste. |
| `HTTP 500` "binding KV no configurado" | Falta `SEGOP_KV` en ese entorno o no se volvió a desplegar. |
| `falta la variable SARA_API_KEY` | Agrega la clave al `.env` / `.env.production`. |
| `la API respondió HTTP 401/403` (Sara) | Clave de Sara vencida o incorrecta. |
| `/api/data` → 403 "acceso denegado" | `ACCESS_AUD` o `ACCESS_TEAM_DOMAIN` no corresponden a la aplicación de Access. |
| La página dice "La sesión expiró" | La sesión de Access caducó; recarga. |
| Un validador recibe vuelos pero no aparece en Planner | Su correo en `config.json` no coincide con el de Planner. |
| El script dice "sin cambios" y quieres reenviar | `--force`. |
| La tarea programada no hace nada | Revisa `logs/push_source.log`; "Iniciar en" = carpeta del repo y sesión iniciada. |
