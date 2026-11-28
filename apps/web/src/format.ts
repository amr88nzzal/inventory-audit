// تاريخ ووقت بلغة الواجهة؛ الفراغ شرطة. A date-time in the UI language; empty is a dash.
export const formatDateTime = (iso: string | null | undefined, lang: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

// قيمة حقل datetime-local (توقيت المتصفح) من ISO وبالعكس. A datetime-local value (browser time) from ISO and back.
const pad = (n: number): string => String(n).padStart(2, '0');
export const isoToLocalInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const localInputToIso = (v: string): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
