import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('api skeleton', () => {
  const app = createApp();

  it('GET /api/v1/health returns { data, meta } and a request id', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' }, meta: {} });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', status: 404, details: null });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('turns malformed JSON into a 400 JSON error without leaking internals', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_JSON', status: 400 });
    expect(JSON.stringify(res.body)).not.toContain('SyntaxError');
  });
});
