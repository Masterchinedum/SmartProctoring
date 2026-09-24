/**
 * Text that leaves the product through trusted channels (staff alert emails, webhooks) must not carry links an
 * outsider wrote: a candidate could otherwise make SmartProctoring deliver "Please verify your account at …" to
 * staff inboxes (security review #10). Client-authored free text is not forwarded at all (catalog wording is used
 * instead, services/integration-events.ts); other user-controlled text goes through stripUrls().
 */

export const LINK_PLACEHOLDER = '[link removed]';

const STOP = `[^\\s<>"'“”‘’()\\[\\]{}]`;
/** Explicit links: scheme://…, mailto:/javascript:/data:… and www.… */
const EXPLICIT: RegExp[] = [
  new RegExp(`\\b[a-z][a-z0-9+.-]{1,20}:\\/\\/${STOP}*`, 'gi'),
  new RegExp(`\\b(?:mailto|tel|sms|data|javascript|vbscript|file|ftp|news|irc|magnet):${STOP}+`, 'gi'),
  new RegExp(`\\bwww\\d{0,3}\\.${STOP}+`, 'gi'),
];
/** Things mail clients auto-link: bare host names with a TLD (example.com/path) and IPv4 literals. */
const IMPLICIT: RegExp[] = [
  new RegExp(`\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?(?:[/?#]${STOP}*)?`, 'g'),
  new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\\b(?::\\d{1,5})?(?:[/?#]${STOP}*)?`, 'gi'),
];

/**
 * Replace anything that looks like a link with "[link removed]". Free text (observations, reasons) is checked for
 * bare host names too; `{ bareHosts: false }` keeps them for identifiers such as names or external ids (which are
 * often e-mail addresses) and removes explicit links only. Unicode look-alikes (fullwidth dots, …) are normalised first.
 */
export function stripUrls(text: string, opts: { bareHosts?: boolean } = {}): string {
  let out = text.normalize('NFKC');
  for (const re of EXPLICIT) out = out.replace(re, LINK_PLACEHOLDER);
  if (opts.bareHosts !== false) for (const re of IMPLICIT) out = out.replace(re, LINK_PLACEHOLDER);
  return out;
}
