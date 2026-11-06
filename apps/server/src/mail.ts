/** Sends one email. Swappable so tests can capture messages and dev can run without a mail provider. */
export type Mailer = (message: { to: string; subject: string; text: string; html: string }) => Promise<void>;

/** Sends through Resend's HTTP API: no SDK, just an API key and a verified sender address. */
export function resendMailer(opts: { apiKey: string; from: string }): Mailer {
  return async ({ to, subject, text, html }) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: opts.from, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend refused the email (${res.status}) ${detail.slice(0, 200)}`.trim());
    }
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The invitation email: who invited you, to what, and one link. */
export function inviteEmail(p: { orgName: string; inviter: string; link: string; expiresInDays: number }) {
  const subject = `${p.inviter} invited you to ${p.orgName} on Ida`;
  const text = `${p.inviter} invited you to join ${p.orgName} on Ida.\n\nAccept the invitation: ${p.link}\n\nSign in with this email address to accept. The link works for ${p.expiresInDays} days.`;
  const html = `<p><strong>${escapeHtml(p.inviter)}</strong> invited you to join <strong>${escapeHtml(p.orgName)}</strong> on Ida.</p>`
    + `<p><a href="${escapeHtml(p.link)}">Accept the invitation</a></p>`
    + `<p style="color:#667">Sign in with this email address to accept. The link works for ${p.expiresInDays} days.</p>`;
  return { subject, text, html };
}
