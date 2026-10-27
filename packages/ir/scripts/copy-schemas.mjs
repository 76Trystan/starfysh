import { cpSync } from 'node:fs';

cpSync('src/schema', 'dist/schema', { recursive: true });
