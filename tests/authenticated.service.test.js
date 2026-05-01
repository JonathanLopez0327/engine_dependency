import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('debe aceptar configuracion por parametro', () => {
            expect(service.baseUrl).toBe('https://api.test.com');
            expect(service.tokenEndpoint).toBe('/auth/login');
            expect(service.serviceAccount).toBe('test@test.com');
            expect(service.servicePassword).toBe('password');
        });

        it('debe leer desde variables de entorno cuando no hay config', () => {
            process.env.DATA_ENGINE_BASE_URL = 'https://env.test.com';
            process.env.DATA_ENGINE_GENERATE_TOKEN = '/env/token';
            process.env.DATA_ENGINE_SERVICE_ACCOUNT = 'env@test.com';
            process.env.DATA_ENGINE_SERVICE_PASSWORD = 'envpassword';

            const s = new AuthenticatedService();

            expect(s.baseUrl).toBe('https://env.test.com');
            expect(s.tokenEndpoint).toBe('/env/token');
            expect(s.serviceAccount).toBe('env@test.com');
            expect(s.servicePassword).toBe('envpassword');

            delete process.env.DATA_ENGINE_BASE_URL;
            delete process.env.DATA_ENGINE_GENERATE_TOKEN;
            delete process.env.DATA_ENGINE_SERVICE_ACCOUNT;
            delete process.env.DATA_ENGINE_SERVICE_PASSWORD;
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
});
