import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import BaseService from '../src/services/base.service.js';

describe('BaseService', () => {
    let service;
    let originalFetch;

    beforeEach(() => {
        service = new BaseService();
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        mock.restoreAll();
        mock.reset();
    });

    describe('sendPOSTRequest', () => {
        it('debe enviar una peticion POST y retornar data', async () => {
            const mockResponse = { success: true, id: 1 };
            const fetchMock = mock.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => mockResponse
            }));
            globalThis.fetch = fetchMock;

            const result = await service.sendPOSTRequest('https://api.test.com/data', { key: 'value' });

            assert.deepEqual(result.data, mockResponse);
            assert.equal(result.status, 200);
            assert.equal(fetchMock.mock.calls.length, 1);
            assert.deepEqual(fetchMock.mock.calls[0].arguments, [
                'https://api.test.com/data',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'value' })
                }
            ]);
        });

        it('debe incluir headers personalizados', async () => {
            const fetchMock = mock.fn(async () => ({
                ok: true,
                status: 201,
                json: async () => ({})
            }));
            globalThis.fetch = fetchMock;

            await service.sendPOSTRequest('https://api.test.com/data', {}, { Authorization: 'Bearer token' });

            assert.deepEqual(fetchMock.mock.calls[0].arguments, [
                'https://api.test.com/data',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer token'
                    },
                    body: JSON.stringify({})
                }
            ]);
        });

        it('debe lanzar error cuando la respuesta no es ok e incluir el body de la respuesta', async () => {
            globalThis.fetch = mock.fn(async () => ({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                text: async () => '{"error":"invalid credentials"}'
            }));

            await assert.rejects(
                service.sendPOSTRequest('https://api.test.com/data', {}),
                /HTTP 401 Unauthorized on POST https:\/\/api\.test\.com\/data - \{"error":"invalid credentials"\}/
            );
        });

        it('debe tolerar respuestas sin body legible', async () => {
            globalThis.fetch = mock.fn(async () => ({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => { throw new Error('stream consumed'); }
            }));

            await assert.rejects(
                service.sendPOSTRequest('https://api.test.com/data', {}),
                /HTTP 500 Internal Server Error on POST/
            );
        });
    });

    describe('sendGETRequest', () => {
        it('debe enviar una peticion GET y retornar data', async () => {
            const mockResponse = { id: 42, status: 'compared' };
            const fetchMock = mock.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => mockResponse
            }));
            globalThis.fetch = fetchMock;

            const result = await service.sendGETRequest('https://api.test.com/data/42');

            assert.deepEqual(result.data, mockResponse);
            assert.equal(result.status, 200);
            assert.deepEqual(fetchMock.mock.calls[0].arguments, [
                'https://api.test.com/data/42',
                { method: 'GET', headers: {} }
            ]);
        });

        it('debe incluir headers personalizados', async () => {
            const fetchMock = mock.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({})
            }));
            globalThis.fetch = fetchMock;

            await service.sendGETRequest('https://api.test.com/data', { Authorization: 'Bearer token' });

            assert.deepEqual(fetchMock.mock.calls[0].arguments, [
                'https://api.test.com/data',
                { method: 'GET', headers: { Authorization: 'Bearer token' } }
            ]);
        });

        it('debe lanzar error cuando la respuesta no es ok e incluir el body', async () => {
            globalThis.fetch = mock.fn(async () => ({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                text: async () => '{"error":"Run not found"}'
            }));

            await assert.rejects(
                service.sendGETRequest('https://api.test.com/data/999'),
                /HTTP 404 Not Found on GET https:\/\/api\.test\.com\/data\/999 - \{"error":"Run not found"\}/
            );
        });
    });
});
