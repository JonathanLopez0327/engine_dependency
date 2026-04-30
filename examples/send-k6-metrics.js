import fs from 'node:fs';
import dotenv from 'dotenv';
import { K6MetricsService } from '../src/index.js';

dotenv.config();

// Soporta dos flujos:
//
// 1) Solo NDJSON (como usa el proyecto actual):
//      k6 run --out json=results.json scripts/updateActivityUAT.js
//      node examples/send-k6-metrics.js results.json
//    El servicio reconstruye el summary desde el NDJSON.
//
// 2) Summary + NDJSON (mas preciso para metricas globales):
//      k6 run --summary-export=summary.json --out json=results.json scripts/updateActivityUAT.js
//      node examples/send-k6-metrics.js results.json summary.json
//
// Requiere CI=1 en el env para que el envio se ejecute.

const samplesPath = process.argv[2] || './results.json';
const summaryPath = process.argv[3];

const data = summaryPath
    ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    : null;

const service = new K6MetricsService();
const result = await service.sendK6Metrics(data, { samplesPath });

console.log('Respuesta:', result);
