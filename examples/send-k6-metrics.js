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

// Una vez persistido el run, el backend puede comparar contra el anterior
// con el mismo scriptHash + testProject. Util para fallar el pipeline ante
// regresiones (p95 > +20%, failedRate +0.02, etc.).
if (result?.id) {
    const report = await service.getCompareReport(result.id);
    if (report?.status === 'compared') {
        const regressed = report.endpoints.filter((e) => e.status === 'regressed');
        console.log(`Comparado vs run ${report.previous?.id}. Endpoints regresados: ${regressed.length}`);
        if (regressed.length) console.log(JSON.stringify(regressed, null, 2));
    } else if (report?.status === 'no_baseline') {
        console.log('Sin run anterior comparable — primera corrida o cambio de fingerprint.');
    }
}
