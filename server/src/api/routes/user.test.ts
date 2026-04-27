import { sql } from 'kysely';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import createApp from '../../app.ts';
import database from '../../db/index.ts';
import { compare } from '../../services/bcrypt/index.ts';
import * as emailService from '../../services/resend/emails.ts';
import { createAdminAccount, createOrganizationAccount, createVolunteerAccount } from '../../tests/fixtures/accounts.ts';
import { createPosting } from '../../tests/fixtures/organizationData.ts';

import type { Database } from '../../db/tables/index.ts';
import type { ControlledTransaction } from 'kysely';
import type TestAgent from 'supertest/lib/agent.js';

const sendPasswordResetEmailSpy = vi
  .spyOn(emailService, 'sendPasswordResetEmail')
  .mockResolvedValue(undefined);

let transaction: ControlledTransaction<Database>;
let server: TestAgent;

beforeEach(async () => {
  transaction = await database.startTransaction().execute();
  server = supertest(createApp(transaction));
});

afterEach(async () => {
  await transaction.rollback().execute();
  sendPasswordResetEmailSpy.mockClear();
});

describe('POST /user/login', () => {
  test('returns 400 for invalid login payload', async () => {
    await server
      .post('/user/login')
      .send({ email: 'invalid-email-format' })
      .expect(400);
  });

  test('logs in organization account with valid credentials', async () => {
    const { organization, plainPassword } = await createOrganizationAccount(transaction, {
      phone_number: '+10000000001',
      url: 'https://test1.example.org',
    });

    const response = await server
      .post('/user/login')
      .send({ email: organization.email, password: plainPassword })
      .expect(200);

    expect(response.body.role).toBe('organization');
    expect(typeof response.body.token).toBe('string');
    expect(response.body.organization).toMatchObject({
      id: organization.id,
      email: organization.email,
      name: organization.name,
    });
    expect(response.body.organization.password).toBeUndefined();
    expect(response.body.organization.org_context_vector).toBeUndefined();
  });

  test('logs in volunteer account with valid credentials', async () => {
    const { volunteer, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'login-vol@example.com',
    });

    const response = await server
      .post('/user/login')
      .send({ email: volunteer.email, password: plainPassword })
      .expect(200);

    expect(response.body.role).toBe('volunteer');
    expect(response.body.volunteer).toMatchObject({
      id: volunteer.id,
      email: volunteer.email,
      first_name: volunteer.first_name,
    });
    expect(response.body.volunteer.password).toBeUndefined();
    expect(response.body.volunteer.volunteer_profile_vector).toBeUndefined();
    expect(response.body.volunteer.volunteer_history_vector).toBeUndefined();
  });

  test('logs in successfully when email input uses uppercase letters', async () => {
    const { volunteer, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'case-insensitive-login@example.com',
    });

    const response = await server
      .post('/user/login')
      .send({ email: 'Case-Insensitive-Login@Example.com', password: plainPassword })
      .expect(200);

    expect(response.body.role).toBe('volunteer');
    expect(response.body.volunteer).toMatchObject({
      id: volunteer.id,
      email: volunteer.email,
    });
  });

  test('rejects login for inexistent account', async () => {
    const response = await server
      .post('/user/login')
      .send({ email: 'missing@example.com', password: 'password' })
      .expect(403);

    expect(response.body.message).toBe('Invalid email or password');
  });

  test('rejects login for organization account', async () => {
    const { organization } = await createOrganizationAccount(transaction, {
      phone_number: '+10000000002',
      url: 'https://test2.example.org',
    });

    const response = await server
      .post('/user/login')
      .send({ email: organization.email, password: 'wrongpassword' })
      .expect(403);

    expect(response.body.message).toBe('Invalid email or password');
  });

  test('rejects login for volunteer account', async () => {
    const { volunteer } = await createVolunteerAccount(transaction);

    const response = await server
      .post('/user/login')
      .send({ email: volunteer.email, password: 'wrongpassword' })
      .expect(403);

    expect(response.body.message).toBe('Invalid email or password');
  });

  test('rejects login for disabled organization account', async () => {
    const { organization, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'disabled-org-login@example.com',
      phone_number: '+10000000003',
      url: 'https://disabled-org.example.org',
    });

    await transaction
      .updateTable('organization_account')
      .set({ is_disabled: true })
      .where('id', '=', organization.id)
      .execute();

    const response = await server
      .post('/user/login')
      .send({ email: organization.email, password: plainPassword })
      .expect(403);

    expect(response.body.message).toBe('Account is disabled. If you think this is a mistake contact the Willing admin.');
  });

  test('rejects login for disabled volunteer account', async () => {
    const { volunteer, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'disabled-volunteer-login@example.com',
    });

    await transaction
      .updateTable('volunteer_account')
      .set({ is_disabled: true })
      .where('id', '=', volunteer.id)
      .execute();

    const response = await server
      .post('/user/login')
      .send({ email: volunteer.email, password: plainPassword })
      .expect(403);

    expect(response.body.message).toBe('Account is disabled. If you think this is a mistake contact the Willing admin.');
  });

  test('rejects login for correct admin credentials', async () => {
    const { admin, plainPassword } = await createAdminAccount(transaction);

    const response = await server
      .post('/user/login')
      .send({ email: admin.email, password: plainPassword })
      .expect(403);

    expect(response.body.message).toBe('Invalid email or password');
  });

  test('rejects login for deleted volunteer account', async () => {
    const { volunteer, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'deleted-volunteer@example.com',
    });

    await transaction
      .updateTable('volunteer_account')
      .set({ is_deleted: true })
      .where('id', '=', volunteer.id)
      .execute();

    await server
      .post('/user/login')
      .send({ email: volunteer.email, password: plainPassword })
      .expect(403);
  });

  test('rejects login for disabled organization account', async () => {
    const { organization, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'disabled-organization@example.com',
    });

    await transaction
      .updateTable('organization_account')
      .set({ is_disabled: true })
      .where('id', '=', organization.id)
      .execute();

    await server
      .post('/user/login')
      .send({ email: organization.email, password: plainPassword })
      .expect(403);
  });
});

