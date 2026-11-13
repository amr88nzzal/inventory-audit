import { describe, expect, it } from 'vitest';
import {
  createRoleSchema,
  isPermission,
  PERMISSIONS,
  setUserRolesSchema,
  updateRoleSchema,
} from './permissions';

describe('permission catalog', () => {
  it('uses module.resource.action and has no duplicates', () => {
    for (const p of PERMISSIONS)
      expect(p).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('recognises only catalog entries', () => {
    expect(isPermission('identity.role.read')).toBe(true);
    expect(isPermission('identity.role.nuke')).toBe(false);
    expect(isPermission('')).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
  });
});

describe('role schemas', () => {
  it('accepts a valid role and trims the name', () => {
    const r = createRoleSchema.parse({ name: '  Auditor ', permissions: ['identity.role.read'] });
    expect(r.name).toBe('Auditor');
  });

  it.each([
    [{ name: '', permissions: [] }],
    [{ name: 'x', permissions: ['nope.nope.nope'] }],
    [{ name: 'x', permissions: ['identity.role.read', 'identity.role.read'] }],
    [{ name: 'x', permissions: [], companyId: 'abc' }], // mass assignment
    [{ name: 'x'.repeat(65), permissions: [] }],
  ])('rejects invalid create input %j', (input) => {
    expect(createRoleSchema.safeParse(input).success).toBe(false);
  });

  it('update requires a version and at least one change', () => {
    expect(updateRoleSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(updateRoleSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateRoleSchema.safeParse({ version: 1, name: 'x' }).success).toBe(true);
    expect(updateRoleSchema.safeParse({ version: 1, description: null }).success).toBe(true);
  });

  it('setUserRoles needs unique UUIDs', () => {
    const id = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
    expect(setUserRolesSchema.safeParse({ roleIds: [id] }).success).toBe(true);
    expect(setUserRolesSchema.safeParse({ roleIds: [id, id] }).success).toBe(false);
    expect(setUserRolesSchema.safeParse({ roleIds: ['x'] }).success).toBe(false);
  });
});
