import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    K6MetricsService,
    aggregateK6Samples,
    aggregateK6SamplesFromFile,
    buildSummaryFromSamplesFile
} from '../src/services/k6-metrics.service.js';

const mockSummary = {
    metrics: {
        http_req_duration: {
            values: { avg: 120.5, min: 50, max: 800, med: 100, 'p(90)': 200, 'p(95)': 300, 'p(99)': 600 }
        },
        http_req_waiting: {
            values: { avg: 80, min: 30, max: 500, med: 70, 'p(90)': 150, 'p(95)': 250, 'p(99)': 450 }
        },
        http_req_failed: {
            values: { rate: 0.02, fails: 4, passes: 196 }
        },
        http_reqs: {
            values: { count: 200, rate: 20.5 }
        },
        group_duration: {
            values: { avg: 1500, min: 800, max: 3000, med: 1400, 'p(90)': 2500, 'p(95)': 2800, 'p(99)': 2950 }
        },
        vus: {
            values: { value: 10, min: 1, max: 50 }
        },
        vus_max: {
            values: { value: 50, min: 50, max: 50 }
        },
        data_received: {
            values: { count: 102400, rate: 1024 }
        },
        data_sent: {
            values: { count: 51200, rate: 512 }
        }
    },
    state: { testRunDurationMs: 60000 },
    options: {
        scenarios: { my_scenario: { executor: 'ramping-vus' } },
        tags: { test_type: 'benchmark' }
    },
    root_group: {
        name: '',
        path: '',
        groups: [
            {
                name: 'Login',
                path: '::Login',
                checks: [
                    { name: 'status is 200', passes: 95, fails: 5 },
                    { name: 'has token', passes: 100, fails: 0 }
                ],
                groups: []
            },
            {
                name: 'Checkout',
                path: '::Checkout',
                checks: [{ name: 'order created', passes: 50, fails: 0 }],
                groups: [
                    {
                        name: 'Payment',
                        path: '::Checkout::Payment',
                        checks: [{ name: 'paid', passes: 48, fails: 2 }],
                        groups: []
                    }
                ]
            }
        ],
        checks: []
    }
};

