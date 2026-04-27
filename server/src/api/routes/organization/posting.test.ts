import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import createApp from '../../../app.ts';
import database from '../../../db/index.ts';
import * as resendEmails from '../../../services/resend/emails.ts';
import { createOrganizationAccount, createVolunteerAccount } from '../../../tests/fixtures/accounts.ts';

import type { Database } from '../../../db/tables/index.ts';
import type { ControlledTransaction } from 'kysely';
import type TestAgent from 'supertest/lib/agent.js';

const formatDateToIso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

let transaction: ControlledTransaction<Database, []>;
let server: TestAgent;

type SkillResponseItem = {
  name: string;
};

beforeEach(async () => {
  transaction = await database.startTransaction().execute();
  server = supertest(createApp(transaction));
});

afterEach(async () => {
  await transaction.rollback().execute();
});

describe('Organization posting applications', () => {
  test('returns requested_dates for partial attendance applications', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-posting-apps@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-posting-apps@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Review Partial Attendance Event',
        description: 'Review requested dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-06-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-06-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Available on selected days',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application_date')
      .values([
        { application_id: application.id, date: new Date('2026-06-01T00:00:00.000Z') },
        { application_id: application.id, date: new Date('2026-06-03T00:00:00.000Z') },
      ])
      .execute();

    const response = await server
      .get(`/organization/posting/${posting.id}/applications`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.applications).toHaveLength(1);
    expect(response.body.applications[0]).toMatchObject({
      application_id: application.id,
      volunteer_id: volunteer.id,
      requested_dates: ['2026-06-01', '2026-06-03'],
    });
  });

  test('automatically rejects pending applications for an ended review-based posting', async () => {
    const rejectionEmailSpy = vi.spyOn(resendEmails, 'sendVolunteerApplicationRejectedEmail').mockResolvedValue(undefined);
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-ended-auto-reject@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-ended-auto-reject@example.com' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Review Posting',
        description: 'Pending applications should be rejected automatically',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: yesterday,
        start_time: '09:00:00',
        end_date: yesterday,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Ended Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Please accept me',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/organization/posting/${posting.id}/applications`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.applications).toEqual([]);

    const remainingApplication = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('id', '=', application.id)
      .executeTakeFirst();

    expect(remainingApplication).toBeUndefined();
    expect(rejectionEmailSpy).toHaveBeenCalledTimes(1);

    rejectionEmailSpy.mockRestore();
  });

  test('accepting a review-based partial application creates enrollment_date rows', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-posting-accept@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-posting-accept@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Review Acceptance Dates Event',
        description: 'Accepted volunteers should keep their selected dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-07-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-07-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Available on selected days',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application_date')
      .values([
        { application_id: application.id, date: new Date('2026-07-01T00:00:00.000Z') },
        { application_id: application.id, date: new Date('2026-07-03T00:00:00.000Z') },
      ])
      .execute();

    await server
      .post(`/organization/posting/${posting.id}/applications/${application.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const enrollment = await transaction
      .selectFrom('enrollment')
      .select(['id', 'volunteer_id', 'posting_id', 'attended'])
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    expect(enrollment.attended).toBe(false);

    const enrollmentDates = await transaction
      .selectFrom('enrollment_date')
      .select(['date', 'attended'])
      .where('enrollment_id', '=', enrollment.id)
      .orderBy('date', 'asc')
      .execute();

    expect(enrollmentDates.map(row => formatDateToIso(row.date))).toEqual([
      '2026-07-01',
      '2026-07-03',
    ]);
    expect(enrollmentDates.every(row => row.attended === false)).toBe(true);

    const remainingApplicationDates = await transaction
      .selectFrom('enrollment_application_date')
      .select('id')
      .where('application_id', '=', application.id)
      .execute();

    expect(remainingApplicationDates).toEqual([]);
  });

  test('rejecting a review-based partial application deletes its requested dates', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-posting-reject@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-posting-reject@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Review Partial Attendance Rejection',
        description: 'Reject requested dates cleanly',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-08-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-08-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Available on selected days',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application_date')
      .values([
        { application_id: application.id, date: new Date('2026-08-01T00:00:00.000Z') },
        { application_id: application.id, date: new Date('2026-08-03T00:00:00.000Z') },
      ])
      .execute();

    await server
      .delete(`/organization/posting/${posting.id}/applications/${application.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const remainingApp = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('id', '=', application.id)
      .executeTakeFirst();

    const remainingDates = await transaction
      .selectFrom('enrollment_application_date')
      .select('id')
      .where('application_id', '=', application.id)
      .execute();

    expect(remainingApp).toBeUndefined();
    expect(remainingDates).toEqual([]);
  });
});

