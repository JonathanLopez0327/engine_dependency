# engine-dependency

Dependencia centralizada para el envio de resultados de tests y datos via API al servicio Data Engine.

## Requisitos

- Node.js >= 18.0.0

## Instalacion

```bash
npm install engine-dependency
```

## Configuracion

Crea un archivo `.env` en la raiz de tu proyecto con las siguientes variables:

```env
DATA_ENGINE_BASE_URL=https://tu-servicio.com
DATA_ENGINE_GENERATE_TOKEN=/api/auth/login
DATA_ENGINE_SERVICE_ACCOUNT=cuenta@servicio.com
DATA_ENGINE_SERVICE_PASSWORD=password
ENV=qa
CI=true

# Identifica el proyecto que produce las metricas (usado por el backend
# para agrupar runs y para construir el scriptHash baseline)
PROJECT_NAME=mi-proyecto

# K6 metrics (opcional, fallback si no estan en data.options del summary)
SCENARIO_NAME=load-test
TEST_TYPE=benchmark
```

Consulta `.env.example` para referencia.

## Uso

### ESM (import)

```javascript
import { TestInformationService } from 'engine-dependency';

const service = new TestInformationService();
await service.sendTestResult(testInfo);
```

### CommonJS (require)

```javascript
const { TestInformationService } = require('engine-dependency');

const service = new TestInformationService();
await service.sendTestResult(testInfo);
```

### Configuracion por parametro

