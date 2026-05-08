import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
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
        mock.method(console, 'log', () => { });
        mock.method(console, 'error', () => { });
    });

    afterEach(() => {
        mock.restoreAll();
        mock.reset();
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
            assert.equal(service.k6MetricsEndpoint, '/api/k6-metrics');
        });

        it('debe permitir override del endpoint', () => {
            const s = new K6MetricsService({ k6MetricsEndpoint: '/custom/k6' });
            assert.equal(s.k6MetricsEndpoint, '/custom/k6');
        });

        it('debe heredar la config de auth de AuthenticatedService', () => {
            assert.equal(service.baseUrl, 'https://api.test.com');
            assert.equal(service.tokenEndpoint, '/auth/login');
            assert.equal(typeof service.generateToken, 'function');
        });
    });

    describe('buildK6Payload', () => {
        it('debe aplanar todos los stats de httpReqDuration y httpReqWaiting', () => {
            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.httpReqDurationAvg, 120.5);
            assert.equal(payload.httpReqDurationMin, 50);
            assert.equal(payload.httpReqDurationMax, 800);
            assert.equal(payload.httpReqDurationMed, 100);
            assert.equal(payload.httpReqDurationP90, 200);
            assert.equal(payload.httpReqDurationP95, 300);
            assert.equal(payload.httpReqDurationP99, 600);
            assert.equal(payload.httpReqWaitingAvg, 80);
            assert.equal(payload.httpReqWaitingP95, 250);
        });

        it('debe aplanar rate de httpReqFailed y stats de httpReqs', () => {
            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.httpReqFailedRate, 0.02);
            assert.equal(payload.httpReqsCount, 200);
            assert.equal(payload.httpReqsRate, 20.5);
        });

        it('debe aplanar concurrencia y transferencia', () => {
            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.vusValue, 10);
            assert.equal(payload.vusMin, 1);
            assert.equal(payload.vusMax, 50);
            assert.equal(payload.vusMaxValue, 50);
            assert.equal(payload.vusMaxMin, 50);
            assert.equal(payload.vusMaxMax, 50);
            assert.equal(payload.dataReceivedCount, 102400);
            assert.equal(payload.dataReceivedRate, 1024);
            assert.equal(payload.dataSentCount, 51200);
            assert.equal(payload.dataSentRate, 512);
        });

        it('debe incluir scenarioName desde data.options.scenarios', () => {
            const payload = service.buildK6Payload(mockSummary);
            assert.equal(payload.scenarioName, 'my_scenario');
        });

        it('debe usar SCENARIO_NAME env var como fallback cuando no hay scenarios', () => {
            process.env.SCENARIO_NAME = 'fallback-scenario';
            const data = { ...mockSummary, options: { tags: { test_type: 'benchmark' } } };

            const payload = service.buildK6Payload(data);

            assert.equal(payload.scenarioName, 'fallback-scenario');
        });

        it('debe extraer testType desde data.options.tags.test_type', () => {
            const payload = service.buildK6Payload(mockSummary);
            assert.equal(payload.testType, 'benchmark');
        });

        it('debe usar TEST_TYPE env var como fallback', () => {
            process.env.TEST_TYPE = 'load';
            const data = { ...mockSummary, options: { scenarios: { s1: {} } } };

            const payload = service.buildK6Payload(data);

            assert.equal(payload.testType, 'load');
        });

        it('debe calcular durationMs, startedAt y endedAt en ISO', () => {
            const fixedNow = 1_700_000_000_000;
            mock.method(Date, 'now', () => fixedNow);

            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.durationMs, 60000);
            assert.equal(payload.endedAt, new Date(fixedNow).toISOString());
            assert.equal(payload.startedAt, new Date(fixedNow - 60000).toISOString());
        });

        it('debe respetar startedAt y endedAt pasados via meta (convertidos a ISO)', () => {
            const payload = service.buildK6Payload(mockSummary, { startedAt: 1000, endedAt: 9000 });

            assert.equal(payload.startedAt, new Date(1000).toISOString());
            assert.equal(payload.endedAt, new Date(9000).toISOString());
        });

        it('debe ser defensive: data vacio retorna campos null sin throw', () => {
            const payload = service.buildK6Payload({});

            assert.equal(payload.httpReqDurationAvg, null);
            assert.equal(payload.httpReqDurationP99, null);
            assert.equal(payload.httpReqWaitingAvg, null);
            assert.equal(payload.httpReqFailedRate, null);
            assert.equal(payload.httpReqsCount, null);
            assert.equal(payload.httpReqsRate, null);
            assert.equal(payload.groupDurationAvg, null);
            assert.equal(payload.vusValue, null);
            assert.equal(payload.vusMax, null);
            assert.equal(payload.scenarioName, null);
            assert.equal(payload.testType, null);
            assert.equal(payload.scriptHash, null);
            assert.equal(payload.durationMs, null);
            assert.deepEqual(payload.groups, []);
        });

        it('debe derivar scriptHash automaticamente desde endpointMetrics', () => {
            const endpointMetrics = {
                'GET /users/:id': { name: '/users/:id', method: 'GET' },
                'POST /orders':   { name: '/orders',    method: 'POST' }
            };
            const payload = service.buildK6Payload(mockSummary, { endpointMetrics });

            assert.match(payload.scriptHash, /^[0-9a-f]{64}$/);
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

            assert.equal(a.scriptHash, b.scriptHash);
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

            assert.notEqual(a.scriptHash, b.scriptHash);
        });

        it('debe respetar scriptHash explicito pasado via meta', () => {
            const payload = service.buildK6Payload(mockSummary, { scriptHash: 'custom-hash' });
            assert.equal(payload.scriptHash, 'custom-hash');
        });

        it('debe permitir forzar scriptHash a null via meta', () => {
            const payload = service.buildK6Payload(mockSummary, {
                endpointMetrics: { 'GET /users': { name: '/users', method: 'GET' } },
                scriptHash: null
            });
            assert.equal(payload.scriptHash, null);
        });

        it('debe mapear pipelineId desde SYSTEM_DEFINITIONID y buildId desde BUILD_BUILDID', () => {
            process.env.SYSTEM_DEFINITIONID = '42';
            process.env.BUILD_BUILDID = '12345';
            process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI = 'https://dev.azure.com/org/';
            process.env.SYSTEM_TEAMPROJECT = 'proj';

            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.pipelineId, '42');
            assert.equal(payload.buildId, '12345');
            assert.equal(payload.runUrl, 'https://dev.azure.com/org/proj/_build/results?buildId=12345');
            assert.equal(payload.provider, 'azure-devops');
        });

        it('debe dejar pipelineId, buildId, runUrl y provider null fuera de CI', () => {
            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.pipelineId, null);
            assert.equal(payload.buildId, null);
            assert.equal(payload.runUrl, null);
            assert.equal(payload.provider, null);
        });

        it('debe aplanar groupDuration global', () => {
            const payload = service.buildK6Payload(mockSummary);
            assert.equal(payload.groupDurationAvg, 1500);
            assert.equal(payload.groupDurationMin, 800);
            assert.equal(payload.groupDurationMax, 3000);
            assert.equal(payload.groupDurationMed, 1400);
            assert.equal(payload.groupDurationP90, 2500);
            assert.equal(payload.groupDurationP95, 2800);
            assert.equal(payload.groupDurationP99, 2950);
        });
    });

    describe('groups', () => {
        it('debe aplanar root_group en una lista plana con paths jerarquicos', () => {
            const payload = service.buildK6Payload(mockSummary);

            assert.equal(payload.groups.length, 3);
            const paths = payload.groups.map((g) => g.path);
            assert.deepEqual(paths, ['::Login', '::Checkout', '::Checkout::Payment']);
        });

        it('debe agregar checks por grupo como { passed, failed }', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            assert.deepEqual(login.checks, { passed: 195, failed: 5 });
        });

        it('debe dejar http_req_duration null cuando no hay groupMetrics', () => {
            const payload = service.buildK6Payload(mockSummary);
            const login = payload.groups.find((g) => g.path === '::Login');

            assert.equal(login.http_req_duration, null);
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

            assert.deepEqual(login.http_req_duration, {
                avg: 100, min: 50, max: 200, med: 90, p90: 150, p95: 180, p99: 195
            });
            assert.equal(checkout.http_req_duration, null);
        });

        it('debe propagar endpoints por grupo desde groupMetrics al payload', () => {
            const groupMetrics = {
                '::Login': {
                    http_req_duration: { avg: 100, min: 50, max: 200, med: 90, 'p(90)': 150, 'p(95)': 180, 'p(99)': 195 },
                    endpoints: [
                        {
                            method: 'POST',
                            name: '/auth',
                            url: null,
                            http_req_duration: { avg: 150, min: 100, max: 200, med: 150, 'p(90)': 190, 'p(95)': 195, 'p(99)': 199 },
                            http_req_failed: { rate: 0.5 },
                            http_reqs: { count: 1 }
                        }
                    ]
                }
            };

            const payload = service.buildK6Payload(mockSummary, { groupMetrics });
            const login = payload.groups.find((g) => g.path === '::Login');
            const checkout = payload.groups.find((g) => g.path === '::Checkout');

            assert.equal(login.endpoints.length, 1);
            assert.equal(login.endpoints[0].method, 'POST');
            assert.equal(login.endpoints[0].name, '/auth');
            assert.equal(login.endpoints[0].http_req_failed.rate, 0.5);
            assert.equal(login.endpoints[0].http_reqs.count, 1);
            assert.deepEqual(checkout.endpoints, []);
        });

        it('debe dejar endpoints: [] cuando groupMetrics no trae el campo', () => {
            const payload = service.buildK6Payload(mockSummary);
            for (const g of payload.groups) {
                assert.deepEqual(g.endpoints, []);
            }
        });
    });

    describe('endpoints', () => {
        it('debe emitir endpoints vacio cuando no hay endpointMetrics', () => {
            const payload = service.buildK6Payload(mockSummary);
            assert.deepEqual(payload.endpoints, []);
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

            assert.equal(payload.endpoints.length, 1);
            const ep = payload.endpoints[0];
            assert.equal(ep.name, 'GET /users/:id');
            assert.equal(ep.method, 'GET');
            assert.equal(ep.group, '::Login');
            assert.equal(ep.http_reqs_count, 4500);
            assert.equal(ep.http_req_failed_rate, 0.02);
            assert.deepEqual(ep.http_req_duration, {
                avg: 89.2, min: 12, max: 500, med: 80, p90: 180, p95: 210, p99: 480
            });
            assert.equal(ep.http_req_waiting.p95, 190);
            assert.deepEqual(ep.statuses, { 200: 4400, 404: 80, 500: 20 });
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

            assert.deepEqual(Object.keys(result).sort(), ['GET /users/:id', 'POST /orders']);
            const get = result['GET /users/:id'];
            assert.equal(get.http_req_duration.avg, 300);
            assert.equal(get.http_req_duration.min, 100);
            assert.equal(get.http_req_duration.max, 500);
            assert.equal(get.http_req_failed.rate, 0.5);
            assert.equal(get.http_reqs.count, 1);
            assert.deepEqual(get.statuses, { 200: 2, 500: 1 });
            assert.equal(get.method, 'GET');
            assert.equal(get.name, '/users/:id');
        });

        it('debe ignorar samples sin tags.name ni tags.url', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { method: 'GET' } } }
            ];
            assert.deepEqual(aggregateK6Endpoints(samples), {});
        });

        it('debe usar tags.url como fallback cuando no hay tags.name', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { url: 'https://api.com/raw', method: 'GET' } } }
            ];
            const result = aggregateK6Endpoints(samples);
            assert.equal(result['GET https://api.com/raw'].http_req_duration.avg, 100);
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

            assert.equal(result['POST /auth'].http_req_duration.avg, 150);
            assert.equal(result['POST /auth'].http_reqs.count, 1);
            assert.deepEqual(result['POST /auth'].statuses, { 200: 2 });
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

            assert.deepEqual(Object.keys(result).sort(), ['::Checkout', '::Login']);
            assert.equal(result['::Login'].http_req_duration.min, 100);
            assert.equal(result['::Login'].http_req_duration.max, 300);
            assert.ok(Math.abs(result['::Login'].http_req_duration.avg - 200) < 0.001);
            assert.deepEqual(result['::Login'].http_req_failed, { rate: 0.5 });
            assert.deepEqual(result['::Login'].http_reqs, { count: 2 });
            assert.equal(result['::Login'].group_duration.avg, 1500);
            assert.equal(result['::Checkout'].http_req_duration.min, 50);
        });

        it('debe ignorar samples sin tag de grupo', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: {} } },
                { type: 'Metric', metric: 'http_req_duration', data: {} }
            ];

            const result = aggregateK6Samples(samples);

            assert.deepEqual(result, {});
        });

        it('debe desglosar endpoints por grupo cuando los samples traen tags.name', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::Login', name: '/auth', method: 'POST' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 200, tags: { group: '::Login', name: '/auth', method: 'POST' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 0,   tags: { group: '::Login', name: '/auth', method: 'POST' } } },
                { type: 'Point', metric: 'http_req_failed',   data: { value: 1,   tags: { group: '::Login', name: '/auth', method: 'POST' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Login', name: '/auth', method: 'POST' } } }
            ];

            const result = aggregateK6Samples(samples);

            assert.equal(result['::Login'].endpoints.length, 1);
            const ep = result['::Login'].endpoints[0];
            assert.equal(ep.method, 'POST');
            assert.equal(ep.name, '/auth');
            assert.equal(ep.http_req_duration.avg, 150);
            assert.equal(ep.http_req_failed.rate, 0.5);
            assert.equal(ep.http_reqs.count, 1);
        });

        it('mismo endpoint en dos grupos debe aparecer en ambos con metricas independientes', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::A', name: '/users', method: 'GET' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::A', name: '/users', method: 'GET' } } },
                { type: 'Point', metric: 'http_req_duration', data: { value: 500, tags: { group: '::B', name: '/users', method: 'GET' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::B', name: '/users', method: 'GET' } } }
            ];

            const result = aggregateK6Samples(samples);

            assert.equal(result['::A'].endpoints.length, 1);
            assert.equal(result['::B'].endpoints.length, 1);
            assert.equal(result['::A'].endpoints[0].http_req_duration.avg, 100);
            assert.equal(result['::B'].endpoints[0].http_req_duration.avg, 500);
            assert.equal(result['::A'].endpoints[0].http_reqs.count, 1);
            assert.equal(result['::B'].endpoints[0].http_reqs.count, 1);
        });

        it('debe dejar endpoints: [] cuando los samples del grupo no traen name ni url', () => {
            const samples = [
                { type: 'Point', metric: 'http_req_duration', data: { value: 100, tags: { group: '::Solo' } } },
                { type: 'Point', metric: 'http_reqs',         data: { value: 1,   tags: { group: '::Solo' } } }
            ];

            const result = aggregateK6Samples(samples);

            assert.deepEqual(result['::Solo'].endpoints, []);
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

            assert.deepEqual(Object.keys(result).sort(), ['::Checkout', '::Login']);
            assert.equal(result['::Login'].http_req_duration.avg, 150);
            assert.deepEqual(result['::Login'].http_reqs, { count: 1 });
            assert.equal(result['::Login'].group_duration.avg, 1500);
            assert.equal(result['::Checkout'].http_req_duration.avg, 80);
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

            assert.equal(result['::A'].http_req_duration.avg, 50);
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

            assert.equal(summary.state.testRunDurationMs, 10000);
            assert.equal(summary.metrics.http_req_duration.values.avg, 100);
            assert.equal(summary.metrics.http_reqs.values.count, 2);
            assert.equal(summary.metrics.data_sent.values.count, 200);
            assert.deepEqual(summary.options.scenarios, { s1: {} });
            assert.deepEqual(summary.options.tags, { test_type: 'load' });
            const groupPaths = summary.root_group.groups.map((g) => g.path).sort();
            assert.deepEqual(groupPaths, ['::A', '::B']);
            assert.equal(summary._groupMetrics['::A'].http_req_duration.avg, 50);
            assert.equal(summary._groupMetrics['::B'].http_req_duration.avg, 150);
        });
    });

    describe('computeScriptHash', () => {
        it('debe retornar null cuando el input es vacio o sin endpoints validos', () => {
            assert.equal(computeScriptHash(null), null);
            assert.equal(computeScriptHash(undefined), null);
            assert.equal(computeScriptHash({}), null);
            assert.equal(computeScriptHash([]), null);
            assert.equal(computeScriptHash([{ method: 'GET' }]), null);
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

            assert.equal(computeScriptHash(map), computeScriptHash(arr));
        });

        it('debe normalizar el method a mayusculas', () => {
            const a = computeScriptHash([{ name: '/users', method: 'get' }]);
            const b = computeScriptHash([{ name: '/users', method: 'GET' }]);
            assert.equal(a, b);
        });

        it('debe usar tags.url como fallback cuando no hay name', () => {
            const hash = computeScriptHash([{ url: 'https://api.com/raw', method: 'GET' }]);
            assert.match(hash, /^[0-9a-f]{64}$/);
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
            mock.method(service, 'generateToken', async () => 'mock-token');
            mock.method(service, 'sendGETRequest', async () => ({ data: report, status: 200 }));

            const result = await service.getCompareReport(42);

            assert.deepEqual(result, report);
            assert.deepEqual(service.sendGETRequest.mock.calls[0].arguments, [
                'https://api.test.com/api/k6-metrics/42/compare',
                { Authorization: 'Bearer mock-token' }
            ]);
        });

        it('debe retornar undefined y loguear cuando runId no esta definido', async () => {
            const tokenSpy = mock.method(service, 'generateToken', service.generateToken);

            const result = await service.getCompareReport(undefined);

            assert.equal(result, undefined);
            assert.equal(tokenSpy.mock.calls.length, 0);
            assert.ok(console.error.mock.calls.length > 0);
        });

        it('debe retornar undefined cuando no obtiene token', async () => {
            mock.method(service, 'generateToken', async () => undefined);

            const result = await service.getCompareReport(42);

            assert.equal(result, undefined);
            assert.ok(console.error.mock.calls.length > 0);
        });

        it('debe atrapar errores de red y retornar undefined', async () => {
            mock.method(service, 'generateToken', async () => 'mock-token');
            mock.method(service, 'sendGETRequest', async () => { throw new Error('boom'); });

            const result = await service.getCompareReport(42);

            assert.equal(result, undefined);
            const loggedWithBoom = console.error.mock.calls.some((c) =>
                c.arguments.some((a) => typeof a === 'string' && a.includes('boom'))
            );
            assert.ok(loggedWithBoom);
        });
    });

    describe('sendK6Metrics', () => {
        it('debe no ejecutarse si CI no esta definido', async () => {
            delete process.env.CI;
            const tokenSpy = mock.method(service, 'generateToken', service.generateToken);

            const result = await service.sendK6Metrics(mockSummary);

            assert.equal(result, undefined);
            assert.equal(tokenSpy.mock.calls.length, 0);
        });

        it('debe enviar las metricas cuando CI esta activo', async () => {
            process.env.CI = 'true';
            mock.method(service, 'generateToken', async () => 'mock-token');
            mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 42 } }));

            const result = await service.sendK6Metrics(mockSummary);

            assert.deepEqual(result, { id: 42 });
            const args = service.sendPOSTRequest.mock.calls[0].arguments;
            assert.equal(args[0], 'https://api.test.com/api/k6-metrics');
            assert.equal(args[1].scenarioName, 'my_scenario');
            assert.equal(args[1].testType, 'benchmark');
            assert.deepEqual(args[2], { Authorization: 'Bearer mock-token' });
        });

        it('debe retornar undefined si no obtiene token', async () => {
            process.env.CI = 'true';
            mock.method(service, 'generateToken', async () => undefined);

            const result = await service.sendK6Metrics(mockSummary);

            assert.equal(result, undefined);
            assert.ok(console.error.mock.calls.length > 0);
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
                mock.method(service, 'generateToken', async () => 'mock-token');
                mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 99 } }));

                await service.sendK6Metrics(null, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0].arguments[1];
                assert.equal(sent.scenarioName, 'updateActivity');
                assert.equal(sent.testType, 'benchmark');
                assert.equal(sent.durationMs, 30000);
                assert.equal(sent.httpReqDurationAvg, 150);
                assert.equal(sent.httpReqsCount, 1);
                assert.equal(sent.dataReceivedCount, 5000);
                assert.equal(sent.vusValue, 5);
                const login = sent.groups.find((g) => g.path === '::Login');
                assert.ok(login);
                assert.equal(login.http_req_duration.avg, 150);
                assert.deepEqual(login.checks, { passed: 0, failed: 0 });
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
                mock.method(service, 'generateToken', async () => 'mock-token');
                mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 7 } }));

                await service.sendK6Metrics(mockSummary, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0].arguments[1];
                const login = sent.groups.find((g) => g.path === '::Login');
                assert.equal(login.http_req_duration.avg, 200);
                assert.equal(login.http_req_duration.p90, 300);
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
                mock.method(service, 'generateToken', async () => 'mock-token');
                mock.method(service, 'sendPOSTRequest', async () => ({ data: { id: 11 } }));

                await service.sendK6Metrics(mockSummary, { samplesPath: tmpFile });

                const sent = service.sendPOSTRequest.mock.calls[0].arguments[1];
                assert.equal(sent.endpoints.length, 2);
                const auth = sent.endpoints.find((e) => e.name === '/auth');
                assert.equal(auth.method, 'POST');
                assert.equal(auth.group, '::Login');
                assert.equal(auth.http_req_duration.avg, 150);
                assert.deepEqual(auth.statuses, { 200: 2 });
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});
