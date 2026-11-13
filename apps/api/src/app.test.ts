import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createDb } from './db';
import { testConfig } from './testing/test-config';

// هذه اختبارات وحدة بلا قاعدة بيانات: الاتصال لا يُفتح إلا عند أول استعلام، ولا مسار هنا يستعلم.
// These are DB-free unit tests: the connection opens only on the first query and no route here queries.
describe('api skeleton', () => {
  const app = createApp({ db: createDb('postgres://u:p@127.0.0.1:1/none'), config: testConfig() });

  it('GET /api/v1/health returns { data, meta } and a request id without a token', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' }, meta: {} });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not reveal which routes exist: unknown /api/v1 paths ask for a token first', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401, details: null });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns the standard 404 shape outside /api/v1', async () => {
    const res = await request(app).get('/elsewhere');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
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

  it('rejects a login body with unknown keys before touching the database', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ companyCode: 'acme', username: 'a', password: 'b', companyId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
