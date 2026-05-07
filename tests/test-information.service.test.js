import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TestInformationService } from '../src/services/test-information.service.js';

const mockTestInfo = {
    title: 'Login exitoso',
    titlePath: ['Auth', 'Login', 'Login exitoso'],
    status: 'passed',
    state: 'passed', // for WDIO
    duration: 3500,
    file: 'tests/auth/login.spec.js',
    project: { name: 'e2e-chrome' },
    retries: 0,
    retry: 0,
    tags: ['@smoke'],
    expectedStatus: 'passed',
    annotations: [],
    timeout: 30000,
    errors: []
};

describe('TestInformationService', () => {
    let service;

    beforeEach(() => {
        service = new TestInformationService({
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
        delete process.env.CI;
    });

    describe('constructor', () => {
        it('debe aceptar configuracion por parametro', () => {
            assert.equal(service.baseUrl, 'https://api.test.com');
            assert.equal(service.tokenEndpoint, '/auth/login');
            assert.equal(service.serviceAccount, 'test@test.com');
            assert.equal(service.servicePassword, 'password');
            assert.equal(service.testResultsEndpoint, '/api/test-results');
        });

        it('debe usar valores por defecto del endpoint de test results', () => {
            const s = new TestInformationService({});
            assert.equal(s.testResultsEndpoint, '/api/test-results');
        });
    });

    describe('buildTestPayload', () => {
        it('debe construir el payload correctamente', () => {
            const payload = service.buildTestPayload(mockTestInfo);

            assert.equal(payload.testTitle, 'Login exitoso');
            assert.equal(payload.testStatus, 'passed');
            assert.equal(payload.duration, 3500);
            assert.equal(payload.testFile, 'tests/auth/login.spec.js');
            assert.equal(payload.retries, 0);
            assert.deepEqual(payload.tags, ['@smoke']);
            assert.equal(payload.testInfo.title, 'Login exitoso');
            assert.deepEqual(payload.testInfo.annotations, []);
        });

        it('debe usar title cuando titlePath no existe', () => {
            const info = { ...mockTestInfo, titlePath: undefined };
            const payload = service.buildTestPayload(info);

            assert.equal(payload.testTitle, 'Login exitoso');
        });
    });

    describe('buildTestPayloadForWDIO', () => {
        it('debe construir el payload correctamente para WDIO', () => {
            const payload = service.buildTestPayloadForWDIO(mockTestInfo);

            assert.equal(payload.testTitle, 'Login exitoso');
            assert.equal(payload.testStatus, 'passed');
            assert.equal(payload.duration, 3500);
            assert.equal(payload.testFile, 'tests/auth/login.spec.js');
            assert.equal(payload.retries, 0);
            assert.deepEqual(payload.tags, ['@smoke']);
            assert.deepEqual(payload.testInfo, {});
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

    describe('sendTestResult', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            const tokenSpy = mock.method(service, 'generateToken', service.generateToken);

            const result = await service.sendTestResult(mockTestInfo);

            assert.equal(result, undefined);
            assert.equal(tokenSpy.mock.calls.length, 0);
        });

        it('debe enviar el resultado cuando CI esta activo', async () => {
            process.env.CI = 'true';
            mock.method(service, 'generateToken', async () => 'mock-token');
            mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 1 } }));

            const result = await service.sendTestResult(mockTestInfo);

            assert.deepEqual(result, { id: 1 });
            const args = service.sendPOSTRequest.mock.calls[0].arguments;
            assert.equal(args[0], 'https://api.test.com/api/test-results');
            assert.ok(args[1] && typeof args[1] === 'object');
            assert.deepEqual(args[2], { Authorization: 'Bearer mock-token' });
        });

        it('debe retornar undefined si no obtiene token', async () => {
            process.env.CI = 'true';
            mock.method(service, 'generateToken', async () => undefined);

            const result = await service.sendTestResult(mockTestInfo);

            assert.equal(result, undefined);
        });
    });

    describe('sendWDIOTestResult', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            const tokenSpy = mock.method(service, 'generateToken', service.generateToken);

            const result = await service.sendWDIOTestResult(mockTestInfo);

            assert.equal(result, undefined);
            assert.equal(tokenSpy.mock.calls.length, 0);
        });

        it('debe enviar el resultado cuando CI esta activo', async () => {
            process.env.CI = 'true';
            mock.method(service, 'generateToken', async () => 'mock-token');
            mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 1 } }));

            const result = await service.sendWDIOTestResult(mockTestInfo);

            assert.deepEqual(result, { id: 1 });
            const args = service.sendPOSTRequest.mock.calls[0].arguments;
            assert.equal(args[0], 'https://api.test.com/api/test-results');
            assert.ok(args[1] && typeof args[1] === 'object');
            assert.deepEqual(args[2], { Authorization: 'Bearer mock-token' });
        });
    });
});
