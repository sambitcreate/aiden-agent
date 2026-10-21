// The words behind the rules classifier (plan §6.2): a tokenizer, a light
// stemmer, the phrases that name each action class, the stop words custom
// rules ignore, and the strong-signal tables (app names, MCP name verbs,
// payment hosts).
//
// Matching works on stems, not raw prefixes: "posting" and "posted" meet
// "post", but "postal" does not, and "purchasing" meets "purchase". Phrases
// match consecutive stems, skipping only determiners ("Place your order"
// matches "place order"). Every table here errs towards precision for the
// locked classes (credentials, money), because a match there hands the call
// to the person.

import type { BotActionClass } from "../../../renderer/shared/bot-rules.js";

/**
 * Lower-case word tokens, NFKC, letters and digits only. camelCase is split
 * ("sendEmail" → send, email) unless `camelCase` is false, which keeps brand
 * names whole ("LinkedIn" → linkedin).
 */
export function tokenize(text: string, options: { camelCase?: boolean } = {}): string[] {
  let value = text.normalize("NFKC");
  if (options.camelCase !== false) {
    value = value.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  }
  return value
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * A light English stemmer: strips one inflection (-ies, -ing, -ed, -es, -s),
 * undoubles the consonant an -ing or -ed left behind, and drops a final
 * silent e, so every form of a verb meets the same stem.
 */
export function stem(word: string): string {
  let value = word;
  let stripped = false;
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 5 && value.endsWith("ing")) {
    value = value.slice(0, -3);
    stripped = true;
  } else if (value.length > 4 && value.endsWith("ed")) {
    value = value.slice(0, -2);
    stripped = true;
  } else if (value.length > 4 && /(?:ss|sh|ch|x|z)es$/u.test(value)) {
    value = value.slice(0, -2);
  } else if (value.length > 3 && value.endsWith("s") && !/(?:ss|us|is)$/u.test(value)) {
    value = value.slice(0, -1);
  }
  if (stripped && /([b-df-hj-np-tv-z])\1$/u.test(value) && !/(?:ll|ss|zz)$/u.test(value)) value = value.slice(0, -1);
  if (!stripped && value.length > 3 && value.endsWith("e")) value = value.slice(0, -1);
  return value;
}

/** Words a phrase match skips: "Place your order" is "place order". */
const DETERMINERS = new Set(["a", "an", "the", "your", "my", "our", "their", "his", "her", "its", "this", "that"]);

/** Words a custom rule's text ignores when it is matched ("book a flight" → book, flight). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  ...DETERMINERS,
  "about", "after", "all", "also", "am", "and", "any", "anyone", "anything", "are", "as", "at", "be", "been",
  "before", "being", "but", "by", "can", "could", "do", "does", "doing", "done", "each", "else", "ever", "every",
  "for", "from", "get", "gets", "go", "got", "has", "have", "he", "her", "him", "how", "i", "if", "in", "into",
  "is", "it", "just", "like", "me", "more", "most", "much", "new", "no", "not", "of", "on", "one", "onto", "or",
  "other", "out", "over", "please", "same", "she", "should", "so", "some", "someone", "something", "stuff", "such",
  "than", "them", "then", "there", "these", "they", "thing", "things", "those", "to", "too", "try", "trying", "up",
  "us", "use", "using", "very", "want", "wants", "was", "we", "were", "what", "when", "whenever", "where", "which",
  "while", "who", "will", "with", "without", "would", "you",
]);

/**
 * The stems a custom rule must all find in an action ("Book flights" → book,
 * flight). The person's words keep brand names whole ("LinkedIn"). Empty when
 * the text is only stop words.
 */
export function contentStems(text: string): string[] {
  return [...new Set(tokenize(text, { camelCase: false }).filter((token) => !STOP_WORDS.has(token)).map(stem))];
}

/** Every stem a custom rule may find in `text`: camelCase split and whole. */
export function actionStems(text: string): string[] {
  return [...tokenize(text), ...tokenize(text, { camelCase: false })].map(stem);
}

/**
 * Stems of `text`, determiners dropped, in order: what phrases are matched
 * against. With `keepPastTense`, a word ending in -ed stays whole: on a label,
 * "Posted by Ada" or "Deleted items" names a state, not the button that does it.
 */
export function phraseStems(text: string, options: { keepPastTense?: boolean } = {}): string[] {
  return tokenize(text)
    .filter((token) => !DETERMINERS.has(token))
    .map((token) => (options.keepPastTense === true && token.length > 4 && token.endsWith("ed") ? token : stem(token)));
}

