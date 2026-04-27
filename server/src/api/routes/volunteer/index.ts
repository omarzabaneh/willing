import crypto from 'crypto';

import bcrypt from 'bcrypt';
import { Router, type Response } from 'express';
import { sql, type Kysely } from 'kysely';
import zod from 'zod';

import createVolunteerCvRouter from './cv.ts';
import {
  type VolunteerCertificateIssueResponse,
  type VolunteerCrisisResponse,
  type VolunteerCrisesResponse,
  type VolunteerCreateResponse,
  type VolunteerCertificateResponse,
  type VolunteerMeResponse,
  type VolunteerOrganizationSearchResponse,
  type VolunteerPinnedCrisesResponse,
  type VolunteerProfileResponse,
  type VolunteerReportOrganizationResponse,
  type VolunteerResendVerificationResponse,
  type VolunteerVerifyEmailResponse,
} from './index.types.ts';
import createVolunteerPostingRouter from './posting.ts';
import authorizeOnly from '../../../auth/authorizeOnly.ts';
import createResetPassword from '../../../auth/resetPassword.ts';
import config from '../../../config.ts';
import executeTransaction from '../../../db/executeTransaction.ts';
import { type Database, type VolunteerAccountWithoutPassword, newVolunteerAccountSchema, newOrganizationReportSchema, volunteerAccountSchema } from '../../../db/tables/index.ts';
import { emailSchema } from '../../../schemas/index.ts';
import { CERTIFICATE_PAYLOAD_VERSION, CERTIFICATE_TYPE, signCertificateVerificationPayload } from '../../../services/certificates/token.ts';
import {
  recomputeVolunteerExperienceVector,
  recomputeVolunteerProfileVector,
} from '../../../services/embeddings/updates.ts';
import { generateJWT } from '../../../services/jwt/index.ts';
import { sendVolunteerVerificationEmail } from '../../../services/resend/emails.ts';
import { getVolunteerProfile } from '../../../services/volunteer/index.ts';
import { normalizeSearchTerms } from '../utils/postingList.js';
import { canRecomputeProfileVector } from '../utils/rateLimit.ts';

const volunteerResponseColumns = [
  'id',
  'first_name',
  'last_name',
  'email',
  'date_of_birth',
  'gender',
  'cv_path',
  'description',
] as const;

const volunteerProfileUserUpdateSchema = volunteerAccountSchema.omit({
  id: true,
  first_name: true,
  last_name: true,
  password: true,
  email: true,
  date_of_birth: true,
  volunteer_profile_vector: true,
  volunteer_history_vector: true,
  created_at: true,
  updated_at: true,
}).partial();

const volunteerProfileUpdateSchema = volunteerProfileUserUpdateSchema.extend({
  skills: zod.array(zod.string().trim().min(1, 'Skill cannot be empty')).optional(),
});

const normalizeSkillList = (skills: string[]) =>
  Array.from(new Set(skills.map(skill => skill.trim()).filter(Boolean))).sort();

const volunteerCertificateIssueSchema = zod.object({
  org_ids: zod.array(zod.coerce.number().int().positive()).max(4).default([]),
}).superRefine((data, ctx) => {
  if (new Set(data.org_ids).size !== data.org_ids.length) {
    ctx.addIssue({
      code: zod.ZodIssueCode.custom,
      path: ['org_ids'],
      message: 'Organization IDs must be unique.',
    });
  }
});

const areSkillListsEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false;
  return left.every((skill, index) => skill === right[index]);
};

const verifyVolunteerEmailSchema = zod.object({
  key: zod.string().min(1),
});

const VOLUNTEER_VERIFICATION_TOKEN_TTL_MS = 1 * 60 * 60 * 1000;

const resendVolunteerVerificationSchema = zod.object({
  email: emailSchema,
});

