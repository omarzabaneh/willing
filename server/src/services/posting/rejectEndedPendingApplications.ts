import { type Kysely } from 'kysely';

import { hasPostingEnded } from './postingTime.ts';
import executeTransaction from '../../db/executeTransaction.ts';
import { type Database } from '../../db/tables/index.ts';
import { sendVolunteerApplicationRejectedEmail } from '../resend/emails.ts';

export async function rejectEndedPendingApplicationsForPostings(
  db: Kysely<Database>,
  postingIds?: readonly number[],
): Promise<Set<number>> {
  const uniquePostingIds = postingIds
    ? [...new Set(postingIds.filter(id => Number.isInteger(id) && id > 0))]
    : undefined;

  if (uniquePostingIds && uniquePostingIds.length === 0) {
    return new Set<number>();
  }

  let postingsQuery = db
    .selectFrom('posting')
    .select([
      'id',
      'automatic_acceptance',
      'end_date',
      'end_time',
    ]);

  if (uniquePostingIds) {
    postingsQuery = postingsQuery.where('id', 'in', uniquePostingIds);
  } else {
    postingsQuery = postingsQuery.where(({ exists, selectFrom }) => exists(
      selectFrom('enrollment_application')
        .select('enrollment_application.id')
        .whereRef('enrollment_application.posting_id', '=', 'posting.id'),
    ));
  }

  const postings = await postingsQuery.execute();

  const endedReviewPostingIds = postings
    .filter(posting => !posting.automatic_acceptance && hasPostingEnded(posting))
    .map(posting => posting.id);

  if (endedReviewPostingIds.length === 0) {
    return new Set<number>();
  }

  const pendingApplications = await db
    .selectFrom('enrollment_application')
    .select(['id', 'posting_id'])
    .where('posting_id', 'in', endedReviewPostingIds)
    .execute();

  const applicationIds = pendingApplications.map(application => application.id);

  if (applicationIds.length === 0) {
    return new Set<number>(endedReviewPostingIds);
  }

  const emailContexts = await db
    .selectFrom('enrollment_application')
    .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment_application.volunteer_id')
    .innerJoin('posting', 'posting.id', 'enrollment_application.posting_id')
    .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
    .select([
      'enrollment_application.id as application_id',
      'volunteer_account.email as volunteer_email',
      'volunteer_account.first_name',
      'volunteer_account.last_name',
      'organization_account.name as organization_name',
      'posting.title as posting_title',
    ])
    .where('enrollment_application.id', 'in', applicationIds)
    .where('volunteer_account.is_deleted', '=', false)
    .where('volunteer_account.is_disabled', '=', false)
    .execute();

  await executeTransaction(db, async (trx) => {
    await trx
      .deleteFrom('enrollment_application_date')
      .where('application_id', 'in', applicationIds)
      .execute();

    await trx
      .deleteFrom('enrollment_application')
      .where('id', 'in', applicationIds)
      .execute();
  });

  await Promise.allSettled(
    emailContexts.map(emailContext =>
      sendVolunteerApplicationRejectedEmail({
        volunteerEmail: emailContext.volunteer_email,
        volunteerName: `${emailContext.first_name} ${emailContext.last_name}`,
        organizationName: emailContext.organization_name,
        postingTitle: emailContext.posting_title,
      }).catch((err: unknown) => {
        console.error(
          `Failed to send ended-posting rejection email for application ${emailContext.application_id}:`,
          err,
        );
      }),
    ),
  );

  return new Set<number>(endedReviewPostingIds);
}
