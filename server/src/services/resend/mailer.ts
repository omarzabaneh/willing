import { Resend } from 'resend';

import config from '../../config.ts';

let resend: Resend;
if (config.NODE_ENV === 'production') {
  resend = new Resend(config.RESEND_API_KEY);
}

function indentLines(content: string): string {
  return content
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}) {
  if (config.NODE_ENV === 'production') {
    const { error } = await resend.emails.send({
      from: 'Willing <' + config.WILLING_SENDER_EMAIL + '>',
      to: opts.to,
      subject: opts.subject,
      html: opts.html || opts.text,
    });
    if (error) {
      console.error('Couldn\'t send mail:', error);
      // throw new Error('Something went wrong when sending email.');
    }
  } else {
    const timestamp = new Date().toISOString();
    const output = [
      '',
      '============================== [DEV] EMAIL =============================',
      `Time: ${timestamp}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Text length: ${opts.text.length} chars`,
      `HTML length: ${opts.html ? `${opts.html.length} chars` : 'none'} (preview hidden in dev logs)`,
      '------------------------------------------------------------------------',
      'Text preview:',
      indentLines(opts.text),
      '========================================================================',
      '',
    ].join('\n');

    console.log(output);
  }
}
