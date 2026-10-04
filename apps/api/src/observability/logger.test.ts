import { describe, expect, it } from 'vitest';
import type { LogLevel } from '../config.ts';
import { createLogger } from './logger.ts';

function capture(level: LogLevel = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    level,
    (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    () => 1_700_000_000_000,
  );
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line with time, level, and msg', () => {
    const { logger, lines } = capture();
    logger.info('started', { port: 3000 });
    expect(lines).toEqual([
      { time: '2023-11-14T22:13:20.000Z', level: 'info', msg: 'started', port: 3000 },
    ]);
  });

  it('merges child fields under later fields', () => {
    const { logger, lines } = capture();
    logger.child({ requestId: 'r1', stage: 'child' }).warn('slow', { stage: 'call' });
    expect(lines[0]).toMatchObject({ requestId: 'r1', stage: 'call', level: 'warn' });
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('expands err with its cause chain', () => {
    const { logger, lines } = capture();
    const root = new Error('socket closed');
    const wrapped = new Error('fetch failed', { cause: root });
    logger.error('upstream', { hostname: 'example.com' }, wrapped);
    expect(lines[0]).toMatchObject({
      hostname: 'example.com',
      err: {
        name: 'Error',
        message: 'fetch failed',
        cause: { name: 'Error', message: 'socket closed' },
      },
    });
    expect(lines[0]).not.toHaveProperty('err.cause.cause');
  });

  it('omits err when none is given and serializes a non-Error err as a string', () => {
    const { logger, lines } = capture();
    logger.error('no error object', { code: 'x' });
    logger.error('odd', undefined, 'plain string');
    expect(lines[0]).not.toHaveProperty('err');
    expect(lines[1]).toMatchObject({ err: 'plain string' });
  });
});
