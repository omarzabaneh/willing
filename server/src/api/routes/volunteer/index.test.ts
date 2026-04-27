import { sql, type ControlledTransaction } from 'kysely';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import createApp from '../../../app.ts';
import database from '../../../db/index.ts';
import { compare } from '../../../services/bcrypt/index.ts';
import * as embeddingUpdates from '../../../services/embeddings/updates.ts';
import * as jwtService from '../../../services/jwt/index.ts';
import * as emailService from '../../../services/resend/emails.ts';
import * as volunteerService from '../../../services/volunteer/index.ts';
import { createAdminAccount, createOrganizationAccount, createVolunteerAccount } from '../../../tests/fixtures/accounts.ts';
import { createOrganizationRequest } from '../../../tests/fixtures/organizationData.ts';

import type { Database } from '../../../db/tables/index.ts';
import type { VolunteerProfileData } from '../../../services/volunteer/index.ts';
import type TestAgent from 'supertest/lib/agent.js';

let transaction: ControlledTransaction<Database>;
let server: TestAgent;

const formatDateToIso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const generateJWTSpy = vi
  .spyOn(jwtService, 'generateJWT');
const sendVolunteerVerificationEmailSpy = vi
  .spyOn(emailService, 'sendVolunteerVerificationEmail')
  .mockResolvedValue(undefined);

beforeEach(async () => {
  transaction = await database.startTransaction().execute();
  server = supertest(createApp(transaction));
});

afterEach(async () => {
  await transaction.rollback().execute();
  generateJWTSpy.mockClear();
  sendVolunteerVerificationEmailSpy.mockClear();
});

