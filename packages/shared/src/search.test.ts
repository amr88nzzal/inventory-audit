import { describe, expect, it } from 'vitest';
import { escapeLike, normalizeSearch } from './search';

describe('normalizeSearch', () => {
  it('collapses alef, yaa, taa marbuta and hamza forms', () => {
    expect(normalizeSearch('أحمد')).toBe(normalizeSearch('احمد'));
    expect(normalizeSearch('إيمان')).toBe(normalizeSearch('ايمان'));
    expect(normalizeSearch('مستودع الواجهة')).toBe(normalizeSearch('مستودع الواجهه'));
    expect(normalizeSearch('على')).toBe(normalizeSearch('علي'));
    expect(normalizeSearch('مسؤول')).toBe(normalizeSearch('مسوول'));
  });
  it('drops diacritics and tatweel', () => {
    expect(normalizeSearch('مُسْتَوْدَع')).toBe('مستودع');
    expect(normalizeSearch('مســتودع')).toBe('مستودع');
  });
  it('unifies Arabic-Indic and Persian digits with Latin ones, and Latin case', () => {
    expect(normalizeSearch('صالة ٥')).toBe('صاله 5');
    expect(normalizeSearch('صالة ۵')).toBe('صاله 5');
    expect(normalizeSearch('WH-Main')).toBe('wh-main');
  });
  it('collapses whitespace and trims', () => {
    expect(normalizeSearch('  مستودع   رئيسي ')).toBe('مستودع رييسي');
    expect(normalizeSearch('')).toBe('');
  });
  it('is idempotent', () => {
    const once = normalizeSearch('أَلْمُسْتَوْدَعُ الرَّئِيسِيَّة ١٢');
    expect(normalizeSearch(once)).toBe(once);
  });
});

describe('escapeLike', () => {
  it('escapes the three LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});
