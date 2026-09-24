/**
 * Outgoing email (alert emails). `ctx.mailer` is an SMTP mailer when SMTP_HOST is configured, otherwise null
 * (email alerts are then unavailable). Tests inject a MemoryMailer through buildApp({ mailer }).
 */
import { createTransport } from 'nodemailer';
import type { SmtpConfig } from '../config.js';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Resolves when the SMTP server accepted the message; rejects otherwise. */
  send(message: MailMessage): Promise<void>;
  /** The configured From address (for display). */
  readonly from: string;
  close?(): Promise<void> | void;
}

/** Header values must not contain line breaks (header injection). */
export function headerSafe(s: string, max = 250): string {
  const one = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function createSmtpMailer(cfg: SmtpConfig): Mailer {
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    from: cfg.from,
    async send(m) {
      await transport.sendMail({ from: cfg.from, to: m.to.join(', '), subject: headerSafe(m.subject), text: m.text, ...(m.html ? { html: m.html } : {}) });
    },
    close() {
      transport.close();
    },
  };
}

/** In-memory mailer for tests and local development. `failNext` makes the next N sends reject. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failNext = 0;
  constructor(readonly from = 'SmartProctoring <alerts@test.example>') {}
  async send(m: MailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SMTP unavailable (simulated)');
    }
    this.sent.push({ ...m, subject: headerSafe(m.subject) });
  }
}
