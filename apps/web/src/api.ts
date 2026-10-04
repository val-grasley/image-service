import {
  ImageApiError,
  ImageApiTransportError,
  type ImageClient,
  type ProblemDetails,
  type ProcessParams,
} from '@image-service/sdk';
import type { Event, Form, SourceError, TransportFailure } from './state.ts';

export function paramsFromForm(form: Form): ProcessParams {
  const params: ProcessParams = { url: form.url };
  if (form.width !== '') params.width = Number(form.width);
  if (form.height !== '') params.height = Number(form.height);
  if (form.crop !== '') params.crop = form.crop;
  if (form.format !== '') params.format = form.format;
  if (form.quality !== '') params.quality = Number(form.quality);
  return params;
}

export async function run(
  client: ImageClient,
  form: Form,
  requestUrl: URL,
  signal: AbortSignal,
): Promise<Event> {
  const params = paramsFromForm(form);
  try {
    const [source, processed] = await Promise.all([
      client.info(params.url, { signal }).catch(sourceError),
      client.process(params, { signal }),
    ]);
    // Blob accepts only ArrayBuffer-backed views, and the SDK types the bytes as possibly shared.
    const blob = new Blob([processed.bytes.slice()], { type: processed.contentType });
    return {
      type: 'resolved',
      requestUrl,
      source,
      processed,
      objectUrl: URL.createObjectURL(blob),
    };
  } catch (error) {
    return { type: 'failed', requestUrl, problem: failure(error) };
  }
}

// Only a problem the service sent can stand in for the source info; a transport failure
// fails the whole request.
function sourceError(error: unknown): SourceError {
  if (error instanceof ImageApiError) return { kind: 'source-error', problem: error.problem };
  throw error;
}

function failure(error: unknown): ProblemDetails | TransportFailure {
  if (error instanceof ImageApiError) return error.problem;
  if (error instanceof ImageApiTransportError) return { kind: 'transport', message: error.message };
  throw error;
}
