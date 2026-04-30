import fs from 'node:fs';
import readline from 'node:readline';
import { AuthenticatedService } from './authenticated.service.js';
import { DEFAULT_ENDPOINTS, ENV_VARS, PROVIDERS } from '../constants.js';

const FULL_STATS = ['avg', 'min', 'max', 'med', 'p(90)', 'p(95)', 'p(99)'];

const pickStats = (src, keys) =>
    src ? Object.fromEntries(keys.map((k) => [k, src[k] ?? null])) : null;

const percentile = (sorted, p) => {
    if (!sorted.length) return null;
    const idx = Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1);
    return sorted[idx];
};

const computeTrend = (values) => {
    if (!values?.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        avg: sum / sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        med: percentile(sorted, 50),
        'p(90)': percentile(sorted, 90),
        'p(95)': percentile(sorted, 95),
        'p(99)': percentile(sorted, 99)
    };
};

/**
 * Flattens the K6 root_group tree into a flat list of groups with their checks.
 * @param {object} rootGroup - The data.root_group from a K6 summary.
 * @returns {Array<{name: string, path: string, checks: object}>}
 */
const flattenGroups = (rootGroup) => {
    const result = [];
    const visit = (node) => {
        if (!node) return;
        if (node.name) {
            const items = (node.checks || []).map((c) => ({
                name: c.name,
                passes: c.passes ?? 0,
                fails: c.fails ?? 0
            }));
            const passes = items.reduce((a, c) => a + c.passes, 0);
            const fails = items.reduce((a, c) => a + c.fails, 0);
            result.push({
                name: node.name,
                path: node.path,
                checks: { total: items.length, passes, fails, items }
            });
        }
        (node.groups || []).forEach(visit);
    };
    visit(rootGroup);
    return result;
};

/**
 * Aggregates per-group HTTP metrics from a K6 NDJSON sample stream
 * (output of `k6 run --out json=out.json`). The summary export alone does
 * not expose per-group metrics, so this helper is needed when the consumer
 * wants groups enriched with http_req_duration/http_req_failed/http_reqs/group_duration.
 *
 * @param {Array<object>} samples - Already parsed K6 samples (one object per line of the NDJSON).
 * @returns {Object<string, object>} Map of group path -> per-group metrics.
 */
const ingestSample = (buckets, s) => {
    if (s?.type !== 'Point') return;
    const groupPath = s.data?.tags?.group;
    if (!groupPath) return;

    const bucket = (buckets[groupPath] ??= {
        durations: [],
        waitings: [],
        groupDurations: [],
        failedTotal: 0,
        failedSum: 0,
        reqsCount: 0
    });

    const value = s.data?.value;
    switch (s.metric) {
        case 'http_req_duration':
            if (typeof value === 'number') bucket.durations.push(value);
            break;
        case 'http_req_waiting':
            if (typeof value === 'number') bucket.waitings.push(value);
            break;
        case 'group_duration':
            if (typeof value === 'number') bucket.groupDurations.push(value);
            break;
        case 'http_req_failed':
            bucket.failedTotal += 1;
            bucket.failedSum += value ?? 0;
            break;
        case 'http_reqs':
            bucket.reqsCount += value ?? 1;
            break;
    }
};

const finalizeBuckets = (buckets) => {
    const result = {};
    for (const [path, b] of Object.entries(buckets)) {
        result[path] = {
            http_req_duration: computeTrend(b.durations),
            http_req_waiting: computeTrend(b.waitings),
            group_duration: computeTrend(b.groupDurations),
            http_req_failed: {
                rate: b.failedTotal > 0 ? b.failedSum / b.failedTotal : null
            },
            http_reqs: { count: b.reqsCount }
        };
    }
    return result;
};

/**
 * Aggregates per-group HTTP metrics from already-parsed K6 samples.
 * @param {Array<object>} samples - K6 NDJSON samples already parsed.
 * @returns {Object<string, object>} Map of group path -> per-group metrics.
 */
export const aggregateK6Samples = (samples = []) => {
    const buckets = {};
    for (const s of samples) ingestSample(buckets, s);
    return finalizeBuckets(buckets);
};