describe('POST /user/forgot-password', () => {
  test('returns 400 for invalid email format', async () => {
    await server
      .post('/user/forgot-password')
      .send({ email: 'not-an-email' })
      .expect(400);

    expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
  });

  test('silently succeeds when the email is unknown', async () => {
    const response = await server
      .post('/user/forgot-password')
      .send({ email: 'unknown@example.com' })
      .expect(200);

    expect(response.body).toEqual({});

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();
    expect(tokens).toHaveLength(0);
    expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
  });

  test('creates a reset token and emails organization', async () => {
    const { organization } = await createOrganizationAccount(transaction, {
      phone_number: '+10000000004',
      url: 'https://test4.example.org',
    });

    const response = await server
      .post('/user/forgot-password')
      .send({ email: organization.email })
      .expect(200);

    expect(response.body).toEqual({});

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.user_id).toBe(organization.id);
    expect(tokens[0]!.role).toBe('organization');

    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledWith(
      organization.email,
      organization.name,
      tokens[0]!.token,
    );
  });

  test('creates a reset token and emails volunteer', async () => {
    const { volunteer } = await createVolunteerAccount(transaction);

    const response = await server
      .post('/user/forgot-password')
      .send({ email: volunteer.email })
      .expect(200);

    expect(response.body).toEqual({});

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.user_id).toBe(volunteer.id);
    expect(tokens[0]!.role).toBe('volunteer');

    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledWith(
      volunteer.email,
      `${volunteer.first_name} ${volunteer.last_name}`,
      tokens[0]!.token,
    );
  });

  test('doesn\'t create a reset token for admin', async () => {
    const { admin } = await createAdminAccount(transaction, {
      email: 'reset-admin@example.com',
    });

    const response = await server
      .post('/user/forgot-password')
      .send({ email: admin.email })
      .expect(200);

    expect(response.body).toEqual({});

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();

    expect(tokens).toHaveLength(0);

    expect(sendPasswordResetEmailSpy).not.toHaveBeenCalled();
  });
});

