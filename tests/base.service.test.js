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

        it('debe lanzar error cuando la respuesta no es ok', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized'
            }));

            await expect(service.sendPOSTRequest('https://api.test.com/data', {}))
                .rejects.toThrow('HTTP 401: Unauthorized');
        });
    });
});
