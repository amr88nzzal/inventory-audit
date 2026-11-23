import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_ACCOUNTS, DEMO_COMPANY_CODE, DEMO_PASSWORD } from '@inventory/shared';
import { describe, expect, it } from 'vitest';

// يضمن أن مقالات الدليل سليمة الترويسة وأن مقال الشركة التجريبية يطابق بياناتها الفعلية.
// Guards the guide articles' front matter and that the demo article matches the real demo data.
const dir = path.resolve(__dirname, '../../../docs/guide/articles');
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
const ROLES = new Set(['admin', 'platform', 'auditor']);

const frontMatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(
    m[1]!
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
};

describe('guide articles', () => {
  it('has articles', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s has valid front matter', (f) => {
    const fm = frontMatter(readFileSync(path.join(dir, f), 'utf8'));
    expect(fm['title']).toBeTruthy();
    expect(fm['summary']).toBeTruthy();
    expect(Number.isInteger(Number(fm['order']))).toBe(true);
    expect(['api-only', 'ready']).toContain(fm['status']);
    const roles = (fm['roles'] ?? '').split(',').map((r) => r.trim());
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) expect(ROLES.has(r), r).toBe(true);
  });

  it('demo article lists the real company code, password and every account', () => {
    const text = readFileSync(path.join(dir, 'demo-company.md'), 'utf8');
    expect(text).toContain(`\`${DEMO_COMPANY_CODE}\``);
    expect(text).toContain(DEMO_PASSWORD);
    for (const a of DEMO_ACCOUNTS) expect(text).toContain(`\`${a.username}\``);
  });
});