describe('Organization posting discover', () => {
  test('GET /organization/posting/discover returns active postings across organizations', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-discover-viewer@example.com' });
    const { organization: ownerOne } = await createOrganizationAccount(transaction, { email: 'org-discover-owner-1@example.com' });
    const { organization: ownerTwo } = await createOrganizationAccount(transaction, { email: 'org-discover-owner-2@example.com' });

    await transaction
      .insertInto('posting')
      .values([
        {
          organization_id: ownerOne.id,
          title: 'Discover Open Posting A',
          description: 'A posting visible to all organizations.',
          latitude: 33.9,
          longitude: 35.5,
          start_date: new Date('2026-09-01T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-09-01T00:00:00.000Z'),
          end_time: '12:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut',
        },
        {
          organization_id: ownerTwo.id,
          title: 'Discover Open Posting B',
          description: 'Another posting visible to all organizations.',
          latitude: 33.91,
          longitude: 35.51,
          start_date: new Date('2026-09-02T00:00:00.000Z'),
          start_time: '10:00:00',
          end_date: new Date('2026-09-02T00:00:00.000Z'),
          end_time: '13:00:00',
          automatic_acceptance: false,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Tripoli',
        },
        {
          organization_id: ownerTwo.id,
          title: 'Closed Posting',
          description: 'Should be hidden from discover.',
          latitude: 33.91,
          longitude: 35.51,
          start_date: new Date('2026-09-03T00:00:00.000Z'),
          start_time: '10:00:00',
          end_date: new Date('2026-09-03T00:00:00.000Z'),
          end_time: '13:00:00',
          automatic_acceptance: false,
          is_closed: true,
          allows_partial_attendance: false,
          location_name: 'Tripoli',
        },
      ])
      .execute();

    const response = await server
      .get('/organization/posting/discover')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.postings.map((posting: { title: string }) => posting.title)).toEqual(
      expect.arrayContaining(['Discover Open Posting A', 'Discover Open Posting B']),
    );
    expect(response.body.postings.map((posting: { title: string }) => posting.title)).not.toContain('Closed Posting');
    expect(response.body.postings.every((posting: { application_status: string }) => posting.application_status === 'none')).toBe(true);
  });

  test('GET /organization/posting/discover supports hide_full filter', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-discover-hide-full@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-discover-capacity-owner@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-discover-capacity@example.com' });

    const fullPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Full Discover Posting',
        description: 'Should be hidden when hide_full=true.',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
        start_date: new Date('2026-09-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-10T00:00:00.000Z'),
        end_time: '12:00:00',
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values({
        posting_id: fullPosting.id,
        volunteer_id: volunteer.id,
        attended: false,
      })
      .execute();

    const response = await server
      .get('/organization/posting/discover?hide_full=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.postings.map((posting: { id: number }) => posting.id)).not.toContain(fullPosting.id);
  });
});