describe('POST /user/forgot-password/reset', () => {
  test('returns 400 when reset payload is invalid', async () => {
    await server
      .post('/user/forgot-password/reset')
      .send({ key: '', password: 'ValidPass123!' })
      .expect(400);
  });

  test('updates the password of a volunteer and deletes the token', async () => {
    const { volunteer } = await createVolunteerAccount(transaction, {
      email: 'needs-reset@example.com',
      password: 'OldPassword123!',
    });

    const resetTokenKey = 'test-reset-token';
    await transaction
      .insertInto('password_reset_token')
      .values({
        user_id: volunteer.id,
        role: 'volunteer',
        token: resetTokenKey,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      })
      .execute();

    const newPassword = 'NewPassword123!';
    const response = await server
      .post('/user/forgot-password/reset')
      .send({ key: resetTokenKey, password: newPassword })
      .expect(200);

    expect(response.body).toEqual({});

    const updatedVolunteer = await transaction
      .selectFrom('volunteer_account')
      .select(['password'])
      .where('id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    expect(await compare(newPassword, updatedVolunteer.password)).toBe(true);

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();
    expect(tokens).toHaveLength(0);
  });

  test('updates the password of an organization and deletes the token', async () => {
    const { organization } = await createOrganizationAccount(transaction, {
      email: 'needs-reset@example.com',
      password: 'OldPassword123!',
    });

    const resetTokenKey = 'test-reset-token';
    await transaction
      .insertInto('password_reset_token')
      .values({
        user_id: organization.id,
        role: 'organization',
        token: resetTokenKey,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      })
      .execute();

    const newPassword = 'NewPassword123!';
    const response = await server
      .post('/user/forgot-password/reset')
      .send({ key: resetTokenKey, password: newPassword })
      .expect(200);

    expect(response.body).toEqual({});

    const updatedOrganization = await transaction
      .selectFrom('organization_account')
      .select(['password'])
      .where('id', '=', organization.id)
      .executeTakeFirstOrThrow();

    expect(await compare(newPassword, updatedOrganization.password)).toBe(true);

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();
    expect(tokens).toHaveLength(0);
  });

  test('returns 400 for unknown reset token', async () => {
    await server
      .post('/user/forgot-password/reset')
      .send({ key: 'unknown-token', password: 'Whatever123!' })
      .expect(400);
  });

  test('returns 400 for expired token', async () => {
    const { organization } = await createOrganizationAccount(transaction, {
      email: 'needs-reset@example.com',
      password: 'OldPassword123!',
    });

    const resetTokenKey = 'test-reset-token';
    await transaction
      .insertInto('password_reset_token')
      .values({
        user_id: organization.id,
        role: 'organization',
        token: resetTokenKey,
        expires_at: new Date(Date.now() - 60 * 1000),
        created_at: new Date(Date.now() - 61 * 60 * 1000),
      })
      .execute();

    const response = await server
      .post('/user/forgot-password/reset')
      .send({ key: resetTokenKey, password: 'Whatever123!' })
      .expect(400);

    expect(response.body.message).toBe('Reset token has expired');

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();

    expect(tokens).toHaveLength(1);
  });

  test('doesn\'t allow setting a weak password', async () => {
    const { volunteer } = await createVolunteerAccount(transaction, {
      email: 'needs-reset@example.com',
      password: 'OldPassword123!',
    });

    const resetTokenKey = 'test-reset-token';
    await transaction
      .insertInto('password_reset_token')
      .values({
        user_id: volunteer.id,
        role: 'volunteer',
        token: resetTokenKey,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      })
      .execute();

    const newPassword = 'weakpassword';
    await server
      .post('/user/forgot-password/reset')
      .send({ key: resetTokenKey, password: newPassword })
      .expect(400);

    const unchangedVolunteer = await transaction
      .selectFrom('volunteer_account')
      .select(['password'])
      .where('id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    expect(await compare('OldPassword123!', unchangedVolunteer.password)).toBe(true);

    const tokens = await transaction
      .selectFrom('password_reset_token')
      .selectAll()
      .execute();

    expect(tokens).toHaveLength(1);
  });

  test('invalidates previous token after password reset', async () => {
    const { volunteer, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'invalidates-token@example.com',
      password: 'OldPassword123!',
    });

    const loginResult = await server
      .post('/user/login')
      .send({ email: volunteer.email, password: plainPassword })
      .expect(200);

    const oldToken = loginResult.body.token;

    await server
      .get('/volunteer/me')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200);

    const resetTokenKey = 'reset-token-' + Date.now();
    await transaction
      .insertInto('password_reset_token')
      .values({
        user_id: volunteer.id,
        role: 'volunteer',
        token: resetTokenKey,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        created_at: new Date(),
      })
      .execute();

    await server
      .post('/user/forgot-password/reset')
      .send({ key: resetTokenKey, password: 'NewPassword123!' })
      .expect(200);

    await server
      .get('/volunteer/me')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(403);

    const loggedIn = await server
      .post('/user/login')
      .send({ email: volunteer.email, password: 'NewPassword123!' })
      .expect(200);

    const newToken = loggedIn.body.token;
    expect(newToken).toBeTruthy();

    await server
      .get('/volunteer/me')
      .set('Authorization', `Bearer ${newToken}`)
      .expect(200);
  });
});

