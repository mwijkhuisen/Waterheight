/**
 * The map itself: a clustered point layer over a Dutch basemap.
 *
 * Clustering is done by MapLibre's own GeoJSON source rather than a plugin.
 * The markers are drawn as a single GPU circle layer, so a few thousand points
 * cost one draw call instead of a few thousand DOM nodes.
 */
import type { Location } from '@rws/shared';
export interface MapViewProps {
    locations: Location[];
    selectedCode: string | null;
    onSelect: (code: string) => void;
    /** Set to fly the map to a location, e.g. from a search result. */
    flyTo: Location | null;
}
export declare function MapView({ locations, selectedCode, onSelect, flyTo }: MapViewProps): import("react").JSX.Element;
//# sourceMappingURL=MapView.d.ts.map