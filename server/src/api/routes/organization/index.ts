import fs from 'fs';
import path from 'path';

import { Router, type Request, type Response } from 'express';
import { sql, type Kysely } from 'kysely';
import zod from 'zod';

import createOrganizationCertificateInfoRouter from './certificateInfo.ts';
import {
  type OrganizationGetLogoFileResponse,
  type OrganizationGetSignatureFileResponse,
  type OrganizationDeleteLogoResponse,
  type OrganizationCrisisResponse,
  type OrganizationCrisesResponse,
  type OrganizationGetMeResponse,
  type OrganizationOrganizationSearchResponse,
  type OrganizationPinnedCrisesResponse,
  type OrganizationProfileResponse,
  type OrganizationReportVolunteerResponse,
  type OrganizationRequestResponse,
  type OrganizationUpdateProfileResponse,
  type OrganizationVolunteerCvDownloadResponse,
  type OrganizationVolunteerProfileResponse,
  type OrganizationUploadLogoResponse,
} from './index.types.ts';
import createPostingRouter from './posting.ts';
import authorizeOnly from '../../../auth/authorizeOnly.ts';
import createResetPassword from '../../../auth/resetPassword.ts';
import {
  newOrganizationRequestSchema,
  newVolunteerReportSchema,
  organizationAccountSchema,
  type PostingSkill,
  type Database,
} from '../../../db/tables/index.ts';
import { recomputeOrganizationVector } from '../../../services/embeddings/updates.ts';
import { sendAdminOrganizationRequestEmail } from '../../../services/resend/emails.ts';
import { orgLogoMulter } from '../../../services/uploads/orgLogo.ts';
import { CV_UPLOAD_DIR, ORG_LOGO_UPLOAD_DIR, ORG_SIGNATURE_UPLOAD_DIR } from '../../../services/uploads/paths.ts';
import uploadSingle from '../../../services/uploads/uploadSingle.ts';
import { getVolunteerProfile } from '../../../services/volunteer/index.ts';
import { normalizeSearchTerms } from '../utils/postingList.js';
import { canRecomputeProfileVector } from '../utils/rateLimit.ts';

const organizationProfileResponseColumns = [
  'id',
  'name',
  'email',
  'phone_number',
  'url',
  'description',
  'latitude',
  'longitude',
  'location_name',
  'logo_path',
  'created_at',
  'updated_at',
] as const;

const organizationPrivateResponseColumns = [
  'id',
  'name',
  'email',
  'phone_number',
  'url',
  'description',
  'latitude',
  'longitude',
  'location_name',
  'logo_path',
] as const;

const postingResponseColumns = [
  'posting.id',
  'posting.organization_id',
  'posting.crisis_id',
  'posting.title',
  'posting.description',
  'posting.latitude',
  'posting.longitude',
  'posting.max_volunteers',
  'posting.start_date',
  'posting.start_time',
  'posting.end_date',
  'posting.end_time',
  'posting.minimum_age',
  'posting.automatic_acceptance',
  'posting.is_closed',
  'posting.allows_partial_attendance',
  'posting.location_name',
  'posting.created_at',
  'posting.updated_at',
] as const;

const organizationProfileUpdateSchema = organizationAccountSchema
  .omit({
    id: true,
    password: true,
    email: true,
    name: true,
    url: true,
    org_context_vector: true,
    created_at: true,
    updated_at: true,
  })
  .partial();

const isSameNullableNumber = (
  left: number | null | undefined,
  right: number | null | undefined,
) => (left ?? null) === (right ?? null);

