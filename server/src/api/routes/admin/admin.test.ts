import fs from 'fs';
import path from 'path';

import sharp from 'sharp';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import createApp from '../../../app.ts';
import database from '../../../db/index.ts';
import * as embeddingService from '../../../services/embeddings/updates.ts';
import * as emailService from '../../../services/resend/emails.ts';
import { PLATFORM_SIGNATURE_UPLOAD_DIR } from '../../../services/uploads/paths.ts';
import { getAbsolutePlatformSignaturePath } from '../../../services/uploads/platformSignature.ts';
import { createAdminAccount, createOrganizationAccount } from '../../../tests/fixtures/accounts.ts';

import type { Database } from '../../../db/tables/index.ts';
import type { ControlledTransaction } from 'kysely';
import type TestAgent from 'supertest/lib/agent.js';

const sendAcceptanceEmailSpy = vi.spyOn(emailService, 'sendOrganizationAcceptanceEmail').mockResolvedValue(undefined);
const sendRejectionEmailSpy = vi.spyOn(emailService, 'sendOrganizationRejectionEmail').mockResolvedValue(undefined);
const recomputeOrganizationVectorSpy = vi.spyOn(embeddingService, 'recomputeOrganizationVector').mockResolvedValue(null);

let transaction: ControlledTransaction<Database>;
let server: TestAgent;
let adminToken: string;
let adminId: number;

beforeEach(async () => {
  transaction = await database.startTransaction().execute();
  server = supertest(createApp(transaction));

  const { admin, token } = await createAdminAccount(transaction, {
    email: 'admin-routes@example.com',
    password: 'AdminPassword123!',
    first_name: 'Admin',
    last_name: 'Tester',
  });

  adminToken = token;
  adminId = admin.id;
});

afterEach(async () => {
  await transaction.rollback().execute();
  vi.clearAllMocks();
});

