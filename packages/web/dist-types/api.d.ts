/**
 * Typed client for our own API.
 *
 * The types come from @rws/shared, so a change to the server contract is a
 * compile error here rather than a runtime surprise.
 */
import type { LatestValue, Location, LocationDetail, QuantitiesResponse } from '@rws/shared';
export declare class ApiRequestError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export interface LocationFilters {
    grootheid?: string | undefined;
    compartiment?: string | undefined;
    q?: string | undefined;
}
export declare function fetchLocations(filters?: LocationFilters, signal?: AbortSignal): Promise<Location[]>;
export declare function fetchQuantities(signal?: AbortSignal): Promise<QuantitiesResponse>;
export declare function fetchLocation(code: string, signal?: AbortSignal): Promise<LocationDetail>;
export declare function fetchLatest(code: string, signal?: AbortSignal): Promise<LatestValue[]>;
//# sourceMappingURL=api.d.ts.map