describe('POST /volunteer/create', () => {
  test('returns 409 if email is used by another volunteer', async () => {
    const { volunteer } = await createVolunteerAccount(transaction);

    await server
      .post('/volunteer/create')
      .send({
        password: 'TestPassword123!',
        email: volunteer.email,
        gender: 'male',
        first_name: 'test',
        last_name: 'test',
        date_of_birth: new Date(),
      })
      .expect(409);

    const volunteersNumber = await transaction
      .selectFrom('volunteer_account')
      .select(({ fn }) => fn.count('id').as('volunteer_count'))
      .executeTakeFirst();

    const pendingVolunteersNumber = await transaction
      .selectFrom('volunteer_pending_account')
      .select(({ fn }) => fn.count('id').as('pending_volunteer_count'))
      .executeTakeFirst();

    expect(volunteersNumber?.volunteer_count).toBe('1');
    expect(pendingVolunteersNumber?.pending_volunteer_count).toBe('0');
    expect(sendVolunteerVerificationEmailSpy).not.toHaveBeenCalled();
  });

  test('returns 409 if email is used in organization request', async () => {
    const request = await createOrganizationRequest(transaction);

    await server
      .post('/volunteer/create')
      .send({
        password: 'TestPassword123!',
        email: request.email,
        gender: 'male',
        first_name: 'test',
        last_name: 'test',
        date_of_birth: new Date(),
      })
      .expect(409);

    const [{ volunteer_count }, { organization_request_count }, { pending_volunteer_count }] = await Promise.all([
      transaction
        .selectFrom('volunteer_account')
        .select(({ fn }) => fn.count('id').as('volunteer_count'))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom('organization_request')
        .select(({ fn }) => fn.count('id').as('organization_request_count'))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom('volunteer_pending_account')
        .select(({ fn }) => fn.count('id').as('pending_volunteer_count'))
        .executeTakeFirstOrThrow(),
    ]);

    expect(volunteer_count).toBe('0');
    expect(organization_request_count).toBe('1');
    expect(pending_volunteer_count).toBe('0');
    expect(sendVolunteerVerificationEmailSpy).not.toHaveBeenCalled();
  });

  test('returns 409 if email is used by an organization', async () => {
    const { organization } = await createOrganizationAccount(transaction);

    await server
      .post('/volunteer/create')
      .send({
        password: 'TestPassword123!',
        email: organization.email,
        gender: 'male',
        first_name: 'test',
        last_name: 'test',
        date_of_birth: new Date(),
      })
      .expect(409);

    const [{ volunteer_count }, { organization_count }, { pending_volunteer_count }] = await Promise.all([
      transaction
        .selectFrom('volunteer_account')
        .select(({ fn }) => fn.count('id').as('volunteer_count'))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom('organization_account')
        .select(({ fn }) => fn.count('id').as('organization_count'))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom('volunteer_pending_account')
        .select(({ fn }) => fn.count('id').as('pending_volunteer_count'))
        .executeTakeFirstOrThrow(),
    ]);

    expect(volunteer_count).toBe('0');
    expect(organization_count).toBe('1');
    expect(pending_volunteer_count).toBe('0');
    expect(sendVolunteerVerificationEmailSpy).not.toHaveBeenCalled();
  });

  test('returns 200, creates a pending volunteer, and sends verification email', async () => {
    const response = await server
      .post('/volunteer/create')
      .send({
        password: 'TestPassword123!',
        email: 'volunteer@willing.social',
        gender: 'male',
        first_name: 'John',
        last_name: 'Doe',
        date_of_birth: '2000-01-01',
      })
      .expect(200);

    expect(response.body).toEqual({ requires_email_verification: true });
    expect(generateJWTSpy).not.toHaveBeenCalled();
    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledTimes(1);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .selectAll()
      .where('email', '=', 'volunteer@willing.social')
      .executeTakeFirstOrThrow();

    expect(pendingVolunteer.first_name).toBe('John');
    expect(pendingVolunteer.last_name).toBe('Doe');
    expect(pendingVolunteer.password).not.toBe('TestPassword123!');
    expect(pendingVolunteer.token.length).toBeGreaterThan(0);

    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledWith({
      volunteerEmail: 'volunteer@willing.social',
      volunteerName: 'John Doe',
      verificationToken: pendingVolunteer.token,
    });

    const [volunteerCountRow, pendingVolunteerCountRow] = await Promise.all([
      transaction
        .selectFrom('volunteer_account')
        .select(({ fn }) => fn.count('id').as('volunteer_count'))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom('volunteer_pending_account')
        .select(({ fn }) => fn.count('id').as('pending_volunteer_count'))
        .executeTakeFirstOrThrow(),
    ]);

    expect(volunteerCountRow.volunteer_count).toBe('0');
    expect(pendingVolunteerCountRow.pending_volunteer_count).toBe('1');
  });

  test('replaces existing pending volunteer entry for same email', async () => {
    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Old',
        last_name: 'User',
        password: 'old-hash',
        email: 'pending@willing.social',
        gender: 'male',
        date_of_birth: new Date('1999-01-01T00:00:00.000Z'),
        token: 'old-token',
      })
      .execute();

    await server
      .post('/volunteer/create')
      .send({
        password: 'TestPassword123!',
        email: 'pending@willing.social',
        gender: 'female',
        first_name: 'New',
        last_name: 'User',
        date_of_birth: '2001-02-03',
      })
      .expect(200);

    const pendingVolunteers = await transaction
      .selectFrom('volunteer_pending_account')
      .selectAll()
      .where('email', '=', 'pending@willing.social')
      .execute();

    expect(pendingVolunteers).toHaveLength(1);
    expect(pendingVolunteers[0]!.first_name).toBe('New');
    expect(pendingVolunteers[0]!.last_name).toBe('User');
    expect(pendingVolunteers[0]!.gender).toBe('female');
    expect(pendingVolunteers[0]!.token).not.toBe('old-token');
    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledTimes(1);
  });
});
describe('POST /volunteer/verify-email', () => {
  test('returns 400 for an invalid verification token', async () => {
    await server
      .post('/volunteer/verify-email')
      .send({ key: 'invalid-token' })
      .expect(400);
  });

  test('returns 400 and keeps pending account when token is expired', async () => {
    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Expired',
        last_name: 'Token',
        password: 'hashed-password',
        email: 'expired-token@example.com',
        gender: 'male',
        date_of_birth: new Date('2000-01-01T00:00:00.000Z'),
        token: 'expired-token',
        created_at: sql`now() - interval '2 hours'`,
      })
      .execute();

    await server
      .post('/volunteer/verify-email')
      .send({ key: 'expired-token' })
      .expect(400);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .select('id')
      .where('email', '=', 'expired-token@example.com')
      .executeTakeFirst();

    expect(pendingVolunteer).not.toBeUndefined();
    expect(generateJWTSpy).not.toHaveBeenCalled();
  });

  test('returns 200 and logs volunteer in when account already exists', async () => {
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'existing-verify@example.com' });
    generateJWTSpy.mockClear();

    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
        password: 'hashed-password',
        email: volunteer.email,
        gender: volunteer.gender,
        date_of_birth: new Date(volunteer.date_of_birth),
        token: 'existing-token',
      })
      .execute();

    const response = await server
      .post('/volunteer/verify-email')
      .send({ key: 'existing-token' })
      .expect(200);

    expect(response.body.volunteer.email).toBe(volunteer.email);
    expect(typeof response.body.token).toBe('string');
    expect(generateJWTSpy).toHaveBeenCalledTimes(1);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .select('id')
      .where('email', '=', volunteer.email)
      .executeTakeFirst();

    expect(pendingVolunteer).not.toBeUndefined();
  });

  test('returns 409 and removes pending account when email belongs to an organization', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-existing-verify@example.com' });
    generateJWTSpy.mockClear();

    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Org',
        last_name: 'Conflict',
        password: 'hashed-password',
        email: organization.email,
        gender: 'male',
        date_of_birth: new Date('2000-01-01T00:00:00.000Z'),
        token: 'org-existing-token',
      })
      .execute();

    await server
      .post('/volunteer/verify-email')
      .send({ key: 'org-existing-token' })
      .expect(409);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .select('id')
      .where('email', '=', organization.email)
      .executeTakeFirst();

    expect(pendingVolunteer).toBeUndefined();
    expect(generateJWTSpy).not.toHaveBeenCalled();
  });

  test('returns 200, creates volunteer account, and returns jwt token', async () => {
    const recomputeProfileSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerProfileVector')
      .mockResolvedValue(null);
    const recomputeExperienceSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerExperienceVector')
      .mockResolvedValue(null);

    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Verified',
        last_name: 'Volunteer',
        password: 'hashed-password',
        email: 'verify-success@example.com',
        gender: 'female',
        date_of_birth: new Date('2002-05-06T00:00:00.000Z'),
        token: 'valid-token',
      })
      .execute();

    const response = await server
      .post('/volunteer/verify-email')
      .send({ key: 'valid-token' })
      .expect(200);

    expect(response.body.volunteer.email).toBe('verify-success@example.com');
    expect(response.body.volunteer.password).toBeUndefined();
    expect(response.body.volunteer.volunteer_profile_vector).toBeUndefined();
    expect(response.body.volunteer.volunteer_history_vector).toBeUndefined();
    expect(typeof response.body.token).toBe('string');

    expect(generateJWTSpy).toHaveBeenCalledWith({
      id: response.body.volunteer.id,
      role: 'volunteer',
      token_version: 0,
    });
    expect(recomputeProfileSpy).toHaveBeenCalledWith(response.body.volunteer.id, transaction);
    expect(recomputeExperienceSpy).toHaveBeenCalledWith(response.body.volunteer.id, transaction);

    const volunteer = await transaction
      .selectFrom('volunteer_account')
      .selectAll()
      .where('email', '=', 'verify-success@example.com')
      .executeTakeFirst();

    expect(volunteer).not.toBeUndefined();

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .selectAll()
      .where('email', '=', 'verify-success@example.com')
      .executeTakeFirst();

    expect(pendingVolunteer).not.toBeUndefined();

    recomputeProfileSpy.mockRestore();
    recomputeExperienceSpy.mockRestore();
  });

  test('returns 200 and logs volunteer in when verification link is reused', async () => {
    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Replay',
        last_name: 'Volunteer',
        password: 'hashed-password',
        email: 'replay-verify@example.com',
        gender: 'female',
        date_of_birth: new Date('2001-05-06T00:00:00.000Z'),
        token: 'reused-valid-token',
      })
      .execute();

    await server
      .post('/volunteer/verify-email')
      .send({ key: 'reused-valid-token' })
      .expect(200);

    generateJWTSpy.mockClear();

    const secondResponse = await server
      .post('/volunteer/verify-email')
      .send({ key: 'reused-valid-token' })
      .expect(200);

    expect(secondResponse.body.volunteer.email).toBe('replay-verify@example.com');
    expect(typeof secondResponse.body.token).toBe('string');
    expect(generateJWTSpy).toHaveBeenCalledTimes(1);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .select('id')
      .where('email', '=', 'replay-verify@example.com')
      .executeTakeFirst();

    expect(pendingVolunteer).not.toBeUndefined();
  });
});
describe('POST /volunteer/resend-verification', () => {
  test('returns 200, creates pending token, and resends email when account is already verified', async () => {
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'resend-existing@example.com' });

    const response = await server
      .post('/volunteer/resend-verification')
      .send({ email: volunteer.email })
      .expect(200);

    expect(response.body).toEqual({});
    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledTimes(1);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .selectAll()
      .where('email', '=', volunteer.email)
      .executeTakeFirstOrThrow();

    expect(pendingVolunteer.token.length).toBeGreaterThan(0);
    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledWith({
      volunteerEmail: volunteer.email,
      volunteerName: `${volunteer.first_name} ${volunteer.last_name}`,
      verificationToken: pendingVolunteer.token,
    });
  });

  test('returns 200 and does nothing when pending volunteer is not found', async () => {
    const response = await server
      .post('/volunteer/resend-verification')
      .send({ email: 'missing-pending@example.com' })
      .expect(200);

    expect(response.body).toEqual({});
    expect(sendVolunteerVerificationEmailSpy).not.toHaveBeenCalled();
  });

  test('returns 200, rotates pending token, and resends verification email', async () => {
    const oldCreatedAt = new Date('2025-01-01T00:00:00.000Z');

    await transaction
      .insertInto('volunteer_pending_account')
      .values({
        first_name: 'Resend',
        last_name: 'Volunteer',
        password: 'hashed-password',
        email: 'resend@example.com',
        gender: 'male',
        date_of_birth: new Date('2001-07-08T00:00:00.000Z'),
        token: 'old-token',
        created_at: oldCreatedAt,
      })
      .execute();

    const response = await server
      .post('/volunteer/resend-verification')
      .send({ email: 'resend@example.com' })
      .expect(200);

    expect(response.body).toEqual({});
    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledTimes(1);

    const pendingVolunteer = await transaction
      .selectFrom('volunteer_pending_account')
      .selectAll()
      .where('email', '=', 'resend@example.com')
      .executeTakeFirstOrThrow();

    expect(pendingVolunteer.token).not.toBe('old-token');
    expect(pendingVolunteer.created_at.getTime()).toBeGreaterThan(oldCreatedAt.getTime());

    expect(sendVolunteerVerificationEmailSpy).toHaveBeenCalledWith({
      volunteerEmail: 'resend@example.com',
      volunteerName: 'Resend Volunteer',
      verificationToken: pendingVolunteer.token,
    });
  });
});

describe('GET /volunteer/me', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .get('/volunteer/me')
      .expect(403);
  });

  test('returns 403 when logged in as organization', async () => {
    const { token: orgToken } = await createOrganizationAccount(transaction);

    await server
      .get('/volunteer/me')
      .set('Authorization', 'Bearer ' + orgToken)
      .expect(403);
  });

  test('returns 403 when logged in as admin', async () => {
    const { token: adminToken } = await createAdminAccount(transaction);

    await server
      .get('/volunteer/me')
      .set('Authorization', 'Bearer ' + adminToken)
      .expect(403);
  });

  test('returns 200 with the currently logged in volunteer', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction);

    const response = await server
      .get('/volunteer/me')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body).toMatchObject({
      volunteer: {
        email: volunteer.email,
      },
    });
  });
});

