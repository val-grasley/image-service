import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Logger } from '../observability/logger.ts';
import { currentWindow, decide, type RateLimiter } from './limiter.ts';

const SEND_TIMEOUT_MS = 500;
const EXPIRY_GRACE_SECONDS = 120;

export function createDynamoDbRateLimiter(options: {
  client: Pick<DynamoDBClient, 'send'>;
  tableName: string;
  limit: number;
  logger: Logger;
}): RateLimiter {
  const { client, tableName, limit, logger } = options;

  return {
    async consume(key, nowMs) {
      const window = currentWindow(nowMs);
      const command = new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `rl#${key}#${String(window.index)}` } },
        UpdateExpression: 'ADD #count :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        // COUNT is a DynamoDB reserved word, so the attribute needs a name placeholder.
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':one': { N: '1' },
          ':exp': { N: String(window.endMs / 1000 + EXPIRY_GRACE_SECONDS) },
        },
        ReturnValues: 'UPDATED_NEW',
      });
      try {
        const output = await client.send(command, {
          abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const count = output.Attributes?.count?.N;
        if (count === undefined) {
          throw new Error('UpdateItem returned no count');
        }
        return decide(Number(count), limit, window.resetSeconds);
      } catch (err) {
        logger.error('Rate limit update failed; allowing the request.', { table: tableName }, err);
        return { allowed: true, limit, remaining: limit, resetSeconds: window.resetSeconds };
      }
    },
  };
}
