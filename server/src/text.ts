// Half of a surrogate pair with no other half. JSON can carry one ("\ud800"); UTF-8, and so
// the database, cannot: it would store U+FFFD in its place.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Free text as it is kept: a lone half of a surrogate pair becomes U+FFFD right away (so the
 * text compares equal to what the database gives back, and a retry of the same request is
 * recognised as the same), and the spaces around it are cut.
 */
export function cleanText(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD").trim();
}
