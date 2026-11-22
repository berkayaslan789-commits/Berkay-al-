export interface LanguageOption {
  code: string;
  nameTr: string;
  nativeName: string;
  bcp47: string;
}

export const WORLD_LANGUAGES: LanguageOption[] = [
  { code: 'tr', nameTr: 'Türkçe', nativeName: 'Türkçe', bcp47: 'tr-TR' },
  { code: 'en', nameTr: 'İngilizce', nativeName: 'English', bcp47: 'en-US' },
  { code: 'es', nameTr: 'İspanyolca', nativeName: 'Español', bcp47: 'es-ES' },
  { code: 'de', nameTr: 'Almanca', nativeName: 'Deutsch', bcp47: 'de-DE' },
  { code: 'fr', nameTr: 'Fransızca', nativeName: 'Français', bcp47: 'fr-FR' },
  { code: 'ar', nameTr: 'Arapça', nativeName: 'العربية', bcp47: 'ar-SA' },
  { code: 'ru', nameTr: 'Rusça', nativeName: 'Русский', bcp47: 'ru-RU' },
  { code: 'ja', nameTr: 'Japonca', nativeName: '日本語', bcp47: 'ja-JP' },
  { code: 'ko', nameTr: 'Korece', nativeName: '한국어', bcp47: 'ko-KR' },
  { code: 'zh', nameTr: 'Çince (Mandarin)', nativeName: '中文', bcp47: 'zh-CN' },
  { code: 'it', nameTr: 'İtalyanca', nativeName: 'Italiano', bcp47: 'it-IT' },
  { code: 'pt', nameTr: 'Portekizce', nativeName: 'Português', bcp47: 'pt-BR' },
  { code: 'nl', nameTr: 'Felemenkçe', nativeName: 'Nederlands', bcp47: 'nl-NL' },
  { code: 'hi', nameTr: 'Hintçe', nativeName: 'हिन्दी', bcp47: 'hi-IN' },
  { code: 'pl', nameTr: 'Lehçe', nativeName: 'Polski', bcp47: 'pl-PL' },
  { code: 'uk', nameTr: 'Ukraynaca', nativeName: 'Українська', bcp47: 'uk-UA' },
  { code: 'el', nameTr: 'Yunanca', nativeName: 'Ελληνικά', bcp47: 'el-GR' },
  { code: 'sv', nameTr: 'İsveççe', nativeName: 'Svenska', bcp47: 'sv-SE' },
  { code: 'az', nameTr: 'Azerbaycan Türkçesi', nativeName: 'Azərbaycan', bcp47: 'az-AZ' },
  { code: 'fa', nameTr: 'Farsça', nativeName: 'فارسی', bcp47: 'fa-IR' },
  { code: 'id', nameTr: 'Endonezce', nativeName: 'Bahasa Indonesia', bcp47: 'id-ID' },
  { code: 'vi', nameTr: 'Vietnamca', nativeName: 'Tiếng Việt', bcp47: 'vi-VN' },
  { code: 'th', nameTr: 'Tayca', nativeName: 'ไทย', bcp47: 'th-TH' },
  { code: 'ro', nameTr: 'Rumence', nativeName: 'Română', bcp47: 'ro-RO' },
];

export const VOICE_PERSONAS = [
  { id: 'Zephyr', label: 'Zephyr (Doğal & Dengeli)' },
  { id: 'Kore', label: 'Kore (Net & Sıcak)' },
  { id: 'Puck', label: 'Puck (Dinamik & Canlı)' },
  { id: 'Charon', label: 'Charon (Derin & Sakin)' },
  { id: 'Fenrir', label: 'Fenrir (Güçlü & Vurgulu)' },
] as const;

export function getLanguageByCode(code: string): LanguageOption {
  return (
    WORLD_LANGUAGES.find((l) => l.code === code) ?? {
      code,
      nameTr: code.toUpperCase(),
      nativeName: code.toUpperCase(),
      bcp47: code,
    }
  );
}
