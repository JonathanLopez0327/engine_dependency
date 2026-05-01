import BaseService from './base.service.js';
import { ENV_VARS } from '../constants.js';

export class AuthenticatedService extends BaseService {
    /**
     * @param {object} config - Configuration object.
     * @param {string} [config.baseUrl] - API base URL.
     * @param {string} [config.tokenEndpoint] - Auth endpoint path.
     * @param {string} [config.serviceAccount] - Service account email.
     * @param {string} [config.servicePassword] - Service account password.
     */
    constructor(config = {}) {
        super();
        this.baseUrl = config.baseUrl || process.env[ENV_VARS.BASE_URL];
        this.tokenEndpoint = config.tokenEndpoint || process.env[ENV_VARS.TOKEN_ENDPOINT];
        this.serviceAccount = config.serviceAccount || process.env[ENV_VARS.SERVICE_ACCOUNT];
        this.servicePassword = config.servicePassword || process.env[ENV_VARS.SERVICE_PASSWORD];
    }

    /**
     * Generates an authentication token.
     * @returns {Promise<string|undefined>} The token or undefined if failed.
     */
    async generateToken() {
        try {
            const response = await this.sendPOSTRequest(`${this.baseUrl}${this.tokenEndpoint}`, {
                email: this.serviceAccount,
                password: this.servicePassword
            });
            return response.data.token;
        } catch (error) {
            console.error(`Error generando token: ${error?.message || error}`);
        }
    }
}
