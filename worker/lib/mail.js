/**
 * Transactional email through Resend (https://resend.com): address verification and password reset.
 *
 *   RESEND_API_KEY  (secret)  — wrangler secret put RESEND_API_KEY.  Unset = email is OFF: nothing is sent and the
 *                               features that depend on it (verification gate, "forgot password") switch themselves off,
 *                               so a half-configured deploy never locks anyone out.
 *   MAIL_FROM       (var)     — e.g. "MaraLyrics <noreply@maralyrics.com>"; the domain must be verified in Resend.
 *   SITE_ORIGIN     (var)     — where links in emails point; defaults to https://maralyrics.com.
 */
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'MaraLyrics <noreply@maralyrics.com>';
export const DEFAULT_SITE_ORIGIN = 'https://maralyrics.com';

export const mailEnabled = (env) => !!(env && env.RESEND_API_KEY);
export const siteOrigin = (env) => String((env && env.SITE_ORIGIN) || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');

/** → { ok: true } | { ok: false, error }. Never throws, and never puts the message body in a log. */
export async function sendMail(env, { to, subject, html, text }) {
  if (!mailEnabled(env)) return { ok: false, error: 'email is not configured' };
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [to], subject, html, text }),
    });
    if (res.ok) return { ok: true };
    const detail = await res.json().catch(() => ({}));
    console.error(`Resend rejected an email (${res.status}): ${detail.message || detail.name || 'no detail'}`);
    return { ok: false, error: `the mail service refused it (${res.status})` };
  } catch (err) {
    console.error(`Resend request failed: ${err && err.message}`);
    return { ok: false, error: 'the mail service could not be reached' };
  }
}
