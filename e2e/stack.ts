// Fixed addresses, because the webServer entries start the stack before any spec loads and
// the specs build source and request URLs against the same servers.
export const upstream = 'http://127.0.0.1:4100';
export const api = 'http://127.0.0.1:4000';
export const rateLimitedApi = 'http://127.0.0.1:4001';
