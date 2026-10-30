/* Frontend mirror of backend/src/config.js WORLD_LANGUAGES + LANGUAGE_GROUPS.
 *
 * WHY A MIRROR EXISTS. Vite and the Express server share no module graph, so a
 * table the browser needs cannot be imported from the backend. The alternative —
 * fetch the list from an endpoint on load — would mean the Settings dropdown is
 * empty for the first paint and a hard-refresh offline shows nothing. This is
 * user-visible preference data, not security data, so a static copy is right.
 *
 * HOW IT STAYS HONEST. api.test.mjs has a "language mirror cannot drift from the
 * backend table" test that reads both files and asserts the same code set and the
 * same script mapping. Adding a language to WORLD_LANGUAGES without adding it
 * here fails that test, so the two lists cannot silently disagree.
 *
 * Format: [code, English name, native name, script, BCP-47 locale].
 * `script` is the Unicode block the reply-guard judges by — see SCRIPT_RANGES in
 * the backend config for what each key means.
 */
export const WORLD_LANGUAGES = [
  ['en', 'English', 'English', 'latin', 'en-US'],
  /* South Asia */
  ['ur', 'Urdu', 'اردو', 'urdu', 'ur-PK'],
  ['hinglish', 'Hinglish', 'Hinglish', 'latin', 'hi-IN'],
  ['hi', 'Hindi', 'हिन्दी', 'devanagari', 'hi-IN'],
  ['bn', 'Bengali', 'বাংলা', 'bengali', 'bn-IN'],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'gurmukhi', 'pa-IN'],
  ['mr', 'Marathi', 'मराठी', 'devanagari', 'mr-IN'],
  ['gu', 'Gujarati', 'ગુજરાતી', 'gujarati', 'gu-IN'],
  ['ne', 'Nepali', 'नेपाली', 'devanagari', 'ne-NP'],
  ['ta', 'Tamil', 'தமிழ்', 'tamil', 'ta-IN'],
  ['te', 'Telugu', 'తెలుగు', 'telugu', 'te-IN'],
  ['kn', 'Kannada', 'ಕನ್ನಡ', 'kannada', 'kn-IN'],
  ['ml', 'Malayalam', 'മലയാളം', 'malayalam', 'ml-IN'],
  ['si', 'Sinhala', 'සිංහල', 'sinhala', 'si-LK'],
  /* East & South-East Asia */
  ['zh', 'Chinese', '中文', 'cjk', 'zh-CN'],
  ['ja', 'Japanese', '日本語', 'kana', 'ja-JP'],
  ['ko', 'Korean', '한국어', 'hangul', 'ko-KR'],
  ['id', 'Indonesian', 'Bahasa Indonesia', 'latin', 'id-ID'],
  ['ms', 'Malay', 'Bahasa Melayu', 'latin', 'ms-MY'],
  ['tl', 'Filipino', 'Filipino', 'latin', 'fil-PH'],
  ['vi', 'Vietnamese', 'Tiếng Việt', 'latin', 'vi-VN'],
  ['th', 'Thai', 'ไทย', 'thai', 'th-TH'],
  ['my', 'Burmese', 'မြန်မာ', 'myanmar', 'my-MM'],
  ['km', 'Khmer', 'ខ្មែរ', 'khmer', 'km-KH'],
  ['lo', 'Lao', 'ລາວ', 'lao', 'lo-LA'],
  /* Middle East & Central Asia */
  ['ar', 'Arabic', 'العربية', 'arabic', 'ar-SA'],
  ['fa', 'Persian', 'فارسی', 'arabic', 'fa-IR'],
  ['ps', 'Pashto', 'پښتو', 'arabic', 'ps-AF'],
  ['he', 'Hebrew', 'עברית', 'hebrew', 'he-IL'],
  ['ku', 'Kurdish', 'Kurdî', 'latin', 'kmr-TR'],
  ['az', 'Azerbaijani', 'Azərbaycan', 'latin', 'az-AZ'],
  ['kk', 'Kazakh', 'Қазақша', 'cyrillic', 'kk-KZ'],
  ['uz', 'Uzbek', 'Oʻzbekcha', 'latin', 'uz-UZ'],
  ['ug', 'Uyghur', 'ئۇيغۇرچە', 'arabic', 'ug-CN'],
  /* Europe */
  ['es', 'Spanish', 'Español', 'latin', 'es-ES'],
  ['fr', 'French', 'Français', 'latin', 'fr-FR'],
  ['de', 'German', 'Deutsch', 'latin', 'de-DE'],
  ['pt', 'Portuguese', 'Português', 'latin', 'pt-BR'],
  ['it', 'Italian', 'Italiano', 'latin', 'it-IT'],
  ['nl', 'Dutch', 'Nederlands', 'latin', 'nl-NL'],
  ['pl', 'Polish', 'Polski', 'latin', 'pl-PL'],
  ['uk', 'Ukrainian', 'Українська', 'cyrillic', 'uk-UA'],
  ['ru', 'Russian', 'Русский', 'cyrillic', 'ru-RU'],
  ['tr', 'Turkish', 'Türkçe', 'latin', 'tr-TR'],
  ['sv', 'Swedish', 'Svenska', 'latin', 'sv-SE'],
  ['da', 'Danish', 'Dansk', 'latin', 'da-DK'],
  ['nb', 'Norwegian', 'Norsk', 'latin', 'nb-NO'],
  ['fi', 'Finnish', 'Suomi', 'latin', 'fi-FI'],
  ['cs', 'Czech', 'Čeština', 'latin', 'cs-CZ'],
  ['sk', 'Slovak', 'Slovenčina', 'latin', 'sk-SK'],
  ['hu', 'Hungarian', 'Magyar', 'latin', 'hu-HU'],
  ['ro', 'Romanian', 'Română', 'latin', 'ro-RO'],
  ['bg', 'Bulgarian', 'Български', 'cyrillic', 'bg-BG'],
  ['sr', 'Serbian', 'Српски', 'cyrillic', 'sr-RS'],
  ['hr', 'Croatian', 'Hrvatski', 'latin', 'hr-HR'],
  ['el', 'Greek', 'Ελληνικά', 'greek', 'el-GR'],
  ['ca', 'Catalan', 'Català', 'latin', 'ca-ES'],
  ['lt', 'Lithuanian', 'Lietuvių', 'latin', 'lt-LT'],
  ['lv', 'Latvian', 'Latviešu', 'latin', 'lv-LV'],
  ['et', 'Estonian', 'Eesti', 'latin', 'et-EE'],
  /* Africa */
  ['sw', 'Swahili', 'Kiswahili', 'latin', 'sw-KE'],
  ['ha', 'Hausa', 'Hausa', 'latin', 'ha-NG'],
  ['yo', 'Yoruba', 'Yorùbá', 'latin', 'yo-NG'],
  ['ig', 'Igbo', 'Igbo', 'latin', 'ig-NG'],
  ['am', 'Amharic', 'አማርኛ', 'ethiopic', 'am-ET'],
  ['af', 'Afrikaans', 'Afrikaans', 'latin', 'af-ZA'],
  ['zu', 'Zulu', 'isiZulu', 'latin', 'zu-ZA'],
  ['so', 'Somali', 'Soomaali', 'latin', 'so-SO'],
]

