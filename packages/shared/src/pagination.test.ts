import { describe, expect, it } from 'vitest';
import { offsetOf, pageMeta, paginationSchema } from './pagination';

describe('paginationSchema', () => {
  it('defaults to page 1 and 25 per page', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });
  it('parses numeric strings from the query', () => {
    expect(paginationSchema.parse({ page: '3', pageSize: '100' })).toEqual({
      page: 3,
      pageSize: 100,
    });
  });
  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: '1e3' },
    { page: '' },
    { page: 'abc' },
    { pageSize: '0' },
    { pageSize: '101' },
    { page: '9999999999' },
  ])('rejects %j', (q) => {
    expect(paginationSchema.safeParse(q).success).toBe(false);
  });
});

describe('pageMeta / offsetOf', () => {
  it('computes pages, with at least one page when empty', () => {
    expect(pageMeta(1, 25, 0).totalPages).toBe(1);
    expect(pageMeta(1, 25, 25).totalPages).toBe(1);
    expect(pageMeta(2, 25, 26).totalPages).toBe(2);
  });
  it('computes the offset', () => {
    expect(offsetOf(1, 25)).toBe(0);
    expect(offsetOf(3, 10)).toBe(20);
  });
});
