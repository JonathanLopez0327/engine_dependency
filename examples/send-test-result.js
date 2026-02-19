import dotenv from 'dotenv';
import { TestInformationService } from '../src/index.js';

dotenv.config();

const service = new TestInformationService();

// Ejemplo: enviar un resultado de test
const testInfo = {
    title: 'Login exitoso con credenciales validas',
    titlePath: ['Auth', 'Login', 'Login exitoso con credenciales validas'],
    status: 'passed',
    duration: 3500,
    file: 'tests/auth/login.spec.js',
    project: { name: 'e2e-chrome' },
    retries: 0,
    retry: 0,
    tags: ['@smoke', '@auth'],
    expectedStatus: 'passed',
    annotations: [],
    timeout: 30000,
    errors: []
};

const result = await service.sendTestResult(testInfo);
console.log('Respuesta:', result);
