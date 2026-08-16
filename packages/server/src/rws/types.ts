/**
 * Shapes of the raw Rijkswaterstaat WaterWebservices responses.
 *
 * These mirror the wire format exactly, Dutch field names and all, and exist
 * only so the normalisers have something typed to consume. Nothing in here may
 * escape into the public API -- that is what @rws/shared is for.
 *
 * Verified against live responses recorded in fixtures/trimmed/.
 */

export interface AquoCode {
  Code: string;
  Omschrijving?: string;
}

export interface AquoMetadata {
  Compartiment?: AquoCode;
  Grootheid?: AquoCode;
  Eenheid?: AquoCode;
  Parameter?: AquoCode;
  Hoedanigheid?: AquoCode;
  Typering?: AquoCode;
  Orgaan?: AquoCode;
  BioTaxon?: AquoCode;
  BioTaxonType?: AquoCode;
  Groepering?: AquoCode;
  BemonsteringsApparaat?: AquoCode;
  BemonsteringsMethode?: AquoCode;
  BemonsteringsSoort?: AquoCode;
  MeetApparaat?: AquoCode;
  WaardeBepalingsMethode?: AquoCode;
  WaardeBepalingsTechniek?: AquoCode;
  WaardeBewerkingsMethode?: AquoCode;
  Parameter_Wat_Omschrijving?: string;
  /** 'meting' for observations, 'verwacht'/'verwachting' for forecasts. */
  ProcesType?: string;
}

/** Per-measurement metadata; carries fields that also identify the series. */
export interface WaarnemingMetadata {
  Bemonsteringshoogte?: string;
  Referentievlak?: string;
  OpdrachtgevendeInstantie?: string;
  /** 'Ongecontroleerd' until Rijkswaterstaat validates, then 'Gecontroleerd'. */
  Statuswaarde?: string;
  Kwaliteitswaardecode?: string;
}

export interface RwsLocatie {
  Code: string;
  Naam?: string;
  Omschrijving?: string;
  Lat?: number;
  Lon?: number;
  Coordinatenstelsel?: string;
}

export interface Meetwaarde {
  /** Always populated upstream, even when the value parses as a number. */
  Waarde_Alfanumeriek?: string;
  Waarde_Numeriek?: number | null;
}

export interface Meting {
  Tijdstip: string;
  Meetwaarde?: Meetwaarde;
  WaarnemingMetadata?: WaarnemingMetadata;
}

export interface Waarneming {
  AquoMetadata?: AquoMetadata;
  Locatie?: RwsLocatie;
  MetingenLijst?: Meting[];
}

export interface OphalenWaarnemingenResponse {
  Succesvol?: boolean;
  Foutmelding?: string;
  WaarnemingenLijst?: Waarneming[];
}

export interface AantalMetingenPerPeriode {
  AantalMetingen?: number;
  Groeperingsperiode?: Record<string, unknown>;
}

export interface AantalWaarnemingenPerPeriode {
  AquoMetadata?: AquoMetadata;
  Locatie?: RwsLocatie;
  WaarnemingMetadata?: WaarnemingMetadata;
  AantalMetingenPerPeriodeLijst?: AantalMetingenPerPeriode[];
}

export interface OphalenAantalWaarnemingenResponse {
  Succesvol?: boolean;
  AantalWaarnemingenPerPeriodeLijst?: AantalWaarnemingenPerPeriode[];
}

export interface CatalogusLocatie extends RwsLocatie {
  Locatie_MessageID?: number;
}

export interface CatalogusAquoMetadata extends AquoMetadata {
  AquoMetadata_MessageID?: number;
}

export interface OphalenCatalogusResponse {
  Succesvol?: boolean;
  LocatieLijst?: CatalogusLocatie[];
  AquoMetadataLijst?: CatalogusAquoMetadata[];
  AquoMetadataLocatieLijst?: {
    Locatie_MessageID?: number;
    AquoMetaData_MessageID?: number;
  }[];
}