/**
 * Streams a K6 NDJSON file (output of `k6 run --out json=out.json`) line by
 * line, aggregating per-group metrics without loading the entire file in memory.
 * @param {string} filePath - Path to the NDJSON output.
 * @returns {Promise<Object<string, object>>} Map of group path -> per-group metrics.
 */
export const aggregateK6SamplesFromFile = async (filePath) => {
    const buckets = {};
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line) continue;
        try {
            ingestSample(buckets, JSON.parse(line));
        } catch {
            // ignora lineas malformadas
        }
    }
    return finalizeBuckets(buckets);
};

/**
 * Builds a minimal K6 summary-shaped object from a `--out json=results.json`
 * NDJSON stream, for use cases where the consumer did NOT pass --summary-export.
 *
 * Aggregates global trends (http_req_duration, http_req_waiting, group_duration),
 * counters (http_reqs, data_received, data_sent), the failed-rate, vus/vus_max,
 * and reconstructs a basic root_group tree from the group tags seen.
 *
 * @param {string} filePath - Path to the NDJSON output.
 * @returns {Promise<object>} An object shaped like the K6 summary `data`.
 */
export const buildSummaryFromSamplesFile = async (filePath) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const global = {
        http_req_duration: [],
        http_req_waiting: [],
        group_duration: [],
        failedTotal: 0,
        failedSum: 0,
        reqsCount: 0,
        dataReceived: 0,
        dataSent: 0,
        vusObserved: [],
        vusMaxObserved: [],
        firstTime: null,
        lastTime: null
    };
    const buckets = {};
    const groupPaths = new Set();
    let scenarios;
    let testTypeTag;

    for await (const line of rl) {
        if (!line) continue;
        let s;
        try { s = JSON.parse(line); } catch { continue; }

        ingestSample(buckets, s);

        if (s.type === 'Metric' && s.data?.thresholds) continue;

        if (s.type === 'Point') {
            const value = s.data?.value;
            const tags = s.data?.tags || {};
            const t = s.data?.time ? Date.parse(s.data.time) : null;
            if (t && (!global.firstTime || t < global.firstTime)) global.firstTime = t;
            if (t && (!global.lastTime || t > global.lastTime)) global.lastTime = t;

            if (tags.group) groupPaths.add(tags.group);
            if (tags.test_type && !testTypeTag) testTypeTag = tags.test_type;
            if (tags.scenario && !scenarios) scenarios = { [tags.scenario]: {} };

            switch (s.metric) {
                case 'http_req_duration':
                    if (typeof value === 'number') global.http_req_duration.push(value);
                    break;
                case 'http_req_waiting':
                    if (typeof value === 'number') global.http_req_waiting.push(value);
                    break;
                case 'group_duration':
                    if (typeof value === 'number') global.group_duration.push(value);
                    break;
                case 'http_req_failed':
                    global.failedTotal += 1;
                    global.failedSum += value ?? 0;
                    break;
                case 'http_reqs':
                    global.reqsCount += value ?? 1;
                    break;
                case 'data_received':
                    global.dataReceived += value ?? 0;
                    break;
                case 'data_sent':
                    global.dataSent += value ?? 0;
                    break;
                case 'vus':
                    if (typeof value === 'number') global.vusObserved.push(value);
                    break;
                case 'vus_max':
                    if (typeof value === 'number') global.vusMaxObserved.push(value);
                    break;
            }
        }
    }

    const testRunDurationMs = global.firstTime && global.lastTime
        ? global.lastTime - global.firstTime
        : null;

    const trendToValues = (arr) => {
        const t = computeTrend(arr);
        return t ? { values: t } : undefined;
    };
    const counterToValues = (count, durationMs) => ({
        values: { count, rate: durationMs ? count / (durationMs / 1000) : null }
    });
    const vusToValues = (arr) => {
        if (!arr.length) return undefined;
        const sorted = [...arr].sort((a, b) => a - b);
        return {
            values: {
                value: arr[arr.length - 1],
                min: sorted[0],
                max: sorted[sorted.length - 1]
            }
        };
    };

    const metrics = {};
    const httpDur = trendToValues(global.http_req_duration);
    const httpWait = trendToValues(global.http_req_waiting);
    const grpDur = trendToValues(global.group_duration);
    if (httpDur) metrics.http_req_duration = httpDur;
    if (httpWait) metrics.http_req_waiting = httpWait;
    if (grpDur) metrics.group_duration = grpDur;
    if (global.failedTotal > 0) {
        metrics.http_req_failed = { values: { rate: global.failedSum / global.failedTotal } };
    }
    if (global.reqsCount > 0) metrics.http_reqs = counterToValues(global.reqsCount, testRunDurationMs);
    if (global.dataReceived > 0) metrics.data_received = counterToValues(global.dataReceived, testRunDurationMs);
    if (global.dataSent > 0) metrics.data_sent = counterToValues(global.dataSent, testRunDurationMs);
    const vusVals = vusToValues(global.vusObserved);
    const vusMaxVals = vusToValues(global.vusMaxObserved);
    if (vusVals) metrics.vus = vusVals;
    if (vusMaxVals) metrics.vus_max = vusMaxVals;

    const buildGroupTree = (paths) => {
        const root = { name: '', path: '', groups: [], checks: [] };
        const nodes = new Map([['', root]]);
        const sorted = [...paths].sort((a, b) => a.split('::').length - b.split('::').length);
        for (const p of sorted) {
            const segments = p.split('::').filter(Boolean);
            const name = segments[segments.length - 1];
            const parentPath = segments.length > 1 ? '::' + segments.slice(0, -1).join('::') : '';
            const parent = nodes.get(parentPath) || root;
            const node = { name, path: p, groups: [], checks: [] };
            parent.groups.push(node);
            nodes.set(p, node);
        }
        return root;
    };

    return {
        metrics,
        state: { testRunDurationMs },
        options: {
            scenarios: scenarios || {},
            tags: testTypeTag ? { test_type: testTypeTag } : {}
        },
        root_group: buildGroupTree(groupPaths),
        _groupMetrics: finalizeBuckets(buckets)
    };
};

