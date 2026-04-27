import config from '../config.ts';
import db from '../db/index.ts';
import {
  sendAdminOrganizationRequestEmail,
  sendOrganizationAcceptanceEmail,
  sendOrganizationRejectionEmail,
  sendPasswordResetEmail,
  sendVolunteerApplicationAcceptedEmail,
  sendVolunteerApplicationRejectedEmail,
} from '../services/resend/emails.ts';

import type { OrganizationRequest } from '../db/tables/index.ts';

const SEND_TO = config.WILLING_SENDER_EMAIL!;
const TOTAL_ROUNDS = 1;
const DELAY_MS = 2000;
const TEMP_PASSWORD = 'TempPass123!';
const RESET_TOKEN = 'test-reset-token-123';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const fakeOrganizationRequest: OrganizationRequest = {
  id: 0,
  name: 'Resend Test Organization',
  email: SEND_TO,
  phone_number: '+96171123456',
  url: 'https://resend-test.willing.local',
  latitude: 33.8938,
  longitude: 35.5018,
  location_name: 'Beirut',
  created_at: new Date(),
};

async function run() {
  if (!SEND_TO) {
    console.error('Please set the WILLING_SENDER_EMAIL variable.');
    return;
  }

  console.log('Starting Resend template test run...');
  console.log(`NODE_ENV: ${config.NODE_ENV}`);
  console.log(`Target email: ${SEND_TO}`);
  console.log(`Rounds: ${TOTAL_ROUNDS}`);
  console.log(`Delay between emails: ${DELAY_MS}ms`);

  let sent = 0;
  let failed = 0;

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    const tasks: { name: string; run: () => Promise<void> }[] = [
      {
        name: 'sendPasswordResetEmail',
        run: () => sendPasswordResetEmail(SEND_TO, 'Resend Tester', `${RESET_TOKEN}-${round}`),
      },
      {
        name: 'sendVolunteerApplicationAcceptedEmail',
        run: () => sendVolunteerApplicationAcceptedEmail({
          volunteerEmail: SEND_TO,
          volunteerName: 'Resend Tester',
          organizationName: 'Resend Test Organization',
          postingTitle: 'Test Posting',
        }),
      },
      {
        name: 'sendVolunteerApplicationRejectedEmail',
        run: () => sendVolunteerApplicationRejectedEmail({
          volunteerEmail: SEND_TO,
          volunteerName: 'Resend Tester',
          organizationName: 'Resend Test Organization',
          postingTitle: 'Test Posting',
        }),
      },
      {
        name: 'sendAdminOrganizationRequestEmail',
        run: () => sendAdminOrganizationRequestEmail(fakeOrganizationRequest, [SEND_TO]),
      },
      {
        name: 'sendOrganizationAcceptanceEmail',
        run: () => sendOrganizationAcceptanceEmail(fakeOrganizationRequest, TEMP_PASSWORD),
      },
      {
        name: 'sendOrganizationRejectionEmail',
        run: () => sendOrganizationRejectionEmail(fakeOrganizationRequest, 'Resend test rejection reason'),
      },
    ];

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i]!;
      const position = `${i + 1}/${tasks.length}`;

      try {
        await task.run();
        sent += 1;
        console.log(`Round ${round} - ${position}: ${task.name} sent`);
      } catch (error) {
        failed += 1;
        console.error(`Round ${round} - ${position}: ${task.name} failed`, error);
      }

      if (i < tasks.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    if (round < TOTAL_ROUNDS) await sleep(DELAY_MS);
  }

  console.log('Resend template test run completed.');
  console.log(`Sent: ${sent}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }

  await db.destroy();
}

run().catch((error) => {
  console.error('Resend test script failed:', error);
  void db.destroy();
  process.exitCode = 1;
});
