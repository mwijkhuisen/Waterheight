import { describe, expect, it } from 'vitest';
import { fold, matchStations, SEARCH_LIMIT } from '../src/lib/stationSearch.ts';

const st = (id: string, name: string, waterName: string | null = null) => ({ id, name, waterName });

const LIST = [
  st('nl.a', 'Lobith', 'Rijn'),
  st('nl.b', 'Hagestein Boven', 'Lek'),
  st('de.c', 'Köln', 'Rhein'),
  st('nl.d', 'Maastricht Sint Pieter', 'Maas'),
  st('be.e', 'Liège', 'Meuse'),
];

describe('fold', () => {
  it('lower-cases and strips diacritics', () => {
    expect(fold('Köln')).toBe('koln');
    expect(fold('LIÈGE')).toBe('liege');
    expect(fold('Hagestein')).toBe('hagestein');
  });
});

describe('matchStations', () => {
  const ids = (q: string) => matchStations(LIST, q).map((s) => s.id);

  it('finds a partial, case-insensitive, diacritics-free query', () => {
    expect(ids('lobit')).toEqual(['nl.a']);
    expect(ids('LOBITH')).toEqual(['nl.a']);
    expect(ids('koln')).toEqual(['de.c']);
    expect(ids('liege')).toEqual(['be.e']);
    expect(ids('Köln')).toEqual(['de.c']);
  });

  it('matches the water name too, after the names that match', () => {
    expect(ids('rijn')).toEqual(['nl.a']);
    expect(ids('maas')).toEqual(['nl.d']);
    // "lek" is in a water name and in no station name
    expect(ids('lek')).toEqual(['nl.b']);
  });

  it('puts a name that starts with the query before one that only contains it', () => {
    const list = [st('1', 'Boven Lek', null), st('2', 'Lekkerkerk', null), st('3', 'Wijk bij Lek', 'Lek')];
    expect(matchStations(list, 'lek').map((s) => s.id)).toEqual(['2', '1', '3']);
  });

  it('needs every word of the query', () => {
    expect(ids('hagestein lek')).toEqual(['nl.b']);
    expect(ids('hagestein rijn')).toEqual([]);
    expect(ids('  sint   pieter ')).toEqual(['nl.d']);
  });

  it('returns nothing for an empty or blank query', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });

  it('keeps two stations with the same label apart by id, in list order', () => {
    const twins = [st('fr.1', 'Pont', 'Meuse'), st('be.2', 'Pont', 'Meuse'), st('nl.3', 'Elders', null)];
    expect(matchStations(twins, 'pont').map((s) => s.id)).toEqual(['fr.1', 'be.2']);
  });

  it('returns at most the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => st(`x.${i}`, `Station ${i}`));
    expect(matchStations(many, 'station')).toHaveLength(SEARCH_LIMIT);
    expect(matchStations(many, 'station', 5).map((s) => s.id)).toEqual(['x.0', 'x.1', 'x.2', 'x.3', 'x.4']);
  });
});