/**
 * The phrases that name each class, as words a label, intent, title or tool
 * name uses. Multi-word phrases match consecutive words.
 */
export const CLASS_PHRASES: Readonly<Record<BotActionClass, readonly string[]>> = Object.freeze({
  credentials: [
    "password", "passcode", "passphrase", "passkey", "2fa", "mfa", "otp", "totp", "two factor", "2 factor",
    "two step", "2 step", "one time code", "one time password", "one time passcode", "verification code",
    "security code", "authentication code", "auth code", "login code", "sign in code", "recovery code",
    "backup code", "recovery key", "authenticator", "security question", "account security", "pin code",
    "pin number", "enter pin",
  ],
  money: [
    "pay", "paid", "payment", "transfer", "wire", "send money", "withdraw", "withdrawal", "deposit", "refund",
    "donate", "donation", "top up", "cash out", "payout", "card number", "credit card", "debit card", "card details",
    "cvv", "cvc", "cvv2", "expiry date", "expiration date", "iban", "routing number", "account number", "sort code",
    "swift code",
  ],
  purchase: [
    "buy", "bought", "purchase", "checkout", "check out", "place order", "order now", "submit order", "complete order",
    "confirm order", "complete purchase", "book", "booking", "book now", "reserve", "reservation", "subscribe",
    "subscription", "rent", "start trial", "free trial", "place bid", "preorder", "pre order",
  ],
  communicate: [
    "send", "reply", "reply all", "forward", "respond", "invite", "share", "send message", "post message",
    "direct message", "dm",
  ],
  delete: [
    "delete", "remove", "erase", "empty trash", "trash", "wipe", "purge", "destroy", "permanently", "uninstall",
    "discard",
  ],
  publish: [
    "publish", "post", "tweet", "retweet", "repost", "toot", "share publicly", "make public", "go live", "broadcast",
    "submit review",
  ],
  install: ["install", "reinstall", "installer", "download and install", "add extension", "add to chrome"],
});

const PHRASE_STEMS: ReadonlyArray<{ actionClass: BotActionClass; phrase: string; stems: readonly string[] }> = Object.entries(
  CLASS_PHRASES,
).flatMap(([actionClass, phrases]) =>
  phrases.map((phrase) => ({ actionClass: actionClass as BotActionClass, phrase, stems: phraseStems(phrase) })),
);

/** The classes behind locked rules: matched for recall, never negated. */
export const LOCKED_CLASSES: ReadonlySet<BotActionClass> = new Set(["credentials", "money"]);

/**
 * Words that, one or two words before a class phrase, mean the control is not
 * the action itself: "Cancel order", "Undo send", "Don't send", "Edit post",
 * "View booking". Compared as stems.
 */
export const NEGATORS: ReadonlySet<string> = new Set(
  ["cancel", "undo", "view", "show", "open", "edit", "new", "draft", "preview", "don", "not", "never", "no", "stop"].map(stem),
);

/**
 * The class phrases found in `stems`, each at most once per class and phrase:
 * the first occurrence that no negator (two words before it) cancels.
 */