describe('GET /volunteer/profile', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .get('/volunteer/profile')
      .expect(403);
  });

  test('returns 403 when logged in as organization', async () => {
    const { token: orgToken } = await createOrganizationAccount(transaction);

    await server
      .get('/volunteer/profile')
      .set('Authorization', 'Bearer ' + orgToken)
      .expect(403);
  });

  test('returns 403 when logged in as admin', async () => {
    const { token: adminToken } = await createAdminAccount(transaction);

    await server
      .get('/volunteer/profile')
      .set('Authorization', 'Bearer ' + adminToken)
      .expect(403);
  });

  test('returns profile data for the current volunteer', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction);

    const profileData: VolunteerProfileData = {
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
        email: volunteer.email,
        date_of_birth: volunteer.date_of_birth,
        gender: volunteer.gender,
        cv_path: 'uploads/cv.pdf',
        description: 'Ready to lend a hand',
      },
      skills: ['First Aid', 'CPR'],
      experience_stats: {
        total_completed_experiences: 2,
        organizations_supported: 2,
        crisis_related_experiences: 1,
        total_hours_completed: 12,
        total_skills_used: 4,
        most_volunteered_crisis: 'Winter Storm',
      },
      completed_experiences: [
        {
          enrollment_id: 101,
          posting_id: 202,
          posting_title: 'Food Drive',
          organization_id: 303,
          organization_name: 'Helping Hands',
          organization_logo_path: null,
          location_name: 'Community Center',
          start_date: new Date('2025-01-15T00:00:00.000Z'),
          start_time: '08:00:00',
          end_date: new Date('2025-01-15T00:00:00.000Z'),
          end_time: '12:00:00',
          crisis_name: null,
          is_closed: false,
          automatic_acceptance: true,
          enrollment_count: 12,
        },
      ],
    };

    const getVolunteerProfileSpy = vi
      .spyOn(volunteerService, 'getVolunteerProfile')
      .mockResolvedValue(profileData);

    const response = await server
      .get('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(getVolunteerProfileSpy).toHaveBeenCalledWith(volunteer.id);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(profileData)));

    getVolunteerProfileSpy.mockRestore();
  });
});

describe('GET /volunteer/certificate', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .get('/volunteer/certificate')
      .expect(403);
  });

  test('returns total hours, organization eligibility, and platform certificate info', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-volunteer@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'certificate-org@example.com' });

    const certificateInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        certificate_feature_enabled: true,
        hours_threshold: 3,
        signatory_name: 'Org Signatory',
        signatory_position: 'Director',
        signature_path: 'uploads/org-signature.png',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: certificateInfo.id })
      .where('id', '=', organization.id)
      .execute();

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Relief Packing',
        description: 'Prepare family food boxes',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-02-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-02-01T00:00:00.000Z'),
        end_time: '13:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const enrollment = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        attended: true,
        created_at: new Date('2026-02-02T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values({
        enrollment_id: enrollment.id,
        posting_id: posting.id,
        date: new Date('2026-02-01T00:00:00.000Z'),
        attended: true,
      })
      .execute();

    await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Old Signatory',
        signatory_position: 'Legacy Lead',
        signature_path: 'uploads/old-platform.png',
        signature_uploaded_by_admin_id: null,
        created_at: new Date('2026-01-04T00:00:00.000Z'),
        updated_at: new Date('2026-01-04T00:00:00.000Z'),
      })
      .execute();

    const latestPlatform = await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Platform Lead',
        signatory_position: 'Coordinator',
        signature_path: 'uploads/platform.png',
        signature_uploaded_by_admin_id: null,
        created_at: new Date('2026-01-05T00:00:00.000Z'),
        updated_at: new Date('2026-01-05T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get('/volunteer/certificate')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body).toMatchObject({
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
      },
      total_hours: 4,
      platform_certificate: {
        signatory_name: latestPlatform.signatory_name,
        signatory_position: latestPlatform.signatory_position,
        signature_path: latestPlatform.signature_path,
      },
    });

    expect(response.body.organizations).toHaveLength(1);
    expect(response.body.organizations[0]).toEqual({
      id: organization.id,
      name: organization.name,
      hours: 4,
      hours_threshold: 3,
      certificate_feature_enabled: true,
      is_disabled: false,
      is_deleted: false,
      eligible: true,
      logo_path: null,
      signatory_name: 'Org Signatory',
      signatory_position: 'Director',
      signature_path: 'uploads/org-signature.png',
    });
  });

  test('counts only attended days for partial attendance postings on the volunteer certificate', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-partial@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'certificate-partial-org@example.com' });

    const certificateInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        certificate_feature_enabled: true,
        hours_threshold: 3,
        signatory_name: 'Org Signatory',
        signatory_position: 'Director',
        signature_path: 'uploads/org-signature.png',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: certificateInfo.id })
      .where('id', '=', organization.id)
      .execute();

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Shift',
        description: 'Partial attendance event',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-03-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-03-03T00:00:00.000Z'),
        end_time: '13:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-02-01T00:00:00.000Z'),
        updated_at: new Date('2026-02-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const enrollment = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        attended: true,
        created_at: new Date('2026-03-02T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values([
        {
          enrollment_id: enrollment.id,
          posting_id: posting.id,
          date: new Date('2026-03-01T00:00:00.000Z'),
          attended: true,
        },
        {
          enrollment_id: enrollment.id,
          posting_id: posting.id,
          date: new Date('2026-03-02T00:00:00.000Z'),
          attended: false,
        },
        {
          enrollment_id: enrollment.id,
          posting_id: posting.id,
          date: new Date('2026-03-03T00:00:00.000Z'),
          attended: false,
        },
      ])
      .execute();

    await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Platform Lead',
        signatory_position: 'Coordinator',
        signature_path: 'uploads/platform.png',
        signature_uploaded_by_admin_id: null,
        created_at: new Date('2026-02-02T00:00:00.000Z'),
        updated_at: new Date('2026-02-02T00:00:00.000Z'),
      })
      .execute();

    const response = await server
      .get('/volunteer/certificate')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.total_hours).toBe(4);
    expect(response.body.organizations).toHaveLength(1);
    expect(response.body.organizations[0]).toMatchObject({
      id: organization.id,
      hours: 4,
    });
  });

  test('returns empty organizations and null platform certificate when no certificate data exists', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-empty@example.com' });

    const response = await server
      .get('/volunteer/certificate')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body).toMatchObject({
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
      },
      total_hours: 0,
      organizations: [],
      platform_certificate: null,
    });
  });

  test('includes disabled and deleted organizations in certificate list as unselectable while all hours count toward total', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-org-status@example.com' });
    const { organization: activeOrg } = await createOrganizationAccount(transaction, { email: 'certificate-active-org@example.com' });
    const { organization: disabledOrg } = await createOrganizationAccount(transaction, { email: 'certificate-disabled-org@example.com' });
    const { organization: deletedOrg } = await createOrganizationAccount(transaction, { email: 'certificate-deleted-org@example.com' });

    const certificateInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        certificate_feature_enabled: true,
        hours_threshold: 1,
        signatory_name: 'Org Signatory',
        signatory_position: 'Director',
        signature_path: 'uploads/org-signature.png',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: certificateInfo.id })
      .where('id', 'in', [activeOrg.id, disabledOrg.id, deletedOrg.id])
      .execute();

    await transaction
      .updateTable('organization_account')
      .set({ is_disabled: true })
      .where('id', '=', disabledOrg.id)
      .execute();

    await transaction
      .updateTable('organization_account')
      .set({ is_deleted: true })
      .where('id', '=', deletedOrg.id)
      .execute();

    const createPostingForOrg = async (organizationId: number, title: string) => transaction
      .insertInto('posting')
      .values({
        organization_id: organizationId,
        title,
        description: 'Certificate status test posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-02-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-02-01T00:00:00.000Z'),
        end_time: '11:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const activePosting = await createPostingForOrg(activeOrg.id, 'Active Org Posting');
    const disabledPosting = await createPostingForOrg(disabledOrg.id, 'Disabled Org Posting');
    const deletedPosting = await createPostingForOrg(deletedOrg.id, 'Deleted Org Posting');

    const enrollments = await transaction
      .insertInto('enrollment')
      .values([
        {
          volunteer_id: volunteer.id,
          posting_id: activePosting.id,
          attended: true,
          created_at: new Date('2026-02-02T00:00:00.000Z'),
        },
        {
          volunteer_id: volunteer.id,
          posting_id: disabledPosting.id,
          attended: true,
          created_at: new Date('2026-02-02T00:00:00.000Z'),
        },
        {
          volunteer_id: volunteer.id,
          posting_id: deletedPosting.id,
          attended: true,
          created_at: new Date('2026-02-02T00:00:00.000Z'),
        },
      ])
      .returningAll()
      .execute();

    await transaction
      .insertInto('enrollment_date')
      .values([
        {
          enrollment_id: enrollments[0]!.id,
          posting_id: activePosting.id,
          date: new Date('2026-02-01T00:00:00.000Z'),
          attended: true,
        },
        {
          enrollment_id: enrollments[1]!.id,
          posting_id: disabledPosting.id,
          date: new Date('2026-02-01T00:00:00.000Z'),
          attended: true,
        },
        {
          enrollment_id: enrollments[2]!.id,
          posting_id: deletedPosting.id,
          date: new Date('2026-02-01T00:00:00.000Z'),
          attended: true,
        },
      ])
      .execute();

    const response = await server
      .get('/volunteer/certificate')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.total_hours).toBe(6);
    expect(response.body.organizations).toHaveLength(3);
    expect(response.body.organizations[0]).toMatchObject({
      id: activeOrg.id,
      name: activeOrg.name,
      hours: 2,
      is_disabled: false,
      is_deleted: false,
      eligible: true,
    });
    expect(response.body.organizations[1]).toMatchObject({
      id: disabledOrg.id,
      name: disabledOrg.name,
      hours: 2,
      is_disabled: true,
      is_deleted: false,
      eligible: false,
    });
    expect(response.body.organizations[2]).toMatchObject({
      id: deletedOrg.id,
      name: deletedOrg.name,
      hours: 2,
      is_disabled: false,
      is_deleted: true,
      eligible: false,
    });
  });

  test('sorts certificate organizations with certificate-enabled organizations first, then by hours', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-sorting-volunteer@example.com' });
    const { organization: certificateEnabledOrg } = await createOrganizationAccount(transaction, { email: 'certificate-sorting-enabled@example.com' });
    const { organization: certificateDisabledOrg } = await createOrganizationAccount(transaction, { email: 'certificate-sorting-disabled@example.com' });

    const enabledInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        certificate_feature_enabled: true,
        hours_threshold: 1,
        signatory_name: 'Enabled Signatory',
        signatory_position: 'Director',
        signature_path: 'uploads/enabled-signature.png',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const disabledInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        certificate_feature_enabled: false,
        hours_threshold: 1,
        signatory_name: 'Disabled Signatory',
        signatory_position: 'Director',
        signature_path: 'uploads/disabled-signature.png',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: enabledInfo.id })
      .where('id', '=', certificateEnabledOrg.id)
      .execute();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: disabledInfo.id })
      .where('id', '=', certificateDisabledOrg.id)
      .execute();

    const enabledPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: certificateEnabledOrg.id,
        title: 'Certificate Enabled Posting',
        description: 'Enabled org posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-03-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-03-01T00:00:00.000Z'),
        end_time: '10:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-02-01T00:00:00.000Z'),
        updated_at: new Date('2026-02-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const disabledPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: certificateDisabledOrg.id,
        title: 'Certificate Disabled Posting',
        description: 'Disabled org posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-03-02T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-03-02T00:00:00.000Z'),
        end_time: '13:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-02-01T00:00:00.000Z'),
        updated_at: new Date('2026-02-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const enrollments = await transaction
      .insertInto('enrollment')
      .values([
        {
          volunteer_id: volunteer.id,
          posting_id: enabledPosting.id,
          attended: true,
          created_at: new Date('2026-03-03T00:00:00.000Z'),
        },
        {
          volunteer_id: volunteer.id,
          posting_id: disabledPosting.id,
          attended: true,
          created_at: new Date('2026-03-03T00:00:00.000Z'),
        },
      ])
      .returningAll()
      .execute();

    await transaction
      .insertInto('enrollment_date')
      .values([
        {
          enrollment_id: enrollments[0]!.id,
          posting_id: enabledPosting.id,
          date: new Date('2026-03-01T00:00:00.000Z'),
          attended: true,
        },
        {
          enrollment_id: enrollments[1]!.id,
          posting_id: disabledPosting.id,
          date: new Date('2026-03-02T00:00:00.000Z'),
          attended: true,
        },
      ])
      .execute();

    const response = await server
      .get('/volunteer/certificate')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.organizations).toHaveLength(2);
    expect(response.body.organizations[0].id).toBe(certificateEnabledOrg.id);
    expect(response.body.organizations[1].id).toBe(certificateDisabledOrg.id);
  });
});

