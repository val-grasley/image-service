import type { ProcessParams, SourceInfo } from '@image-service/sdk';
import { describe, expectTypeOf, it } from 'vitest';
import type { InfoResponse } from './info.ts';
import type { ProcessQuery } from './process.ts';

// Strips only the `| undefined` Zod adds to optional outputs and keeps the optional modifier,
// so an omitted, extra, retyped, or newly required field fails the comparison.
type Normalize<T> = { [K in keyof T]: Exclude<T[K], undefined> };

describe('route schemas are locked to the SDK types', () => {
  it('the /process query output equals ProcessParams', () => {
    expectTypeOf<Normalize<ProcessQuery>>().toEqualTypeOf<Normalize<ProcessParams>>();
  });

  it('the /info response equals SourceInfo', () => {
    expectTypeOf<Normalize<InfoResponse>>().toEqualTypeOf<Normalize<SourceInfo>>();
  });
});