En lugar de depender de variables de entorno, puedes pasar la configuracion directamente al constructor. Todos los servicios siguen la misma firma `new Servicio(config = {})`, donde cada campo de `config` es opcional y cae a su env var correspondiente si no se pasa. Consulta la seccion [API](#api) para la lista completa de campos por servicio.

```javascript
const service = new TestInformationService({
    baseUrl: 'https://tu-servicio.com',
    tokenEndpoint: '/api/auth/login',
    testResultsEndpoint: '/api/test-results',
    serviceAccount: 'cuenta@servicio.com',
    servicePassword: 'password'
});
```

### Enviar resultado de test

```javascript
const testInfo = {
    title: 'Login exitoso con credenciales validas',
    titlePath: ['Auth', 'Login', 'Login exitoso con credenciales validas'],
    status: 'passed',
    duration: 3500,
    file: 'tests/auth/login.spec.js',
    project: { name: 'e2e-chrome' },
    retries: 0,
    retry: 0,
    tags: ['@smoke', '@auth'],
    expectedStatus: 'passed',
    annotations: [],
    timeout: 30000,
    errors: []
};

const result = await service.sendTestResult(testInfo);
```

> `sendTestResult` solo ejecuta el envio cuando la variable de entorno `CI` esta definida. Esto evita envios accidentales en entornos locales.

### Enviar metricas de K6

Soporta dos flujos segun como corras K6:

**Flujo simple — solo NDJSON** (no requiere `--summary-export`):

```bash
k6 run --out json=results.json scripts/updateActivityUAT.js
```

```javascript
import { K6MetricsService } from 'engine-dependency';

const service = new K6MetricsService();
// data = null: el servicio reconstruye el summary desde el NDJSON
await service.sendK6Metrics(null, { samplesPath: './results.json' });
```

**Flujo completo — summary + NDJSON** (mas preciso para metricas globales como `vus_max`, `data_received` rate):

```bash
k6 run --summary-export=summary.json --out json=results.json script.js
```

```javascript
import fs from 'node:fs';
import { K6MetricsService } from 'engine-dependency';

const data = JSON.parse(fs.readFileSync('./summary.json', 'utf8'));
const service = new K6MetricsService();
await service.sendK6Metrics(data, { samplesPath: './results.json' });
```

Si ya tienes los samples parseados en memoria, puedes precomputar las metricas y pasarlas directo:

```javascript
import { aggregateK6Samples } from 'engine-dependency';
const groupMetrics = aggregateK6Samples(samples);
await service.sendK6Metrics(data, { groupMetrics });
```

> `sendK6Metrics` solo ejecuta el envio cuando la variable de entorno `CI` esta definida.

> K6 corre en su propio runtime (goja) sin soporte para `fetch` ni `dotenv`, por lo que esta dependencia se invoca desde Node, no desde el script de K6.

#### Grupos (`group()`) y sus metricas

K6 expone los grupos en `data.root_group` con su jerarquia y `checks`, **pero el summary nativo NO incluye metricas HTTP per-group**. Para obtener `http_req_duration` por grupo (y todas las metricas per-endpoint, ver siguiente seccion) necesitas el stream NDJSON (`--out json=results.json`). Pasandolo via `meta.samplesPath`, el servicio lo streamea automaticamente y mergea las metricas en cada grupo del payload.

Si solo pasas el summary (sin `samplesPath`), los grupos saldran con `name`, `path`, `checks` y `http_req_duration` como `null`.

#### Endpoints y comparacion entre runs

Ademas de los grupos, el servicio extrae metricas **per-endpoint** del NDJSON, keyando por `${METHOD} ${tags.name || tags.url}`. Cada endpoint en el payload trae `http_reqs_count`, `http_req_failed_rate`, `http_req_duration`, `http_req_waiting` y un breakdown de `statuses` (`{"200": 120, "500": 3}`).

Para que las comparaciones entre runs sean estables, **etiqueta cada request en tu script de K6**:

```javascript
http.get('https://api.com/users/123', { tags: { name: 'GET /users/:id' } });
```

Sin `tags.name`, K6 usa la URL literal y la cardinalidad explota (cada `userId` cuenta como un endpoint distinto).

A partir del set de endpoints se computa un `scriptHash` (SHA-256 de los keys ordenados). El backend usa ese hash + `testProject` para encontrar el run anterior comparable. Renombrar, agregar o quitar un endpoint cambia el hash y el backend tratara los runs como tests distintos en lugar de producir un diff enganoso.

Tras `sendK6Metrics`, puedes pedir el reporte de comparacion contra el run anterior:

```javascript
const result = await service.sendK6Metrics(null, { samplesPath: './results.json' });
if (result?.id) {
    const report = await service.getCompareReport(result.id);
    if (report?.status === 'compared') {
        const regressed = report.endpoints.filter((e) => e.status === 'regressed');
        if (regressed.length) process.exit(1); // falla el pipeline en regresiones
    }
}
```

## API

### `BaseService`

Clase base que provee metodos HTTP reutilizables.

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `sendPOSTRequest(url, body, headers?)` | `url`: string, `body`: object, `headers`: object (opcional) | `{ data, status }` | Envia una peticion POST con JSON |
| `sendGETRequest(url, headers?)` | `url`: string, `headers`: object (opcional) | `{ data, status }` | Envia una peticion GET y parsea la respuesta como JSON |

### `AuthenticatedService`

Extiende `BaseService`. Centraliza la config de auth y la generacion del token.

**Constructor**

```javascript
new AuthenticatedService(config = {})
```

| Campo de `config` | Tipo | Default / Env var |
|---|---|---|
| `baseUrl` | `string` | `process.env.DATA_ENGINE_BASE_URL` |
| `tokenEndpoint` | `string` | `process.env.DATA_ENGINE_GENERATE_TOKEN` |
| `serviceAccount` | `string` | `process.env.DATA_ENGINE_SERVICE_ACCOUNT` |
| `servicePassword` | `string` | `process.env.DATA_ENGINE_SERVICE_PASSWORD` |

**Metodos**

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `generateToken()` | - | `string \| undefined` | Obtiene un token JWT del servicio |

### `TestInformationService`

Extiende `AuthenticatedService`. Gestiona el envio de resultados de tests.

**Constructor**

```javascript
new TestInformationService(config = {})
```

Hereda los 4 campos de `AuthenticatedService` y agrega:

| Campo de `config` | Tipo | Default / Env var |
|---|---|---|
| `testResultsEndpoint` | `string` | `'/api/test-results'` (`DEFAULT_ENDPOINTS.TEST_RESULTS`) |

**Metodos**

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `buildTestPayload(testInfo)` | `testInfo`: object | `object` | Construye el payload para el API |
| `sendTestResult(testInfo)` | `testInfo`: object | `object \| undefined` | Autentica y envia el resultado del test |
| `sendWDIOTestResult(testInfo)` | `testInfo`: object | `object \| undefined` | Variante para tests de WebDriverIO |

### `K6MetricsService`

Extiende `AuthenticatedService`. Construye y envia metricas de pruebas de carga K6, y consulta el reporte de comparacion vs el run anterior.

**Constructor**

```javascript
new K6MetricsService(config = {})
```

Hereda los 4 campos de `AuthenticatedService` y agrega:

| Campo de `config` | Tipo | Default / Env var |
|---|---|---|
| `k6MetricsEndpoint` | `string` | `'/api/k6-metrics'` (`DEFAULT_ENDPOINTS.K6_METRICS`) |

Uso tipico (cero argumentos, todo desde `.env`):

```javascript
const service = new K6MetricsService();
```

Override explicito:

```javascript
const service = new K6MetricsService({
    baseUrl: 'https://data-engine.com',
    tokenEndpoint: '/api/auth/login',
    serviceAccount: 'svc@empresa.com',
    servicePassword: 'secret',
    k6MetricsEndpoint: '/api/k6-metrics'  // opcional
});
```

**Metodos**

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `buildK6Payload(data, meta?)` | `data`: K6 summary object, `meta`: `{ startedAt?, endedAt?, groupMetrics?, endpointMetrics?, scriptHash? }` | `object` | Extrae metricas del summary y arma el payload |
| `sendK6Metrics(data, meta?)` | Igual que arriba; `meta` ademas acepta `samplesPath` (path al NDJSON; el servicio lo streamea y agrega per-group y per-endpoint automaticamente). Si `data = null` y se pasa `samplesPath`, el summary se reconstruye desde el NDJSON | `object \| undefined` | Autentica y envia las metricas. Devuelve `{ id, ... }` con el id persistido por el backend |
| `getCompareReport(runId)` | `runId`: id devuelto por `sendK6Metrics` | `object \| undefined` | Pide al backend la comparacion vs el run anterior con el mismo `scriptHash + testProject`. Devuelve `{ status, current, previous, global, endpoints }`. `status` puede ser `compared`, `no_baseline`, etc. |

### Utilities

- `aggregateK6Samples(samples)`: toma el NDJSON ya parseado (array de samples) y devuelve un objeto `{ [groupPath]: { http_req_duration, http_req_waiting, http_req_failed, http_reqs, group_duration } }`.
- `aggregateK6SamplesFromFile(path)`: streamea el NDJSON line-by-line desde disco (memoria constante) y devuelve el mismo shape como `Promise`. Es lo que usa `sendK6Metrics` internamente cuando le pasas `meta.samplesPath`.
- `aggregateK6Endpoints(samples)`: toma el NDJSON ya parseado y devuelve un mapa `{ "${METHOD} ${name}": { name, method, url, group, http_req_duration, http_req_waiting, http_req_failed, http_reqs, statuses } }`. Para keys estables, anota tus requests con `tags: { name: 'GET /users/:id' }`.
- `aggregateK6EndpointsFromFile(path)`: version streaming desde disco del helper anterior. Es lo que usa `sendK6Metrics` cuando le pasas `meta.samplesPath`.
- `buildSummaryFromSamplesFile(path)`: streamea el NDJSON y reconstruye un objeto con la misma forma que el `data` del summary nativo (metrics globales, root_group, scenarios, duration), e incluye `_groupMetrics` y `_endpointMetrics` ya agregados. Util cuando solo corriste con `--out json=...` sin `--summary-export`. Es lo que usa `sendK6Metrics` cuando le pasas `data = null`.
- `computeScriptHash(endpointMetrics)`: SHA-256 estable del set de endpoints (`${METHOD} ${name}` ordenados). Acepta el mapa de `aggregateK6Endpoints*` o un array `[{method, name}]`. Devuelve `null` si no hay endpoints. `buildK6Payload` lo computa automaticamente si no pasas `meta.scriptHash`.

### Payload de metricas K6

`sendK6Metrics` envia el siguiente payload al endpoint `/api/k6-metrics` (campos en flat camelCase):

| Campo | Origen |
|---|---|
| `scenarioName` | Primer key de `data.options.scenarios` o env `SCENARIO_NAME` |
| `testType` | `data.options.tags.test_type` o env `TEST_TYPE` |
| `scriptHash` | SHA-256 del set de endpoints (ver seccion *Endpoints y comparacion*) |
| `environment` | Env `ENV` |
| `testProject` | Env `PROJECT_NAME` |
| `pipelineId` | Env `SYSTEM_DEFINITIONID` (id de la definicion del pipeline) |
| `buildId` | Env `BUILD_BUILDID` (id de la corrida especifica) |
| `commitSha` | Env `BUILD_SOURCEVERSION` |
| `branch` | Env `BUILD_SOURCEBRANCH` |
| `runUrl` | URL del build en Azure DevOps (si `BUILD_BUILDID` esta seteado) |
| `provider` | `'azure-devops'` si ejecuta en pipeline |
| `startedAt` / `endedAt` | ISO strings, calculados a partir de `data.state.testRunDurationMs` o overrideados via `meta.startedAt` / `meta.endedAt` |
| `durationMs` | `data.state.testRunDurationMs` |
| `httpReqDurationAvg/Min/Max/Med/P90/P95/P99` | Trend global de `http_req_duration` (flatten) |
| `httpReqWaitingAvg/...` | Trend global de `http_req_waiting` (TTFB, flatten) |
| `httpReqFailedRate` | Rate de `http_req_failed` |
| `httpReqsCount` / `httpReqsRate` | Counter de `http_reqs` |
| `groupDurationAvg/...` | Trend global de `group_duration` (flatten) |
| `vusValue` / `vusMin` / `vusMax` | Valores actuales de `vus` |
| `vusMaxValue` / `vusMaxMin` / `vusMaxMax` | Valores de `vus_max` |
| `dataReceivedCount` / `dataReceivedRate` | Bytes recibidos (counter + rate) |
| `dataSentCount` / `dataSentRate` | Bytes enviados (counter + rate) |
| `groups` | Array `[{ name, path, checks: { passed, failed }, http_req_duration }]`. `http_req_duration` solo viene poblado si se pasa `meta.groupMetrics` o `meta.samplesPath` |
| `endpoints` | Array `[{ name, method, url, group, http_reqs_count, http_req_failed_rate, http_req_duration, http_req_waiting, statuses }]`. Solo viene poblado si se pasa `meta.endpointMetrics` o `meta.samplesPath` |

### Payload enviado

`sendTestResult` construye y envia el siguiente payload al endpoint `/api/test-results`:

| Campo | Origen |
|---|---|
| `testTitle` | `titlePath` concatenado o `title` |
| `testStatus` | `status` del test |
| `duration` | Duracion en ms |
| `testFile` | Ruta del archivo de test |
| `testProject` | Nombre del proyecto |
| `retries` / `retry` | Intentos configurados y actual |
| `tags` | Tags del test |
| `environment` | Variable de entorno `ENV` |
| `testInfo` | Objeto con `title`, `expectedStatus`, `annotations`, `timeout`, `errors` |
| `pipelineId` | `BUILD_BUILDID` (Azure DevOps) |
| `commitSha` | `BUILD_SOURCEVERSION` |
| `branch` | `BUILD_SOURCEBRANCH` |
| `runUrl` | URL del build en Azure DevOps |
| `provider` | `azure-devops` si ejecuta en pipeline |

## Scripts

```bash
npm run build          # Genera dist/ con ESM y CJS
npm run clean          # Elimina dist/
npm run lint           # Ejecuta ESLint sobre src/
npm run lint:fix       # Corrige errores de lint automaticamente
npm test               # Ejecuta tests unitarios
npm run test:watch     # Tests en modo watch
npm run test:coverage  # Tests con reporte de cobertura
npm run validate       # lint + test + build (pipeline completo)
```

## Estructura del proyecto

```
engine-dependency/
├── src/
│   ├── index.js                          # Entry point
│   ├── constants.js                      # Endpoints y env vars
│   └── services/
│       ├── base.service.js               # Servicio HTTP base (fetch nativo)
│       ├── authenticated.service.js      # Auth compartida (generateToken)
│       ├── test-information.service.js   # Servicio de resultados de tests
│       └── k6-metrics.service.js         # Servicio de metricas K6
├── tests/
│   ├── base.service.test.js
│   ├── authenticated.service.test.js
│   ├── test-information.service.test.js
│   └── k6-metrics.service.test.js
├── dist/                                 # Generado por build
│   ├── esm/                              # Modulos ES
│   └── cjs/                              # CommonJS
├── examples/
│   ├── send-test-result.js
│   └── send-k6-metrics.js
├── .env.example
├── rollup.config.js
├── eslint.config.js
└── package.json
```

## Extender con nuevos servicios

1. Crea un nuevo archivo en `src/services/` que extienda `BaseService`.
2. Exportalo desde `src/index.js`.
3. Ejecuta `npm run build`.

```javascript
// src/services/mi-servicio.service.js
import BaseService from './base.service.js';

export class MiServicio extends BaseService {
    async enviarDatos(payload) {
        const response = await this.sendPOSTRequest('https://api.com/datos', payload);
        return response.data;
    }
}
```

```javascript
// src/index.js
export { default as BaseService } from './services/base.service.js';
export { AuthenticatedService } from './services/authenticated.service.js';
export { TestInformationService } from './services/test-information.service.js';
export { K6MetricsService } from './services/k6-metrics.service.js';
export { MiServicio } from './services/mi-servicio.service.js';
```

> Si tu servicio necesita auth contra Data Engine, extiende `AuthenticatedService` en lugar de `BaseService` para reutilizar `generateToken()` y la config compartida.
