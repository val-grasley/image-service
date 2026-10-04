import type { SourceType } from '@image-service/sdk';

type Signature = {
  type: SourceType;
  parts: readonly (readonly [offset: number, bytes: number[]])[];
};

const SIGNATURES: readonly Signature[] = [
  { type: 'jpeg', parts: [[0, [0xff, 0xd8, 0xff]]] },
  { type: 'png', parts: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  { type: 'gif', parts: [[0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]]] },
  { type: 'gif', parts: [[0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]]] },
  {
    type: 'webp',
    parts: [
      [0, [0x52, 0x49, 0x46, 0x46]],
      [8, [0x57, 0x45, 0x42, 0x50]],
    ],
  },
  { type: 'tiff', parts: [[0, [0x49, 0x49, 0x2a, 0x00]]] },
  { type: 'tiff', parts: [[0, [0x4d, 0x4d, 0x00, 0x2a]]] },
  {
    type: 'avif',
    parts: [
      [4, [0x66, 0x74, 0x79, 0x70]],
      [8, [0x61, 0x76, 0x69, 0x66]],
    ],
  },
  {
    type: 'avif',
    parts: [
      [4, [0x66, 0x74, 0x79, 0x70]],
      [8, [0x61, 0x76, 0x69, 0x73]],
    ],
  },
];

export function sniff(bytes: Uint8Array): SourceType | undefined {
  return SIGNATURES.find(({ parts }) =>
    parts.every(([offset, expected]) =>
      expected.every((byte, index) => bytes[offset + index] === byte),
    ),
  )?.type;
}
