import type { ResultCache } from '../cache/result-cache.ts';
import type { Config } from '../config.ts';
import type { inspect, pipelineVersion, transform } from '../image/pipeline.ts';
import type { Logger } from '../observability/logger.ts';
import type { SourceCache } from '../source/cache.ts';
import type { FetchedSource } from '../source/fetcher.ts';
import type { PolicyConfig } from '../source/policy.ts';

type BoundFetch = (url: URL, log: Logger) => Promise<FetchedSource>;

export type OperationDeps = {
  fetchSource: BoundFetch;
  sourceCache: SourceCache;
  resultCache: ResultCache;
  pipeline: {
    inspect: typeof inspect;
    transform: typeof transform;
    pipelineVersion: typeof pipelineVersion;
  };
  policy: PolicyConfig;
  limits: Pick<
    Config,
    | 'maxInputPixels'
    | 'maxOutputDimension'
    | 'maxOutputPixels'
    | 'maxOutputBytes'
    | 'maxAvifOutputPixels'
    | 'transformTimeoutSeconds'
  >;
};