describe('Admin route coverage', () => {
  test('POST /admin/login rejects invalid payload', async () => {
    await server
      .post('/admin/login')
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  test('POST /admin/login rejects invalid credentials', async () => {
    await server
      .post('/admin/login')
      .send({ email: 'admin-routes@example.com', password: 'wrong-password' })
      .expect(403);
  });

  test('POST /admin/login returns admin token and user data', async () => {
    const response = await server
      .post('/admin/login')
      .send({ email: 'admin-routes@example.com', password: 'AdminPassword123!' })
      .expect(200);

    expect(typeof response.body.token).toBe('string');
    expect(response.body.admin).toMatchObject({
      id: adminId,
      email: 'admin-routes@example.com',
      first_name: 'Admin',
      last_name: 'Tester',
    });
    expect(response.body.admin.password).toBeUndefined();
  });

  test('GET /admin/me returns admin profile for admin token', async () => {
    const response = await server
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.admin).toMatchObject({
      id: adminId,
      email: 'admin-routes@example.com',
    });
    expect(response.body.admin.password).toBeUndefined();
  });

  test('GET /admin/me rejects a non-admin token', async () => {
    const { token } = await createOrganizationAccount(transaction, { email: 'not-admin@example.com' });

    await server
      .get('/admin/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('GET /admin/getOrganizationRequests returns organization requests', async () => {
    await transaction
      .insertInto('organization_request')
      .values([
        {
          name: 'First Org',
          email: 'first@example.com',
          phone_number: '+96170000001',
          url: 'https://first.example',
          latitude: 33.9,
          longitude: 35.5,
          location_name: 'First Location',
        },
        {
          name: 'Second Org',
          email: 'second@example.com',
          phone_number: '+96170000002',
          url: 'https://second.example',
          latitude: 33.8,
          longitude: 35.4,
          location_name: 'Second Location',
        },
      ])
      .execute();

    const response = await server
      .get('/admin/getOrganizationRequests?sortBy=name&sortDir=asc')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.organizationRequests).toHaveLength(2);
    expect(response.body.organizationRequests[0].name).toBe('First Org');
    expect(response.body.organizationRequests[1].name).toBe('Second Org');
  });

  test('GET /admin/getOrganizationRequests filters by name, email, and location search text', async () => {
    await transaction
      .insertInto('organization_request')
      .values([
        {
          name: 'Alpha Relief',
          email: 'alpha@example.com',
          phone_number: '+96170000011',
          url: 'https://alpha.example',
          latitude: 33.91,
          longitude: 35.51,
          location_name: 'Beirut Center',
        },
        {
          name: 'Beta Support',
          email: 'contact@beta.org',
          phone_number: '+96170000012',
          url: 'https://beta.example',
          latitude: 33.92,
          longitude: 35.52,
          location_name: 'Tripoli North',
        },
      ])
      .execute();

    const byName = await server
      .get('/admin/getOrganizationRequests?search=alpha')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(byName.body.organizationRequests).toHaveLength(1);
    expect(byName.body.organizationRequests[0].name).toBe('Alpha Relief');

    const byEmail = await server
      .get('/admin/getOrganizationRequests?search=beta.org')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(byEmail.body.organizationRequests).toHaveLength(1);
    expect(byEmail.body.organizationRequests[0].email).toBe('contact@beta.org');

    const byLocation = await server
      .get('/admin/getOrganizationRequests?search=tripoli')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(byLocation.body.organizationRequests).toHaveLength(1);
    expect(byLocation.body.organizationRequests[0].location_name).toBe('Tripoli North');
  });

  test('POST /admin/reviewOrganizationRequest rejects a request and sends rejection email', async () => {
    const createdRequest = await transaction
      .insertInto('organization_request')
      .values({
        name: 'Rejected Org',
        email: 'rejected@example.com',
        phone_number: '+96170000003',
        url: 'https://rejected.example',
        latitude: 34.0,
        longitude: 35.6,
        location_name: 'Rejected Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .post('/admin/reviewOrganizationRequest')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ requestId: createdRequest.id, accepted: false, reason: 'Not a good fit' })
      .expect(200);

    const remainingRequest = await transaction
      .selectFrom('organization_request')
      .select('id')
      .where('id', '=', createdRequest.id)
      .executeTakeFirst();

    expect(remainingRequest).toBeUndefined();
    expect(sendRejectionEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendRejectionEmailSpy).toHaveBeenCalledWith(expect.objectContaining({ id: createdRequest.id }), 'Not a good fit');
  });

  test('POST /admin/reviewOrganizationRequest accepts a request and creates an organization account', async () => {
    const createdRequest = await transaction
      .insertInto('organization_request')
      .values({
        name: 'Accepted Org',
        email: 'accepted@example.com',
        phone_number: '+96170000004',
        url: 'https://accepted.example',
        latitude: 34.1,
        longitude: 35.7,
        location_name: 'Accepted Location',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .post('/admin/reviewOrganizationRequest')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ requestId: createdRequest.id, accepted: true, reason: null })
      .expect(200);

    expect(response.body.organization).toMatchObject({
      email: 'accepted@example.com',
      name: 'Accepted Org',
      location_name: 'Accepted Location',
    });

    const organizationRow = await transaction
      .selectFrom('organization_account')
      .select('id')
      .where('email', '=', 'accepted@example.com')
      .executeTakeFirstOrThrow();

    expect(organizationRow).toBeDefined();
    expect(sendAcceptanceEmailSpy).toHaveBeenCalledTimes(1);
    expect(recomputeOrganizationVectorSpy).toHaveBeenCalledWith(organizationRow.id, transaction);
  });
});

describe('Admin crises routes', () => {
  test('GET /admin/crises returns empty list initially', async () => {
    const response = await server
      .get('/admin/crises')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.crises).toEqual([]);
  });

  test('POST /admin/crises creates a new crisis', async () => {
    const response = await server
      .post('/admin/crises')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test Crisis', description: 'Test description' })
      .expect(201);

    expect(response.body.crisis).toMatchObject({ name: 'Test Crisis', description: 'Test description', pinned: false });
  });

  test('PUT /admin/crises/:id updates the crisis', async () => {
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Update Crisis', description: 'Old description', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .put(`/admin/crises/${crisis.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Crisis', description: 'Updated description' })
      .expect(200);

    expect(response.body.crisis).toMatchObject({ id: crisis.id, name: 'Updated Crisis', description: 'Updated description' });
  });

  test('PATCH /admin/crises/:id/pin updates pinned status', async () => {
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Pin Crisis', description: 'Pin me', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .patch(`/admin/crises/${crisis.id}/pin`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pinned: true })
      .expect(200);

    expect(response.body.crisis).toMatchObject({ id: crisis.id, pinned: true });
  });

  test('DELETE /admin/crises/:id deletes the crisis', async () => {
    const crisis = await transaction
      .insertInto('crisis')
      .values({ name: 'Delete Crisis', description: 'Delete me', pinned: false })
      .returningAll()
      .executeTakeFirstOrThrow();

    await server
      .delete(`/admin/crises/${crisis.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const deleted = await transaction
      .selectFrom('crisis')
      .select('id')
      .where('id', '=', crisis.id)
      .executeTakeFirst();

    expect(deleted).toBeUndefined();
  });
});

describe('Admin certificate settings routes', () => {
  test('GET /admin/certificate-settings returns null when no settings exist', async () => {
    const response = await server
      .get('/admin/certificate-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.settings).toBeNull();
  });

  test('PUT /admin/certificate-settings creates certificate settings', async () => {
    const response = await server
      .put('/admin/certificate-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ signatory_name: 'Admin Signatory', signatory_position: 'Director' })
      .expect(200);

    expect(response.body.settings).toMatchObject({
      signatory_name: 'Admin Signatory',
      signatory_position: 'Director',
      signature_path: null,
      signature_uploaded_by_admin_id: null,
    });
  });

  test('PUT /admin/certificate-settings updates existing certificate settings', async () => {
    await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Original Name',
        signatory_position: 'Original Position',
        signature_path: null,
        signature_uploaded_by_admin_id: null,
      })
      .execute();

    const response = await server
      .put('/admin/certificate-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ signatory_name: 'Updated Name' })
      .expect(200);

    expect(response.body.settings).toMatchObject({
      signatory_name: 'Updated Name',
      signatory_position: 'Original Position',
    });
  });

  test('DELETE /admin/certificate-settings/signature returns 404 when settings absent', async () => {
    const response = await server
      .delete('/admin/certificate-settings/signature')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    expect(response.body.message).toBe('Platform certificate settings not found');
  });

  test('DELETE /admin/certificate-settings/signature clears an existing signature path', async () => {
    const settings = await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Signer',
        signatory_position: 'Position',
        signature_path: 'platform-signature-test.png',
        signature_uploaded_by_admin_id: adminId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const response = await server
      .delete('/admin/certificate-settings/signature')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body).toEqual({});

    const updatedSettings = await transaction
      .selectFrom('platform_certificate_settings')
      .selectAll()
      .where('id', '=', settings.id)
      .executeTakeFirstOrThrow();

    expect(updatedSettings.signature_path).toBeNull();
    expect(updatedSettings.signature_uploaded_by_admin_id).toBeNull();
  });

  test('POST /admin/certificate-settings/upload-signature rejects missing file', async () => {
    const response = await server
      .post('/admin/certificate-settings/upload-signature')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(response.body.message).toBe('No signature file provided');
  });

  test('POST /admin/certificate-settings/upload-signature returns 400 for invalid image data', async () => {
    const invalidSignaturePath = path.join(PLATFORM_SIGNATURE_UPLOAD_DIR, 'invalid-signature.png');
    await fs.promises.mkdir(PLATFORM_SIGNATURE_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(invalidSignaturePath, 'not-a-real-image');

    try {
      const response = await server
        .post('/admin/certificate-settings/upload-signature')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('signature', invalidSignaturePath, {
          filename: 'invalid-signature.png',
          contentType: 'image/png',
        })
        .expect(400);

      expect(response.body.message).toBe('Failed to process signature image. Please upload a valid PNG, JPG, or SVG file.');
    } finally {
      await fs.promises.unlink(invalidSignaturePath).catch(() => {});
    }
  });

  test('POST /admin/certificate-settings/upload-signature stores a normalized PNG and returns settings', async () => {
    const validPng = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();
    const tempInputPath = path.join(PLATFORM_SIGNATURE_UPLOAD_DIR, 'signature-input.png');
    let normalizedPath: string | null = null;

    await fs.promises.mkdir(PLATFORM_SIGNATURE_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(tempInputPath, validPng);

    try {
      const response = await server
        .post('/admin/certificate-settings/upload-signature')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('signature', tempInputPath, {
          filename: 'signature.png',
          contentType: 'image/png',
        })
        .expect(200);

      expect(response.body.settings).toMatchObject({
        signatory_name: null,
        signatory_position: null,
        signature_uploaded_by_admin_id: adminId,
      });
      expect(typeof response.body.settings.signature_path).toBe('string');
      expect(response.body.settings.signature_path.endsWith('.png')).toBe(true);

      normalizedPath = response.body.settings.signature_path as string;
      const normalizedAbsolutePath = getAbsolutePlatformSignaturePath(normalizedPath);
      const normalizedStat = await fs.promises.stat(normalizedAbsolutePath);
      expect(normalizedStat.isFile()).toBe(true);
    } finally {
      if (normalizedPath) {
        await fs.promises.unlink(getAbsolutePlatformSignaturePath(normalizedPath)).catch(() => {});
      }
      await fs.promises.unlink(tempInputPath).catch(() => {});
    }
  });

  test('POST /admin/certificate-settings/upload-signature replaces existing signature file', async () => {
    const oldSignatureName = 'platform-signature-old.png';
    const oldSignaturePath = path.join(PLATFORM_SIGNATURE_UPLOAD_DIR, oldSignatureName);
    await fs.promises.mkdir(PLATFORM_SIGNATURE_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(oldSignaturePath, 'old-signature-content');

    const settings = await transaction
      .insertInto('platform_certificate_settings')
      .values({
        signatory_name: 'Signer',
        signatory_position: 'Position',
        signature_path: oldSignatureName,
        signature_uploaded_by_admin_id: adminId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const validPng = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();
    const tempInputPath = path.join(PLATFORM_SIGNATURE_UPLOAD_DIR, 'signature-input.png');
    let newSignaturePath: string | null = null;

    await fs.promises.mkdir(PLATFORM_SIGNATURE_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(tempInputPath, validPng);

    try {
      const response = await server
        .post('/admin/certificate-settings/upload-signature')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('signature', tempInputPath, {
          filename: 'signature.png',
          contentType: 'image/png',
        })
        .expect(200);

      expect(response.body.settings.id).toBe(settings.id);
      expect(response.body.settings.signature_path).not.toBe(oldSignatureName);
      expect(response.body.settings.signature_uploaded_by_admin_id).toBe(adminId);

      newSignaturePath = response.body.settings.signature_path as string;
      expect(await fs.promises.access(oldSignaturePath).then(() => false).catch(() => true)).toBe(true);
      expect(await fs.promises.access(getAbsolutePlatformSignaturePath(newSignaturePath)).then(() => true).catch(() => false)).toBe(true);
    } finally {
      if (newSignaturePath) {
        await fs.promises.unlink(getAbsolutePlatformSignaturePath(newSignaturePath)).catch(() => {});
      }
      await fs.promises.unlink(oldSignaturePath).catch(() => {});
      await fs.promises.unlink(tempInputPath).catch(() => {});
    }
  });
});