describe('POST /volunteer/certificate/issue', () => {
  test('returns 400 when volunteer has zero completed hours', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'certificate-zero-hours@example.com' });

    const response = await server
      .post('/volunteer/certificate/issue')
      .set('Authorization', 'Bearer ' + token)
      .send({ org_ids: [] })
      .expect(400);

    expect(response.body.message).toBe('You need completed volunteering hours before generating a certificate.');
  });

  test('rejects disabled organizations while still counting their attended hours in total certificate hours', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'certificate-issue-disabled-org@example.com' });
    const { organization: activeOrg } = await createOrganizationAccount(transaction, { email: 'certificate-issue-active-org@example.com' });
    const { organization: disabledOrg } = await createOrganizationAccount(transaction, { email: 'certificate-issue-disabled-org-2@example.com' });

    await transaction
      .updateTable('organization_account')
      .set({ is_disabled: true })
      .where('id', '=', disabledOrg.id)
      .execute();

    const activePosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: activeOrg.id,
        title: 'Active Issue Posting',
        description: 'Certificate issue test posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-02-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-02-01T00:00:00.000Z'),
        end_time: '11:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const disabledPosting = await transaction
      .insertInto('posting')
      .values({
        organization_id: disabledOrg.id,
        title: 'Disabled Issue Posting',
        description: 'Certificate issue test posting',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 25,
        start_date: new Date('2026-02-02T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-02-02T00:00:00.000Z'),
        end_time: '11:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
        crisis_id: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const enrollments = await transaction
      .insertInto('enrollment')
      .values([
        {
          volunteer_id: volunteer.id,
          posting_id: activePosting.id,
          attended: true,
          created_at: new Date('2026-02-03T00:00:00.000Z'),
        },
        {
          volunteer_id: volunteer.id,
          posting_id: disabledPosting.id,
          attended: true,
          created_at: new Date('2026-02-03T00:00:00.000Z'),
        },
      ])
      .returning(['id', 'posting_id'])
      .execute();

    await transaction
      .insertInto('enrollment_date')
      .values(enrollments.map(enrollment => ({
        enrollment_id: enrollment.id,
        posting_id: enrollment.posting_id,
        date: enrollment.posting_id === activePosting.id
          ? new Date('2026-02-01T00:00:00.000Z')
          : new Date('2026-02-02T00:00:00.000Z'),
        attended: true,
      })))
      .execute();

    const response = await server
      .post('/volunteer/certificate/issue')
      .set('Authorization', 'Bearer ' + token)
      .send({ org_ids: [disabledOrg.id] })
      .expect(400);

    expect(response.body.message).toBe(`Organization ${disabledOrg.id} cannot be included in this certificate.`);
  });
});

