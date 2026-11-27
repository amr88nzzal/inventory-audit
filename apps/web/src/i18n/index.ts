import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';
import en from './en.json';

export type Lang = 'ar' | 'en';
const KEY = 'inventory.lang';

// تفضيل اللغة محفوظ على الجهاز فقط؛ والعربية أولاً. The language preference stays on the device only; Arabic first.
const stored = (): Lang => {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
};
export const dirOf = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');

export const applyLang = (lang: Lang): void => {
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // التخزين غير متاح (نافذة خاصة): لا مشكلة. Storage unavailable (private window): fine.
  }
};

export const setupI18n = async (lang: Lang = stored()): Promise<typeof i18n> => {
  await i18n.use(initReactI18next).init({
    lng: lang,
    fallbackLng: 'ar',
    resources: { ar: { translation: ar }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  applyLang(lang);
  return i18n;
};
export { i18n };
