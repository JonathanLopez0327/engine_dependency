import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticatedService } from '../src/services/authenticated.service.js';

describe('AuthenticatedService', () => {
    let service;

    beforeEach(() => {
        service = new AuthenticatedService({
            baseUrl: 'https://api.test.com',
            tokenEndpoint: '/auth/login',
            serviceAccount: 'test@test.com',
            servicePassword: 'password'
        });
        mock.method(console, 'log', () => { });
        mock.method(console, 'error', () => { });
    });

    afterEach(() => {
        mock.restoreAll();
        mock.reset();
    });

    describe('constructor', () => {
        it('debe aceptar configuracion por parametro', () => {
            assert.equal(service.baseUrl, 'https://api.test.com');
            assert.equal(service.tokenEndpoint, '/auth/login');
            assert.equal(service.serviceAccount, 'test@test.com');
            assert.equal(service.servicePassword, 'password');
        });

        it('debe leer desde variables de entorno cuando no hay config', () => {
            process.env.DATA_ENGINE_BASE_URL = 'https://env.test.com';
            process.env.DATA_ENGINE_GENERATE_TOKEN = '/env/token';
            process.env.DATA_ENGINE_SERVICE_ACCOUNT = 'env@test.com';
            process.env.DATA_ENGINE_SERVICE_PASSWORD = 'envpassword';

            const s = new AuthenticatedService();

            assert.equal(s.baseUrl, 'https://env.test.com');
            assert.equal(s.tokenEndpoint, '/env/token');
            assert.equal(s.serviceAccount, 'env@test.com');
            assert.equal(s.servicePassword, 'envpassword');

            delete process.env.DATA_ENGINE_BASE_URL;
            delete process.env.DATA_ENGINE_GENERATE_TOKEN;
            delete process.env.DATA_ENGINE_SERVICE_ACCOUNT;
            delete process.env.DATA_ENGINE_SERVICE_PASSWORD;
        });
    });

    describe('generateToken', () => {
        it('debe retornar el token cuando la peticion es exitosa', async () => {
            mock.method(service, 'sendPOSTRequest', async () => ({
                data: { token: 'mock-token-123' }
            }));

            const token = await service.generateToken();

            assert.equal(token, 'mock-token-123');
            assert.deepEqual(service.sendPOSTRequest.mock.calls[0].arguments, [
                'https://api.test.com/auth/login',
                { email: 'test@test.com', password: 'password' }
            ]);
        });

        it('debe retornar undefined cuando falla la peticion', async () => {
            mock.method(service, 'sendPOSTRequest', async () => { throw new Error('Network error'); });

            const token = await service.generateToken();

            assert.equal(token, undefined);
            assert.ok(console.error.mock.calls.length > 0);
        });
    });
});