function createVolunteerRouter(db: Kysely<Database>) {
  const volunteerRouter = Router();

  volunteerRouter.post('/create', async (req, res: Response<VolunteerCreateResponse>) => {
    const body = newVolunteerAccountSchema.parse(req.body);

    const [existingVolunteer, existingOrganization, existingOrganizationRequest] = await Promise.all([
      db
        .selectFrom('volunteer_account')
        .select('id')
        .where('email', '=', body.email)
        .executeTakeFirst(),
      db
        .selectFrom('organization_account')
        .select('id')
        .where('email', '=', body.email)
        .executeTakeFirst(),
      db
        .selectFrom('organization_request')
        .select('id')
        .where('email', '=', body.email)
        .executeTakeFirst(),
    ]);

    if (existingVolunteer || existingOrganization || existingOrganizationRequest) {
      res.status(409);
      throw new Error('Email already in use, log in or use another email');
    }

    const hashedPassword = await bcrypt.hash(body.password, 10);
    const existingPendingVolunteer = await db
      .selectFrom('volunteer_pending_account')
      .select('id')
      .where('email', '=', body.email)
      .executeTakeFirst();

    if (existingPendingVolunteer) {
      await db
        .deleteFrom('volunteer_pending_account')
        .where('id', '=', existingPendingVolunteer.id)
        .execute();
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');

    await db
      .insertInto('volunteer_pending_account')
      .values({
        ...body,
        date_of_birth: new Date(body.date_of_birth),
        password: hashedPassword,
        token: verificationToken,
      })
      .execute();

    await sendVolunteerVerificationEmail({
      volunteerEmail: body.email,
      volunteerName: `${body.first_name} ${body.last_name}`,
      verificationToken,
    });

    res.json({
      requires_email_verification: true,
    });
  });

  volunteerRouter.post('/verify-email', async (req, res: Response<VolunteerVerifyEmailResponse>) => {
    const { key } = verifyVolunteerEmailSchema.parse(req.body);

    const pendingVolunteer = await db
      .selectFrom('volunteer_pending_account')
      .selectAll('volunteer_pending_account')
      .select([
        sql<boolean>`volunteer_pending_account.created_at + (interval '1 millisecond' * ${VOLUNTEER_VERIFICATION_TOKEN_TTL_MS}) < now()`.as('is_expired')])
      .where('token', '=', key)
      .executeTakeFirst();

    if (!pendingVolunteer) {
      res.status(400);
      throw new Error('Invalid or expired verification token');
    }

    if (pendingVolunteer.is_expired) {
      res.status(400);
      throw new Error('Invalid or expired verification token');
    }

    const [existingVolunteer, existingOrganization] = await Promise.all([
      db
        .selectFrom('volunteer_account')
        .select([
          'id',
          'token_version',
          'is_deleted',
          'is_disabled',
        ])
        .where('email', '=', pendingVolunteer.email)
        .executeTakeFirst(),
      db
        .selectFrom('organization_account')
        .select('id')
        .where('email', '=', pendingVolunteer.email)
        .executeTakeFirst(),
    ]);

    if (existingVolunteer) {
      if (existingVolunteer.is_deleted || existingVolunteer.is_disabled) {
        res.status(403);
        throw new Error('Account is disabled or deleted');
      }

      const volunteer = await db
        .selectFrom('volunteer_account')
        .select(volunteerResponseColumns)
        .where('id', '=', existingVolunteer.id)
        .where('is_deleted', '=', false)
        .where('is_disabled', '=', false)
        .executeTakeFirstOrThrow();

      const token = await generateJWT({
        id: volunteer.id,
        role: 'volunteer',
        token_version: existingVolunteer.token_version,
      });

      res.json({ volunteer, token });
      return;
    }

    if (existingOrganization) {
      await db
        .deleteFrom('volunteer_pending_account')
        .where('id', '=', pendingVolunteer.id)
        .execute();

      res.status(409);
      throw new Error('Account already exists, log in instead');
    }

    const volunteer = await executeTransaction(db, async (trx) => {
      const createdVolunteer = await trx
        .insertInto('volunteer_account')
        .values({
          first_name: pendingVolunteer.first_name,
          last_name: pendingVolunteer.last_name,
          email: pendingVolunteer.email,
          password: pendingVolunteer.password,
          date_of_birth: pendingVolunteer.date_of_birth.toISOString().slice(0, 10),
          gender: pendingVolunteer.gender,
        })
        .returning(volunteerResponseColumns)
        .executeTakeFirst();

      if (!createdVolunteer) {
        res.status(500);
        throw new Error('Failed to verify volunteer account');
      }

      await trx
        .updateTable('volunteer_pending_account')
        .set({ created_at: new Date() })
        .where('id', '=', pendingVolunteer.id)
        .execute();

      return createdVolunteer;
    });

    await recomputeVolunteerProfileVector(volunteer.id, db);
    await recomputeVolunteerExperienceVector(volunteer.id, db);

    const token = await generateJWT({ id: volunteer.id, role: 'volunteer', token_version: 0 });

    res.json({ volunteer, token });
  });

  volunteerRouter.post('/resend-verification', async (req, res: Response<VolunteerResendVerificationResponse>) => {
    const { email } = resendVolunteerVerificationSchema.parse(req.body);

    const existingVolunteer = await db
      .selectFrom('volunteer_account')
      .select(['first_name', 'last_name', 'email', 'password', 'gender', 'date_of_birth'])
      .where('email', '=', email)
      .executeTakeFirst();

    const pendingVolunteer = await db
      .selectFrom('volunteer_pending_account')
      .select(['id', 'first_name', 'last_name', 'email'])
      .where('email', '=', email)
      .executeTakeFirst();

    if (!pendingVolunteer && !existingVolunteer) {
      res.json({});
      return;
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');

    if (pendingVolunteer) {
      await db
        .updateTable('volunteer_pending_account')
        .set({ token: verificationToken, created_at: new Date() })
        .where('id', '=', pendingVolunteer.id)
        .execute();
    } else {
      await db
        .insertInto('volunteer_pending_account')
        .values({
          first_name: existingVolunteer!.first_name,
          last_name: existingVolunteer!.last_name,
          password: existingVolunteer!.password,
          email: existingVolunteer!.email,
          gender: existingVolunteer!.gender,
          date_of_birth: new Date(existingVolunteer!.date_of_birth),
          token: verificationToken,
        })
        .execute();
    }

    const recipient = pendingVolunteer
      ? {
          email: pendingVolunteer.email,
          first_name: pendingVolunteer.first_name,
          last_name: pendingVolunteer.last_name,
        }
      : {
          email: existingVolunteer!.email,
          first_name: existingVolunteer!.first_name,
          last_name: existingVolunteer!.last_name,
        };

    await sendVolunteerVerificationEmail({
      volunteerEmail: recipient.email,
      volunteerName: `${recipient.first_name} ${recipient.last_name}`,
      verificationToken,
    });

    res.json({});
  });

  volunteerRouter.use(authorizeOnly('volunteer'));

  volunteerRouter.get('/me', async (req, res: Response<VolunteerMeResponse>) => {
    const volunteer = await db
      .selectFrom('volunteer_account')
      .select(volunteerResponseColumns)
      .where('id', '=', req.userJWT!.id)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirstOrThrow();

    res.json({ volunteer });
  });

  volunteerRouter.get('/profile', async (req, res: Response<VolunteerProfileResponse>) => {
    const profile = await getVolunteerProfile(req.userJWT!.id);
    res.json(profile);
  });

  volunteerRouter.get('/organizations', async (req, res: Response<VolunteerOrganizationSearchResponse>) => {
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

  volunteerRouter.get('/certificate', async (req, res: Response<VolunteerCertificateResponse>) => {
    const volunteerId = req.userJWT!.id;

    const volunteer = await db
      .selectFrom('volunteer_account')
      .select(['id', 'first_name', 'last_name'])
      .where('id', '=', volunteerId)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirstOrThrow();

    const hoursPerAttendedDateExpr = sql<number>`GREATEST(
      0,
      EXTRACT(EPOCH FROM (
        (enrollment_date.date + posting.end_time)
        - (enrollment_date.date + posting.start_time)
      )) / 3600.0
    )`;

    const totalHoursRow = await db
      .selectFrom('enrollment_date')
      .innerJoin('enrollment', 'enrollment.id', 'enrollment_date.enrollment_id')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .select(sql<number>`COALESCE(SUM(${hoursPerAttendedDateExpr}), 0)`.as('total_hours'))
      .where('enrollment.volunteer_id', '=', volunteerId)
      .where('enrollment_date.attended', '=', true)
      .executeTakeFirstOrThrow();

    const organizations = await db
      .selectFrom('enrollment_date')
      .innerJoin('enrollment', 'enrollment.id', 'enrollment_date.enrollment_id')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .leftJoin(
        'organization_certificate_info',
        'organization_certificate_info.id',
        'organization_account.certificate_info_id',
      )
      .select([
        'organization_account.id',
        'organization_account.name',
        'organization_account.logo_path',
        'organization_account.is_disabled',
        'organization_account.is_deleted',
        'organization_certificate_info.hours_threshold',
        'organization_certificate_info.certificate_feature_enabled',
        'organization_certificate_info.signatory_name',
        'organization_certificate_info.signatory_position',
        'organization_certificate_info.signature_path',
        sql<number>`COALESCE(SUM(${hoursPerAttendedDateExpr}), 0)`.as('hours'),
      ])
      .where('enrollment.volunteer_id', '=', volunteerId)
      .where('enrollment_date.attended', '=', true)
      .groupBy([
        'organization_account.id',
        'organization_account.name',
        'organization_account.logo_path',
        'organization_account.is_disabled',
        'organization_account.is_deleted',
        'organization_certificate_info.hours_threshold',
        'organization_certificate_info.certificate_feature_enabled',
        'organization_certificate_info.signatory_name',
        'organization_certificate_info.signatory_position',
        'organization_certificate_info.signature_path',
      ])
      .orderBy(sql<boolean>`COALESCE(organization_certificate_info.certificate_feature_enabled, false)`, 'desc')
      .orderBy('hours', 'desc')
      .orderBy('organization_account.name', 'asc')
      .execute();

    const platformCertificate = await db
      .selectFrom('platform_certificate_settings')
      .select(['signatory_name', 'signatory_position', 'signature_path'])
      .orderBy('id', 'desc')
      .executeTakeFirst();

    res.json({
      volunteer,
      total_hours: Number(totalHoursRow.total_hours ?? 0),
      organizations: organizations.map((organization) => {
        const hours = Number(organization.hours ?? 0);
        const threshold = organization.hours_threshold ?? null;
        const featureEnabled = Boolean(organization.certificate_feature_enabled);
        const hasSignatoryInfo = Boolean(
          organization.signatory_name?.trim()
          && organization.signatory_position?.trim()
          && organization.signature_path?.trim(),
        );
        const eligible = featureEnabled
          && !organization.is_disabled
          && !organization.is_deleted
          && threshold !== null
          && hasSignatoryInfo
          && hours >= threshold;

        return {
          id: organization.id,
          name: organization.name,
          hours,
          hours_threshold: threshold,
          certificate_feature_enabled: featureEnabled,
          is_disabled: organization.is_disabled,
          is_deleted: organization.is_deleted,
          eligible,
          logo_path: organization.logo_path ?? null,
          signatory_name: organization.signatory_name ?? null,
          signatory_position: organization.signatory_position ?? null,
          signature_path: organization.signature_path ?? null,
        };
      }),
      platform_certificate: platformCertificate
        ? {
            signatory_name: platformCertificate.signatory_name ?? null,
            signatory_position: platformCertificate.signatory_position ?? null,
            signature_path: platformCertificate.signature_path ?? null,
          }
        : null,
    });
  });

  volunteerRouter.post('/certificate/issue', async (req, res: Response<VolunteerCertificateIssueResponse>) => {
    const volunteerId = req.userJWT!.id;
    const body = volunteerCertificateIssueSchema.parse(req.body);
    const issuedAt = new Date();
    const selectedOrgIds = [...body.org_ids].sort((left, right) => left - right);

    const hoursPerAttendedDateExpr = sql<number>`GREATEST(
      0,
      EXTRACT(EPOCH FROM (
        (enrollment_date.date + posting.end_time)
        - (enrollment_date.date + posting.start_time)
      )) / 3600.0
    )`;

    const rows = await db
      .selectFrom('enrollment_date')
      .innerJoin('enrollment', 'enrollment.id', 'enrollment_date.enrollment_id')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .select([
        'posting.organization_id as organization_id',
        sql<number>`COALESCE(SUM(${hoursPerAttendedDateExpr}), 0)`.as('hours'),
      ])
      .where('enrollment.volunteer_id', '=', volunteerId)
      .where('enrollment_date.attended', '=', true)
      .where('enrollment.created_at', '<=', issuedAt)
      .groupBy('posting.organization_id')
      .execute();

    const hoursByOrganizationId = new Map<number, number>();
    rows.forEach((row) => {
      hoursByOrganizationId.set(row.organization_id, Number(Number(row.hours ?? 0).toFixed(2)));
    });

    const totalHours = Number(rows.reduce((sum, row) => sum + Number(row.hours ?? 0), 0).toFixed(2));

    if (totalHours <= 0) {
      res.status(400);
      throw new Error('You need completed volunteering hours before generating a certificate.');
    }

    if (selectedOrgIds.length > 0) {
      const activeOrganizations = await db
        .selectFrom('organization_account')
        .select(['id'])
        .where('id', 'in', selectedOrgIds)
        .where('is_deleted', '=', false)
        .where('is_disabled', '=', false)
        .execute();

      const activeOrgIds = new Set(activeOrganizations.map(organization => organization.id));
      const invalidOrgId = selectedOrgIds.find(orgId => !activeOrgIds.has(orgId));
      if (invalidOrgId != null) {
        res.status(400);
        throw new Error(`Organization ${invalidOrgId} cannot be included in this certificate.`);
      }
    }

    for (const orgId of selectedOrgIds) {
      const orgHours = hoursByOrganizationId.get(orgId);
      if (!orgHours || orgHours <= 0) {
        res.status(400);
        throw new Error(`Organization ${orgId} cannot be included in this certificate.`);
      }
    }

    const hoursPerOrg = selectedOrgIds.reduce<Record<string, number>>((record, orgId) => {
      record[String(orgId)] = Number((hoursByOrganizationId.get(orgId) ?? 0).toFixed(2));
      return record;
    }, {});

    const payload = {
      v: CERTIFICATE_PAYLOAD_VERSION,
      uid: String(volunteerId),
      issued_at: issuedAt.toISOString(),
      org_ids: selectedOrgIds.map(id => String(id)),
      total_hours: totalHours,
      hours_per_org: hoursPerOrg,
      type: CERTIFICATE_TYPE,
    };

    const verificationToken = signCertificateVerificationPayload(payload, config.CERTIFICATE_VERIFICATION_SECRET);

    res.json({
      verification_token: verificationToken,
      issued_at: payload.issued_at,
    });
  });

  volunteerRouter.get('/crises/pinned', async (_req, res: Response<VolunteerPinnedCrisesResponse>) => {
    const crises = await db
      .selectFrom('crisis')
      .selectAll()
      .where('pinned', '=', true)
      .orderBy('created_at', 'desc')
      .execute();

    res.json({ crises });
  });

  volunteerRouter.get('/crises', async (req, res: Response<VolunteerCrisesResponse>) => {
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
      case 'title_asc':
        query = query.orderBy('name', 'asc');
        break;
      case 'title_desc':
        query = query.orderBy('name', 'desc');
        break;
    }

    const crises = await query.execute();

    res.json({ crises });
  });

  volunteerRouter.get('/crises/:id', async (req, res: Response<VolunteerCrisisResponse>) => {
    const { id } = zod.object({
      id: zod.coerce.number().int().positive('ID must be a positive number'),
    }).parse(req.params);

    const crisis = await db
      .selectFrom('crisis')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!crisis) {
      res.status(404);
      throw new Error('Crisis not found');
    }

    res.json({ crisis });
  });

  volunteerRouter.put('/profile', async (req, res: Response<VolunteerProfileResponse>) => {
    const body = volunteerProfileUpdateSchema.parse(req.body);
    const volunteerId = req.userJWT!.id;

    const existingVolunteer = await db
      .selectFrom('volunteer_account')
      .select([
        'first_name',
        'last_name',
        'email',
        'date_of_birth',
        'gender',
        'cv_path',
        'description',
      ])
      .where('id', '=', volunteerId)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirstOrThrow();

    const existingSkills = await db
      .selectFrom('volunteer_skill')
      .select('name')
      .where('volunteer_id', '=', volunteerId)
      .execute();

    const normalizedExistingSkills = normalizeSkillList(existingSkills.map(skill => skill.name));
    const normalizedIncomingSkills = body.skills !== undefined ? normalizeSkillList(body.skills) : undefined;

    const didSkillsChange = normalizedIncomingSkills !== undefined
      ? !areSkillListsEqual(normalizedIncomingSkills, normalizedExistingSkills)
      : false;

    const shouldRecomputeProfileVector = (
      (body.gender !== undefined && body.gender !== existingVolunteer.gender)
      || (body.cv_path !== undefined && body.cv_path !== existingVolunteer.cv_path)
      || (body.description !== undefined && body.description !== existingVolunteer.description)
      || didSkillsChange
    );

    await executeTransaction(db, async (executor) => {
      const volunteerUpdate: Partial<Omit<VolunteerAccountWithoutPassword, 'id'>> = {};

      if (body.gender !== undefined) volunteerUpdate.gender = body.gender;
      if (body.cv_path !== undefined) volunteerUpdate.cv_path = body.cv_path;
      if (body.description !== undefined) volunteerUpdate.description = body.description;
      if (Object.keys(volunteerUpdate).length > 0) {
        await executor
          .updateTable('volunteer_account')
          .set(volunteerUpdate)
          .where('id', '=', volunteerId)
          .execute();
      }

      if (didSkillsChange) {
        await executor
          .deleteFrom('volunteer_skill')
          .where('volunteer_id', '=', volunteerId)
          .execute();

        if (normalizedIncomingSkills && normalizedIncomingSkills.length > 0) {
          await executor
            .insertInto('volunteer_skill')
            .values(
              normalizedIncomingSkills.map(name => ({
                volunteer_id: volunteerId,
                name,
              })),
            )
            .execute();
        }
      }
    });

    if (shouldRecomputeProfileVector && canRecomputeProfileVector(req)) {
      await recomputeVolunteerProfileVector(volunteerId, db);
    }

    const profile = await getVolunteerProfile(volunteerId);
    res.json(profile);
  });

  volunteerRouter.post('/organization/:id/report', async (req, res: Response<VolunteerReportOrganizationResponse>) => {
    const { id: organizationId } = zod.object({
      id: zod.coerce.number().int().positive('Organization ID must be a positive number'),
    }).parse(req.params);

    const body = newOrganizationReportSchema.parse(req.body);
    const volunteerId = req.userJWT!.id;

    const organization = await db
      .selectFrom('organization_account')
      .select('id')
      .where('id', '=', organizationId)
      .where('is_deleted', '=', false)
      .where('is_disabled', '=', false)
      .executeTakeFirst();

    if (!organization) {
      res.status(404);
      throw new Error('Organization not found.');
    }

    await db
      .insertInto('organization_report')
      .values({
        reported_organization_id: organizationId,
        reporter_volunteer_id: volunteerId,
        title: body.title,
        message: body.message,
      })
      .execute();

    res.json({});
  });

  volunteerRouter.use('/profile/cv', createVolunteerCvRouter(db));
  volunteerRouter.use('/posting', createVolunteerPostingRouter(db));
  volunteerRouter.post('/reset-password', createResetPassword(db));

  return volunteerRouter;
}

export default createVolunteerRouter;