describe('DELETE /volunteer/posting/:id/enroll withdrawal behavior', () => {
  test('removes the entire enrollment for partial attendance postings', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-withdraw@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-withdraw-org@example.com' });

    const postingStartDate = new Date();
    postingStartDate.setDate(postingStartDate.getDate() + 3);
    const postingEndDate = new Date(postingStartDate);
    postingEndDate.setDate(postingEndDate.getDate() + 6);

    const selectedDateOne = new Date(postingStartDate);
    const selectedDateTwo = new Date(postingStartDate);
    selectedDateTwo.setDate(selectedDateTwo.getDate() + 2);
    const selectedDateThree = new Date(postingStartDate);
    selectedDateThree.setDate(selectedDateThree.getDate() + 4);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Attendance Event',
        description: 'Test partial withdraw behavior',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: postingStartDate,
        start_time: '09:00:00',
        end_date: postingEndDate,
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
        crisis_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const enrollResponse = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({
        dates: [
          formatDateToIso(selectedDateOne),
          formatDateToIso(selectedDateTwo),
          formatDateToIso(selectedDateThree),
        ],
        message: 'Enroll for selected partial dates',
      })
      .expect(200);

    expect(enrollResponse.body.enrollment).toBeDefined();

    const withdrawResponse = await server
      .delete(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ message: 'Withdraw the whole application' })
      .expect(200);

    expect(withdrawResponse.body).toEqual({});

    const remainingDates = await transaction
      .selectFrom('enrollment_date')
      .select('date')
      .where('enrollment_id', '=', enrollResponse.body.enrollment.id)
      .execute();

    expect(remainingDates).toEqual([]);
  });

  test('returns 403 when trying to withdraw from an ended enrolled posting', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'ended-enrolled-withdraw@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'ended-enrolled-withdraw-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Enrolled Event',
        description: 'Withdraw should be blocked after the posting ends',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        start_time: '09:00:00',
        end_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Enroll before the posting ends',
        attended: false,
      })
      .execute();

    await server
      .delete(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .expect(403);

    const enrollment = await transaction
      .selectFrom('enrollment')
      .select('id')
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', volunteer.id)
      .executeTakeFirst();

    expect(enrollment).toBeDefined();
  });

  test('removes the entire pending application for partial attendance postings', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-pending-withdraw@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-pending-withdraw-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Pending Withdrawal Event',
        description: 'Test full pending withdrawal behavior',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-05-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-05-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const applyResponse = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-05-01', '2026-05-03'], message: 'Applying for selected days' })
      .expect(200);

    expect(applyResponse.body.enrollment).toBeDefined();

    await server
      .delete(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200, {});

    const remainingApplication = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('posting_id', '=', posting.id)
      .executeTakeFirst();

    const remainingApplicationDates = await transaction
      .selectFrom('enrollment_application_date')
      .select('id')
      .execute();

    expect(remainingApplication).toBeUndefined();
    expect(remainingApplicationDates).toEqual([]);
  });

  test('returns 403 when trying to withdraw an ended pending application', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'ended-pending-withdraw@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'ended-pending-withdraw-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Pending Event',
        description: 'Pending applications should not be withdrawable after the posting ends',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        start_time: '09:00:00',
        end_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        message: 'Apply before the posting ends',
      })
      .execute();

    await server
      .delete(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .expect(403);

    const application = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', volunteer.id)
      .executeTakeFirst();

    expect(application).toBeDefined();
  });
});

describe('GET /volunteer/posting/:id selected partial dates', () => {
  test('returns requested application dates for a pending partial application', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-pending-selected@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-pending-selected-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Pending Partial Attendance Event',
        description: 'Pending partial attendance application',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-05-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-05-12T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
        crisis_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-05-10', '2026-05-12'], message: 'Only available on selected days' })
      .expect(200);

    const response = await server
      .get(`/volunteer/posting/${posting.id}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.posting.application_status).toBe('pending');
    expect(response.body.enrolled_dates).toEqual([]);
    expect(response.body.selected_dates).toEqual(['2026-05-10', '2026-05-12']);
  });

  test('automatically rejects a pending application when the posting has already ended', async () => {
    const rejectionEmailSpy = vi.spyOn(emailService, 'sendVolunteerApplicationRejectedEmail').mockResolvedValue(undefined);
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'ended-pending-detail@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'ended-pending-detail-org@example.com' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Pending Review Posting',
        description: 'Pending applications should disappear after the posting ends',
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
        message: 'Please consider me',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/volunteer/posting/${posting.id}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.posting.application_status).toBe('none');
    expect(response.body.selected_dates).toEqual([]);

    const remainingApplication = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('id', '=', application.id)
      .executeTakeFirst();

    expect(remainingApplication).toBeUndefined();
    expect(rejectionEmailSpy).toHaveBeenCalledTimes(1);

    rejectionEmailSpy.mockRestore();
  });

  test('returns enrolled_dates after a review-based partial application is accepted', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-accepted-selected@example.com' });
    const { organization, token: orgToken } = await createOrganizationAccount(transaction, { email: 'partial-accepted-selected-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Accepted Partial Attendance Event',
        description: 'Accepted partial attendance should surface enrolled dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-07-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-07-12T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-07-10', '2026-07-12'], message: 'Apply for review-based partial attendance' })
      .expect(200);

    const application = await transaction
      .selectFrom('enrollment_application')
      .select('id')
      .where('posting_id', '=', posting.id)
      .where('volunteer_id', '=', (await transaction
        .selectFrom('volunteer_account')
        .select('id')
        .where('email', '=', 'partial-accepted-selected@example.com')
        .executeTakeFirstOrThrow()).id)
      .executeTakeFirstOrThrow();

    await server
      .post(`/organization/posting/${posting.id}/applications/${application.id}/accept`)
      .set('Authorization', 'Bearer ' + orgToken)
      .expect(200);

    const response = await server
      .get(`/volunteer/posting/${posting.id}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.posting.application_status).toBe('registered');
    expect(response.body.enrolled_dates).toEqual(['2026-07-10', '2026-07-12']);
    expect(response.body.selected_dates).toEqual(['2026-07-10', '2026-07-12']);
  });

  test('returns posting_dates including the end date', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-posting-dates@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-posting-dates-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Inclusive Posting Dates Event',
        description: 'Posting dates should include the final day',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 20,
        start_date: new Date('2026-04-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-04-29T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/volunteer/posting/${posting.id}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.posting_dates[0]).toBe('2026-04-01');
    expect(response.body.posting_dates.at(-1)).toBe('2026-04-29');
    expect(response.body.posting_dates).toHaveLength(29);
  });

  test('rejects selecting a full date for partial attendance postings', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-full-day-blocked@example.com' });
    const { volunteer: enrolledVolunteer } = await createVolunteerAccount(transaction, { email: 'partial-full-day-existing@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-full-day-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Per-Day Capacity Event',
        description: 'One date is already full',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
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

    const existingEnrollment = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: enrolledVolunteer.id,
        posting_id: posting.id,
        message: 'Already assigned to one day',
        attended: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values({
        enrollment_id: existingEnrollment.id,
        posting_id: posting.id,
        date: new Date('2026-06-02T00:00:00.000Z'),
        attended: false,
      })
      .execute();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-06-02'], message: 'Trying to apply to a full day' })
      .expect(403);

    expect(response.body.message).toBe('Selected date 2026-06-02 is already full');
  });

  test('rejects a partial attendance enrollment when one selected date is full and another is available', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-mixed-capacity@example.com' });
    const { volunteer: existingVolunteer } = await createVolunteerAccount(transaction, { email: 'partial-mixed-capacity-existing@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-mixed-capacity-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Mixed Capacity Partial Event',
        description: 'Mixed date capacity should reject only the full date',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
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

    const existingEnrollment = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: existingVolunteer.id,
        posting_id: posting.id,
        message: 'Already assigned to one day',
        attended: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values({
        enrollment_id: existingEnrollment.id,
        posting_id: posting.id,
        date: new Date('2026-06-02T00:00:00.000Z'),
        attended: false,
      })
      .execute();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-06-02', '2026-06-03'], message: 'Mixed availability attempt' })
      .expect(403);

    expect(response.body.message).toBe('Selected date 2026-06-02 is already full');
  });

  test('allows partial attendance enrollment when other dates are full but selected date is available', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-available-date@example.com' });
    const { volunteer: existingVolunteerA } = await createVolunteerAccount(transaction, { email: 'partial-available-date-A@example.com' });
    const { volunteer: existingVolunteerB } = await createVolunteerAccount(transaction, { email: 'partial-available-date-B@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-available-date-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Available Day Event',
        description: 'Should allow applying to another available date',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 1,
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

    const existingEnrollmentA = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: existingVolunteerA.id,
        posting_id: posting.id,
        message: 'Day A enrollment',
        attended: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values({
        enrollment_id: existingEnrollmentA.id,
        posting_id: posting.id,
        date: new Date('2026-06-01T00:00:00.000Z'),
        attended: false,
      })
      .execute();

    const existingEnrollmentB = await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: existingVolunteerB.id,
        posting_id: posting.id,
        message: 'Day B enrollment',
        attended: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_date')
      .values({
        enrollment_id: existingEnrollmentB.id,
        posting_id: posting.id,
        date: new Date('2026-06-02T00:00:00.000Z'),
        attended: false,
      })
      .execute();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-06-03'], message: 'Applying to available day' })
      .expect(200);

    expect(response.body.enrollment).toBeDefined();
    expect(response.body.enrollment).toMatchObject({ posting_id: posting.id });
  });

  test('rejects partial attendance enrollments without selected dates', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-no-dates@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-no-dates-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Attendance Missing Dates',
        description: 'Dates required for partial attendance',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
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

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'No dates selected' })
      .expect(400);

    expect(response.body.message).toBe('You must select at least one date when partial attendance is enabled');
  });

  test('rejects partial attendance enrollments when selected date is outside the posting range', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-outside-date@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-outside-date-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Attendance Out of Range',
        description: 'Selected date must be within range',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
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

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dates: ['2026-06-04'], message: 'Out of range date' })
      .expect(400);

    expect(response.body.message).toBe('Selected date 2026-06-04 is outside the posting date range');
  });

  test('allows one-day partial attendance postings to apply without selecting dates', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-single-day@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-single-day-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Partial Attendance Single Day',
        description: 'Single-day partial posting should not require date selection',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-06-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-06-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Applying without selecting the only available day' })
      .expect(200);

    expect(response.body.enrollment).toBeDefined();
    expect(response.body.enrollment.posting_id).toBe(posting.id);

    const selectedDates = await transaction
      .selectFrom('enrollment_application_date')
      .select('date')
      .where('application_id', '=', response.body.enrollment.id)
      .execute();

    expect(selectedDates).toHaveLength(1);
    expect(selectedDates[0]).toBeDefined();
    expect(formatDateToIso(selectedDates[0]!.date)).toBe('2026-06-01');
  });

  test('rejects date selection for full commitment postings', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'full-commitment-dates@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'full-commitment-dates-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Full Commitment Event',
        description: 'Dates cannot be selected for full-commitment postings',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-06-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-06-03T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dates: ['2026-06-01'], message: 'Should be rejected' })
      .expect(400);

    expect(response.body.message).toBe('This posting requires full commitment; date selection is not allowed');
  });

  test('deduplicates duplicate selected dates for partial attendance enrollments', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-duplicate-dates@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-duplicate-dates-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Duplicate Selected Dates Event',
        description: 'Duplicate selected dates should be normalized',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-06-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-06-12T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const enrollResponse = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ dates: ['2026-06-11', '2026-06-11'], message: 'Duplicate dates should be deduped' })
      .expect(200);

    const enrollment = enrollResponse.body.enrollment;
    expect(enrollment).toBeDefined();

    const dates = await transaction
      .selectFrom('enrollment_date')
      .select(['date'])
      .where('enrollment_id', '=', enrollment.id)
      .orderBy('date', 'asc')
      .execute();

    expect(dates.map(row => formatDateToIso(row.date))).toEqual(['2026-06-11']);
  });

  test('creates enrollment_date rows for auto-accepted partial attendance enrollments', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'partial-auto-accept@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'partial-auto-accept-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Auto Accept Partial Attendance Event',
        description: 'Auto accepted partial attendance should store selected dates',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-06-10T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-06-12T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: true,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const enrollResponse = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dates: ['2026-06-10', '2026-06-12'], message: 'Enroll with selected dates' })
      .expect(200);

    const enrollment = enrollResponse.body.enrollment;
    expect(enrollment).toBeDefined();

    const dates = await transaction
      .selectFrom('enrollment_date')
      .select(['date'])
      .where('enrollment_id', '=', enrollment.id)
      .orderBy('date', 'asc')
      .execute();

    expect(dates.map(row => formatDateToIso(row.date))).toEqual(['2026-06-10', '2026-06-12']);
  });
});

