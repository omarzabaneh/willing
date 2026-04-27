import { sendEmail } from './mailer.ts';
import { buildEmailBody } from './template.ts';
import config from '../../config.ts';
import { type OrganizationRequest } from '../../db/tables/index.ts';

export async function sendOrganizationAcceptanceEmail(
  organizationRequest: OrganizationRequest,
  password: string,
) {
  const to = organizationRequest.email;

  const subject = 'Welcome to Willing!';
  const loginUrl = `${config.CLIENT_URL}/login`;

  const { html, text } = buildEmailBody({
    title: 'Welcome to Willing!',
    intro: `Hello ${organizationRequest.name}, your organization request was approved.`,
    rows: [
      { label: 'Email', value: to },
      { label: 'Temporary password', value: password },
    ],
    paragraphs: ['We are excited to have you on Willing. Please change your password after your first login.'],
    ctaLabel: 'Go to Login',
    ctaUrl: loginUrl,
    tone: 'success',
  });

  await sendEmail({ to: [to], subject, text, html });
}

export async function sendPasswordResetEmail(to: string, name: string, resetToken: string) {
  const subject = 'Reset your Willing password';
  const resetUrl = `${config.CLIENT_URL}/forgot-password?key=${encodeURIComponent(resetToken)}`;

  const { html, text } = buildEmailBody({
    title: 'Password Reset Request',
    intro: `Hello ${name}, we received a request to reset your password.`,
    paragraphs: ['If this was you, use the button below to set a new password.'],
    ctaLabel: 'Reset Password',
    ctaUrl: resetUrl,
    note: 'If you did not request this, you can safely ignore this email.',
    tone: 'primary',
  });

  await sendEmail({ to: [to], subject, text, html });
}

export async function sendOrganizationRejectionEmail(
  organizationRequest: OrganizationRequest,
  reason: string | null,
) {
  const to = organizationRequest.email;

  const subject = 'Your organization request was not approved';

  const rows = reason && reason.trim().length
    ? [{ label: 'Reason', value: reason.trim() }]
    : undefined;

  const { html, text } = buildEmailBody({
    title: 'Organization Request Rejected',
    intro: `Hello ${organizationRequest.name}, your organization request was not approved.`,
    ...(rows ? { rows } : {}),
    paragraphs: ['You can submit a new request with updated information if needed.'],
    note: `For any extra questions, contact willing.app.lb@gmail.com.`,
    tone: 'error',
  });

  await sendEmail({ to: [to], subject, text, html });
}

export async function sendAdminOrganizationRequestEmail(
  organizationRequest: OrganizationRequest,
  adminEmails: string[],
) {
  if (adminEmails.length === 0) {
    throw new Error('No admin emails were provided.');
  }

  const subject = 'New organization request to review';

  const reviewUrl = `${config.CLIENT_URL}/admin`;
  const { html, text } = buildEmailBody({
    title: 'New Organization Request Submitted',
    intro: 'A new organization request is ready for review in the admin dashboard.',
    rows: [
      { label: 'Organization name', value: organizationRequest.name },
      { label: 'Organization email', value: organizationRequest.email },
      { label: 'Phone', value: organizationRequest.phone_number ?? '—' },
      { label: 'Website', value: organizationRequest.url ?? '—' },
      { label: 'Location', value: organizationRequest.location_name },
    ],
    ctaLabel: 'Review Request',
    ctaUrl: reviewUrl,
    tone: 'accent',
  });

  await sendEmail({
    to: adminEmails,
    subject,
    text,
    html,
  });
}
function formatEmailDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export async function sendVolunteerApplicationAcceptedEmail(opts: {
  volunteerEmail: string;
  volunteerName: string;
  organizationName: string;
  postingTitle: string;
  acceptedDates?: string[];
}) {
  const subject = 'You\'re in! Your volunteering application was accepted';

  const rows = [
    { label: 'Organization', value: opts.organizationName },
    { label: 'Posting', value: opts.postingTitle },
  ];

  const paragraphs = ['Congratulations! Thank you for stepping up to help your community.'];

  if (opts.acceptedDates && opts.acceptedDates.length > 0) {
    const formattedDates = opts.acceptedDates
      .map(date => formatEmailDate(date));
    rows.push({ label: 'Accepted dates', value: formattedDates.join(', ') });
  }

  const { html, text } = buildEmailBody({
    title: 'Application Accepted - Congratulations!',
    intro: `Hello ${opts.volunteerName}, your volunteering application was accepted.`,
    rows,
    paragraphs,
    tone: 'success',
  });

  await sendEmail({ to: [opts.volunteerEmail], subject, text, html });
}

export async function sendVolunteerApplicationRejectedEmail(opts: {
  volunteerEmail: string;
  volunteerName: string;
  organizationName: string;
  postingTitle: string;
}) {
  const subject = 'Update on your volunteer application';

  const { html, text } = buildEmailBody({
    title: 'Application Not Accepted',
    intro: `Hello ${opts.volunteerName}, your volunteering application was not accepted this time.`,
    rows: [
      { label: 'Organization', value: opts.organizationName },
      { label: 'Posting', value: opts.postingTitle },
    ],
    note: 'Keep an eye on new opportunities that match your skills.',
    tone: 'error',
  });

  await sendEmail({ to: [opts.volunteerEmail], subject, text, html });
}

export async function sendVolunteerVerificationEmail(opts: {
  volunteerEmail: string;
  volunteerName: string;
  verificationToken: string;
}) {
  const subject = 'Verify your Willing account email';
  const verifyUrl = `${config.CLIENT_URL}/volunteer/verify-email?key=${encodeURIComponent(opts.verificationToken)}&email=${encodeURIComponent(opts.volunteerEmail)}`;
  const { html, text } = buildEmailBody({
    title: 'Confirm Your Email Address',
    intro: `Hello ${opts.volunteerName}, Welcome to Willing!`,
    paragraphs: ['Please verify your email address to activate your volunteer account.'],
    ctaLabel: 'Verify Email',
    ctaUrl: verifyUrl,
    note: 'If you did not create this account, you can safely ignore this email.',
    tone: 'primary',
  });

  await sendEmail({ to: [opts.volunteerEmail], subject, text, html });
}

export async function sendPostingDeletedEmail(opts: {
  volunteerEmail: string;
  volunteerName: string;
  postingTitle: string;
  organizationName: string;
}) {
  const subject = 'A posting you were enrolled in has been removed';

  const { html, text } = buildEmailBody({
    title: 'Posting Removed',
    intro: `Hello ${opts.volunteerName}, a posting you were enrolled in has been removed.`,
    rows: [
      { label: 'Posting', value: opts.postingTitle },
      { label: 'Organization', value: opts.organizationName },
    ],
    paragraphs: ['Your enrollment in this posting has been cancelled. We apologize for the inconvenience.'],
    note: 'Keep an eye on new opportunities that match your skills.',
    tone: 'error',
  });

  await sendEmail({ to: [opts.volunteerEmail], subject, text, html });
}
