// تطبيع نص البحث العربي: لا فرق بين أشكال الألف والياء والتاء المربوطة، ولا بين الحركات والتطويل
// والأرقام العربية والغربية، ولا بين حالتي الأحرف اللاتينية. يُطبَّق على المخزَّن وعلى مدخل البحث بالدالة نفسها.
// Arabic search normalization: alef/yaa/taa-marbuta variants, diacritics, tatweel, Arabic-Indic digits
// and Latin case all collapse. The same function is applied to what is stored and to the search input.
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

export const normalizeSearch = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// يُهرَّب % و_ و\ كي لا يصبح مدخل المستخدم نمطاً في LIKE.
// Escape %, _ and \ so user input never becomes a LIKE pattern.
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