describe('GET /volunteer/crises/pinned', () => {
  test('returns pinned crises ordered by creation time', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crisis-pinned@example.com' });

    const olderPinned = await transaction
      .insertInto('crisis')
      .values({
        name: 'Flood Response',
        description: 'Support flooded regions',
        pinned: true,
        created_at: new Date('2024-01-01T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const latestPinned = await transaction
      .insertInto('crisis')
      .values({
        name: 'Wildfire Relief',
        description: 'Coordinate evacuations',
        pinned: true,
        created_at: new Date('2024-02-01T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('crisis')
      .values({
        name: 'Unpinned Event',
        description: 'General support',
        pinned: false,
        created_at: new Date('2024-03-01T00:00:00.000Z'),
      })
      .execute();

    const response = await server
      .get('/volunteer/crises/pinned')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.crises).toHaveLength(2);
    expect(response.body.crises.map((crisis: { id: number }) => crisis.id)).toEqual([
      latestPinned.id,
      olderPinned.id,
    ]);
  });
});

describe('GET /volunteer/crises/:id', () => {
  test('returns 400 for non-positive crisis id', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crisis-invalid-id@example.com' });

    await server
      .get('/volunteer/crises/0')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
  });

  test('returns 404 for unknown crisis', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crisis-lookup@example.com' });

    await server
      .get('/volunteer/crises/999999')
      .set('Authorization', 'Bearer ' + token)
      .expect(404);
  });

  test('returns the requested crisis', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crisis-lookup-success@example.com' });

    const crisis = await transaction
      .insertInto('crisis')
      .values({
        name: 'Fuel Shortage',
        description: 'Coordinate deliveries',
        pinned: false,
        created_at: new Date('2025-03-01T00:00:00.000Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/volunteer/crises/${crisis.id}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.crisis).toMatchObject({
      id: crisis.id,
      name: 'Fuel Shortage',
      description: 'Coordinate deliveries',
      pinned: false,
    });
  });
});

describe('PUT /volunteer/profile', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .put('/volunteer/profile')
      .send({ first_name: 'Updated' })
      .expect(403);
  });

  test('returns 403 when logged in as organization', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'profile-org-forbidden@example.com' });

    await server
      .put('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .send({ first_name: 'Updated' })
      .expect(403);
  });

  test('returns 403 when logged in as admin', async () => {
    const { token } = await createAdminAccount(transaction, { email: 'profile-admin-forbidden@example.com' });

    await server
      .put('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .send({ first_name: 'Updated' })
      .expect(403);
  });

  test('skips profile vector recomputation when profile update recompute limit is exceeded', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'profile-rate-limit@example.com' });
    const recomputeProfileSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerProfileVector')
      .mockResolvedValue(null);
    const getVolunteerProfileSpy = vi
      .spyOn(volunteerService, 'getVolunteerProfile')
      .mockResolvedValue({
        volunteer: {
          id: volunteer.id,
          first_name: volunteer.first_name,
          last_name: volunteer.last_name,
          email: volunteer.email,
          date_of_birth: volunteer.date_of_birth,
          gender: volunteer.gender,
          cv_path: volunteer.cv_path,
          description: volunteer.description ?? '',
        },
        skills: [],
        experience_stats: {
          total_completed_experiences: 0,
          organizations_supported: 0,
          crisis_related_experiences: 0,
          total_hours_completed: 0,
          total_skills_used: 0,
          most_volunteered_crisis: null,
        },
        completed_experiences: [],
      });

    for (let index = 0; index < 3; index += 1) {
      await server
        .put('/volunteer/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: `Updated volunteer description ${index}`,
        })
        .expect(200);
    }

    await server
      .put('/volunteer/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Updated volunteer description 4',
      })
      .expect(200);

    expect(recomputeProfileSpy).toHaveBeenCalledTimes(3);

    recomputeProfileSpy.mockRestore();
    getVolunteerProfileSpy.mockRestore();
  });

  test('updates volunteer details, replaces skills, and recomputes profile vector', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'profile-update@example.com' });

    await transaction
      .insertInto('volunteer_skill')
      .values({ volunteer_id: volunteer.id, name: 'First Aid' })
      .execute();

    const recomputeProfileSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerProfileVector')
      .mockResolvedValue(null);

    const profileData: VolunteerProfileData = {
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
        email: volunteer.email,
        date_of_birth: volunteer.date_of_birth,
        gender: volunteer.gender,
        cv_path: null,
        description: 'Available evenings',
      },
      skills: ['First Aid', 'Logistics'],
      experience_stats: {
        total_completed_experiences: 0,
        organizations_supported: 0,
        crisis_related_experiences: 0,
        total_hours_completed: 0,
        total_skills_used: 0,
        most_volunteered_crisis: null,
      },
      completed_experiences: [],
    };

    const getVolunteerProfileSpy = vi
      .spyOn(volunteerService, 'getVolunteerProfile')
      .mockResolvedValue(profileData);

    const response = await server
      .put('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .send({
        first_name: 'Updated',
        description: 'Available evenings',
        skills: ['Logistics ', 'First Aid', 'Logistics'],
      })
      .expect(200);

    expect(recomputeProfileSpy).toHaveBeenCalledWith(volunteer.id, transaction);
    expect(getVolunteerProfileSpy).toHaveBeenCalledWith(volunteer.id);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(profileData)));

    const updatedVolunteer = await transaction
      .selectFrom('volunteer_account')
      .select(['first_name', 'description'])
      .where('id', '=', volunteer.id)
      .executeTakeFirst();

    expect(updatedVolunteer).not.toBeUndefined();
    expect(updatedVolunteer).toMatchObject({
      first_name: volunteer.first_name,
      description: 'Available evenings',
    });

    const updatedSkills = await transaction
      .selectFrom('volunteer_skill')
      .select('name')
      .where('volunteer_id', '=', volunteer.id)
      .orderBy('name', 'asc')
      .execute();

    expect(updatedSkills.map(skill => skill.name)).toEqual(['First Aid', 'Logistics']);

    recomputeProfileSpy.mockRestore();
    getVolunteerProfileSpy.mockRestore();
  });

  test('does not recompute profile vector for a no-op update payload', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'profile-noop@example.com' });

    await transaction
      .insertInto('volunteer_skill')
      .values({ volunteer_id: volunteer.id, name: 'First Aid' })
      .execute();

    const recomputeProfileSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerProfileVector')
      .mockResolvedValue(null);

    const profileData: VolunteerProfileData = {
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
        email: volunteer.email,
        date_of_birth: volunteer.date_of_birth,
        gender: volunteer.gender,
        cv_path: volunteer.cv_path,
        description: volunteer.description ?? '',
      },
      skills: ['First Aid'],
      experience_stats: {
        total_completed_experiences: 0,
        organizations_supported: 0,
        crisis_related_experiences: 0,
        total_hours_completed: 0,
        total_skills_used: 0,
        most_volunteered_crisis: null,
      },
      completed_experiences: [],
    };

    const getVolunteerProfileSpy = vi
      .spyOn(volunteerService, 'getVolunteerProfile')
      .mockResolvedValue(profileData);

    const response = await server
      .put('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(200);

    expect(recomputeProfileSpy).not.toHaveBeenCalled();
    expect(getVolunteerProfileSpy).toHaveBeenCalledWith(volunteer.id);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(profileData)));

    const skills = await transaction
      .selectFrom('volunteer_skill')
      .select('name')
      .where('volunteer_id', '=', volunteer.id)
      .orderBy('name', 'asc')
      .execute();

    expect(skills.map(skill => skill.name)).toEqual(['First Aid']);

    recomputeProfileSpy.mockRestore();
    getVolunteerProfileSpy.mockRestore();
  });

  test('clears all skills when skills is an empty array and recomputes profile vector', async () => {
    const { volunteer, token } = await createVolunteerAccount(transaction, { email: 'profile-clear-skills@example.com' });

    await transaction
      .insertInto('volunteer_skill')
      .values([
        { volunteer_id: volunteer.id, name: 'First Aid' },
        { volunteer_id: volunteer.id, name: 'Logistics' },
      ])
      .execute();

    const recomputeProfileSpy = vi
      .spyOn(embeddingUpdates, 'recomputeVolunteerProfileVector')
      .mockResolvedValue(null);

    const profileData: VolunteerProfileData = {
      volunteer: {
        id: volunteer.id,
        first_name: volunteer.first_name,
        last_name: volunteer.last_name,
        email: volunteer.email,
        date_of_birth: volunteer.date_of_birth,
        gender: volunteer.gender,
        cv_path: volunteer.cv_path,
        description: volunteer.description ?? '',
      },
      skills: [],
      experience_stats: {
        total_completed_experiences: 0,
        organizations_supported: 0,
        crisis_related_experiences: 0,
        total_hours_completed: 0,
        total_skills_used: 0,
        most_volunteered_crisis: null,
      },
      completed_experiences: [],
    };

    const getVolunteerProfileSpy = vi
      .spyOn(volunteerService, 'getVolunteerProfile')
      .mockResolvedValue(profileData);

    const response = await server
      .put('/volunteer/profile')
      .set('Authorization', 'Bearer ' + token)
      .send({ skills: [] })
      .expect(200);

    expect(recomputeProfileSpy).toHaveBeenCalledWith(volunteer.id, transaction);
    expect(getVolunteerProfileSpy).toHaveBeenCalledWith(volunteer.id);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(profileData)));

    const skills = await transaction
      .selectFrom('volunteer_skill')
      .select('name')
      .where('volunteer_id', '=', volunteer.id)
      .execute();

    expect(skills).toEqual([]);

    recomputeProfileSpy.mockRestore();
    getVolunteerProfileSpy.mockRestore();
  });
});