export const LANGUAGE_GROUPS = [
  ['South Asia', ['ur', 'hinglish', 'hi', 'bn', 'pa', 'mr', 'gu', 'ne', 'ta', 'te', 'kn', 'ml', 'si']],
  ['East & South-East Asia', ['zh', 'ja', 'ko', 'id', 'ms', 'tl', 'vi', 'th', 'my', 'km', 'lo']],
  ['Middle East & Central Asia', ['ar', 'fa', 'ps', 'he', 'ku', 'az', 'kk', 'uz', 'ug']],
  ['Europe', ['es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'uk', 'ru', 'tr', 'sv', 'da', 'nb', 'fi', 'cs', 'sk', 'hu', 'ro', 'bg', 'sr', 'hr', 'el', 'ca', 'lt', 'lv', 'et']],
  ['Africa', ['sw', 'ha', 'yo', 'ig', 'am', 'af', 'zu', 'so']],
]

/* Derived lookup maps — same shape the backend exposes, so code written against
 * either side reads the same. */
export const REPLY_LANGUAGES = ['auto', ...WORLD_LANGUAGES.map(([code]) => code)]
export const REPLY_LANGUAGE_SCRIPTS = Object.fromEntries(WORLD_LANGUAGES.map(([code, , , script]) => [code, script]))
export const REPLY_LANGUAGE_NAMES = Object.fromEntries(WORLD_LANGUAGES.map(([code, name]) => [code, name]))
export const REPLY_LANGUAGE_NATIVES = Object.fromEntries(WORLD_LANGUAGES.map(([code, , native]) => [code, native]))
export const REPLY_LANGUAGE_LOCALES = Object.fromEntries(WORLD_LANGUAGES.map(([code, , , , locale]) => [code, locale]))

/* The dropdown list, English-first then grouped by region. "Auto — reply in
 * whatever you wrote" is always at the top because it is the shipped default
 * and a user hunting for it should not have to scroll. English sits alone as
 * its own section (it is in no region group by design — the groups are the
 * non-English neighbourhoods a user scans when English is not their first
 * language). */
const rowFor = (code) => WORLD_LANGUAGES.find((r) => r[0] === code)
const optionFor = (code) => {
  const row = rowFor(code)
  if (!row) return null
  const [, name, native] = row
  return { id: code, label: native && native !== name ? `${name} — ${native}` : name }
}
export const LANGUAGE_GROUPS_UI = [
  { region: 'Auto', entries: [{ id: 'auto', label: 'Auto — reply in whatever language you write' }] },
  { region: 'English', entries: [optionFor('en')] },
  ...LANGUAGE_GROUPS.map(([region, codes]) => ({ region, entries: codes.map(optionFor).filter(Boolean) })),
]
/* Flat list, kept for the loadVoicePrefs validator and any code that just wants
 * every valid code without caring about the region grouping. */
export const LANGUAGE_OPTIONS = LANGUAGE_GROUPS_UI.flatMap((g) => g.entries)

/* TTS rate profile. Every non-tuned language falls back to 1.0 (natural speed);
 * the four below are the ones the shipped Windows/en-IN voices rush or garble
 * without an explicit number. See voiceSelect.js for why each value is what it
 * is — the reasoning is preserved for the original four and no new language has
 * been ear-tuned yet, so it would be a guess to give one a rate. */
export const LANG_RATE_DEFAULT = 1.0
