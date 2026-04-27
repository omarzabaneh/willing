import fs from 'fs';
import path from 'path';

import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import createApp from '../../../app.ts';
import database from '../../../db/index.ts';
import * as embeddingService from '../../../services/embeddings/updates.ts';
import { CV_UPLOAD_DIR, ORG_LOGO_UPLOAD_DIR, ORG_SIGNATURE_UPLOAD_DIR } from '../../../services/uploads/paths.ts';
import { createOrganizationAccount, createVolunteerAccount } from '../../../tests/fixtures/accounts.ts';

import type { Database } from '../../../db/tables/index.ts';
import type { ControlledTransaction } from 'kysely';
import type TestAgent from 'supertest/lib/agent.js';

let transaction: ControlledTransaction<Database, []>;
let server: TestAgent;

beforeEach(async () => {
  transaction = await database.startTransaction().execute();
  server = supertest(createApp(transaction));
});

afterEach(async () => {
  await transaction.rollback().execute();
});

describe('Organization index routes', () => {
  test('GET /organization/me returns private organization profile', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-me@example.com' });

    const response = await server
      .get('/organization/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.organization).toMatchObject({
      id: organization.id,
      email: organization.email,
      name: organization.name,
      logo_path: null,
    });
  });

  test('GET /organization/organizations returns organizations with posting counts', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-search-viewer@example.com' });
    const { organization: firstOrg } = await createOrganizationAccount(transaction, {
      email: 'org-search-a@example.com',
      name: 'Alpha Aid',
      phone_number: '+96110000001',
      url: 'https://alpha-aid.org',
    });
    const { organization: secondOrg } = await createOrganizationAccount(transaction, {
      email: 'org-search-b@example.com',
      name: 'Bravo Relief',
      phone_number: '+96110000002',
      url: 'https://bravo-relief.org',
    });

    await transaction
      .insertInto('posting')
      .values([
        {
          organization_id: firstOrg.id,
          title: 'Alpha Posting 1',
          description: 'Support alpha area',
          latitude: 33.9,
          longitude: 35.5,
          start_date: new Date('2026-10-01T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-10-01T00:00:00.000Z'),
          end_time: '17:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut',
        },
        {
          organization_id: firstOrg.id,
          title: 'Alpha Posting 2',
          description: 'Support alpha area',
          latitude: 33.91,
          longitude: 35.51,
          start_date: new Date('2026-10-02T00:00:00.000Z'),
          start_time: '09:00:00',
          end_date: new Date('2026-10-02T00:00:00.000Z'),
          end_time: '17:00:00',
          automatic_acceptance: true,
          is_closed: false,
          allows_partial_attendance: false,
          location_name: 'Beirut',
        },
      ])
      .execute();

    const response = await server
      .get('/organization/organizations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const alpha = response.body.organizations.find((organization: { id: number }) => organization.id === firstOrg.id);
    const bravo = response.body.organizations.find((organization: { id: number }) => organization.id === secondOrg.id);

    expect(alpha).toBeDefined();
    expect(alpha.posting_count).toBe(2);
    expect(bravo).toBeDefined();
    expect(bravo.posting_count).toBe(0);
  });

  test('PUT /organization/profile updates organization profile', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-update-profile@example.com' });

    const response = await server
      .put('/organization/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Updated organization description',
        location_name: 'Updated Location',
      })
      .expect(200);

    expect(response.body.organization).toMatchObject({
      description: 'Updated organization description',
      location_name: 'Updated Location',
    });
  });

  test('PUT /organization/profile skips recomputing profile vector after the per-window limit is exceeded', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-profile-rate-limit@example.com' });
    const recomputeOrganizationVectorSpy = vi
      .spyOn(embeddingService, 'recomputeOrganizationVector')
      .mockResolvedValue(null);

    for (let index = 0; index < 3; index += 1) {
      await server
        .put('/organization/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: `Updated organization description ${index}`,
        })
        .expect(200);
    }

    await server
      .put('/organization/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Updated organization description 4',
      })
      .expect(200);

    expect(recomputeOrganizationVectorSpy).toHaveBeenCalledTimes(3);

    recomputeOrganizationVectorSpy.mockRestore();
  });

  test('GET /organization/:id returns public organization profile with postings and skills', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-public-profile@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'org-profile-volunteer@example.com' });

    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'Public Posting',
        description: 'Public event',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 10,
        start_date: new Date('2026-10-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-10-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: true,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'Public Venue',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('posting_skill')
      .values({ posting_id: posting.id, name: 'First Aid' })
      .execute();

    await transaction
      .insertInto('enrollment')
      .values({
        volunteer_id: volunteer.id,
        posting_id: posting.id,
        attended: false,
      })
      .execute();

    const response = await server
      .get(`/organization/${organization.id}`)
      .expect(200);

    expect(response.body.organization).toMatchObject({
      id: organization.id,
      name: organization.name,
      email: organization.email,
    });
    expect(response.body.postings).toHaveLength(1);
    expect(response.body.postings[0]).toMatchObject({
      id: posting.id,
      title: 'Public Posting',
      location_name: 'Public Venue',
      enrollment_count: 1,
    });
    expect(response.body.postings[0].skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'First Aid',
        }),
      ]),
    );
  });

  test('GET /organization/volunteer/:id returns 403 when volunteer is unrelated', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-volunteer-unrelated@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-unrelated@example.com' });

    const response = await server
      .get(`/organization/volunteer/${volunteer.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body.message).toBe('You can only view profiles of volunteers related to your postings.');
  });

  test('POST /organization/request rejects when email already exists', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-request-duplicate@example.com' });

    const response = await server
      .post('/organization/request')
      .send({
        email: organization.email,
        name: 'Duplicate Org',
        phone_number: '+96100000000',
        url: 'https://example.org',
        location_name: 'Beirut',
        latitude: 33.8938,
        longitude: 35.5018,
      })
      .expect(400);

    expect(response.body.message).toBe('An organization with this email account already exists');
  });

  test('POST /organization/request rejects when a request is already pending', async () => {
    const email = 'org-request-pending@example.com';
    await transaction
      .insertInto('organization_request')
      .values({
        email,
        name: 'Pending Org',
        phone_number: '+96100000001',
        url: 'https://example.org',
        location_name: 'Beirut',
        latitude: 33.8938,
        longitude: 35.5018,
      })
      .execute();

    const response = await server
      .post('/organization/request')
      .send({
        email,
        name: 'Pending Org 2',
        phone_number: '+96100000002',
        url: 'https://example.org',
        location_name: 'Beirut',
        latitude: 33.9012,
        longitude: 35.5123,
      })
      .expect(400);

    expect(response.body.message).toBe('A request with this email is already pending');
  });

  test('GET /organization/:id/logo returns 404 when there is no logo', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-logo-missing@example.com' });

    const response = await server
      .get(`/organization/${organization.id}/logo`)
      .expect(404);

    expect(response.body.message).toBe('Organization logo not found');
  });

  test('GET /organization/:id/logo returns a PNG file when a logo exists', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-logo-success@example.com' });
    const filename = 'organization-logo-test.png';
    const filePath = path.join(ORG_LOGO_UPLOAD_DIR, filename);

    await fs.promises.mkdir(ORG_LOGO_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, await fs.promises.readFile(path.join(process.cwd(), 'package.json')).catch(() => Buffer.from('png')));
    await transaction
      .updateTable('organization_account')
      .set({ logo_path: filename })
      .where('id', '=', organization.id)
      .execute();

    try {
      const response = await server
        .get(`/organization/${organization.id}/logo`)
        .expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toBeInstanceOf(Buffer);
    } finally {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  });

  test('GET /organization/:id/signature returns 404 when signature is missing', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-signature-missing@example.com' });

    const response = await server
      .get(`/organization/${organization.id}/signature`)
      .expect(404);

    expect(response.body.message).toBe('Organization signature not found');
  });

  test('GET /organization/:id/signature returns SVG content type when signature exists', async () => {
    const { organization } = await createOrganizationAccount(transaction, { email: 'org-signature-success@example.com' });
    const filename = 'organization-signature-test.svg';
    const filePath = path.join(ORG_SIGNATURE_UPLOAD_DIR, filename);

    await fs.promises.mkdir(ORG_SIGNATURE_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, '<svg></svg>');

    const certificateInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        signature_path: filename,
        certificate_feature_enabled: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ certificate_info_id: certificateInfo.id })
      .where('id', '=', organization.id)
      .execute();

    try {
      const response = await server
        .get(`/organization/${organization.id}/signature`)
        .expect(200);

      expect(response.headers['content-type']).toBe('image/svg+xml');
      expect(response.body.toString()).toContain('<svg');
    } finally {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  });

  test('GET /organization/crises/pinned returns only pinned crises', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-crises-pinned@example.com' });
    await transaction
      .insertInto('crisis')
      .values([{ name: 'Pinned Crisis', description: 'Urgent', pinned: true }, { name: 'Normal Crisis', description: 'Regular', pinned: false }])
      .execute();

    const response = await server
      .get('/organization/crises/pinned')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.crises).toHaveLength(1);
    expect(response.body.crises[0].name).toBe('Pinned Crisis');
  });

  test('GET /organization/crises filters pinned crises when pinned=true', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-crises-filter-true@example.com' });
    await transaction
      .insertInto('crisis')
      .values([
        { name: 'Pinned Alpha', description: 'Urgent', pinned: true },
        { name: 'Unpinned Beta', description: 'Regular', pinned: false },
      ])
      .execute();

    const response = await server
      .get('/organization/crises?pinned=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.crises).toHaveLength(1);
    expect(response.body.crises[0].name).toBe('Pinned Alpha');
    expect(response.body.crises[0].pinned).toBe(true);
  });

  test('GET /organization/crises filters unpinned crises when pinned=false', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-crises-filter-false@example.com' });
    await transaction
      .insertInto('crisis')
      .values([
        { name: 'Pinned Gamma', description: 'Urgent', pinned: true },
        { name: 'Unpinned Delta', description: 'Regular', pinned: false },
      ])
      .execute();

    const response = await server
      .get('/organization/crises?pinned=false')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.crises).toHaveLength(1);
    expect(response.body.crises[0].name).toBe('Unpinned Delta');
    expect(response.body.crises[0].pinned).toBe(false);
  });

  test('GET /organization/crises/:id returns a crisis by id and 404 when missing', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'org-crises-by-id@example.com' });
    const inserted = await transaction
      .insertInto('crisis')
      .values({ name: 'Single Crisis', description: 'Single', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .get(`/organization/crises/${inserted.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.crisis).toMatchObject({ id: inserted.id, name: 'Single Crisis' });

    await server
      .get('/organization/crises/999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  test('GET /organization/volunteer/:id/cv returns a volunteer CV when relationship exists', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-cv-success@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-cv@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'CV Event',
        description: 'Event',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 3,
        start_date: new Date('2026-10-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-10-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'CV Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id, message: 'Hello' })
      .execute();

    const cvFilename = 'vol-cv-test.pdf';
    const cvPath = path.join(CV_UPLOAD_DIR, cvFilename);
    await fs.promises.mkdir(CV_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(cvPath, 'PDF content');
    await transaction
      .updateTable('volunteer_account')
      .set({ cv_path: cvFilename })
      .where('id', '=', volunteer.id)
      .execute();

    try {
      const response = await server
        .get(`/organization/volunteer/${volunteer.id}/cv`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('attachment');
    } finally {
      await fs.promises.unlink(cvPath).catch(() => {});
    }
  });

  test('GET /organization/volunteer/:id/cv returns 404 when volunteer has no CV', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-cv-missing@example.com' });
    const { volunteer } = await createVolunteerAccount(transaction, { email: 'vol-cv-missing@example.com' });
    const posting = await transaction
      .insertInto('posting')
      .values({
        organization_id: organization.id,
        title: 'CV Missing Event',
        description: 'Event',
        latitude: 33.9,
        longitude: 35.5,
        max_volunteers: 3,
        start_date: new Date('2026-10-01T00:00:00.000Z'),
        start_time: '09:00:00',
        end_date: new Date('2026-10-01T00:00:00.000Z'),
        end_time: '17:00:00',
        minimum_age: 18,
        automatic_acceptance: false,
        is_closed: false,
        allows_partial_attendance: false,
        location_name: 'CV Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto('enrollment_application')
      .values({ volunteer_id: volunteer.id, posting_id: posting.id, message: 'Hello' })
      .execute();

    await server
      .get(`/organization/volunteer/${volunteer.id}/cv`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  test('DELETE /organization/logo returns 400 when certificates are enabled', async () => {
    const { organization, token } = await createOrganizationAccount(transaction, { email: 'org-delete-logo-locked@example.com' });
    const logoFilename = 'org-delete-logo.png';
    const logoPath = path.join(ORG_LOGO_UPLOAD_DIR, logoFilename);
    await fs.promises.mkdir(ORG_LOGO_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(logoPath, 'logo');

    const certificateInfo = await transaction
      .insertInto('organization_certificate_info')
      .values({
        signature_path: null,
        certificate_feature_enabled: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await transaction
      .updateTable('organization_account')
      .set({ logo_path: logoFilename, certificate_info_id: certificateInfo.id })
      .where('id', '=', organization.id)
      .execute();

    try {
      const response = await server
        .delete('/organization/logo')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      expect(response.body.message).toBe('Disable certificates before removing organization profile picture.');
    } finally {
      await fs.promises.unlink(logoPath).catch(() => {});
    }
  });
});
