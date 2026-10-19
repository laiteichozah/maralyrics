/** The two emails we send. Plain, inline-styled HTML (email clients ignore stylesheets) plus a text version. */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout({ heading, intro, buttonText, link, outro }) {
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f1fa;font-family:Arial,Helvetica,sans-serif;color:#2a1650;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e3d9f5;">
<tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#a67c18;font-weight:bold;">MaraLyrics</td></tr>
<tr><td style="padding:0 32px;font-size:24px;font-weight:bold;">${esc(heading)}</td></tr>
<tr><td style="padding:12px 32px;font-size:15px;line-height:1.6;">${esc(intro)}</td></tr>
<tr><td style="padding:8px 32px 20px;"><a href="${esc(link)}" style="display:inline-block;background:#d9b44a;color:#2b1a05;text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:999px;">${esc(buttonText)}</a></td></tr>
<tr><td style="padding:0 32px 8px;font-size:13px;line-height:1.5;color:#6b5a96;">Or paste this address into your browser:<br><a href="${esc(link)}" style="color:#6b5a96;word-break:break-all;">${esc(link)}</a></td></tr>
<tr><td style="padding:12px 32px 28px;font-size:13px;line-height:1.5;color:#6b5a96;">${esc(outro)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}\n\n${buttonText}: ${link}\n\n${outro}\n\nMaraLyrics`;
  return { html, text };
}

export function verifyEmailMessage({ link }) {
  return {
    subject: 'Confirm your email for MaraLyrics',
    ...layout({
      heading: 'Confirm your email',
      intro: 'Thanks for joining MaraLyrics. Please confirm that this is your email address so we can take your profile claims and Green mark orders forward.',
      buttonText: 'Confirm my email',
      link,
      outro: 'This link works once and expires in 24 hours. If you did not create a MaraLyrics account you can ignore this email.',
    }),
  };
}

export function resetPasswordMessage({ link }) {
  return {
    subject: 'Reset your MaraLyrics password',
    ...layout({
      heading: 'Choose a new password',
      intro: 'Someone asked to reset the password of the MaraLyrics account for this email address. If that was you, choose a new password with the button below.',
      buttonText: 'Reset my password',
      link,
      outro: 'This link works once and expires in 1 hour. If you did not ask for this, ignore this email — your password stays the same.',
    }),
  };
}
