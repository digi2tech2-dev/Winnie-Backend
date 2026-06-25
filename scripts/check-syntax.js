'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'uploads', 'logs']);
const TARGET_DIRS = ['src', 'scripts'];
const ROOT_FILES = [
    'ecosystem.config.js',
    'fix_wallet_transactions.js',
    'jest.config.js',
];

const files = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walk(path.join(dir, entry.name));
            }
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(path.join(dir, entry.name));
        }
    }
}

for (const dir of TARGET_DIRS) {
    const fullPath = path.join(ROOT, dir);
    if (fs.existsSync(fullPath)) walk(fullPath);
}

for (const file of ROOT_FILES) {
    const fullPath = path.join(ROOT, file);
    if (fs.existsSync(fullPath)) files.push(fullPath);
}

let failed = false;
for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        encoding: 'utf8',
    });

    if (result.status !== 0) {
        failed = true;
        process.stderr.write(result.stderr || result.stdout);
    }
}

if (failed) {
    process.exit(1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
