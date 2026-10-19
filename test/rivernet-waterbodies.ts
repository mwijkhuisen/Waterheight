import type { RiversFile } from '../packages/contracts/src/rivers.ts';
import { loadWaterbodyInput, readWaterbodies, type WaterbodyInput } from '../tools/geo/rivernet/waterbodies.ts';
import { repoRoot } from './catalogue.ts';

/** The committed water-body fixture (the osmium export of geo.yml), the one the generated registry/rivernet.yaml used. */
export const WATERBODY_FIXTURE = `${repoRoot}tools/geo/fixtures/rivernet.waterbodies.geojsonseq`;

/** The registry's water bodies with their polygons from the committed fixture: the sixth argument of place(). */
export const fixtureWaterbodies = (rivers: RiversFile): Promise<WaterbodyInput> =>
  loadWaterbodyInput(readWaterbodies(rivers), WATERBODY_FIXTURE);