describe('GET /volunteer/organizations', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .get('/volunteer/organizations')
      .expect(403);
  });

  test('returns organizations with posting counts sorted by name by default', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'org-search-viewer@example.com' });
    const { organization: firstOrg } = await createOrganizationAccount(transaction, {
      email: 'org-a@example.com',
      name: 'Alpha Responders',
      phone_number: '123-456-7890',
      url: 'https://alpharesponders.org',
    });
    const { organization: secondOrg } = await createOrganizationAccount(transaction, {
      email: 'org-b@example.com',
      name: 'Bravo Collective',
      phone_number: '987-654-3210',
      url: 'https://bravocollective.org',
    });

    await transaction
      .insertInto('posting')
      .values([
        {
          organization_id: firstOrg.id,
          title: 'First Posting',
          description: 'Support first area',
          latitude: 33.9,
          longitude: 35.5,
          start_date: new Date('2026-02-01T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-02-01T00:00:00.000Z'),
          end_time: '13:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut Downtown',
        },
        {
          organization_id: firstOrg.id,
          title: 'Second Posting',
          description: 'Support second area',
          latitude: 33.91,
          longitude: 35.51,
          start_date: new Date('2026-02-02T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-02-02T00:00:00.000Z'),
          end_time: '13:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut Waterfront',
        },
        {
          organization_id: secondOrg.id,
          title: 'Third Posting',
          description: 'Support third area',
          latitude: 33.92,
          longitude: 35.52,
          start_date: new Date('2026-02-03T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-02-03T00:00:00.000Z'),
          end_time: '13:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut Suburbs',
        },
      ])
      .execute();

    const response = await server
      .get('/volunteer/organizations')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.organizations.map((org: { name: string }) => org.name)).toEqual([
      'Alpha Responders',
      'Bravo Collective',
    ]);

    expect(response.body.organizations).toEqual([
      {
        id: firstOrg.id,
        name: 'Alpha Responders',
        description: null,
        location_name: 'Beirut',
        logo_path: null,
        posting_count: 2,
      },
      {
        id: secondOrg.id,
        name: 'Bravo Collective',
        description: null,
        location_name: 'Beirut',
        logo_path: null,
        posting_count: 1,
      },
    ]);
  });

  test('filters organizations by certificate enabled or disabled', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'org-search-cert@example.com' });
    const { organization: enabledOrg } = await createOrganizationAccount(transaction, {
      email: 'enabled-org@example.com',
      name: 'Enabled Org',
      phone_number: '111-222-3333',
      url: 'https://enabled.example.org',
    });
    const { organization: disabledOrg } = await createOrganizationAccount(transaction, {
      email: 'disabled-org@example.com',
      name: 'Disabled Org',
      phone_number: '222-333-4444',
      url: 'https://disabled.example.org',
    });
    const { organization: _noInfoOrg } = await createOrganizationAccount(transaction, {
      email: 'no-info-org@example.com',
      name: 'NoInfo Org',
      phone_number: '333-444-5555',
      url: 'https://no-info.example.org',
    });

    const enabledCertInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({ certificate_feature_enabled: true, hours_threshold: null, signatory_name: null, signatory_position: null, signature_path: null })
      .returningAll()
      .executeTakeFirstOrThrow();

    const disabledCertInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({ certificate_feature_enabled: false, hours_threshold: null, signatory_name: null, signatory_position: null, signature_path: null })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: enabledCertInfo.id })
      .where('id', '=', enabledOrg.id)
      .execute();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: disabledCertInfo.id })
      .where('id', '=', disabledOrg.id)
      .execute();

    const enabledResponse = await server
      .get('/volunteer/organizations?certificate_enabled=enabled')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(enabledResponse.body.organizations.map((o: { name: string }) => o.name)).toEqual(['Enabled Org']);

    const disabledResponse = await server
      .get('/volunteer/organizations?certificate_enabled=disabled')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(disabledResponse.body.organizations.map((o: { name: string }) => o.name).sort()).toEqual(['Disabled Org', 'NoInfo Org']);

    const allResponse = await server
      .get('/volunteer/organizations?certificate_enabled=all')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(allResponse.body.organizations.map((o: { name: string }) => o.name).sort()).toEqual(['Disabled Org', 'Enabled Org', 'NoInfo Org']);
  });

  test('applies search across organization fields', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'org-search-filter@example.com' });
    const { organization: matchingOrg } = await createOrganizationAccount(transaction, {
      email: 'beirut-helpers@example.com',
      name: 'Beirut Helpers',
      phone_number: '111-222-3333',
      url: 'https://beirut-helpers.example.org',
    });

    await transaction
      .updateTable('organization_account')
      .set({
        description: 'Emergency logistics and food support',
        location_name: 'Beirut Downtown',
      })
      .where('id', '=', matchingOrg.id)
      .execute();

    await createOrganizationAccount(transaction, {
      email: 'tripoli-care@example.com',
      name: 'Tripoli Care Network',
      phone_number: '444-555-6666',
      url: 'https://tripoli-care.example.org',
    });

    const response = await server
      .get('/volunteer/organizations?search=beiruthelpers')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.organizations).toHaveLength(1);
    expect(response.body.organizations[0]).toMatchObject({
      id: matchingOrg.id,
      name: 'Beirut Helpers',
    });
  });
});

