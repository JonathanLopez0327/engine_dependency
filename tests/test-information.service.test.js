import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.CI;
    });

    describe('constructor', () => {
        it('debe aceptar configuracion por parametro', () => {
            expect(service.baseUrl).toBe('https://api.test.com');
            expect(service.tokenEndpoint).toBe('/auth/login');
            expect(service.serviceAccount).toBe('test@test.com');
            expect(service.servicePassword).toBe('password');
            expect(service.testResultsEndpoint).toBe('/api/test-results');
        });

        it('debe usar valores por defecto del endpoint de test results', () => {
            const s = new TestInformationService({});
            expect(s.testResultsEndpoint).toBe('/api/test-results');
        });
    });

    describe('buildTestPayload', () => {
        it('debe construir el payload correctamente', () => {
            const payload = service.buildTestPayload(mockTestInfo);

            expect(payload.testTitle).toBe('Login exitoso');
            expect(payload.testStatus).toBe('passed');
            expect(payload.duration).toBe(3500);
            expect(payload.testFile).toBe('tests/auth/login.spec.js');
            expect(payload.retries).toBe(0);
            expect(payload.tags).toEqual(['@smoke']);
            expect(payload.testInfo.title).toBe('Login exitoso');
            expect(payload.testInfo.annotations).toEqual([]);
        });

        it('debe usar title cuando titlePath no existe', () => {
            const info = { ...mockTestInfo, titlePath: undefined };
            const payload = service.buildTestPayload(info);

            expect(payload.testTitle).toBe('Login exitoso');
        });
    });

    describe('buildTestPayloadForWDIO', () => {
        it('debe construir el payload correctamente para WDIO', () => {
            const payload = service.buildTestPayloadForWDIO(mockTestInfo);

            expect(payload.testTitle).toBe('Login exitoso');
            expect(payload.testStatus).toBe('passed');
            expect(payload.duration).toBe(3500);
            expect(payload.testFile).toBe('tests/auth/login.spec.js');
            expect(payload.retries).toBe(0);
            expect(payload.tags).toEqual(['@smoke']);
            expect(payload.testInfo).toEqual({});
        });
    });

    describe('generateToken', () => {
        it('debe retornar el token cuando la peticion es exitosa', async () => {
            vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({
                data: { token: 'mock-token-123' }
            });

            const token = await service.generateToken();

            expect(token).toBe('mock-token-123');
            expect(service.sendPOSTRequest).toHaveBeenCalledWith(
                'https://api.test.com/auth/login',
                { email: 'test@test.com', password: 'password' }
            );
        });

        it('debe retornar undefined cuando falla la peticion', async () => {
            vi.spyOn(service, 'sendPOSTRequest').mockRejectedValue(new Error('Network error'));

            const token = await service.generateToken();

            expect(token).toBeUndefined();
            expect(console.error).toHaveBeenCalled();
        });
    });

    describe('sendTestResult', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            vi.spyOn(service, 'generateToken');

            const result = await service.sendTestResult(mockTestInfo);

            expect(result).toBeUndefined();
            expect(service.generateToken).not.toHaveBeenCalled();
        });

        it('debe enviar el resultado cuando CI esta activo', async () => {
            process.env.CI = 'true';
            vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
            vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 1 } });

            const result = await service.sendTestResult(mockTestInfo);

            expect(result).toEqual({ id: 1 });
            expect(service.sendPOSTRequest).toHaveBeenCalledWith(
                'https://api.test.com/api/test-results',
                expect.any(Object),
                { Authorization: 'Bearer mock-token' }
            );
        });

        it('debe retornar undefined si no obtiene token', async () => {
            process.env.CI = 'true';
            vi.spyOn(service, 'generateToken').mockResolvedValue(undefined);

            const result = await service.sendTestResult(mockTestInfo);

            expect(result).toBeUndefined();
        });
    });

    describe('sendWDIOTestResult', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            vi.spyOn(service, 'generateToken');

            const result = await service.sendWDIOTestResult(mockTestInfo);

            expect(result).toBeUndefined();
            expect(service.generateToken).not.toHaveBeenCalled();
        });

        it('debe enviar el resultado cuando CI esta activo', async () => {
            process.env.CI = 'true';
            vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
            vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 1 } });

            const result = await service.sendWDIOTestResult(mockTestInfo);

            expect(result).toEqual({ id: 1 });
            expect(service.sendPOSTRequest).toHaveBeenCalledWith(
                'https://api.test.com/api/test-results',
                expect.any(Object),
                { Authorization: 'Bearer mock-token' }
            );
        });
    });
});
