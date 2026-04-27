import config from '../../config.ts';

export type EmailTone = 'primary' | 'success' | 'error' | 'accent';

export type EmailDetailRow = {
  label: string;
  value: string;
};

export type EmailContent = {
  title: string;
  intro: string;
  tone: EmailTone;
  paragraphs?: string[];
  rows?: EmailDetailRow[];
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
};

const EMAIL_THEME = {
  background: '#f7f7f9',
  card: '#ffffff',
  text: '#30323a',
  muted: '#656a76',
  border: '#eceaf2',
  primary: '#AA87DE',
  secondary: '#E4A9D1',
  accent: '#87DED6',
  success: '#87DE89',
  error: '#FF7489',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function renderRowsHtml(rows: EmailDetailRow[]): string {
  const renderedRows = rows
    .map(row => `
      <tr>
        <td class="willing-row-label" style="padding:8px 0;vertical-align:top;color:${EMAIL_THEME.muted};font-weight:600;width:36%;">${escapeHtml(row.label)}</td>
        <td class="willing-row-value" style="padding:8px 0;vertical-align:top;color:${EMAIL_THEME.text};">${escapeHtml(row.value)}</td>
      </tr>
    `)
    .join('');

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${EMAIL_THEME.border};border-radius:12px;padding:14px 16px;background:${EMAIL_THEME.background};">
      ${renderedRows}
    </table>
  `;
}

export function buildEmailBody(content: EmailContent): { html: string; text: string } {
  const toneColor = EMAIL_THEME[content.tone];

  const paragraphsHtml = (content.paragraphs ?? [])
    .map(paragraph => `<p class="willing-paragraph" style="margin:0 0 14px;color:${EMAIL_THEME.text};font-size:14px;line-height:1.65;">${escapeHtml(paragraph)}</p>`)
    .join('');

  const rowsHtml = content.rows && content.rows.length > 0
    ? `${renderRowsHtml(content.rows)}${paragraphsHtml ? '<div style="height:16px;"></div>' : ''}`
    : '';

  const ctaHtml = content.ctaLabel && content.ctaUrl
    ? `
      <div style="margin-top:24px;">
        <a class="willing-button" href="${escapeHtml(content.ctaUrl)}" style="display:inline-block;background:${EMAIL_THEME.primary};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">
          ${escapeHtml(content.ctaLabel)}
        </a>
      </div>
    `
    : '';

  const noteHtml = content.note
    ? `<p class="willing-note" style="margin:20px 0 0;color:${EMAIL_THEME.muted};font-size:14px;line-height:1.5;">${escapeHtml(content.note)}</p>`
    : '';

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          @media only screen and (max-width: 600px) {
            .willing-body { padding: 14px !important; }
            .willing-brand { font-size: 18px !important; }
            .willing-badge { font-size: 11px !important; }
            .willing-title { font-size: 20px !important; }
            .willing-intro { font-size: 14px !important; line-height: 1.55 !important; }
            .willing-row-label, .willing-row-value { font-size: 13px !important; }
            .willing-paragraph, .willing-note { font-size: 13px !important; line-height: 1.55 !important; }
            .willing-button { font-size: 14px !important; padding: 10px 14px !important; }
            .willing-footer { font-size: 12px !important; }
          }
        </style>
      </head>
      <body class="willing-body" style="margin:0;padding:24px;background:${EMAIL_THEME.background};font-family:Inter,Segoe UI,Arial,sans-serif;color:${EMAIL_THEME.text};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;">
          <tr>
            <td>
              <div style="background:linear-gradient(100deg,${EMAIL_THEME.primary},${EMAIL_THEME.secondary});padding:18px 22px;border-radius:16px 16px 0 0;">
                <h1 class="willing-brand" style="margin:0;font-size:20px;line-height:1.2;color:#ffffff;">Willing</h1>
                <p style="margin:6px 0 0;color:#ffffffd0;font-size:13px;">Connecting volunteers to their vision of a better community</p>
              </div>
              <div style="background:${EMAIL_THEME.card};padding:26px 24px 24px;border:1px solid ${EMAIL_THEME.border};border-top:none;border-radius:0 0 16px 16px;">
                <div class="willing-badge" style="display:inline-block;padding:6px 12px;border-radius:999px;background:${toneColor}22;color:${toneColor};font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;">Willing Update</div>
                <h2 class="willing-title" style="margin:14px 0 8px;font-size:23px;line-height:1.3;color:${EMAIL_THEME.text};">${escapeHtml(content.title)}</h2>
                <p class="willing-intro" style="margin:0 0 18px;font-size:15px;line-height:1.65;color:${EMAIL_THEME.muted};">${escapeHtml(content.intro)}</p>
                ${rowsHtml}
                ${paragraphsHtml}
                ${ctaHtml}
                ${noteHtml}
                <hr style="border:none;border-top:1px solid ${EMAIL_THEME.border};margin:24px 0;" />
                <p class="willing-footer" style="margin:0;color:${EMAIL_THEME.muted};font-size:13px;line-height:1.5;">Willing Team<br />${config.WILLING_SENDER_EMAIL}</p>
              </div>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const textParts: string[] = [content.intro];

  if (content.rows && content.rows.length > 0) {
    textParts.push(content.rows.map(row => `${row.label}: ${row.value}`).join('\n'));
  }

  if (content.paragraphs && content.paragraphs.length > 0) {
    textParts.push(content.paragraphs.join('\n\n'));
  }

  if (content.ctaUrl) {
    textParts.push(`${content.ctaLabel ?? 'Open link'}: ${content.ctaUrl}`);
  }

  if (content.note) {
    textParts.push(content.note);
  }

  textParts.push('Willing Team');

  const text = textParts.join('\n\n');

  return { html, text };
}