export class K6MetricsService extends AuthenticatedService {
    /**
     * @param {object} config - Configuration object.
     */
    constructor(config = {}) {
        super(config);
        this.k6MetricsEndpoint = config.k6MetricsEndpoint || DEFAULT_ENDPOINTS.K6_METRICS;
    }

    /**
     * Builds the payload from a K6 summary object (the `data` arg of handleSummary
     * or the contents of `--summary-export` JSON).
     * @param {object} data - The K6 summary data.
     * @param {object} [meta] - Optional metadata.
     * @param {number} [meta.startedAt] - Override start timestamp (ms epoch).
     * @param {number} [meta.endedAt] - Override end timestamp (ms epoch).
     * @param {object} [meta.groupMetrics] - Per-group metrics keyed by group path.
     *   Use `aggregateK6Samples()` on the NDJSON output of `--out json=out.json` to build it.
     * @returns {object} The payload.
     */
    buildK6Payload(data, meta = {}) {
        const m = data?.metrics || {};
        const duration = data?.state?.testRunDurationMs ?? null;
        const endedAt = meta.endedAt ?? Date.now();
        const startedAt = meta.startedAt ?? (duration ? endedAt - duration : null);

        const scenarios = data?.options?.scenarios || {};
        const scenarioName = Object.keys(scenarios)[0] || process.env[ENV_VARS.SCENARIO_NAME] || null;
        const testType = data?.options?.tags?.test_type || process.env[ENV_VARS.TEST_TYPE] || null;

        const groupMetrics = meta.groupMetrics || {};
        const groups = flattenGroups(data?.root_group).map((g) => {
            const gm = groupMetrics[g.path] || {};
            return {
                name: g.name,
                path: g.path,
                checks: g.checks,
                group_duration: gm.group_duration ?? null,
                http_req_duration: gm.http_req_duration ?? null,
                http_req_waiting: gm.http_req_waiting ?? null,
                http_req_failed: gm.http_req_failed ?? null,
                http_reqs: gm.http_reqs ?? null
            };
        });

        return {
            scenarioName,
            testType,
            duration,
            startedAt,
            endedAt,
            http_req_duration: pickStats(m.http_req_duration?.values, FULL_STATS),
            http_req_waiting: pickStats(m.http_req_waiting?.values, FULL_STATS),
            http_req_failed: { rate: m.http_req_failed?.values?.rate ?? null },
            http_reqs: pickStats(m.http_reqs?.values, ['count', 'rate']),
            group_duration: pickStats(m.group_duration?.values, FULL_STATS),
            vus: pickStats(m.vus?.values, ['value', 'min', 'max']),
            vus_max: pickStats(m.vus_max?.values, ['value', 'min', 'max']),
            data_received: pickStats(m.data_received?.values, ['count', 'rate']),
            data_sent: pickStats(m.data_sent?.values, ['count', 'rate']),
            groups,
            environment: process.env[ENV_VARS.ENV] || null,
            testProject: process.env[ENV_VARS.PROJECT_NAME] || null,
            pipelineId: process.env[ENV_VARS.BUILD_ID] || null,
            commitSha: process.env[ENV_VARS.SOURCE_VERSION] || null,
            branch: process.env[ENV_VARS.SOURCE_BRANCH] || null,
            runUrl: process.env[ENV_VARS.BUILD_ID]
                ? `${process.env[ENV_VARS.TEAM_FOUNDATION_COLLECTION_URI]}${process.env[ENV_VARS.TEAM_PROJECT]}/_build/results?buildId=${process.env[ENV_VARS.BUILD_ID]}`
                : null,
            provider: process.env[ENV_VARS.BUILD_ID] ? PROVIDERS.AZURE_DEVOPS : null
        };
    }