describe('K6MetricsService', () => {
    let service;

    beforeEach(() => {
        service = new K6MetricsService({
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
        delete process.env.SCENARIO_NAME;
        delete process.env.TEST_TYPE;
    });

    describe('constructor', () => {
        it('debe usar el endpoint default de k6 metrics', () => {
            expect(service.k6MetricsEndpoint).toBe('/api/k6-metrics');
        });

        it('debe permitir override del endpoint', () => {
            const s = new K6MetricsService({ k6MetricsEndpoint: '/custom/k6' });
            expect(s.k6MetricsEndpoint).toBe('/custom/k6');
        });

        it('debe heredar la config de auth de AuthenticatedService', () => {
            expect(service.baseUrl).toBe('https://api.test.com');
            expect(service.tokenEndpoint).toBe('/auth/login');
            expect(typeof service.generateToken).toBe('function');
        });
    });

    describe('buildK6Payload', () => {
        it('debe extraer todos los stats de http_req_duration y http_req_waiting', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.http_req_duration).toEqual({
                avg: 120.5, min: 50, max: 800, med: 100,
                'p(90)': 200, 'p(95)': 300, 'p(99)': 600
            });
            expect(payload.http_req_waiting.avg).toBe(80);
            expect(payload.http_req_waiting['p(95)']).toBe(250);
        });

        it('debe extraer rate de http_req_failed y stats de http_reqs', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.http_req_failed).toEqual({ rate: 0.02 });
            expect(payload.http_reqs).toEqual({ count: 200, rate: 20.5 });
        });

        it('debe extraer concurrencia y transferencia', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.vus).toEqual({ value: 10, min: 1, max: 50 });
            expect(payload.vus_max).toEqual({ value: 50, min: 50, max: 50 });
            expect(payload.data_received).toEqual({ count: 102400, rate: 1024 });
            expect(payload.data_sent).toEqual({ count: 51200, rate: 512 });
        });

        it('debe incluir scenarioName desde data.options.scenarios', () => {
            const payload = service.buildK6Payload(mockSummary);
            expect(payload.scenarioName).toBe('my_scenario');
        });

        it('debe usar SCENARIO_NAME env var como fallback cuando no hay scenarios', () => {
            process.env.SCENARIO_NAME = 'fallback-scenario';
            const data = { ...mockSummary, options: { tags: { test_type: 'benchmark' } } };

            const payload = service.buildK6Payload(data);

            expect(payload.scenarioName).toBe('fallback-scenario');
        });

        it('debe extraer testType desde data.options.tags.test_type', () => {
            const payload = service.buildK6Payload(mockSummary);
            expect(payload.testType).toBe('benchmark');
        });

        it('debe usar TEST_TYPE env var como fallback', () => {
            process.env.TEST_TYPE = 'load';
            const data = { ...mockSummary, options: { scenarios: { s1: {} } } };

            const payload = service.buildK6Payload(data);

            expect(payload.testType).toBe('load');
        });

        it('debe calcular duration, startedAt y endedAt', () => {
            const fixedNow = 1_700_000_000_000;
            vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

            const payload = service.buildK6Payload(mockSummary);

            expect(payload.duration).toBe(60000);
            expect(payload.endedAt).toBe(fixedNow);
            expect(payload.startedAt).toBe(fixedNow - 60000);
        });

        it('debe respetar startedAt y endedAt pasados via meta', () => {
            const payload = service.buildK6Payload(mockSummary, { startedAt: 1000, endedAt: 9000 });

            expect(payload.startedAt).toBe(1000);
            expect(payload.endedAt).toBe(9000);
        });

        it('debe ser defensive: data vacio retorna sub-objetos null sin throw', () => {
            const payload = service.buildK6Payload({});

            expect(payload.http_req_duration).toBeNull();
            expect(payload.http_req_waiting).toBeNull();
            expect(payload.http_req_failed).toEqual({ rate: null });
            expect(payload.http_reqs).toBeNull();
            expect(payload.group_duration).toBeNull();
            expect(payload.vus).toBeNull();
            expect(payload.scenarioName).toBeNull();
            expect(payload.testType).toBeNull();
            expect(payload.duration).toBeNull();
            expect(payload.groups).toEqual([]);
        });

        it('debe extraer group_duration global', () => {
            const payload = service.buildK6Payload(mockSummary);
            expect(payload.group_duration).toEqual({
                avg: 1500, min: 800, max: 3000, med: 1400,
                'p(90)': 2500, 'p(95)': 2800, 'p(99)': 2950
            });
        });
    });

    describe('groups', () => {
        it('debe aplanar root_group en una lista plana con paths jerarquicos', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.groups).toHaveLength(3);
            const paths = payload.groups.map((g) => g.path);
            expect(paths).toEqual(['::Login', '::Checkout', '::Checkout::Payment']);
        });

        it('debe agregar checks por grupo con totales', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            expect(login.checks).toEqual({
                total: 2,
                passes: 195,
                fails: 5,
                items: [
                    { name: 'status is 200', passes: 95, fails: 5 },
                    { name: 'has token', passes: 100, fails: 0 }
                ]
            });
        });

        it('debe dejar metricas null cuando no hay groupMetrics', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            expect(login.group_duration).toBeNull();
            expect(login.http_req_duration).toBeNull();
            expect(login.http_req_failed).toBeNull();
            expect(login.http_reqs).toBeNull();
        });

        it('debe mergear groupMetrics por path en cada grupo', () => {
            const groupMetrics = {
                '::Login': {
                    http_req_duration: { avg: 100, min: 50, max: 200, med: 90, 'p(90)': 150, 'p(95)': 180, 'p(99)': 195 },
                    http_req_failed: { rate: 0.05 },
                    http_reqs: { count: 100 },
                    group_duration: { avg: 1200, min: 800, max: 1800, med: 1100, 'p(90)': 1600, 'p(95)': 1700, 'p(99)': 1790 }
                }
            };

            const payload = service.buildK6Payload(mockSummary, { groupMetrics });
            const login = payload.groups.find((g) => g.path === '::Login');
            const checkout = payload.groups.find((g) => g.path === '::Checkout');

            expect(login.http_req_duration.avg).toBe(100);
            expect(login.http_req_failed).toEqual({ rate: 0.05 });
            expect(login.http_reqs).toEqual({ count: 100 });
            expect(login.group_duration.avg).toBe(1200);
            // grupo sin metricas: queda null
            expect(checkout.http_req_duration).toBeNull();
        });
    });

    describe('aggregateK6Samples', () => {
        it('debe agregar samples por group path', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 300, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 0,   tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 1,   tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Login' } } },
                { type: 'Point', metric: 'group_duration',    data: { value: 1500, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 50,  tags: { group: '::Checkout' } } }
            ];

            const result = aggregateK6Samples(samples);

            expect(Object.keys(result).sort()).toEqual(['::Checkout', '::Login']);
            expect(result['::Login'].http_req_duration.min).toBe(100);
            expect(result['::Login'].http_req_duration.max).toBe(300);
            expect(result['::Login'].http_req_duration.avg).toBeCloseTo(200);
            expect(result['::Login'].http_req_failed).toEqual({ rate: 0.5 });
            expect(result['::Login'].http_reqs).toEqual({ count: 2 });
            expect(result['::Login'].group_duration.avg).toBe(1500);
            expect(result['::Checkout'].http_req_duration.min).toBe(50);
        });

        it('debe ignorar samples sin tag de grupo', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: {} } },
                { type: 'Metric', metric: 'http_req_duration', data: {} }
            ];

            const result = aggregateK6Samples(samples);

            expect(result).toEqual({});
        });
    });

    describe('aggregateK6SamplesFromFile', () => {
        let tmpFile;

        afterEach(() => {
            if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            tmpFile = null;
        });

        it('debe streamear el NDJSON desde disco y agregar por grupo', async () => {
            tmpFile = path.join(os.tmpdir(), `k6-samples-${Date.now()}.ndjson`);
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Login' } } },
                { type: 'Point', metric: 'group_duration',    data: { value: 1500, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 80,  tags: { group: '::Checkout' } } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

            const result = await aggregateK6SamplesFromFile(tmpFile);

            expect(Object.keys(result).sort()).toEqual(['::Checkout', '::Login']);
            expect(result['::Login'].http_req_duration.avg).toBe(150);
            expect(result['::Login'].http_reqs).toEqual({ count: 1 });
            expect(result['::Login'].group_duration.avg).toBe(1500);
            expect(result['::Checkout'].http_req_duration.avg).toBe(80);
        });

        it('debe ignorar lineas malformadas', async () => {
            tmpFile = path.join(os.tmpdir(), `k6-samples-bad-${Date.now()}.ndjson`);
            fs.writeFileSync(tmpFile, [
                '{not-json',
                JSON.stringify({ type: 'Point', metric: 'http_req_duration', data: { value: 50, tags: { group: '::A' } } }),
                '',
                'broken line'
            ].join('\n'));

            const result = await aggregateK6SamplesFromFile(tmpFile);

            expect(result['::A'].http_req_duration.avg).toBe(50);
        });
    });

    describe('buildSummaryFromSamplesFile', () => {
        let tmpFile;

        afterEach(() => {
            if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            tmpFile = null;
        });

        it('debe reconstruir un summary con metrics globales y root_group desde el NDJSON', async () => {
            tmpFile = path.join(os.tmpdir(), `k6-build-summary-${Date.now()}.ndjson`);
            const t0 = '2026-04-30T10:00:00.000Z';
            const t1 = '2026-04-30T10:00:10.000Z';
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 50, time: t0, tags: { group: '::A', scenario: 's1', test_type: 'load' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 150, time: t1, tags: { group: '::B' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,  time: t1, tags: { group: '::A' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,  time: t1, tags: { group: '::B' } } },
                { type: 'Point', metric: 'data_sent',         data: { value: 200, time: t1, tags: {} } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n'));

            const summary = await buildSummaryFromSamplesFile(tmpFile);

            expect(summary.state.testRunDurationMs).toBe(10000);
            expect(summary.metrics.http_req_duration.values.avg).toBe(100);
            expect(summary.metrics.http_reqs.values.count).toBe(2);
            expect(summary.metrics.data_sent.values.count).toBe(200);
            expect(summary.options.scenarios).toEqual({ s1: {} });
            expect(summary.options.tags).toEqual({ test_type: 'load' });
            const groupPaths = summary.root_group.groups.map((g) => g.path).sort();
            expect(groupPaths).toEqual(['::A', '::B']);
            expect(summary._groupMetrics['::A'].http_req_duration.avg).toBe(50);
            expect(summary._groupMetrics['::B'].http_req_duration.avg).toBe(150);
        });
    });

    describe('sendK6Metrics', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            vi.spyOn(service, 'generateToken');

            const result = await service.sendK6Metrics(mockSummary);

            expect(result).toBeUndefined();
            expect(service.generateToken).not.toHaveBeenCalled();
        });

        it('debe enviar las metricas cuando CI esta activo', async () => {
            process.env.CI = 'true';
            vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
            vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 42 } });

            const result = await service.sendK6Metrics(mockSummary);

            expect(result).toEqual({ id: 42 });
            expect(service.sendPOSTRequest).toHaveBeenCalledWith(
                'https://api.test.com/api/k6-metrics',
                expect.objectContaining({ scenarioName: 'my_scenario', testType: 'benchmark' }),
                { Authorization: 'Bearer mock-token' }
            );
        });

        it('debe retornar undefined si no obtiene token', async () => {
            process.env.CI = 'true';
            vi.spyOn(service, 'generateToken').mockResolvedValue(undefined);

            const result = await service.sendK6Metrics(mockSummary);

            expect(result).toBeUndefined();
            expect(console.error).toHaveBeenCalled();
        });

        it('debe reconstruir summary desde NDJSON cuando data es null', async () => {
            process.env.CI = 'true';
            const tmpFile = path.join(os.tmpdir(), `k6-only-stream-${Date.now()}.ndjson`);
            const t0 = '2026-04-30T10:00:00.000Z';
            const t1 = '2026-04-30T10:00:30.000Z';
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, time: t0, tags: { group: '::Login', scenario: 'updateActivity', test_type: 'benchmark' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, time: t1, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   time: t1, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 0,   time: t1, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'data_received',     data: { value: 5000, time: t1, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'vus',               data: { value: 5,   time: t1, tags: {} } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n'));

            try {
                vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
                vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 99 } });

                await service.sendK6Metrics(null, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0][1];
                expect(sent.scenarioName).toBe('updateActivity');
                expect(sent.testType).toBe('benchmark');
                expect(sent.duration).toBe(30000);
                expect(sent.http_req_duration.avg).toBe(150);
                expect(sent.http_reqs.count).toBe(1);
                expect(sent.data_received.count).toBe(5000);
                expect(sent.vus.value).toBe(5);
                const login = sent.groups.find((g) => g.path === '::Login');
                expect(login).toBeTruthy();
                expect(login.http_req_duration.avg).toBe(150);
                expect(login.http_reqs).toEqual({ count: 1 });
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('debe streamear samplesPath y mergear groupMetrics automaticamente', async () => {
            process.env.CI = 'true';
            const tmpFile = path.join(os.tmpdir(), `k6-send-${Date.now()}.ndjson`);
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 300, tags: { group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Login' } } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n'));

            try {
                vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
                vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 7 } });

                await service.sendK6Metrics(mockSummary, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0][1];
                const login = sent.groups.find((g) => g.path === '::Login');
                expect(login.http_req_duration.avg).toBe(200);
                expect(login.http_reqs).toEqual({ count: 1 });
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});
