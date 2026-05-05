import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BaseService from '../src/services/base.service.js';

describe('BaseService', () => {
    let service;

    beforeEach(() => {
        service = new BaseService();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('sendPOSTRequest', () => {
        it('debe enviar una peticion POST y retornar data', async () => {
            const mockResponse = { success: true, id: 1 };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve(mockResponse)
            }));

            const result = await service.sendPOSTRequest('https://api.test.com/data', { key: 'value' });

            expect(result.data).toEqual(mockResponse);
            expect(result.status).toBe(200);
            expect(fetch).toHaveBeenCalledWith('https://api.test.com/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'value' })
            });
        });

        it('debe incluir headers personalizados', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 201,
                json: () => Promise.resolve({})
            }));

            await service.sendPOSTRequest('https://api.test.com/data', {}, { Authorization: 'Bearer token' });

            expect(fetch).toHaveBeenCalledWith('https://api.test.com/data', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token'
                },
                body: JSON.stringify({})
            });
        });

        it('debe lanzar error cuando la respuesta no es ok e incluir el body de la respuesta', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                text: () => Promise.resolve('{"error":"invalid credentials"}')
            }));

            await expect(service.sendPOSTRequest('https://api.test.com/data', {}))
                .rejects.toThrow(/HTTP 401 Unauthorized on POST https:\/\/api\.test\.com\/data - \{"error":"invalid credentials"\}/);
        });

        it('debe tolerar respuestas sin body legible', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: () => Promise.reject(new Error('stream consumed'))
            }));

            await expect(service.sendPOSTRequest('https://api.test.com/data', {}))
                .rejects.toThrow(/HTTP 500 Internal Server Error on POST/);
        });
    });

    describe('sendGETRequest', () => {
        it('debe enviar una peticion GET y retornar data', async () => {
            const mockResponse = { id: 42, status: 'compared' };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve(mockResponse)
            }));

            const result = await service.sendGETRequest('https://api.test.com/data/42');

            expect(result.data).toEqual(mockResponse);
            expect(result.status).toBe(200);
            expect(fetch).toHaveBeenCalledWith('https://api.test.com/data/42', {
                method: 'GET',
                headers: {}
            });
        });

        it('debe incluir headers personalizados', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({})
            }));

            await service.sendGETRequest('https://api.test.com/data', { Authorization: 'Bearer token' });

            expect(fetch).toHaveBeenCalledWith('https://api.test.com/data', {
                method: 'GET',
                headers: { Authorization: 'Bearer token' }
            });
        });

        it('debe lanzar error cuando la respuesta no es ok e incluir el body', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                text: () => Promise.resolve('{"error":"Run not found"}')
            }));

            await expect(service.sendGETRequest('https://api.test.com/data/999'))
                .rejects.toThrow(/HTTP 404 Not Found on GET https:\/\/api\.test\.com\/data\/999 - \{"error":"Run not found"\}/);
        });
    });
});
