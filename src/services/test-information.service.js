import { AuthenticatedService } from './authenticated.service.js';
import { DEFAULT_ENDPOINTS, ENV_VARS, PROVIDERS } from '../constants.js';

export class TestInformationService extends AuthenticatedService {
    /**
     * @param {object} config - Configuration object.
     */
    constructor(config = {}) {
        super(config);
        this.testResultsEndpoint = config.testResultsEndpoint || DEFAULT_ENDPOINTS.TEST_RESULTS;
    }

    /**
     * Builds the payload for standard test results.
     * @param {object} testInfo - The test information.
     * @returns {object} The payload.
     */
    buildTestPayload(testInfo) {
        return {
            testTitle: testInfo.title,
            testStatus: testInfo.status || testInfo.state,
            duration: testInfo.duration,
            testFile: testInfo.file,
            testProject: process.env[ENV_VARS.PROJECT_NAME],
            retries: (testInfo.retries || testInfo.retries?.length) ?? 0,
            retry: testInfo.retry ?? 0,
            tags: testInfo.tags || [],
            environment: process.env[ENV_VARS.ENV],
            testInfo: {
                title: testInfo.title,
                expectedStatus: testInfo.expectedStatus || null,
                annotations: testInfo.annotations || null,
                timeout: testInfo.timeout || testInfo.timedOut,
                errors: testInfo.errors || testInfo.err || null
            },
            pipelineId: process.env[ENV_VARS.BUILD_ID] || null,
            commitSha: process.env[ENV_VARS.SOURCE_VERSION] || null,
            branch: process.env[ENV_VARS.SOURCE_BRANCH] || null,
            runUrl: process.env[ENV_VARS.BUILD_ID]
                ? `${process.env[ENV_VARS.TEAM_FOUNDATION_COLLECTION_URI]}${process.env[ENV_VARS.TEAM_PROJECT]}/_build/results?buildId=${process.env[ENV_VARS.BUILD_ID]}`
                : null,
            provider: process.env[ENV_VARS.BUILD_ID] ? PROVIDERS.AZURE_DEVOPS : null
        };
    }

    /**
     * Builds the payload for WDIO test results.
     * @param {object} testInfo - The test information.
     * @returns {object} The payload.
     */
    buildTestPayloadForWDIO(testInfo) {
        return {
            testTitle: testInfo.title,
            testStatus: testInfo.state,
            duration: testInfo.duration,
            testFile: testInfo.file,
            testProject: process.env[ENV_VARS.PROJECT_NAME],
            retries: testInfo.retries ?? 0,
            retry: testInfo.retry ?? 0,
            tags: testInfo.tags || [],
            environment: process.env[ENV_VARS.ENV],
            testInfo: {},
            pipelineId: "",
            commitSha: "",
            branch: "",
            runUrl: "",
            provider: ""
        };
    }

    /**
     * Internal method to send test result.
     * @param {object} payload - The payload to send.
     * @param {string} testTitle - The title of the test for logging.
     * @param {string} testStatus - The status of the test for logging.
     * @returns {Promise<any>} The response data.
     */
    async _sendResult(payload, testTitle, testStatus) {
        if (!process.env.CI) return;

        try {
            const token = await this.generateToken();
            if (!token) {
                console.error('No se pudo obtener el token, omitiendo envio de resultado de test');
                return;
            }

            const response = await this.sendPOSTRequest(
                `${this.baseUrl}${this.testResultsEndpoint}`,
                payload,
                { Authorization: `Bearer ${token}` }
            );

            console.log(`Resultado de test enviado: ${testTitle} - ${testStatus}`);
            return response?.data;
        } catch (error) {
            console.error(`Error enviando resultado de test: ${error?.message || error}`);
        }
    }

    /**
     * Sends the test result.
     * @param {object} testInfo - The test information.
     * @returns {Promise<any>} The response data.
     */
    async sendTestResult(testInfo) {
        const payload = this.buildTestPayload(testInfo);
        return this._sendResult(payload, testInfo.title, testInfo.status || testInfo.state);
    }

    /**
     * Sends the WDIO test result.
     * @param {object} testInfo - The test information.
     * @returns {Promise<any>} The response data.
     */
    async sendWDIOTestResult(testInfo) {
        const payload = this.buildTestPayloadForWDIO(testInfo);
        return this._sendResult(payload, testInfo.title, testInfo.state);
    }
}