describe('GET /volunteer/crises', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .get('/volunteer/crises')
      .expect(403);
  });

  test('returns crises with pinned entries first by default sorting', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crises-default-sort@example.com' });

    await transaction
      .insertInto('crisis')
      .values([
        {
          name: 'Bravo Crisis',
          description: 'Unpinned crisis',
          pinned: false,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          name: 'Zulu Crisis',
          description: 'Pinned crisis',
          pinned: true,
          created_at: new Date('2026-01-02T00:00:00.000Z'),
        },
        {
          name: 'Alpha Crisis',
          description: 'Pinned crisis',
          pinned: true,
          created_at: new Date('2026-01-03T00:00:00.000Z'),
        },
      ])
      .execute();

    const response = await server
      .get('/volunteer/crises')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.crises.map((crisis: { name: string }) => crisis.name)).toEqual([
      'Alpha Crisis',
      'Zulu Crisis',
      'Bravo Crisis',
    ]);
  });

  test('filters by pinned flag and supports title_desc sorting', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'crises-filter-sort@example.com' });

    await transaction
      .insertInto('crisis')
      .values([
        {
          name: 'Storm Aid',
          description: 'Primary storm response',
          pinned: true,
          created_at: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          name: 'Avalanche Rescue',
          description: 'Mountain response',
          pinned: true,
          created_at: new Date('2026-02-02T00:00:00.000Z'),
        },
        {
          name: 'Storm Recovery',
          description: 'Long-term support',
          pinned: false,
          created_at: new Date('2026-02-03T00:00:00.000Z'),
        },
      ])
      .execute();

    const response = await server
      .get('/volunteer/crises?pinned=true&sort_by=title_desc')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);

    expect(response.body.crises.map((crisis: { name: string }) => crisis.name)).toEqual([
      'Storm Aid',
      'Avalanche Rescue',
    ]);
  });
});

describe('POST /volunteer/reset-password', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .post('/volunteer/reset-password')
      .send({ currentPassword: 'current', newPassword: 'NewPassword123!' })
      .expect(403);
  });

  test('returns 403 when logged in as organization', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'reset-password-org@example.com' });

    await server
      .post('/volunteer/reset-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: 'OrgPassword123!', newPassword: 'NewPassword123!' })
      .expect(403);
  });

  test('returns 403 when current password is incorrect', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'reset-password-invalid-current@example.com' });

    await server
      .post('/volunteer/reset-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: 'WrongPassword123!', newPassword: 'NewPassword123!' })
      .expect(403);
  });

  test('updates password hash and returns a fresh token when current password is correct', async () => {
    const { volunteer, token, plainPassword } = await createVolunteerAccount(transaction, { email: 'reset-password-success@example.com' });

    const beforeUpdate = await transaction
      .selectFrom('volunteer_account')
      .select('password')
      .where('id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    const response = await server
      .post('/volunteer/reset-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: plainPassword, newPassword: 'NewPassword123!' })
      .expect(200);

    expect(typeof response.body.token).toBe('string');
    expect(response.body.token.length).toBeGreaterThan(0);

    const afterUpdate = await transaction
      .selectFrom('volunteer_account')
      .select('password')
      .where('id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    expect(afterUpdate.password).not.toBe(beforeUpdate.password);
    expect(await compare(plainPassword, afterUpdate.password)).toBe(false);
    expect(await compare('NewPassword123!', afterUpdate.password)).toBe(true);
  });
});

describe('POST /volunteer/posting/:id/enroll ended posting validation', () => {
  test('returns 403 when applying to a posting that has ended', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'ended-posting-vol@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'ended-posting-org@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Posting',
        description: 'This posting has already ended',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2000-01-01T09:00:00Z'),
        start_time: '09:00:00',
        end_date: new Date('2000-01-02T00:00:00Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ message: 'I want to join' })
      .expect(403);

    expect(response.body.message).toBe('This posting has ended');
  });

  test('allows applying to a posting ending today', async () => {
    const { token } = await createVolunteerAccount(transaction, { email: 'today-posting-vol@example.com' });
    const { organization } = await createOrganizationAccount(transaction, { email: 'today-posting-org@example.com' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    lastWeek.setHours(0, 0, 0, 0);

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ending Today Posting',
        description: 'This posting ends today',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: lastWeek,
        start_time: '09:00:00',
        end_date: today,
        end_time: '23:59:59',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Test Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .post(`/volunteer/posting/${posting.id}/enroll`)
      .set('Authorization', 'Bearer ' + token)
      .send({ message: 'Joining on the last day' })
      .expect(200);
  });
});
