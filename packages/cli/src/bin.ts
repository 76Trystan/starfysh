#!/usr/bin/env node
import { run } from './run.js';

const code = run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
process.exit(code);
