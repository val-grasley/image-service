import type {
  DynamoDBClient,
  UpdateItemCommand,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../observability/logger.ts';
import { createDynamoDbRateLimiter } from './dynamodb.ts';

const MID_WINDOW = Date.UTC(2026, 9, 4, 12, 0, 30);

function setup(respond: () => Promise<Pick<UpdateItemCommandOutput, 'Attributes' | '$metadata'>>) {
  const sent: { input: UpdateItemCommand['input']; options: unknown }[] = [];
  const client: Pick<DynamoDBClient, 'send'> = {
    // send's overloads take either request options or a callback second; only the former is used.
    send: (command: UpdateItemCommand, options?: unknown) => {
      sent.push({ input: command.input, options });
      return respond();
    },
  };
  const lines: string[] = [];
  const logger = createLogger(
    'debug',
    (line) => lines.push(line),
    () => MID_WINDOW,
  );
  const limiter = createDynamoDbRateLimiter({
    client,
    tableName: 'rate-limits',
    limit: 60,
    logger,
  });
  return { limiter, sent, logged: () => lines.map((line): unknown => JSON.parse(line)) };
}

const returningCount = (count: number) => () =>
  Promise.resolve({ Attributes: { count: { N: String(count) } }, $metadata: {} });

describe('createDynamoDbRateLimiter', () => {
  it('sends one atomic UpdateItem for the key and window, expiring 120 s after the window ends', async () => {
    const { limiter, sent } = setup(returningCount(1));
    await limiter.consume('203.0.113.9', MID_WINDOW);
    expect(sent.map((call) => call.input)).toEqual([
      {
        TableName: 'rate-limits',
        Key: { pk: { S: 'rl#203.0.113.9#29851920' } },
        UpdateExpression: 'ADD #count :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':exp': { N: '1791115380' } },
        ReturnValues: 'UPDATED_NEW',
      },
    ]);
    expect(sent[0]?.options).toHaveProperty('abortSignal', expect.any(AbortSignal));
  });

  it('allows when the returned count is at the limit', async () => {
    const { limiter } = setup(returningCount(60));
    expect(await limiter.consume('203.0.113.9', MID_WINDOW)).toEqual({
      allowed: true,
      limit: 60,
      remaining: 0,
      resetSeconds: 30,
    });
  });

  it('denies when the returned count is above the limit', async () => {
    const { limiter } = setup(returningCount(61));
    expect(await limiter.consume('203.0.113.9', MID_WINDOW)).toEqual({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetSeconds: 30,
    });
  });

  it('allows and logs an error when the send is rejected', async () => {
    const { limiter, logged } = setup(() =>
      Promise.reject(new Error('ProvisionedThroughputExceeded')),
    );
    expect(await limiter.consume('203.0.113.9', MID_WINDOW)).toEqual({
      allowed: true,
      limit: 60,
      remaining: 60,
      resetSeconds: 30,
    });
    expect(logged()).toMatchObject([
      { level: 'error', table: 'rate-limits', err: { message: 'ProvisionedThroughputExceeded' } },
    ]);
  });

  it('allows and logs an error when the response carries no count', async () => {
    const { limiter, logged } = setup(() => Promise.resolve({ $metadata: {} }));
    expect(await limiter.consume('203.0.113.9', MID_WINDOW)).toMatchObject({ allowed: true });
    expect(logged()).toMatchObject([
      { level: 'error', table: 'rate-limits', err: { message: 'UpdateItem returned no count' } },
    ]);
  });
});