export function phraseMatches(
  stems: readonly string[],
  classes?: ReadonlySet<BotActionClass>,
): Array<{ actionClass: BotActionClass; phrase: string; index: number; length: number }> {
  const found: Array<{ actionClass: BotActionClass; phrase: string; index: number; length: number }> = [];
  for (const entry of PHRASE_STEMS) {
    if (classes !== undefined && !classes.has(entry.actionClass)) continue;
    const length = entry.stems.length;
    for (let start = 0; start + length <= stems.length; start += 1) {
      let matches = true;
      for (let index = 0; index < length; index += 1) {
        if (stems[start + index] !== entry.stems[index]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const negated =
        !LOCKED_CLASSES.has(entry.actionClass) &&
        stems.slice(Math.max(0, start - 2), start).some((word) => NEGATORS.has(word));
      if (negated) continue;
      found.push({ actionClass: entry.actionClass, phrase: entry.phrase, index: start, length });
      break;
    }
  }
  return found;
}

/** Messaging apps: an input action in one of them is communicating (plan §6.2). Compared lower-case. */
export const COMMUNICATION_APPS: ReadonlySet<string> = new Set([
  "mail", "messages", "outlook", "microsoft outlook", "slack", "whatsapp", "telegram", "signal", "discord",
  "microsoft teams", "teams", "messenger", "spark", "mimestream", "airmail", "superhuman",
  "com.apple.mail", "com.apple.mobilesms", "com.microsoft.outlook", "com.tinyspeck.slackmacgap", "net.whatsapp.whatsapp",
  "ru.keepcoder.telegram", "org.whispersystems.signal-desktop", "com.hnc.discord", "com.microsoft.teams2",
]);

/** Menu items and whole button labels that install software ("Get" in the App Store). Compared lower-case. */
export const INSTALL_LEAVES: ReadonlySet<string> = new Set(["install", "get", "install update", "install now", "update and install"]);

/**
 * MCP tool-name verbs (strong signals). `anywhere` verbs count at any word of
 * the name (`gmail_send_message`); `leading` verbs only as its first word
 * (`book_flight`, `email_customer`), because elsewhere they are usually nouns
 * (`update_book`); `phrases` are consecutive name words (`create_payment_intent`).
 */
export const MCP_NAME_VERBS: ReadonlyArray<{
  actionClass: BotActionClass;
  anywhere: readonly string[];
  leading?: readonly string[];
  phrases?: readonly string[];
}> = Object.freeze([
  {
    actionClass: "communicate",
    anywhere: ["send", "reply", "forward", "respond", "invite", "share"],
    leading: ["email", "message", "sms", "notify", "dm"],
    phrases: ["post message", "post chat", "post dm", "post reply"],
  },
  { actionClass: "delete", anywhere: ["delete", "remove", "destroy", "erase", "purge", "trash", "wipe"] },
  { actionClass: "publish", anywhere: ["post", "publish", "tweet", "repost", "retweet"] },
  {
    actionClass: "money",
    anywhere: ["transfer", "pay", "refund", "payout", "withdraw", "charge"],
    phrases: ["create payment", "send money", "send payment"],
  },
  {
    actionClass: "purchase",
    anywhere: ["buy", "purchase", "checkout", "subscribe"],
    leading: ["book", "reserve", "order"],
    phrases: ["place order", "create order", "submit order", "create booking", "make booking", "create reservation", "make reservation"],
  },
  { actionClass: "install", anywhere: ["install", "reinstall"] },
]);

/** Name words after `post` that make it a message, not a public post (`slack_post_message`). */
export const MCP_POST_MESSAGE_WORDS: ReadonlySet<string> = new Set(["message", "chat", "dm", "reply"].map(stem));

/**
 * Hosts that take payments: a form posting to one moves money and buys
 * something. A host matches itself and its subdomains.
 */
export const PAYMENT_HOSTS: readonly string[] = Object.freeze([
  "stripe.com", "stripe.network", "paypal.com", "braintreegateway.com", "braintree-api.com", "adyen.com",
  "adyenpayments.com", "squareup.com", "square.link", "checkout.com", "authorize.net", "klarna.com", "afterpay.com",
  "affirm.com", "pay.google.com", "razorpay.com", "mollie.com", "worldpay.com", "2checkout.com", "paddle.com",
  "payu.com", "paystack.co", "flutterwave.com", "sumup.com", "shopifypay.com", "pay.shopify.com",
  "checkout.shopify.com",
]);

/** Whether `host` is one of `hosts` or a subdomain of one. */
function hostIn(host: string, hosts: readonly string[]): boolean {
  const normalized = host.trim().toLocaleLowerCase("en-US").replace(/\.$/u, "");
  if (normalized.length === 0) return false;
  return hosts.some((candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`));
}

export function isPaymentHost(host: string): boolean {
  return hostIn(host, PAYMENT_HOSTS);
}

/**
 * Web chat apps, where Enter in the message box sends it. A host matches
 * itself and its subdomains.
 */
export const MESSAGING_HOSTS: readonly string[] = Object.freeze([
  "slack.com", "web.whatsapp.com", "messenger.com", "discord.com", "teams.microsoft.com", "teams.live.com",
  "web.telegram.org", "messages.google.com", "chat.google.com", "web.skype.com", "app.element.io",
]);

/** Web mail, where Enter in the body is a new line and Control- or Command-Enter sends. */
export const MAIL_HOSTS: readonly string[] = Object.freeze([
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com",
  "mail.proton.me", "app.fastmail.com",
]);

export function isMessagingHost(host: string): boolean {
  return hostIn(host, MESSAGING_HOSTS);
}

export function isMailHost(host: string): boolean {
  return hostIn(host, MAIL_HOSTS);
}

/** Words in a text box's name that make it a message box ("Message #general", "Type a message", "Reply"). Compared as stems. */
export const COMPOSER_WORDS: ReadonlySet<string> = new Set(["message", "reply", "chat", "dm", "compose"].map(stem));

/** Words in a text box's name that make it a search or filter box, where Enter sends nothing. Compared as stems. */
export const SEARCH_BOX_WORDS: ReadonlySet<string> = new Set(["search", "find", "filter", "jump"].map(stem));
