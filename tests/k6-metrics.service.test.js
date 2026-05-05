import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    K6MetricsService,
    aggregateK6Samples,
    aggregateK6SamplesFromFile,
    aggregateK6Endpoints,
    aggregateK6EndpointsFromFile,
    buildSummaryFromSamplesFile,
    computeScriptHash
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
        delete process.env.BUILD_BUILDID;
        delete process.env.SYSTEM_DEFINITIONID;
        delete process.env.BUILD_SOURCEVERSION;
        delete process.env.BUILD_SOURCEBRANCH;
        delete process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
        delete process.env.SYSTEM_TEAMPROJECT;
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
        it('debe aplanar todos los stats de httpReqDuration y httpReqWaiting', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.httpReqDurationAvg).toBe(120.5);
            expect(payload.httpReqDurationMin).toBe(50);
            expect(payload.httpReqDurationMax).toBe(800);
            expect(payload.httpReqDurationMed).toBe(100);
            expect(payload.httpReqDurationP90).toBe(200);
            expect(payload.httpReqDurationP95).toBe(300);
            expect(payload.httpReqDurationP99).toBe(600);
            expect(payload.httpReqWaitingAvg).toBe(80);
            expect(payload.httpReqWaitingP95).toBe(250);
        });

        it('debe aplanar rate de httpReqFailed y stats de httpReqs', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.httpReqFailedRate).toBe(0.02);
            expect(payload.httpReqsCount).toBe(200);
            expect(payload.httpReqsRate).toBe(20.5);
        });

        it('debe aplanar concurrencia y transferencia', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.vusValue).toBe(10);
            expect(payload.vusMin).toBe(1);
            expect(payload.vusMax).toBe(50);
            expect(payload.vusMaxValue).toBe(50);
            expect(payload.vusMaxMin).toBe(50);
            expect(payload.vusMaxMax).toBe(50);
            expect(payload.dataReceivedCount).toBe(102400);
            expect(payload.dataReceivedRate).toBe(1024);
            expect(payload.dataSentCount).toBe(51200);
            expect(payload.dataSentRate).toBe(512);
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

        it('debe calcular durationMs, startedAt y endedAt en ISO', () => {
            const fixedNow = 1_700_000_000_000;
            vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

            const payload = service.buildK6Payload(mockSummary);

            expect(payload.durationMs).toBe(60000);
            expect(payload.endedAt).toBe(new Date(fixedNow).toISOString());
            expect(payload.startedAt).toBe(new Date(fixedNow - 60000).toISOString());
        });

        it('debe respetar startedAt y endedAt pasados via meta (convertidos a ISO)', () => {
            const payload = service.buildK6Payload(mockSummary, { startedAt: 1000, endedAt: 9000 });

            expect(payload.startedAt).toBe(new Date(1000).toISOString());
            expect(payload.endedAt).toBe(new Date(9000).toISOString());
        });

        it('debe ser defensive: data vacio retorna campos null sin throw', () => {
            const payload = service.buildK6Payload({});

            expect(payload.httpReqDurationAvg).toBeNull();
            expect(payload.httpReqDurationP99).toBeNull();
            expect(payload.httpReqWaitingAvg).toBeNull();
            expect(payload.httpReqFailedRate).toBeNull();
            expect(payload.httpReqsCount).toBeNull();
            expect(payload.httpReqsRate).toBeNull();
            expect(payload.groupDurationAvg).toBeNull();
            expect(payload.vusValue).toBeNull();
            expect(payload.vusMax).toBeNull();
            expect(payload.scenarioName).toBeNull();
            expect(payload.testType).toBeNull();
            expect(payload.scriptHash).toBeNull();
            expect(payload.durationMs).toBeNull();
            expect(payload.groups).toEqual([]);
        });

        it('debe derivar scriptHash automaticamente desde endpointMetrics', () => {
            const endpointMetrics = {
                'GET /users/:id': { name: '/users/:id', method: 'GET' },
                'POST /orders':   { name: '/orders',    method: 'POST' }
            };
            const payload = service.buildK6Payload(mockSummary, { endpointMetrics });

            expect(payload.scriptHash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('scriptHash debe ser estable cuando cambia el orden de los endpoints', () => {
            const a = service.buildK6Payload(mockSummary, {
                endpointMetrics: {
                    'GET /users':   { name: '/users',   method: 'GET' },
                    'POST /orders': { name: '/orders',  method: 'POST' }
                }
            });
            const b = service.buildK6Payload(mockSummary, {
                endpointMetrics: {
                    'POST /orders': { name: '/orders',  method: 'POST' },
                    'GET /users':   { name: '/users',   method: 'GET' }
                }
            });

            expect(a.scriptHash).toBe(b.scriptHash);
        });

        it('scriptHash debe cambiar cuando se agrega o renombra un endpoint', () => {
            const a = service.buildK6Payload(mockSummary, {
                endpointMetrics: { 'GET /users': { name: '/users', method: 'GET' } }
            });
            const b = service.buildK6Payload(mockSummary, {
                endpointMetrics: {
                    'GET /users':   { name: '/users',   method: 'GET' },
                    'POST /orders': { name: '/orders',  method: 'POST' }
                }
            });

            expect(a.scriptHash).not.toBe(b.scriptHash);
        });

        it('debe respetar scriptHash explicito pasado via meta', () => {
            const payload = service.buildK6Payload(mockSummary, { scriptHash: 'custom-hash' });
            expect(payload.scriptHash).toBe('custom-hash');
        });

        it('debe permitir forzar scriptHash a null via meta', () => {
            const payload = service.buildK6Payload(mockSummary, {
                endpointMetrics: { 'GET /users': { name: '/users', method: 'GET' } },
                scriptHash: null
            });
            expect(payload.scriptHash).toBeNull();
        });

        it('debe mapear pipelineId desde SYSTEM_DEFINITIONID y buildId desde BUILD_BUILDID', () => {
            process.env.SYSTEM_DEFINITIONID = '42';
            process.env.BUILD_BUILDID = '12345';
            process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI = 'https://dev.azure.com/org/';
            process.env.SYSTEM_TEAMPROJECT = 'proj';

            const payload = service.buildK6Payload(mockSummary);

            expect(payload.pipelineId).toBe('42');
            expect(payload.buildId).toBe('12345');
            expect(payload.runUrl).toBe('https://dev.azure.com/org/proj/_build/results?buildId=12345');
            expect(payload.provider).toBe('azure-devops');
        });

        it('debe dejar pipelineId, buildId, runUrl y provider null fuera de CI', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.pipelineId).toBeNull();
            expect(payload.buildId).toBeNull();
            expect(payload.runUrl).toBeNull();
            expect(payload.provider).toBeNull();
        });

        it('debe aplanar groupDuration global', () => {
            const payload = service.buildK6Payload(mockSummary);
            expect(payload.groupDurationAvg).toBe(1500);
            expect(payload.groupDurationMin).toBe(800);
            expect(payload.groupDurationMax).toBe(3000);
            expect(payload.groupDurationMed).toBe(1400);
            expect(payload.groupDurationP90).toBe(2500);
            expect(payload.groupDurationP95).toBe(2800);
            expect(payload.groupDurationP99).toBe(2950);
        });
    });

    describe('groups', () => {
        it('debe aplanar root_group en una lista plana con paths jerarquicos', () => {
            const payload = service.buildK6Payload(mockSummary);

            expect(payload.groups).toHaveLength(3);
            const paths = payload.groups.map((g) => g.path);
            expect(paths).toEqual(['::Login', '::Checkout', '::Checkout::Payment']);
        });

        it('debe agregar checks por grupo como { passed, failed }', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            expect(login.checks).toEqual({ passed: 195, failed: 5 });
        });

        it('debe dejar http_req_duration null cuando no hay groupMetrics', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            expect(login.http_req_duration).toBeNull();
        });

        it('debe mergear http_req_duration por path desde groupMetrics (claves p90 sin parens)', () => {
            const groupMetrics = {
                '::Login': {
                    http_req_duration: { avg: 100, min: 50, max: 200, med: 90, 'p(90)': 150, 'p(95)': 180, 'p(99)': 195 }
                }
            };

            const payload = service.buildK6Payload(mockSummary, { groupMetrics });
            const login = payload.groups.find((g) => g.path === '::Login');
            const checkout = payload.groups.find((g) => g.path === '::Checkout');

            expect(login.http_req_duration).toEqual({
                avg: 100, min: 50, max: 200, med: 90, p90: 150, p95: 180, p99: 195
            });
            expect(checkout.http_req_duration).toBeNull();
        });
    });

    describe('endpoints', () => {
        it('debe emitir endpoints vacio cuando no hay endpointMetrics', () => {
            const payload = service.buildK6Payload(mockSummary);
            expect(payload.endpoints).toEqual([]);
        });

        it('debe construir endpoints con method, statuses y trends desde endpointMetrics', () => {
            const endpointMetrics = {
                'GET /users/:id': {
                    name: 'GET /users/:id',
                    method: 'GET',
                    url: 'https://api.com/users/123',
                    group: '::Login',
                    http_req_duration: { avg: 89.2, min: 12, max: 500, med: 80, 'p(90)': 180, 'p(95)': 210, 'p(99)': 480 },
                    http_req_waiting: { avg: 70, min: 8, max: 450, med: 65, 'p(90)': 150, 'p(95)': 190, 'p(99)': 430 },
                    http_req_failed: { rate: 0.02 },
                    http_reqs: { count: 4500 },
                    statuses: { 200: 4400, 404: 80, 500: 20 }
                }
            };

            const payload = service.buildK6Payload(mockSummary, { endpointMetrics });

            expect(payload.endpoints).toHaveLength(1);
            const ep = payload.endpoints[0];
            expect(ep.name).toBe('GET /users/:id');
            expect(ep.method).toBe('GET');
            expect(ep.group).toBe('::Login');
            expect(ep.http_reqs_count).toBe(4500);
            expect(ep.http_req_failed_rate).toBe(0.02);
            expect(ep.http_req_duration).toEqual({
                avg: 89.2, min: 12, max: 500, med: 80, p90: 180, p95: 210, p99: 480
            });
            expect(ep.http_req_waiting.p95).toBe(190);
            expect(ep.statuses).toEqual({ 200: 4400, 404: 80, 500: 20 });
        });
    });

    describe('aggregateK6Endpoints', () => {
        it('debe agregar samples por method + tags.name', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { name: '/users/:id', method: 'GET', status: '200' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 300, tags: { name: '/users/:id', method: 'GET', status: '200' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 500, tags: { name: '/users/:id', method: 'GET', status: '500' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 0,   tags: { name: '/users/:id', method: 'GET' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 1,   tags: { name: '/users/:id', method: 'GET' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { name: '/users/:id', method: 'GET' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 80,  tags: { name: '/orders',     method: 'POST', status: '201' } } }
            ];

            const result = aggregateK6Endpoints(samples);

            expect(Object.keys(result).sort()).toEqual(['GET /users/:id', 'POST /orders']);
            const get = result['GET /users/:id'];
            expect(get.http_req_duration.avg).toBe(300);
            expect(get.http_req_duration.min).toBe(100);
            expect(get.http_req_duration.max).toBe(500);
            expect(get.http_req_failed.rate).toBe(0.5);
            expect(get.http_reqs.count).toBe(1);
            expect(get.statuses).toEqual({ 200: 2, 500: 1 });
            expect(get.method).toBe('GET');
            expect(get.name).toBe('/users/:id');
        });

        it('debe ignorar samples sin tags.name ni tags.url', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { method: 'GET' } } }
            ];
            expect(aggregateK6Endpoints(samples)).toEqual({});
        });

        it('debe usar tags.url como fallback cuando no hay tags.name', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { url: 'https://api.com/raw', method: 'GET' } } }
            ];
            const result = aggregateK6Endpoints(samples);
            expect(result['GET https://api.com/raw'].http_req_duration.avg).toBe(100);
        });
    });

    describe('aggregateK6EndpointsFromFile', () => {
        let tmpFile;

        afterEach(() => {
            if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            tmpFile = null;
        });

        it('debe streamear el NDJSON y agregar por endpoint', async () => {
            tmpFile = path.join(os.tmpdir(), `k6-endpoints-${Date.now()}.ndjson`);
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { name: '/auth', method: 'POST', status: '200' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, tags: { name: '/auth', method: 'POST', status: '200' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { name: '/auth', method: 'POST' } } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

            const result = await aggregateK6EndpointsFromFile(tmpFile);

            expect(result['POST /auth'].http_req_duration.avg).toBe(150);
            expect(result['POST /auth'].http_reqs.count).toBe(1);
            expect(result['POST /auth'].statuses).toEqual({ 200: 2 });
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

    describe('computeScriptHash', () => {
        it('debe retornar null cuando el input es vacio o sin endpoints validos', () => {
            expect(computeScriptHash(null)).toBeNull();
            expect(computeScriptHash(undefined)).toBeNull();
            expect(computeScriptHash({})).toBeNull();
            expect(computeScriptHash([])).toBeNull();
            expect(computeScriptHash([{ method: 'GET' }])).toBeNull();
        });

        it('debe aceptar tanto map como array', () => {
            const map = {
                'GET /users':   { name: '/users',  method: 'GET' },
                'POST /orders': { name: '/orders', method: 'POST' }
            };
            const arr = [
                { name: '/users',  method: 'GET' },
                { name: '/orders', method: 'POST' }
            ];

            expect(computeScriptHash(map)).toBe(computeScriptHash(arr));
        });

        it('debe normalizar el method a mayusculas', () => {
            const a = computeScriptHash([{ name: '/users', method: 'get' }]);
            const b = computeScriptHash([{ name: '/users', method: 'GET' }]);
            expect(a).toBe(b);
        });

        it('debe usar tags.url como fallback cuando no hay name', () => {
            const hash = computeScriptHash([{ url: 'https://api.com/raw', method: 'GET' }]);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('getCompareReport', () => {
        it('debe llamar al endpoint /compare con Bearer token y retornar el reporte', async () => {
            const report = {
                status: 'compared',
                current: { id: 42 },
                previous: { id: 30 },
                global: {
                    p95: { current: 320, previous: 290, deltaMs: 30, deltaPct: 10.3 },
                    failedRate: { current: 0.02, previous: 0.01, delta: 0.01 },
                    reqsRate: { current: 20, previous: 21, delta: -1 }
                },
                endpoints: []
            };
            vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
            vi.spyOn(service, 'sendGETRequest').mockResolvedValue({ data: report, status: 200 });

            const result = await service.getCompareReport(42);

            expect(result).toEqual(report);
            expect(service.sendGETRequest).toHaveBeenCalledWith(
                'https://api.test.com/api/k6-metrics/42/compare',
                { Authorization: 'Bearer mock-token' }
            );
        });

        it('debe retornar undefined y loguear cuando runId no esta definido', async () => {
            vi.spyOn(service, 'generateToken');

            const result = await service.getCompareReport(undefined);

            expect(result).toBeUndefined();
            expect(service.generateToken).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalled();
        });

        it('debe retornar undefined cuando no obtiene token', async () => {
            vi.spyOn(service, 'generateToken').mockResolvedValue(undefined);

            const result = await service.getCompareReport(42);

            expect(result).toBeUndefined();
            expect(console.error).toHaveBeenCalled();
        });

        it('debe atrapar errores de red y retornar undefined', async () => {
            vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
            vi.spyOn(service, 'sendGETRequest').mockRejectedValue(new Error('boom'));

            const result = await service.getCompareReport(42);

            expect(result).toBeUndefined();
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
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
                expect(sent.durationMs).toBe(30000);
                expect(sent.httpReqDurationAvg).toBe(150);
                expect(sent.httpReqsCount).toBe(1);
                expect(sent.dataReceivedCount).toBe(5000);
                expect(sent.vusValue).toBe(5);
                const login = sent.groups.find((g) => g.path === '::Login');
                expect(login).toBeTruthy();
                expect(login.http_req_duration.avg).toBe(150);
                expect(login.checks).toEqual({ passed: 0, failed: 0 });
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('debe streamear samplesPath y mergear http_req_duration por grupo', async () => {
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
                expect(login.http_req_duration.p90).toBe(300);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('debe reconstruir endpoints desde samplesPath', async () => {
            process.env.CI = 'true';
            const tmpFile = path.join(os.tmpdir(), `k6-send-endpoints-${Date.now()}.ndjson`);
            const lines = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { name: '/auth', method: 'POST', status: '200', group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, tags: { name: '/auth', method: 'POST', status: '200', group: '::Login' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { name: '/auth', method: 'POST', group: '::Login' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 50,  tags: { name: '/users', method: 'GET', status: '200' } } }
            ];
            fs.writeFileSync(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n'));

            try {
                vi.spyOn(service, 'generateToken').mockResolvedValue('mock-token');
                vi.spyOn(service, 'sendPOSTRequest').mockResolvedValue({ data: { id: 11 } });

                await service.sendK6Metrics(mockSummary, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0][1];
                expect(sent.endpoints).toHaveLength(2);
                const auth = sent.endpoints.find((e) => e.name === '/auth');
                expect(auth.method).toBe('POST');
                expect(auth.group).toBe('::Login');
                expect(auth.http_req_duration.avg).toBe(150);
                expect(auth.statuses).toEqual({ 200: 2 });
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});
