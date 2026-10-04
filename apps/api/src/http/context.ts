import type { ErrorCode } from '@image-service/sdk';
import type { Logger } from '../observability/logger.ts';

// The Node adapter binds the incoming request, whose socket gives the client address; the
// Lambda adapter binds no socket.
export type AppEnv = {
  Bindings: { incoming?: { socket: { remoteAddress?: string | undefined } } };
  Variables: {
    requestId: string;
    log: Logger;
    sourceHostname: string | undefined;
    resultCache: 'hit' | 'miss' | undefined;
    errorCode: ErrorCode | undefined;
  };
};
