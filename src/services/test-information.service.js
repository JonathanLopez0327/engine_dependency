import BaseService from './base.service.js';

export class TestInformationService extends BaseService {
    constructor(config = {}) {
        super();
        this.baseUrl = config.baseUrl || process.env.DATA_ENGINE_BASE_URL;
        this.tokenEndpoint = config.tokenEndpoint || process.env.DATA_ENGINE_GENERATE_TOKEN;
        this.testResultsEndpoint = config.testResultsEndpoint || '/api/test-results';
        this.serviceAccount = config.serviceAccount || process.env.DATA_ENGINE_SERVICE_ACCOUNT;
        this.servicePassword = config.servicePassword || process.env.DATA_ENGINE_SERVICE_PASSWORD;
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
            testTitle: testInfo.title,
            testStatus: testInfo.status || testInfo.state,
            duration: testInfo.duration,
            testFile: testInfo.file,
            testProject: process.env.PROJECT_NAME,
            retries: (testInfo.retries || testInfo.retries?.length) ?? 0,
            retry: testInfo.retry ?? 0,
            tags: testInfo.tags || [],
            environment: process.env.ENV,
            testInfo: {
                title: testInfo.title,
                expectedStatus: testInfo.expectedStatus || null,
                annotations: testInfo.annotations || null,
                timeout: testInfo.timeout || testInfo.timedOut,
                errors: testInfo.errors || testInfo.err || null
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

    buildTestPayloadForWDIO(testInfo) {
        return {
            testTitle: testInfo.title,
            testStatus: testInfo.state,
            duration: testInfo.duration,
            testFile: testInfo.file,
            testProject: process.env.PROJECT_NAME,
            retries: testInfo.retries ?? 0,
            retry: testInfo.retry ?? 0,
            tags: testInfo.tags || [],
            environment: process.env.ENV,
            testInfo: {},
            pipelineId: null,
            commitSha: null,
            branch: null,
            runUrl: null,
            provider: null
        };
    }

    async sendTestResult(testInfo) {
        if (!process.env.CI) return;

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

    async sendWDIOTestResult(testInfo) {
        try {

            const token = await this.generateToken();
            if (!token) {
                console.log('No se pudo obtener el token, omitiendo envio de resultado de test');
                return;
            }

            const payload = this.buildTestPayloadForWDIO(testInfo);
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