describe('DELETE /user/account', () => {
  test('returns 403 when unauthenticated', async () => {
    await server
      .delete('/user/account')
      .expect(403);
  });

  test('soft deletes volunteer account and invalidates current token', async () => {
    const { volunteer, token, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'delete-volunteer@example.com',
    });

    await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(200);

    const deletedVolunteer = await transaction
      .selectFrom('volunteer_account')
      .select(['is_deleted', 'token_version'])
      .where('id', '=', volunteer.id)
      .executeTakeFirstOrThrow();

    expect(deletedVolunteer.is_deleted).toBe(true);

    await server
      .get('/volunteer/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('soft deletes organization account and invalidates current token', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'delete-organization@example.com',
    });

    await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(200);

    const deletedOrganization = await transaction
      .selectFrom('organization_account')
      .select(['is_deleted', 'token_version'])
      .where('id', '=', organization.id)
      .executeTakeFirstOrThrow();

    expect(deletedOrganization.is_deleted).toBe(true);

    await server
      .get('/organization/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('returns 403 when password is incorrect for volunteer', async () => {
    const { token } = await createVolunteerAccount(transaction, {
      email: 'wrong-pw-vol@example.com',
    });

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'WrongPassword123!' })
      .expect(403);

    expect(response.body.message).toBe('Incorrect password');
  });

  test('returns 403 when password is incorrect for organization', async () => {
    const { token } = await createOrganizationAccount(transaction, {
      email: 'wrong-pw-org@example.com',
      phone_number: '+10000000099',
      url: 'https://wrong-pw.example.org',
    });

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'WrongPassword123!' })
      .expect(403);

    expect(response.body.message).toBe('Incorrect password');
  });

  test('returns 409 when volunteer is enrolled in an active posting', async () => {
    const { volunteer, token, plainPassword } = await createVolunteerAccount(transaction, {
      email: 'enrolled-vol@example.com',
    });
    const { organization } = await createOrganizationAccount(transaction, {
      email: 'org-for-active@example.com',
      phone_number: '+10000000050',
      url: 'https://active-org.example.org',
    });

    const today = new Date();
    const futureEnd = new Date(today);
    futureEnd.setDate(futureEnd.getDate() + 7);
    const pastStart = new Date(today);
    pastStart.setDate(pastStart.getDate() - 1);

    const posting = await createPosting(transaction, {
      organizationId: organization.id,
      overrides: { start_date: pastStart, end_date: futureEnd },
    });

    await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        attended: false,
      })
      .execute();

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(409);

    expect(response.body.message).toContain('enrolled in active postings');
  });

  test('returns 409 when organization has a currently running posting', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'running-org@example.com',
      phone_number: '+10000000051',
      url: 'https://running-org.example.org',
    });

    const today = new Date();
    const futureEnd = new Date(today);
    futureEnd.setDate(futureEnd.getDate() + 7);
    const pastStart = new Date(today);
    pastStart.setDate(pastStart.getDate() - 1);

    await createPosting(transaction, {
      organizationId: organization.id,
      overrides: { start_date: pastStart, end_date: futureEnd },
    });

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(409);

    expect(response.body.message).toContain('currently running');
  });

  test('returns 409 when organization posting ends later today', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'running-today-org@example.com',
      phone_number: '+10000000055',
      url: 'https://running-today-org.example.org',
    });

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Running Today Posting',
        description: 'In progress now',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: sql<Date>`CURRENT_DATE`,
        start_time: sql<string>`(CURRENT_TIMESTAMP - interval '1 hour')::time`,
        end_date: sql<Date>`CURRENT_DATE`,
        end_time: sql<string>`(CURRENT_TIMESTAMP + interval '1 hour')::time`,
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
      })
      .execute();

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(409);

    expect(response.body.message).toContain('currently running');
  });

  test('returns 409 when organization posting ends in the next 5 minutes', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'running-next-five-org@example.com',
      phone_number: '+10000000056',
      url: 'https://running-next-five-org.example.org',
    });

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ends In Five Minutes Posting',
        description: 'Should still block account deletion',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: sql<Date>`CURRENT_DATE`,
        start_time: sql<string>`(CURRENT_TIMESTAMP - interval '1 hour')::time`,
        end_date: sql<Date>`CURRENT_DATE`,
        end_time: sql<string>`(CURRENT_TIMESTAMP + interval '5 minutes')::time`,
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
      })
      .execute();

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(409);

    expect(response.body.message).toContain('currently running');
  });

  test('allows organization deletion when an ongoing posting is closed', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'closed-running-org@example.com',
      phone_number: '+10000000057',
      url: 'https://closed-running-org.example.org',
    });

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Closed Ongoing Posting',
        description: 'Should not block account deletion once closed',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: sql<Date>`CURRENT_DATE`,
        start_time: sql<string>`(CURRENT_TIMESTAMP - interval '1 hour')::time`,
        end_date: sql<Date>`CURRENT_DATE`,
        end_time: sql<string>`(CURRENT_TIMESTAMP + interval '1 hour')::time`,
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: true,
        allows_partial_attendance: false,
        location_name: 'Beirut',
      })
      .execute();

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(200);

    expect(response.body).toEqual({});

    const deletedOrganization = await transaction
      .selectFrom('organization_account')
      .select(['is_deleted'])
      .where('id', '=', organization.id)
      .executeTakeFirstOrThrow();

    expect(deletedOrganization.is_deleted).toBe(true);
  });

  test('allows organization deletion when the posting ended earlier today', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'ended-org@example.com',
      phone_number: '+10000000054',
      url: 'https://ended-org.example.org',
    });

    await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Ended Today Posting',
        description: 'Already ended earlier today',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: sql<Date>`CURRENT_DATE`,
        start_time: sql<string>`(CURRENT_TIMESTAMP::time - interval '2 hours')::time`,
        end_date: sql<Date>`CURRENT_DATE`,
        end_time: sql<string>`(CURRENT_TIMESTAMP::time - interval '2 minutes')::time`,
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Beirut',
      })
      .execute();

    const response = await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(200);

    expect(response.body).toEqual({});

    const deletedOrganization = await transaction
      .selectFrom('organization_account')
      .select(['is_deleted', 'token_version'])
      .where('id', '=', organization.id)
      .executeTakeFirstOrThrow();

    expect(deletedOrganization.is_deleted).toBe(true);
  });

  test('cleans up future postings when organization deletes account', async () => {
    const { organization, token, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'cleanup-org@example.com',
      phone_number: '+10000000052',
      url: 'https://cleanup-org.example.org',
    });

    const futureStart = new Date();
    futureStart.setDate(futureStart.getDate() + 10);
    const futureEnd = new Date(futureStart);
    futureEnd.setDate(futureEnd.getDate() + 5);

    const posting = await createPosting(transaction, {
      organizationId: organization.id,
      overrides: { start_date: futureStart, end_date: futureEnd },
    });

    await server
      .delete('/user/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: plainPassword })
      .expect(200);

    const deletedPosting = await transaction
      .selectFrom('posting')
      .select('id')
      .where('id', '=', posting.id)
      .executeTakeFirst();

    expect(deletedPosting).toBeUndefined();
  });

  test('rejects login for deleted organization account', async () => {
    const { organization, plainPassword } = await createOrganizationAccount(transaction, {
      email: 'deleted-org@example.com',
      phone_number: '+10000000053',
      url: 'https://deleted-org.example.org',
    });

    await transaction
      .updateTable('organization_account')
      .set({ is_deleted: true })
      .where('id', '=', organization.id)
      .execute();

    await server
      .post('/user/login')
      .send({ email: organization.email, password: plainPassword })
      .expect(403);
  });
});