describe('Organization posting management', () => {
  test('creates a posting with crisis and skills', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-create-posting@example.com' });
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Test Crisis', description: 'Test crisis', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Created Posting',
        description: 'Created with skills',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: '2026-09-01',
        start_time: '09:00:00',
        end_date: '2026-09-02',
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Create Location',
        crisis_id: crisis.id,
        skills: ['CPR', ' First Aid ', 'CPR'],
      })
      .expect(200);

    expect(response.body.posting.title).toBe('Created Posting');
    expect(response.body.posting.crisis_id).toBe(crisis.id);
    const skillNames = (response.body.skills as SkillResponseItem[]).map(skill => skill.name);
    expect(skillNames).toHaveLength(3);
    expect(skillNames).toContain('CPR');
    expect(skillNames).toContain(' First Aid ');
  });

  test('returns 400 when creating a posting with a non-existent crisis tag', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-create-posting-invalid-crisis@example.com' });

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Invalid Crisis Posting',
        description: 'Invalid crisis',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: '2026-09-01',
        start_time: '09:00:00',
        end_date: '2026-09-02',
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Invalid Location',
        crisis_id: 999999,
      })
      .expect(400);

    expect(response.body.message).toBe('Selected crisis tag does not exist');
  });

  test('updates posting skills and attaches crisis data', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-update-posting@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Update Me',
        description: 'Before update',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-10-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-10-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Update Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Update Crisis', description: 'Update crisis desc', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('posting_skill')
      .values([{ posting_id: posting.id, name: 'Old' }])
      .execute();

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Updated Posting',
        skills: ['CPR', 'Updated'],
        crisis_id: crisis.id,
      })
      .expect(200);

    expect(response.body.posting.title).toBe('Updated Posting');
    expect(response.body.crisis.id).toBe(crisis.id);
    expect((response.body.skills as SkillResponseItem[]).map(skill => skill.name).sort()).toEqual(['CPR', 'Updated']);
  });

  test('deletes a posting and removes associated enrollment rows', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-delete-posting@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-delete-posting@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Delete Me',
        description: 'To be deleted',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
        start_date: new Date('2026-11-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-11-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Delete Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        attended: true,
      })
      .execute();

    await server
      .delete(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const deletedPosting = await transaction
      .selectFrom('posting')
      .select('id')
      .where('id', '=', posting.id)
      .executeTakeFirst();

    expect(deletedPosting).toBeUndefined();
  });

  test('deleting a posting sends notification emails to enrolled volunteers', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-delete-email-posting@example.com' });
    const { volunteer: volunteerOne } = await createVolunteerAccount(transaction, {
      email: 'vol-delete-email-one@example.com',
      first_name: 'Alice',
      last_name: 'Walker',
    });
    const { volunteer: volunteerTwo } = await createVolunteerAccount(transaction, {
      email: 'vol-delete-email-two@example.com',
      first_name: 'Bob',
      last_name: 'Stone',
    });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Delete With Email Notifications',
        description: 'To be deleted with volunteer notifications',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-11-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-11-10T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Delete Email Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values([
        {
          volunteer_id: volunteerOne.id,
          posting_id: posting.id,
          attended: false,
        },
        {
          volunteer_id: volunteerTwo.id,
          posting_id: posting.id,
          attended: true,
        },
      ])
      .execute();

    const postingDeletedEmailSpy = vi.spyOn(resendEmails, 'sendPostingDeletedEmail').mockResolvedValue(undefined);

    await server
      .delete(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(postingDeletedEmailSpy).toHaveBeenCalledTimes(2);
    expect(postingDeletedEmailSpy).toHaveBeenCalledWith({
      volunteerEmail: volunteerOne.email,
      volunteerName: `${volunteerOne.first_name} ${volunteerOne.last_name}`,
      postingTitle: posting.title,
      organizationName: organization.name,
    });
    expect(postingDeletedEmailSpy).toHaveBeenCalledWith({
      volunteerEmail: volunteerTwo.email,
      volunteerName: `${volunteerTwo.first_name} ${volunteerTwo.last_name}`,
      postingTitle: posting.title,
      organizationName: organization.name,
    });

    postingDeletedEmailSpy.mockRestore();
  });

  test('returns 400 when accepting an application for an open posting', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-accept-open@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-accept-open@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Open Posting',
        description: 'Should not accept manually',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Open Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/organization/posting/${posting.id}/applications/${application.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(response.body.message).toBe('Cannot accept applications for open postings');
  });

  test('returns 403 when rejecting an application for a different posting', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-reject-mismatch@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-reject-mismatch@example.com' });

    const postingOne = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Posting One',
        description: 'Posting one',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Location One',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const postingTwo = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Posting Two',
        description: 'Posting two',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-02T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Location Two',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: postingOne.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .delete(`/organization/posting/${postingTwo.id}/applications/${application.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body.message).toBe('Application does not belong to this posting');
  });

  test('accepts a review application with no requested dates and creates all posting dates', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-accept-no-dates@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-accept-no-dates@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'No Dates Posting',
        description: 'No requested dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-12T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'No Dates Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .post(`/organization/posting/${posting.id}/applications/${application.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const enrollment = await transaction
      .selectFrom('enrollment')
      .select(['id'])
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    const dates = await transaction
      .selectFrom('enrollment_date')
      .select('date')
      .where('enrollment_id', '=', enrollment.id)
      .orderBy('date', 'asc')
      .execute();

    expect(dates.map(row => formatDateToIso(row.date))).toEqual(['2026-12-10', '2026-12-11', '2026-12-12']);
  });

  test('GET /organization/posting with filters and title sort returns the expected posting', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-list-filter@example.com' });
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'List Crisis', description: 'Filter crisis', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Other Posting',
        description: 'Other event',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-01T00:00:00.000Z'),
        start_time: '08:00:00',
        end_date: new Date('2026-09-01T00:00:00.000Z'),
        end_time: '16:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: true,
        allows_partial_attendance: false,
        location_name: 'Other Location',
      })
      .execute();

    const expectedPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Searchable Posting',
        description: 'Search match',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-02T00:00:00.000Z'),
        start_time: '09:30:00',
        end_date: new Date('2026-09-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Search Location',
        crisis_id: crisis.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get('/organization/posting')
      .query({
        search: 'Searchable',
        is_closed: 'false',
        automatic_acceptance: 'false',
        crisis_id: String(crisis.id),
        sortBy: 'title',
        sortDir: 'desc',
        start_date_from: '2026-09-02',
        end_date_to: '2026-09-02',
        start_time_from: '09:00:00',
        end_time_to: '18:00:00',
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.postings).toHaveLength(1);
    expect(response.body.postings[0].id).toBe(expectedPosting.id);
    expect(response.body.postings[0].title).toBe('Searchable Posting');
  });

  test('GET /organization/posting supports posting_filter and hide_full', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-list-posting-filter@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-listing-vol@example.com' });
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Filter Crisis', description: 'Filter crisis', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Open Posting',
        description: 'Open posting example',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-04T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-04T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Open Location',
      })
      .execute();

    const fullPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Full Posting',
        description: 'Full posting example',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
        start_date: new Date('2026-09-05T00:00:00.000Z'),
        start_time: '10:00:00',
        end_date: new Date('2026-09-05T00:00:00.000Z'),
        end_time: '18:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Full Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: fullPosting.id,
        attended: false,
      })
      .execute();

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Tagged Partial Posting',
        description: 'Tagged partial posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-06T00:00:00.000Z'),
        start_time: '11:00:00',
        end_date: new Date('2026-09-06T00:00:00.000Z'),
        end_time: '19:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Tagged Location',
        crisis_id: crisis.id,
      })
      .execute();

    const openResponse = await server
      .get('/organization/posting')
      .query({ posting_filter: 'open' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(openResponse.body.postings.map((posting: { title: string }) => posting.title)).toEqual(
      expect.arrayContaining(['Open Posting', 'Full Posting']),
    );
    expect(openResponse.body.postings.some((posting: { title: string }) => posting.title === 'Tagged Partial Posting')).toBe(false);

    const hideFullResponse = await server
      .get('/organization/posting')
      .query({ posting_filter: 'open', hide_full: 'true' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(hideFullResponse.body.postings.map((posting: { title: string }) => posting.title)).toEqual(['Open Posting']);
  });

  test('GET /organization/posting/:id returns posting with crisis and skills', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-get-posting@example.com' });
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Detail Crisis', description: 'Detail crisis', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Detail Posting',
        description: 'Has crisis',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-03T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Detail Location',
        crisis_id: crisis.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('posting_skill')
      .values({ posting_id: posting.id, name: 'Detail Skill' })
      .execute();

    const response = await server
      .get(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.posting.id).toBe(posting.id);
    expect(response.body.crisis.id).toBe(crisis.id);
    expect(response.body.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ posting_id: posting.id, name: 'Detail Skill' }),
    ]));
  });

  test('GET /organization/posting/:id allows organizations to view other organizations postings', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-get-foreign-posting-viewer@example.com' });
    const { organization: ownerOrganization } = await createOrganizationAccount(transaction, { email: 'org-get-foreign-posting-owner@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: ownerOrganization.id,
        title: 'Foreign Posting',
        description: 'Visible for other organizations in read-only mode.',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 5,
        start_date: new Date('2026-09-06T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-06T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Foreign Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.posting.id).toBe(posting.id);
    expect(response.body.posting.organization_id).toBe(ownerOrganization.id);
  });

  test('GET /organization/posting/:id returns 404 when posting is missing', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-posting-missing-get@example.com' });

    await server
      .get('/organization/posting/999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  test('GET /organization/posting/:id/enrollments returns enrollments for a posting', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-get-enrollments@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-get-enrollments@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Enrollments Posting',
        description: 'Enrollment list',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-04T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-04T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Enrollments Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id, attended: false })
      .execute();

    const response = await server
      .get(`/organization/posting/${posting.id}/enrollments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.enrollments).toHaveLength(1);
    expect(response.body.enrollments[0].volunteer_id).toBe(volunteer.id);
  });

  test('GET /organization/posting/:id/applications returns empty array for automatic acceptance postings', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-open-apps@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Open Apps Posting',
        description: 'Open acceptance',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-09-05T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-09-05T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Open Apps Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/organization/posting/${posting.id}/applications`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.applications).toEqual([]);
  });

  test('PUT /organization/posting/:id returns 404 when posting is missing', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-posting-missing-update@example.com' });

    await server
      .put('/organization/posting/999999')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Missing' })
      .expect(404);
  });

  test('DELETE /organization/posting/:id returns 404 when posting is missing', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-posting-missing-delete@example.com' });

    await server
      .delete('/organization/posting/999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  test('accepting an application on the wrong posting returns 403', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-accept-mismatch@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-accept-mismatch@example.com' });
    const postingOne = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Posting One',
        description: 'One',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-10T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'One',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const postingTwo = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Posting Two',
        description: 'Two',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-11T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-11T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Two',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: postingOne.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/organization/posting/${postingTwo.id}/applications/${application.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body.message).toBe('Application does not belong to this posting');
  });

  test('returns 403 when accepting an application for a posting that has already ended', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-accept-ended@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-accept-ended@example.com' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Review Posting',
        description: 'Should reject acceptance after end time',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: yesterday,
        start_time: '09:00:00',
        end_date: yesterday,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Ended Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const application = await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/organization/posting/${posting.id}/applications/${application.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body.message).toBe('This posting has ended');

    const enrollment = await transaction
      .selectFrom('enrollment')
      .select('id')
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', volunteer.id)
      .executeTakeFirst();

    expect(enrollment).toBeUndefined();
  });

  test('returns 403 when changing closed state for a posting that has already ended', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-ended-closed-update@example.com' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Closed Toggle Posting',
        description: 'Closed state should not change after end',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: yesterday,
        start_time: '09:00:00',
        end_date: yesterday,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Ended Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_closed: true })
      .expect(403);

    expect(response.body.message).toBe('Cannot change posting availability after it has ended');

    const updatedPosting = await transaction
      .selectFrom('posting')
      .select('is_closed')
      .where('id', '=', posting.id)
      .executeTakeFirstOrThrow();

    expect(updatedPosting.is_closed).toBe(false);
  });

  test('returns 403 when changing schedule fields for a posting that has already ended', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-ended-schedule-update@example.com' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Schedule Update Posting',
        description: 'Schedule should not change after end',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: yesterday,
        start_time: '09:00:00',
        end_date: yesterday,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Ended Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ end_time: '18:00:00' })
      .expect(403);

    expect(response.body.message).toBe('Cannot change posting availability after it has ended');

    const updatedPosting = await transaction
      .selectFrom('posting')
      .select('end_time')
      .where('id', '=', posting.id)
      .executeTakeFirstOrThrow();

    expect(updatedPosting.end_time).toBe('17:00:00');
  });

  test('returns 400 when creating a posting with a past start date', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-past-start@example.com' });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Past Start Posting',
        description: 'Should fail',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: formatDateToIso(yesterday),
        start_time: '09:00:00',
        end_date: '2026-12-01',
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Past Location',
        crisis_id: null,
      })
      .expect(400);

    expect(response.body.message).toBe('Start date cannot be in the past');
  });

  test('returns 400 when creating a posting with a past end date', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-past-end@example.com' });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Past End Posting',
        description: 'Should fail',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: formatDateToIso(new Date()),
        start_time: '09:00:00',
        end_date: formatDateToIso(yesterday),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Past Location',
        crisis_id: null,
      })
      .expect(400);

    expect(response.body.message).toBe('End date cannot be in the past');
  });

  test('allows creating a posting with today as the start date', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-today-date@example.com' });

    const today = formatDateToIso(new Date());

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Today Posting',
        description: 'Should succeed',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: today,
        start_time: '23:59:00',
        end_date: today,
        end_time: '23:59:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Today Location',
        crisis_id: null,
      })
      .expect(200);

    expect(response.body.posting.title).toBe('Today Posting');
  });

  test('returns 400 when creating a posting with today start date but past start time', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-past-time-create@example.com' });

    const today = formatDateToIso(new Date());

    const response = await server
      .post('/organization/posting')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Past Time Posting',
        description: 'Should fail',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: today,
        start_time: '00:00:00',
        end_date: today,
        end_time: '23:59:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Past Time Location',
        crisis_id: null,
      })
      .expect(400);

    expect(response.body.message).toBe('Start time cannot be in the past');
  });

  test('returns 400 when updating a posting start time to a past time on today', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-past-time-update@example.com' });

    const today = new Date();
    const todayIso = formatDateToIso(today);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Today Posting',
        description: 'Will update time',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: today,
        start_time: '23:59:00',
        end_date: today,
        end_time: '23:59:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Update Time Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ start_date: todayIso, start_time: '00:00:00' })
      .expect(400);

    expect(response.body.message).toBe('Start time cannot be in the past');
  });

  test('returns 400 when updating a posting with a new past start date', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-update-past@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Future Posting',
        description: 'Will try past update',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Update Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ start_date: formatDateToIso(yesterday) })
      .expect(400);

    expect(response.body.message).toBe('Start date cannot be in the past');
  });

  test('returns 400 when updating a posting with a new past end date', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-update-past-end@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Future Posting',
        description: 'Will try past end update',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-12-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-12-02T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Update Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ end_date: formatDateToIso(yesterday) })
      .expect(400);

    expect(response.body.message).toBe('End date cannot be in the past');
  });

  test('allows updating a posting without changing its existing past dates', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-update-keep-past@example.com' });

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Old Posting',
        description: 'Has past dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: pastDate,
        start_time: '09:00:00',
        end_date: pastDate,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Past Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .put(`/organization/posting/${posting.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Updated Title Only',
        start_date: formatDateToIso(pastDate),
        end_date: formatDateToIso(pastDate),
      })
      .expect(200);

    expect(response.body.posting.title).toBe('Updated Title Only');
  });
});