function createOrganizationRouter(db: Kysely<Database>) {
  const hasVolunteerRelationshipWithOrganization = async (
    organizationId: number,
    volunteerId: number,
  ) => {
    const relatedApplication = await db
      .selectFrom('enrollment_application')
      .innerJoin(
        'posting',
        'posting.id',
        'enrollment_application.posting_id',
      )
      .select('enrollment_application.id')
      .where('enrollment_application.volunteer_id', '=', volunteerId)
      .where('posting.organization_id', '=', organizationId)
      .executeTakeFirst();

    if (relatedApplication) return true;

    const relatedEnrollment = await db
      .selectFrom('enrollment')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .select('enrollment.id')
      .where('enrollment.volunteer_id', '=', volunteerId)
      .where('posting.organization_id', '=', organizationId)
      .executeTakeFirst();

    return Boolean(relatedEnrollment);
  };

  const organizationRouter = Router();

  organizationRouter.post('/request', async (req, res: Response<OrganizationRequestResponse>) => {
    const body = newOrganizationRequestSchema.parse(req.body);

    const email = body.email;

    const checkAccountRequest = await db
      .selectFrom('organization_account')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (checkAccountRequest) {
      res.status(400);
      throw new Error('An organization with this email account already exists');
    }

    const checkVolunteerAccount = await db
      .selectFrom('volunteer_account')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (checkVolunteerAccount) {
      res.status(400);
      throw new Error('An account with this email already exists');
    }

    const checkPendingRequest = await db
      .selectFrom('organization_request')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (checkPendingRequest) {
      res.status(400);
      throw new Error('A request with this email is already pending');
    }

    const organization = await db
      .insertInto('organization_request')
      .values(body)
      .returningAll()
      .executeTakeFirst();

    if (!organization) {
      throw new Error('Failed to create organization request');
    }

    const adminEmails = (await db.selectFrom('admin_account').select('email').execute()).map(
      row => row.email,
    );

    await sendAdminOrganizationRequestEmail(organization, adminEmails);
    res.json({});
  });

  organizationRouter.get('/:id/logo', async (req, res: Response<OrganizationGetLogoFileResponse>, next) => {
    const { id } = zod
      .object({
        id: zod.coerce.number().int().positive('ID must be a positive number'),
      })
      .parse(req.params);

    const organization = await db
      .selectFrom('organization_account')
      .select(['logo_path'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!organization?.logo_path) {
      res.status(404);
      throw new Error('Organization logo not found');
    }

    const ext = path.extname(organization.logo_path).toLowerCase();
    if (ext === '.png') {
      res.setHeader('Content-Type', 'image/png');
    } else {
      res.setHeader('Content-Type', 'image/jpeg');
    }
    res.setHeader('Content-Disposition', 'inline; filename="organization-logo"');

    res.sendFile(organization.logo_path, { root: ORG_LOGO_UPLOAD_DIR }, (error) => {
      if (!error) return;
      next(error);
    });
  });

  organizationRouter.get(
    '/:id/signature',
    async (req, res: Response<OrganizationGetSignatureFileResponse>, next) => {
      const { id } = zod
        .object({
          id: zod.coerce.number().int().positive('ID must be a positive number'),
        })
        .parse(req.params);

      const organization = await db
        .selectFrom('organization_account')
        .leftJoin(
          'organization_certificate_info',
          'organization_certificate_info.id',
          'organization_account.certificate_info_id',
        )
        .select(['organization_certificate_info.signature_path'])
        .where('organization_account.id', '=', id)
        .executeTakeFirst();

      if (!organization?.signature_path) {
        res.status(404);
        throw new Error('Organization signature not found');
      }

      const ext = path.extname(organization.signature_path).toLowerCase();
      if (ext === '.png') {
        res.setHeader('Content-Type', 'image/png');
      } else if (ext === '.svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
      } else {
        res.setHeader('Content-Type', 'image/jpeg');
      }
      res.setHeader('Content-Disposition', 'inline; filename="organization-signature"');

      res.sendFile(organization.signature_path, { root: ORG_SIGNATURE_UPLOAD_DIR }, (error) => {
        if (!error) return;
        next(error);
      });
    },
  );

  organizationRouter.get('/:id', async (req, res: Response<OrganizationProfileResponse>, next) => {
    let orgId;
    try {
      orgId = zod
        .object({
          id: zod.coerce.number(),
        })
        .parse(req.params).id;
    } catch (_error: unknown) {
      next();
      return;
    }

    const organization = await db
      .selectFrom('organization_account')
      .select([...organizationProfileResponseColumns, 'is_deleted', 'is_disabled'])
      .where('id', '=', orgId)
      .executeTakeFirst();

    if (!organization) {
      res.status(404);
      throw new Error('Organization not found');
    }

    if (organization.is_deleted || organization.is_disabled) {
      res.status(410);
      throw new Error('This organization is no longer available');
    }

    const { is_deleted: _d, is_disabled: _i, ...organizationProfile } = organization;

    const postings = await db
      .selectFrom('posting')
      .select(postingResponseColumns)
      .where('organization_id', '=', orgId)
      .orderBy('posting.start_date', 'asc')
      .orderBy('posting.start_time', 'asc')
      .execute();

    const postingIds = postings.map(p => p.id);
    const skills = postingIds.length > 0
      ? await db
          .selectFrom('posting_skill')
          .selectAll()
          .where('posting_id', 'in', postingIds)
          .execute()
      : [];

    const enrollmentsByPosting = postingIds.length > 0
      ? await db
          .selectFrom('enrollment')
          .select([
            'posting_id',
            sql<number>`COUNT(*)`.as('enrollment_count'),
          ])
          .where('posting_id', 'in', postingIds)
          .groupBy('posting_id')
          .execute()
      : [];

    const enrollmentCountByPostingId = new Map<number, number>(
      enrollmentsByPosting.map(row => [row.posting_id, Number(row.enrollment_count ?? 0)]),
    );

    const skillsByPostingId = new Map<number, PostingSkill[]>();
    skills.forEach((skill) => {
      if (!skillsByPostingId.has(skill.posting_id)) {
        skillsByPostingId.set(skill.posting_id, []);
      }
      skillsByPostingId.get(skill.posting_id)!.push(skill);
    });

    const postingsWithSkills = postings.map(posting => ({
      ...posting,
      skills: skillsByPostingId.get(posting.id) || [],
      enrollment_count: enrollmentCountByPostingId.get(posting.id) ?? 0,
    }));

    res.json({ organization: organizationProfile, postings: postingsWithSkills });
  });

  organizationRouter.use(authorizeOnly('organization'));

  organizationRouter.get('/crises/pinned', async (_req, res: Response<OrganizationPinnedCrisesResponse>) => {
    const crises = await db
      .selectFrom('crisis')
      .selectAll()
      .where('pinned', '=', true)
      .orderBy('created_at', 'desc')
      .execute();

    res.json({ crises });
  });

  organizationRouter.get('/crises', async (req, res: Response<OrganizationCrisesResponse>) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const sortBy = typeof req.query.sort_by === 'string' ? req.query.sort_by : 'pinned_first';
    const pinnedFilter = typeof req.query.pinned === 'string'
      ? req.query.pinned === 'true'
        ? true
        : req.query.pinned === 'false'
          ? false
          : undefined
      : undefined;

    let query = db
      .selectFrom('crisis')
      .selectAll();

    if (search) {
      const terms = normalizeSearchTerms(search);
      query = query.where(({ and, or }) => and(
        terms.map((term) => {
          const likePattern = `%${term}%`;
          return or([
            sql<boolean>`lower(crisis.name) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(crisis.name), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(coalesce(crisis.description, '')) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(coalesce(crisis.description, '')), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
          ]);
        }),
      ));
    }

    if (typeof pinnedFilter === 'boolean') {
      query = query.where('pinned', '=', pinnedFilter);
    }

    switch (sortBy) {
      case 'pinned_first':
        query = query.orderBy('pinned', 'desc').orderBy('created_at', 'desc');
        break;
      case 'title_desc':
        query = query.orderBy('name', 'desc');
        break;
      case 'title_asc':
      default:
        query = query.orderBy('name', 'asc');
        break;
    }

    const crises = await query.execute();

    res.json({ crises });
  });

  organizationRouter.get('/crises/:id', async (req, res: Response<OrganizationCrisisResponse>) => {
    const { id } = zod
      .object({
        id: zod.coerce.number().int().positive('ID must be a positive number'),
      })
      .parse(req.params);

    const crisis = await db.selectFrom('crisis').selectAll().where('id', '=', id).executeTakeFirst();

    if (!crisis) {
      res.status(404);
      throw new Error('Crisis not found');
    }

    res.json({ crisis });
  });

  organizationRouter.get('/me', async (req, res: Response<OrganizationGetMeResponse>) => {
    const organization = await db
      .selectFrom('organization_account')
      .select(organizationPrivateResponseColumns)
      .where('id', '=', req.userJWT!.id)
      .where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();

    res.json({ organization });
  });

  organizationRouter.get('/organizations', async (req, res: Response<OrganizationOrganizationSearchResponse>) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const certificateEnabled = typeof req.query.certificate_enabled === 'string' ? req.query.certificate_enabled : 'all';

    let query = db
      .selectFrom('organization_account')
      .leftJoin('posting', 'posting.organization_id', 'organization_account.id')
      .leftJoin('organization_certificate_info', 'organization_certificate_info.id', 'organization_account.certificate_info_id')
      .select([
        'organization_account.id',
        'organization_account.name',
        'organization_account.description',
        'organization_account.location_name',
        'organization_account.logo_path',
        sql<number>`COALESCE(COUNT(posting.id), 0)`.as('posting_count'),
      ])
      .where('organization_account.is_deleted', '=', false)
      .where('organization_account.is_disabled', '=', false)
      .groupBy('organization_account.id');

    if (certificateEnabled === 'enabled') {
      query = query.where('organization_certificate_info.certificate_feature_enabled', '=', true);
    } else if (certificateEnabled === 'disabled') {
      query = query.where(({ or }) => or([
        sql<boolean>`organization_certificate_info.certificate_feature_enabled = false`,
        sql<boolean>`organization_certificate_info.certificate_feature_enabled IS NULL`,
      ]));
    }

    if (search) {
      const terms = normalizeSearchTerms(search);
      query = query.where(({ and, or }) => and(
        terms.map((term) => {
          const likePattern = `%${term}%`;
          return or([
            sql<boolean>`lower(organization_account.name) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(organization_account.name), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(organization_account.description) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(organization_account.description), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(organization_account.location_name) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(organization_account.location_name), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
          ]);
        }),
      ));
    }

    const sortBy = typeof req.query.sort_by === 'string' ? req.query.sort_by : 'name';
    const sortDir = req.query.sort_dir === 'desc' ? 'desc' : 'asc';

    const orderByColumn = sortBy === 'title' ? 'organization_account.name' : 'organization_account.name';

    const organizationsRaw = await query
      .orderBy(orderByColumn, sortDir)
      .limit(30)
      .execute();

    const organizations = organizationsRaw.map(organization => ({
      id: organization.id,
      name: organization.name,
      description: organization.description ?? null,
      location_name: organization.location_name ?? null,
      logo_path: organization.logo_path ?? null,
      posting_count: Number(organization.posting_count ?? 0),
    }));

    res.json({ organizations });
  });

  organizationRouter.get('/volunteer/:id', async (req, res: Response<OrganizationVolunteerProfileResponse>) => {
    const { id: volunteerId } = zod
      .object({
        id: zod.coerce.number().int().positive('Volunteer ID must be a positive number'),
      })
      .parse(req.params);

    const organizationId = req.userJWT!.id;

    const hasRelationship = await hasVolunteerRelationshipWithOrganization(organizationId, volunteerId);
    if (!hasRelationship) {
      res.status(403);
      throw new Error('You can only view profiles of volunteers related to your postings.');
    }

    const volunteerExists = await db
      .selectFrom('volunteer_account')
      .select('id')
      .where('id', '=', volunteerId)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirst();

    if (!volunteerExists) {
      res.status(410);
      throw new Error('This volunteer is no longer available');
    }

    const profile = await getVolunteerProfile(volunteerId);
    res.json({ profile });
  });

  organizationRouter.post('/volunteer/:id/report', async (req, res: Response<OrganizationReportVolunteerResponse>) => {
    const { id: volunteerId } = zod
      .object({
        id: zod.coerce.number().int().positive('Volunteer ID must be a positive number'),
      })
      .parse(req.params);

    const body = newVolunteerReportSchema.parse(req.body);
    const organizationId = req.userJWT!.id;

    const volunteer = await db
      .selectFrom('volunteer_account')
      .select('id')
      .where('id', '=', volunteerId)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirst();

    if (!volunteer) {
      res.status(404);
      throw new Error('Volunteer not found or is no longer available');
    }

    await db
      .insertInto('volunteer_report')
      .values({
        reported_volunteer_id: volunteerId,
        reporter_organization_id: organizationId,
        title: body.title,
        message: body.message,
      })
      .execute();

    res.json({});
  });

  organizationRouter.get(
    '/volunteer/:id/cv',
    async (req, res: Response<OrganizationVolunteerCvDownloadResponse>, next) => {
      const { id: volunteerId } = zod
        .object({
          id: zod.coerce.number().int().positive('Volunteer ID must be a positive number'),
        })
        .parse(req.params);

      const organizationId = req.userJWT!.id;
      const hasRelationship = await hasVolunteerRelationshipWithOrganization(organizationId, volunteerId);
      if (!hasRelationship) {
        res.status(403);
        throw new Error('You can only access CVs of volunteers related to your postings.');
      }

      const volunteer = await db
        .selectFrom('volunteer_account')
        .select(['id', 'cv_path', 'first_name', 'last_name'])
        .where('id', '=', volunteerId)
        .where('is_deleted', '=', false)
        .where('is_disabled', '=', false)
        .executeTakeFirstOrThrow();

      if (!volunteer.cv_path) {
        res.status(404);
        throw new Error('Volunteer CV not found');
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${volunteer.first_name}-${volunteer.last_name}-cv.pdf"`,
      );

      res.sendFile(volunteer.cv_path, { root: CV_UPLOAD_DIR }, (error) => {
        if (!error) return;
        next(error);
      });
    },
  );

  organizationRouter.put('/profile', async (req, res: Response<OrganizationUpdateProfileResponse>) => {
    const body = organizationProfileUpdateSchema.parse(req.body);
    const organizationId = req.userJWT!.id;
    const existingOrganization = await db
      .selectFrom('organization_account')
      .select(['description', 'location_name', 'latitude', 'longitude'])
      .where('id', '=', organizationId)
      .where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();

    const shouldUpdateDescription = body.description !== undefined && body.description !== existingOrganization.description;
    const shouldUpdateLocationName = body.location_name !== undefined && body.location_name !== existingOrganization.location_name;
    const shouldUpdateLatitude = body.latitude !== undefined && !isSameNullableNumber(body.latitude, existingOrganization.latitude);
    const shouldUpdateLongitude = body.longitude !== undefined && !isSameNullableNumber(body.longitude, existingOrganization.longitude);
    const shouldRecomputeOrganizationVector = shouldUpdateDescription || shouldUpdateLocationName || shouldUpdateLatitude || shouldUpdateLongitude;

    if (Object.keys(body).length > 0) {
      await db
        .updateTable('organization_account')
        .set(body)
        .where('id', '=', organizationId)
        .execute();
    }

    if (shouldRecomputeOrganizationVector && canRecomputeProfileVector(req)) {
      await recomputeOrganizationVector(organizationId, db);
    }

    const organization = await db
      .selectFrom('organization_account')
      .select(organizationPrivateResponseColumns)
      .where('id', '=', organizationId)
      .where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();

    res.json({ organization });
  });

  organizationRouter.post(
    '/logo',
    uploadSingle(orgLogoMulter, 'logo'),
    async (req: Request, res: Response<OrganizationUploadLogoResponse>) => {
      if (!req.file) {
        res.status(400);
        throw new Error('No logo file provided');
      }

      const organizationId = req.userJWT!.id;
      const existingOrganization = await db
        .selectFrom('organization_account')
        .select(['logo_path'])
        .where('id', '=', organizationId)
        .where('is_deleted', '=', false)
        .executeTakeFirstOrThrow();

      if (existingOrganization.logo_path) {
        try {
          await fs.promises.unlink(path.join(ORG_LOGO_UPLOAD_DIR, existingOrganization.logo_path));
        } catch {
          // ignore missing old logo file
        }
      }

      await db
        .updateTable('organization_account')
        .set({ logo_path: req.file.filename })
        .where('id', '=', organizationId)
        .execute();

      const organization = await db
        .selectFrom('organization_account')
        .select(organizationPrivateResponseColumns)
        .where('id', '=', organizationId)
        .where('is_deleted', '=', false)
        .executeTakeFirstOrThrow();

      res.json({ organization });
    },
  );

  organizationRouter.delete('/logo', async (req: Request, res: Response<OrganizationDeleteLogoResponse>) => {
    const organizationId = req.userJWT!.id;
    const existingOrganization = await db
      .selectFrom('organization_account')
      .select(['logo_path', 'certificate_info_id'])
      .where('id', '=', organizationId)
      .where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();

    if (existingOrganization.certificate_info_id) {
      const certificateInfo = await db
        .selectFrom('organization_certificate_info')
        .select(['certificate_feature_enabled'])
        .where('id', '=', existingOrganization.certificate_info_id)
        .executeTakeFirst();

      if (certificateInfo?.certificate_feature_enabled) {
        res.status(400);
        throw new Error('Disable certificates before removing organization profile picture.');
      }
    }

    if (existingOrganization.logo_path) {
      try {
        await fs.promises.unlink(path.join(ORG_LOGO_UPLOAD_DIR, existingOrganization.logo_path));
      } catch {
        // ignore missing old logo file
      }
    }

    await db
      .updateTable('organization_account')
      .set({ logo_path: sql`NULL` })
      .where('id', '=', organizationId)
      .execute();

    const organization = await db
      .selectFrom('organization_account')
      .select(organizationPrivateResponseColumns)
      .where('id', '=', organizationId)
      .where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();

    res.json({ organization });
  });

  organizationRouter.post('/reset-password', createResetPassword(db));

  organizationRouter.use('/posting', createPostingRouter(db));
  organizationRouter.use('/certificate-info', createOrganizationCertificateInfoRouter(db));

  return organizationRouter;
}

export default createOrganizationRouter;