    /**
     * Sends K6 metrics to the backend. Skips when CI env var is not set.
     *
     * Supports two modes:
     *   1) Pass `data` (summary from --summary-export or handleSummary). Optionally
     *      also pass `meta.samplesPath` to enrich each group with HTTP metrics.
     *   2) Pass `data = null` and only `meta.samplesPath`. The summary is rebuilt
     *      from the NDJSON stream — useful when only `--out json=...` was used.
     *
     * @param {object|null} data - The K6 summary data (or null when reconstructing from NDJSON).
     * @param {object} [meta] - Optional metadata.
     * @param {number} [meta.startedAt] - Override start timestamp.
     * @param {number} [meta.endedAt] - Override end timestamp.
     * @param {object} [meta.groupMetrics] - Pre-computed per-group metrics.
     * @param {string} [meta.samplesPath] - Path to the K6 NDJSON output.
     * @returns {Promise<any>} The response data.
     */
    async sendK6Metrics(data, meta = {}) {
        if (!process.env.CI) return;

        try {
            const token = await this.generateToken();
            if (!token) {
                console.error('No se pudo obtener el token, omitiendo envio de metricas K6');
                return;
            }

            const resolvedMeta = { ...meta };
            let resolvedData = data;

            if (!resolvedData && resolvedMeta.samplesPath) {
                resolvedData = await buildSummaryFromSamplesFile(resolvedMeta.samplesPath);
                if (!resolvedMeta.groupMetrics && resolvedData._groupMetrics) {
                    resolvedMeta.groupMetrics = resolvedData._groupMetrics;
                }
            } else if (!resolvedMeta.groupMetrics && resolvedMeta.samplesPath) {
                resolvedMeta.groupMetrics = await aggregateK6SamplesFromFile(resolvedMeta.samplesPath);
            }

            const payload = this.buildK6Payload(resolvedData, resolvedMeta);
            const response = await this.sendPOSTRequest(
                `${this.baseUrl}${this.k6MetricsEndpoint}`,
                payload,
                { Authorization: `Bearer ${token}` }
            );

            console.log(`Metricas K6 enviadas: ${payload.scenarioName} (${payload.duration}ms, ${payload.groups.length} grupos)`);
            return response?.data;
        } catch (error) {
            console.error(`Error enviando metricas K6: ${error?.message || error}`);
        }
    }
}
