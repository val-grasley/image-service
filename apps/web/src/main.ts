import { ImageClient, processUrl } from '@image-service/sdk';
import { paramsFromForm, run } from './api.ts';
import { mount, type Dispatch } from './render.ts';
import { effectsFor, initialState, reduce, type Event } from './state.ts';

const client = new ImageClient(location.origin);
let state = initialState;

const dispatch: Dispatch = (input) => {
  const event: Event =
    input.type === 'submit-requested'
      ? {
          type: 'submit',
          requestUrl: processUrl(location.origin, paramsFromForm(state.form)),
          controller: new AbortController(),
        }
      : input;
  const before = state;
  state = reduce(state, event);
  const { abort, revoke } = effectsFor(before.phase, state.phase);
  abort?.abort();
  if (revoke !== undefined) URL.revokeObjectURL(revoke);
  update(state);
  const { phase } = state;
  if (phase.kind === 'loading' && phase !== before.phase) {
    void run(client, state.form, phase.requestUrl, phase.controller.signal).then(dispatch);
  }
};

const update = mount(document.body, dispatch);
update(state);
