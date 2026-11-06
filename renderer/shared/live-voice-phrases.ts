// Fixed spoken phrases that Aiden Live acts on from the user's own transcribed
// speech: answering an approval, confirming a guarded action, and ending the
// session. A phrase only counts when it is the whole utterance. Nothing here
// guesses meaning from free speech, and the model's own words never reach it.

export type LiveVoicePhraseKind = "allow" | "deny" | "confirm" | "end";

export interface LiveVoiceLanguage {
  code: string;
  name: string;
}

/** Languages with a fixed phrase list, in Settings order. */
export const LIVE_VOICE_LANGUAGES: readonly LiveVoiceLanguage[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
];

// Words that also mean "hello" ("ciao", "salut", "안녕") are left out of `end`,
// and a bare "yes" never allows or confirms anything.
const PHRASES: Record<string, Record<LiveVoicePhraseKind, readonly string[]>> = {
  en: {
    allow: ["allow", "allow once", "allow it", "yes allow", "yes allow it", "allow this once"],
    deny: ["deny", "deny it", "don't allow", "do not allow", "no deny", "reject"],
    confirm: ["yes do it", "yes go ahead", "go ahead", "do it", "confirm", "yes confirm"],
    end: ["bye", "bye bye", "goodbye", "good bye", "that's all", "that is all", "end live", "stop live"],
  },
  es: {
    allow: ["permitir", "permitir una vez", "permítelo", "sí permitir"],
    deny: ["denegar", "no permitir", "rechazar", "no lo permitas"],
    confirm: ["sí hazlo", "sí adelante", "adelante", "confirmar", "hazlo"],
    end: ["adiós", "hasta luego", "eso es todo", "chao"],
  },
  fr: {
    allow: ["autoriser", "autoriser une fois", "j'autorise", "oui autoriser"],
    deny: ["refuser", "ne pas autoriser", "je refuse", "refusé"],
    confirm: ["oui vas-y", "oui fais-le", "vas-y", "confirmer", "oui confirme"],
    end: ["au revoir", "c'est tout", "à plus", "bye"],
  },
  de: {
    allow: ["erlauben", "einmal erlauben", "zulassen", "ja erlauben"],
    deny: ["ablehnen", "nicht erlauben", "verweigern", "nein ablehnen"],
    confirm: ["ja mach es", "ja mach das", "mach es", "bestätigen", "ja bestätigen"],
    end: ["tschüss", "tschüs", "auf wiedersehen", "das war's", "das wars"],
  },
  pt: {
    allow: ["permitir", "permitir uma vez", "autorizar", "sim permitir"],
    deny: ["negar", "não permitir", "recusar", "não autorizar"],
    confirm: ["sim pode fazer", "pode fazer", "sim faça", "confirmar", "pode seguir"],
    end: ["tchau", "adeus", "até logo", "é só isso"],
  },
  it: {
    allow: ["consenti", "consenti una volta", "permetti", "sì consenti"],
    deny: ["nega", "non consentire", "rifiuta", "non permettere"],
    confirm: ["sì fallo", "fallo", "procedi", "conferma", "sì procedi"],
    end: ["arrivederci", "è tutto", "a dopo"],
  },
  hi: {
    allow: ["अनुमति दो", "अनुमति दें", "एक बार अनुमति दें", "हाँ अनुमति दो", "हां अनुमति दो"],
    deny: ["मना करो", "मना करें", "अनुमति मत दो", "अनुमति न दें", "अस्वीकार करो"],
    confirm: ["हाँ करो", "हां करो", "हाँ कर दो", "हां कर दो", "पुष्टि करें"],
    end: ["अलविदा", "बाय", "बस इतना ही", "बस इतना"],
  },
  bn: {
    allow: ["অনুমতি দাও", "অনুমতি দিন", "একবার অনুমতি দিন", "হ্যাঁ অনুমতি দাও"],
    deny: ["অনুমতি দিও না", "অনুমতি দেবেন না", "প্রত্যাখ্যান করো", "বাতিল করো"],
    confirm: ["হ্যাঁ করো", "হ্যাঁ করুন", "হ্যাঁ করে দাও", "নিশ্চিত করো"],
    end: ["বিদায়", "বাই", "এটুকুই", "আজ এই পর্যন্ত"],
  },
  ja: {
    allow: ["許可", "許可する", "許可します", "一度だけ許可", "はい許可"],
    deny: ["拒否", "拒否する", "拒否します", "許可しない"],
    confirm: ["はいやって", "はい実行", "実行して", "はいお願いします"],
    end: ["さようなら", "バイバイ", "じゃあね", "以上です"],
  },
  ko: {
    allow: ["허용", "허용해", "허용해 줘", "한 번 허용", "네 허용"],
    deny: ["거부", "거부해", "허용 안 함", "허용하지 마", "거절"],
    confirm: ["네 해 주세요", "네 해주세요", "네 진행해", "진행해", "네 실행해"],
    end: ["안녕히 계세요", "잘 있어", "바이바이", "이상입니다"],
  },
  zh: {
    allow: ["允许", "允许一次", "同意", "好的允许"],
    deny: ["拒绝", "不允许", "不同意"],
    confirm: ["是的做吧", "好的执行", "确认执行", "执行吧", "确认"],
    end: ["再见", "拜拜", "就这样"],
  },
};

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s]*$/u;

/**
 * Comparison form: NFKC, lower case, punctuation dropped, all whitespace
 * removed (CJK speech has none), and Latin accents folded so "adios" matches
 * "adiós". Accents are kept in other scripts, where marks carry meaning.
 */
export function normalizeLiveVoicePhrase(text: string): string {
  const base = text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const folded = LATIN_ONLY.test(base)
    ? base.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC")
    : base;
  return folded.replace(/\s+/gu, "");
}

const LOOKUP: ReadonlyMap<string, { kind: LiveVoicePhraseKind; language: string }> = (() => {
  const map = new Map<string, { kind: LiveVoicePhraseKind; language: string }>();
  for (const [language, kinds] of Object.entries(PHRASES)) {
    for (const kind of Object.keys(kinds) as LiveVoicePhraseKind[]) {
      for (const phrase of kinds[kind]) {
        const key = normalizeLiveVoicePhrase(phrase);
        const existing = map.get(key);
        // A phrase shared by two languages ("permitir") keeps the first; a
        // phrase that would mean two different things is a list bug.
        if (existing && existing.kind !== kind) {
          throw new Error(`Live voice phrase "${phrase}" means two things.`);
        }
        if (!existing) map.set(key, { kind, language });
      }
    }
  }
  return map;
})();

/** The fixed phrase an utterance is, or null when it is anything else. */
export function matchLiveVoicePhrase(
  text: string,
): { kind: LiveVoicePhraseKind; language: string } | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 80) return null;
  // "Allow?", "Bye?!" and "¿Permitir?" ask about the phrase; they do not say
  // it. Any question mark anywhere makes the utterance a question.
  if (/[?？¿⸮\u037E؟]/u.test(text)) return null;
  const key = normalizeLiveVoicePhrase(text);
  if (key.length === 0) return null;
  return LOOKUP.get(key) ?? null;
}

/** The phrases for one kind in one language, for Settings and spoken prompts. */
export function liveVoicePhrases(language: string, kind: LiveVoicePhraseKind): readonly string[] {
  return PHRASES[language]?.[kind] ?? [];
}
