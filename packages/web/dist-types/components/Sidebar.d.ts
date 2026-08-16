/**
 * Filters and search.
 *
 * There is deliberately no "has data" toggle: every location on the map is
 * active by definition, so such a filter would be a no-op that implies the
 * map might be showing dead stations.
 */
import type { CompartmentInfo, Location, QuantityInfo } from '@rws/shared';
export interface SidebarProps {
    quantities: QuantityInfo[];
    compartments: CompartmentInfo[];
    selectedQuantity: string | null;
    selectedCompartment: string | null;
    search: string;
    locations: Location[];
    loading: boolean;
    error: string | null;
    onQuantityChange: (code: string | null) => void;
    onCompartmentChange: (code: string | null) => void;
    onSearchChange: (value: string) => void;
    onSelect: (location: Location) => void;
    selectedCode: string | null;
}
export declare function Sidebar(props: SidebarProps): import("react").JSX.Element;
//# sourceMappingURL=Sidebar.d.ts.map