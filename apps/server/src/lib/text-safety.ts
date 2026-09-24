/**
 * Text that leaves the product through trusted channels (staff alert emails, webhooks) must not carry links an
 * outsider wrote: a candidate could otherwise make SmartProctoring deliver "Please verify your account at …" to
 * staff inboxes (security review #10). Client-authored free text is not forwarded at all (catalog wording is used
 * instead, services/integration-events.ts); anything else user-controlled goes through stripUrls().
 */

export const LINK_PLACEHOLDER = '[link removed]';

// scheme://… , mailto:/tel:/data:/javascript: …, www.… , bare host names with a TLD (example.com/path, even when
// obfuscated with spaces around dots is NOT attempted), IPv4 literals with an optional port/path.
const URL_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"'“”‘’]*/gi,
  /\b(?:mailto|tel|sms|data|javascript|vbscript|file|ftp|news|irc|magnet):[^\s<>"'“”‘’]+/gi,
  /\bwww\d{0,3}\.[^\s<>"'“”‘’]+/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#][^\s<>"'“”‘’]*)?/g,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\b(?::\d{1,5})?(?:[/?#][^\s<>"'“”‘’]*)?/gi,
];

/** Replace anything that looks like a link or a host name with "[link removed]". */
export function stripUrls(text: string): string {
  let out = text.normalize('NFKC');
  for (const re of URL_PATTERNS) out = out.replace(re, LINK_PLACEHOLDER);
  return out;
}
