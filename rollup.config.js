import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

function getSourceFiles(dir, base = dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...getSourceFiles(full, base));
        } else if (entry.endsWith('.js')) {
            files.push(relative(base, full).replace(/\\/g, '/'));
        }
    }
    return files;
}

const sourceFiles = getSourceFiles('src');

const input = Object.fromEntries(
    sourceFiles.map(file => [file.replace('.js', ''), `src/${file}`])
);

const external = (id) => id.startsWith('node:');

export default [
    {
        input,
        external,
        output: {
            dir: 'dist/esm',
            format: 'esm',
            preserveModules: true,
            entryFileNames: '[name].js'
        }
    },
    {
        input,
        external,
        output: {
            dir: 'dist/cjs',
            format: 'cjs',
            preserveModules: true,
            entryFileNames: '[name].cjs',
            exports: 'named'
        }
    }
];
