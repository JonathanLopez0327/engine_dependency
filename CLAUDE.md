# Eres un JavaScript Senior Developer

# Contexto
Se creo una funcionalidad para conectarse y enviar datos via API a un servicio backend que las almancena, pero los proyectos han crecido por lo que centralizar la logica parece mas eficiente.

# Codigo
```javascript
import BaseService from '../base.service.js';
import dotenv from 'dotenv';

dotenv.config();

exports.TestInformationService = class TestInformationService extends BaseService {
    constructor() {
        super();
        this.baseUrl = process.env.DATA_ENGINE_BASE_URL;
        this.tokenEndpoint = process.env.DATA_ENGINE_GENERATE_TOKEN;
        this.testResultsEndpoint = '/api/test-results';
        this.serviceAccount = process.env.DATA_ENGINE_SERVICE_ACCOUNT;
        this.servicePassword = process.env.DATA_ENGINE_SERVICE_PASSWORD;
    }

    async generateToken() {
        try {
            const response = await this.sendPOSTRequest(`${this.baseUrl}${this.tokenEndpoint}`, {
                email: this.serviceAccount,
                password: this.servicePassword
            });
            return response.data.token;
        } catch (error) {
            console.log(`Error generando token para test results: ${error?.message || error}`);
        }
    }

    buildTestPayload(testInfo) {
        return {
            testTitle: testInfo.titlePath?.join(' > ') || testInfo.title,
            testStatus: testInfo.status,
            duration: testInfo.duration,
            testFile: testInfo.file,
            testProject: testInfo.project?.name || null,
            retries: testInfo.retries ?? 0,
            retry: testInfo.retry ?? 0,
            tags: testInfo.tags || [],
            environment: process.env.ENV,
            testInfo: {
                title: testInfo.title,
                expectedStatus: testInfo.expectedStatus,
                annotations: testInfo.annotations || [],
                timeout: testInfo.timeout,
                errors: testInfo.errors || []
            },
            pipelineId: process.env.BUILD_BUILDID || null,
            commitSha: process.env.BUILD_SOURCEVERSION || null,
            branch: process.env.BUILD_SOURCEBRANCH || null,
            runUrl: process.env.BUILD_BUILDID
                ? `${process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI}${process.env.SYSTEM_TEAMPROJECT}/_build/results?buildId=${process.env.BUILD_BUILDID}`
                : null,
            provider: process.env.BUILD_BUILDID ? 'azure-devops' : null
        };
    }

    async sendTestResult(testInfo) {
        if (process.env.CI) {
            try {
                const token = await this.generateToken();
                if (!token) {
                    console.log('No se pudo obtener el token, omitiendo envio de resultado de test');
                    return;
                }

                const payload = this.buildTestPayload(testInfo);
                const response = await this.sendPOSTRequest(
                    `${this.baseUrl}${this.testResultsEndpoint}`,
                    payload,
                    { Authorization: `Bearer ${token}` }
                );

                console.log(`Resultado de test enviado: ${testInfo.title} - ${testInfo.status}`);
                return response?.data;
            } catch (error) {
                console.log(`Error enviando resultado de test: ${error?.message || error}`);
            }
        }

    }
};

```

# Tarea
1. Toma este codigo de base para crear una dependencia de javascript que pueda ser utilizada en cualquier proyecto de nodejs.
2. Crea una estructura de carpetas y archivos para centralizar la logica de envio de datos via API a un servicio backend que las almancena.
3. Crea un archivo de ejemplo de como se puede utilizar la dependencia.