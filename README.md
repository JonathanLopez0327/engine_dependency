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

En lugar de depender de variables de entorno, puedes pasar la configuracion directamente al constructor:

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

## API

### `BaseService`

Clase base que provee metodos HTTP reutilizables.

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `sendPOSTRequest(url, body, headers?)` | `url`: string, `body`: object, `headers`: object (opcional) | `{ data, status }` | Envia una peticion POST con JSON |

### `TestInformationService`

Extiende `BaseService`. Gestiona autenticacion y envio de resultados de tests.

| Metodo | Parametros | Retorno | Descripcion |
|---|---|---|---|
| `generateToken()` | - | `string \| undefined` | Obtiene un token JWT del servicio |
| `buildTestPayload(testInfo)` | `testInfo`: object | `object` | Construye el payload para el API |
| `sendTestResult(testInfo)` | `testInfo`: object | `object \| undefined` | Autentica y envia el resultado del test |

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
│   └── services/
│       ├── base.service.js               # Servicio HTTP base (fetch nativo)
│       └── test-information.service.js   # Servicio de resultados de tests
├── tests/
│   ├── base.service.test.js
│   └── test-information.service.test.js
├── dist/                                 # Generado por build
│   ├── esm/                              # Modulos ES
│   └── cjs/                              # CommonJS
├── examples/
│   └── send-test-result.js
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
export { TestInformationService } from './services/test-information.service.js';
export { MiServicio } from './services/mi-servicio.service.js';
```
