#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startFakeUpstream } from './server.ts';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = Number(values.port ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('--port must be an integer between 0 and 65535.');
}
const upstream = await startFakeUpstream({ port });
console.log(`fake upstream listening on ${upstream.url.href}`);
