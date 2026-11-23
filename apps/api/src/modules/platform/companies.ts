import { randomBytes } from 'node:crypto';
import type { CreateCompanyInput } from '@inventory/shared';
import { enterTenant, newId, withPlatform } from '../../db';
import { AppError } from '../../errors';
import { hashPassword } from '../auth';
import { ensureAdminRole, ensureUserRole } from '../rbac';
import type { PlatformDeps, PlatformIdentity } from './service';

export interface CompanyView {
  id: string;
  name: string;
  code: string;
  isDemo: boolean;
  createdAt: string;
}

export interface CreatedCompany {
  company: CompanyView;
  admin: { id: string; username: string; displayName: string };
  /** تُعرض هذه المرة فقط ولا تُخزَّن إلا مجزَّأة. Shown this once only; stored only hashed. */
  temporaryPassword: string;
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

// الرمز demo وما يبدأ به محجوز للشركة التجريبية ونسخها المؤرشفة.
// The code `demo` and anything starting with it is reserved for the demo company and its archived copies.
const RESERVED = /^demo(-|$)/;

// 18 بايتاً عشوائياً = 24 حرفاً: أطول من الحد الأدنى بكثير، فلا حاجة لقواعد تركيب تُضعف العشوائية.
// 18 random bytes = 24 chars: far above the minimum, so no composition rules that would weaken randomness.
const generateTemporaryPassword = (): string => randomBytes(18).toString('base64url');

/**
 * ينشئ الشركة ودور المدير وأول مستخدم في معاملة واحدة: إما كل شيء أو لا شيء (لا شركة يتيمة بلا أدمن).
 * Creates the company, admin role and first user in one transaction: all or nothing (no orphan company without an admin).
 */
export const createCompanyWithAdmin = async (
  deps: Pick<PlatformDeps, 'db' | 'config'>,
  actor: PlatformIdentity,
  input: CreateCompanyInput,
): Promise<CreatedCompany> => {
  if (RESERVED.test(input.code)) {
    throw new AppError('COMPANY_CODE_RESERVED', 400, 'This company code is reserved');
  }
  const temporaryPassword = generateTemporaryPassword();
  // التجزئة قبل فتح المعاملة لأنها بطيئة. Hash before opening the transaction: it is slow.
  const passwordHash = await hashPassword(temporaryPassword, deps.config.passwordHashLogN);
  const companyId = newId();
  const adminId = newId();
  const displayName = input.admin.displayName ?? input.admin.username;

  try {
    const createdAt = await withPlatform(deps.db, async (trx) => {
      const row = await trx
        .insertInto('companies')
        .values({
          id: companyId,
          name: input.name,
          code: input.code,
          is_demo: false,
          created_by: actor.adminId,
          updated_by: actor.adminId,
          deleted_at: null,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      // ننتقل داخل المعاملة نفسها لسياق الشركة الجديدة لإنشاء بياناتها بدور التطبيق لا دور المنصة.
      // Move, inside the same transaction, into the new company's context to create its data as the app role, not the platform role.
      await enterTenant(trx, { companyId, userId: null });
      const roleId = await ensureAdminRole(trx, companyId, null);
      await trx
        .insertInto('users')
        .values({
          id: adminId,
          company_id: companyId,
          username: input.admin.username,
          display_name: displayName,
          active: true,
          password_hash: passwordHash,
          must_change_password: true,
          password_changed_at: null,
          locked_until: null,
          last_login_at: null,
          created_by: null,
          updated_by: null,
          deleted_at: null,
        })
        .execute();
      await ensureUserRole(trx, companyId, adminId, roleId, null);
      return row.created_at;
    });
    return {
      company: {
        id: companyId,
        name: input.name,
        code: input.code,
        isDemo: false,
        createdAt: new Date(createdAt).toISOString(),
      },
      admin: { id: adminId, username: input.admin.username, displayName },
      temporaryPassword,
    };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('COMPANY_CODE_TAKEN', 409, 'A company with this code already exists');
    throw err;
  }
};

export const listCompanies = async (deps: Pick<PlatformDeps, 'db'>): Promise<CompanyView[]> => {
  const rows = await withPlatform(deps.db, (trx) =>
    trx
      .selectFrom('companies')
      .select(['id', 'name', 'code', 'is_demo', 'created_at'])
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute(),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    isDemo: r.is_demo,
    createdAt: new Date(r.created_at).toISOString(),
  }));
};
