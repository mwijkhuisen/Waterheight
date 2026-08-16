/**
 * Typed client for our own API.
 *
 * The types come from @rws/shared, so a change to the server contract is a
 * compile error here rather than a runtime surprise.
 */
export class ApiRequestError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'ApiRequestError';
    }
}
async function get(path, signal) {
    const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
        // The API always uses one error envelope; fall back only if that fails.
        let code = 'http_error';
        let message = `Request failed with status ${res.status}`;
        try {
            const body = (await res.json());
            if (body?.error) {
                code = body.error.code;
                message = body.error.message;
            }
        }
        catch { /* keep the fallback */ }
        throw new ApiRequestError(res.status, code, message);
    }
    return (await res.json());
}
export function fetchLocations(filters = {}, signal) {
    const params = new URLSearchParams();
    if (filters.grootheid)
        params.set('grootheid', filters.grootheid);
    if (filters.compartiment)
        params.set('compartiment', filters.compartiment);
    if (filters.q)
        params.set('q', filters.q);
    const query = params.toString();
    return get(`/api/locations${query ? `?${query}` : ''}`, signal);
}
export function fetchQuantities(signal) {
    return get('/api/quantities', signal);
}
export function fetchLocation(code, signal) {
    return get(`/api/locations/${encodeURIComponent(code)}`, signal);
}
export function fetchLatest(code, signal) {
    return get(`/api/locations/${encodeURIComponent(code)}/latest`, signal);
}
//# sourceMappingURL=api.js.map