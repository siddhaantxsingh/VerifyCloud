// Email delivery. With SMTP_URL set, mail goes through SMTP (nodemailer);
// otherwise messages are written to the log (development) — they are never
// silently dropped. The in-memory outbox keeps the last messages for tests.
import nodemailer, { type Transporter } from "nodemailer";

import type { ServerConfig } from "./config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export class Mailer {
  readonly outbox: Mail[] = [];
  private transport?: Transporter;
  constructor(
    private cfg: ServerConfig,
    private log: { info: (o: object, m: string) => void },
  ) {
    if (cfg.smtpUrl) this.transport = nodemailer.createTransport(cfg.smtpUrl);
  }

  get configured() {
    return Boolean(this.transport);
  }

  async send(m: Mail) {
    this.outbox.push(m);
    if (this.outbox.length > 100) this.outbox.shift();
    if (!this.transport) {
      this.log.info({ to: m.to, subject: m.subject, text: m.text }, "email (SMTP not configured; logged instead of sent)");
      return;
    }
    await this.transport.sendMail({ from: this.cfg.mailFrom, to: m.to, subject: m.subject, text: m.text });
  }
}
