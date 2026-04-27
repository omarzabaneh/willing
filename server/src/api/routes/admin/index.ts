import { Router, type Response } from 'express';
import { sql, type Kysely } from 'kysely';
import zod from 'zod';

import createAdminCertificateSettingsRouter from './certificateSettings.ts';
import createAdminCrisesRouter from './crises.ts';
import {
  type AdminAcceptOrganizationReportResponse,
  type AdminAcceptVolunteerReportResponse,
  type AdminDisableOrganizationAccountResponse,
  type AdminDisableVolunteerAccountResponse,
  type AdminGetOrganizationReportResponse,
  type AdminGetVolunteerReportResponse,
  type AdminLoginResponse,
  type AdminMeResponse,
  type AdminOrganizationRequestReviewResponse,
  type AdminRejectOrganizationReportResponse,
  type AdminRejectVolunteerReportResponse,
  type AdminOrganizationRequestsResponse,
  type AdminReportsResponse,
} from './index.types.ts';
import authorizeOnly from '../../../auth/authorizeOnly.ts';
import removePassword from '../../../auth/removePassword.ts';
import createResetPassword from '../../../auth/resetPassword.ts';
import executeTransaction from '../../../db/executeTransaction.ts';
import { type Database } from '../../../db/tables/index.ts';
import { compare, hash } from '../../../services/bcrypt/index.ts';
import { recomputeOrganizationVector } from '../../../services/embeddings/updates.ts';
import { generateJWT } from '../../../services/jwt/index.ts';
import { sendOrganizationAcceptanceEmail, sendOrganizationRejectionEmail, sendPostingDeletedEmail } from '../../../services/resend/emails.ts';
import { loginInfoSchema } from '../../../types.ts';
import { parseListQuery } from '../utils/listQuery.ts';
import { getSingleQueryValue } from '../utils/queryValue.ts';

const organizationPrivateResponseColumns = [
  'id',
  'name',
  'email',
  'phone_number',
  'url',
  'latitude',
  'longitude',
  'location_name',
] as const;

const reportTypeValues = ['scam', 'impersonation', 'harassment', 'inappropriate_behavior', 'other'] as const;
const reportScopeValues = ['all', 'organization', 'volunteer'] as const;

const parseOptionalDateQueryParam = (value: unknown, fieldName: 'startDate' | 'endDate') => {
  const rawValue = getSingleQueryValue(value)?.trim();

  if (!rawValue) return undefined;

  const parsedDate = new Date(rawValue);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid ${fieldName}. Expected a valid date string.`);
  }

  return parsedDate;
};

function createAdminRouter(db: Kysely<Database>) {
  const adminRouter = Router();

  const today = sql<Date>`CURRENT_DATE`;

  interface PostingDeletedNotification {
    volunteerEmail: string;
    volunteerName: string;
    postingTitle: string;
    organizationName: string;
  }

  async function cleanupDisabledOrganization(trx: Kysely<Database>, organizationId: number): Promise<PostingDeletedNotification[]> {
    const organization = await trx
      .selectFrom('organization_account')
      .select('name')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();

    const notifications: PostingDeletedNotification[] = [];

    // Delete postings that haven't started yet (with FK cleanup)
    const notStartedPostingIds = await trx
      .selectFrom('posting')
      .select(['id', 'title'])
      .where('organization_id', '=', organizationId)
      .where('start_date', '>', today)
      .execute();

    const notStartedIds = notStartedPostingIds.map(p => p.id);

    if (notStartedIds.length > 0) {
      // Collect enrolled volunteers for email notification before deletion
      const enrolledVolunteers = await trx
        .selectFrom('enrollment')
        .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment.volunteer_id')
        .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
        .select([
          'volunteer_account.email as volunteer_email',
          'volunteer_account.first_name',
          'volunteer_account.last_name',
          'posting.title as posting_title',
        ])
        .where('enrollment.posting_id', 'in', notStartedIds)
        .execute();

      for (const v of enrolledVolunteers) {
        notifications.push({
          volunteerEmail: v.volunteer_email,
          volunteerName: `${v.first_name} ${v.last_name}`,
          postingTitle: v.posting_title,
          organizationName: organization.name,
        });
      }

      await trx.deleteFrom('enrollment_application_date').where('application_id', 'in',
        trx.selectFrom('enrollment_application').select('id').where('posting_id', 'in', notStartedIds),
      ).execute();
      await trx.deleteFrom('enrollment_date').where('posting_id', 'in', notStartedIds).execute();
      await trx.deleteFrom('enrollment_application').where('posting_id', 'in', notStartedIds).execute();
      await trx.deleteFrom('enrollment').where('posting_id', 'in', notStartedIds).execute();
      await trx.deleteFrom('posting_skill').where('posting_id', 'in', notStartedIds).execute();
      await trx.deleteFrom('posting').where('id', 'in', notStartedIds).execute();
    }

    // Drop enrolled (non-attended) volunteers from active postings belonging to this org
    const activePostingIds = await trx
      .selectFrom('posting')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('start_date', '<=', today)
      .where('end_date', '>=', today)
      .execute();

    const activeIds = activePostingIds.map(p => p.id);

    if (activeIds.length > 0) {
      // Collect non-attended enrolled volunteers for email notification before dropping
      const droppedVolunteers = await trx
        .selectFrom('enrollment')
        .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment.volunteer_id')
        .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
        .select([
          'volunteer_account.email as volunteer_email',
          'volunteer_account.first_name',
          'volunteer_account.last_name',
          'posting.title as posting_title',
        ])
        .where('enrollment.posting_id', 'in', activeIds)
        .where('enrollment.attended', '=', false)
        .execute();

      for (const v of droppedVolunteers) {
        notifications.push({
          volunteerEmail: v.volunteer_email,
          volunteerName: `${v.first_name} ${v.last_name}`,
          postingTitle: v.posting_title,
          organizationName: organization.name,
        });
      }

      await trx.deleteFrom('enrollment_date').where('posting_id', 'in', activeIds)
        .where('enrollment_id', 'in',
          trx.selectFrom('enrollment').select('id').where('posting_id', 'in', activeIds).where('attended', '=', false),
        ).execute();
      await trx.deleteFrom('enrollment').where('posting_id', 'in', activeIds).where('attended', '=', false).execute();
    }

    return notifications;
  }

  async function cleanupDisabledVolunteer(trx: Kysely<Database>, volunteerId: number) {
    // Drop volunteer from all active/upcoming postings they're enrolled in (non-attended only)
    const activeEnrollmentIds = await trx
      .selectFrom('enrollment')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .select('enrollment.id')
      .where('enrollment.volunteer_id', '=', volunteerId)
      .where('enrollment.attended', '=', false)
      .where('posting.end_date', '>=', today)
      .execute();

    const enrollmentIds = activeEnrollmentIds.map(e => e.id);

    if (enrollmentIds.length > 0) {
      await trx.deleteFrom('enrollment_date').where('enrollment_id', 'in', enrollmentIds).execute();
      await trx.deleteFrom('enrollment').where('id', 'in', enrollmentIds).execute();
    }

    // Withdraw pending applications for upcoming postings only
    const pendingAppIds = await trx
      .selectFrom('enrollment_application')
      .innerJoin('posting', 'posting.id', 'enrollment_application.posting_id')
      .select('enrollment_application.id')
      .where('enrollment_application.volunteer_id', '=', volunteerId)
      .where('posting.end_date', '>=', today)
      .execute();

    const appIds = pendingAppIds.map(a => a.id);

    if (appIds.length > 0) {
      await trx.deleteFrom('enrollment_application_date').where('application_id', 'in', appIds).execute();
      await trx.deleteFrom('enrollment_application').where('id', 'in', appIds).execute();
    }
  }

  adminRouter.post('/login', async (req, res: Response<AdminLoginResponse>) => {
    const body = loginInfoSchema.parse(req.body);

    const account = await db
      .selectFrom('admin_account')
      .selectAll()
      .where('admin_account.email', '=', body.email)
      .executeTakeFirst();

    if (!account) {
      res.status(403);
      throw new Error('Invalid email or password');
    }

    const match = await compare(body.password, account.password);

    if (!match) {
      res.status(403);
      throw new Error('Invalid email or password');
    }

    const token = await generateJWT({
      id: account.id,
      role: 'admin',
      token_version: account.token_version,
    });

    res.json({
      token,
      admin: removePassword(account),
    });
  });

  adminRouter.use(authorizeOnly('admin'));

  adminRouter.get('/me', async (req, res: Response<AdminMeResponse>) => {
    const admin = await db
      .selectFrom('admin_account')
      .selectAll()
      .where('id', '=', req.userJWT!.id)
      .executeTakeFirstOrThrow();

    res.json({ admin: removePassword(admin) });
  });

  adminRouter.get('/getOrganizationRequests', async (req, res: Response<AdminOrganizationRequestsResponse>) => {
    const { search, sortBy, sortDir } = parseListQuery(req.query, {
      allowedSortBy: ['created_at', 'name', 'email'],
      defaultSortBy: 'created_at',
    });

    let organizationRequestsQuery = db
      .selectFrom('organization_request')
      .selectAll();

    if (search) {
      const searchPattern = `%${search}%`;
      organizationRequestsQuery = organizationRequestsQuery.where(eb => eb.or([
        eb('organization_request.name', 'ilike', searchPattern),
        eb('organization_request.email', 'ilike', searchPattern),
        eb('organization_request.location_name', 'ilike', searchPattern),
      ]));
    }

    switch (sortBy) {
      case 'name':
      case 'email':
        organizationRequestsQuery = organizationRequestsQuery.orderBy('organization_request.name', sortDir);
        break;
      case 'created_at':
      default:
        organizationRequestsQuery = organizationRequestsQuery.orderBy('organization_request.created_at', sortDir);
        break;
    }

    const organizationRequests = await organizationRequestsQuery.execute();

    res.json({ organizationRequests });
  });

  adminRouter.get('/reports', async (req, res: Response<AdminReportsResponse>) => {
    const { search, sortBy, sortDir } = parseListQuery(req.query, {
      allowedSortBy: ['created_at', 'title'],
      defaultSortBy: 'created_at',
    });

    const scopeInput = getSingleQueryValue(req.query.scope)?.trim().toLowerCase();
    const reportTypeInput = getSingleQueryValue(req.query.reportType)?.trim().toLowerCase();

    if (scopeInput && !reportScopeValues.includes(scopeInput as typeof reportScopeValues[number])) {
      res.status(400);
      throw new Error('Invalid scope. Expected one of: all, organization, volunteer.');
    }

    if (reportTypeInput && !reportTypeValues.includes(reportTypeInput as typeof reportTypeValues[number])) {
      res.status(400);
      throw new Error('Invalid reportType.');
    }

    const scope = scopeInput as typeof reportScopeValues[number] | undefined;

    const reportType = reportTypeInput as typeof reportTypeValues[number] | undefined;

    let startDate: Date | undefined;
    let endDate: Date | undefined;
    try {
      startDate = parseOptionalDateQueryParam(req.query.startDate, 'startDate');
      endDate = parseOptionalDateQueryParam(req.query.endDate, 'endDate');
    } catch (error) {
      res.status(400);
      throw error;
    }

    if (startDate && endDate && startDate > endDate) {
      res.status(400);
      throw new Error('startDate must be less than or equal to endDate.');
    }

    const searchPattern = `%${search}%`;

    const organizationReportsRows = scope === 'volunteer'
      ? []
      : await db
          .selectFrom('organization_report')
          .innerJoin('organization_account as reported_organization', 'reported_organization.id', 'organization_report.reported_organization_id')
          .innerJoin('volunteer_account as reporter_volunteer', 'reporter_volunteer.id', 'organization_report.reporter_volunteer_id')
          .select([
            'organization_report.id as id',
            'organization_report.title as title',
            'organization_report.message as message',
            'organization_report.created_at as created_at',
            'reported_organization.id as reported_organization_id',
            'reported_organization.name as reported_organization_name',
            'reported_organization.email as reported_organization_email',
            'reporter_volunteer.id as reporter_volunteer_id',
            'reporter_volunteer.first_name as reporter_volunteer_first_name',
            'reporter_volunteer.last_name as reporter_volunteer_last_name',
            'reporter_volunteer.email as reporter_volunteer_email',
          ])
          .where('reported_organization.is_deleted', '=', false)
          .where('reported_organization.is_disabled', '=', false)
          .$if(Boolean(reportType), qb => qb.where('organization_report.title', '=', reportType!))
          .$if(Boolean(startDate), qb => qb.where('organization_report.created_at', '>=', startDate!))
          .$if(Boolean(endDate), qb => qb.where('organization_report.created_at', '<=', endDate!))
          .$if(Boolean(search), qb => qb.where(eb => eb.or([
            eb('organization_report.title', 'ilike', searchPattern),
            eb('organization_report.message', 'ilike', searchPattern),
            eb('reported_organization.name', 'ilike', searchPattern),
            eb('reported_organization.email', 'ilike', searchPattern),
            eb('reporter_volunteer.first_name', 'ilike', searchPattern),
            eb('reporter_volunteer.last_name', 'ilike', searchPattern),
            eb('reporter_volunteer.email', 'ilike', searchPattern),
          ])))
          .orderBy(sortBy === 'title' ? 'organization_report.title' : 'organization_report.created_at', sortDir)
          .execute();

    const volunteerReportsRows = scope === 'organization'
      ? []
      : await db
          .selectFrom('volunteer_report')
          .innerJoin('volunteer_account as reported_volunteer', 'reported_volunteer.id', 'volunteer_report.reported_volunteer_id')
          .innerJoin('organization_account as reporter_organization', 'reporter_organization.id', 'volunteer_report.reporter_organization_id')
          .select([
            'volunteer_report.id as id',
            'volunteer_report.title as title',
            'volunteer_report.message as message',
            'volunteer_report.created_at as created_at',
            'reported_volunteer.id as reported_volunteer_id',
            'reported_volunteer.first_name as reported_volunteer_first_name',
            'reported_volunteer.last_name as reported_volunteer_last_name',
            'reported_volunteer.email as reported_volunteer_email',
            'reporter_organization.id as reporter_organization_id',
            'reporter_organization.name as reporter_organization_name',
            'reporter_organization.email as reporter_organization_email',
          ])
          .where('reported_volunteer.is_deleted', '=', false)
          .where('reported_volunteer.is_disabled', '=', false)
          .$if(Boolean(reportType), qb => qb.where('volunteer_report.title', '=', reportType!))
          .$if(Boolean(startDate), qb => qb.where('volunteer_report.created_at', '>=', startDate!))
          .$if(Boolean(endDate), qb => qb.where('volunteer_report.created_at', '<=', endDate!))
          .$if(Boolean(search), qb => qb.where(eb => eb.or([
            eb('volunteer_report.title', 'ilike', searchPattern),
            eb('volunteer_report.message', 'ilike', searchPattern),
            eb('reported_volunteer.first_name', 'ilike', searchPattern),
            eb('reported_volunteer.last_name', 'ilike', searchPattern),
            eb('reported_volunteer.email', 'ilike', searchPattern),
            eb('reporter_organization.name', 'ilike', searchPattern),
            eb('reporter_organization.email', 'ilike', searchPattern),
          ])))
          .orderBy(sortBy === 'title' ? 'volunteer_report.title' : 'volunteer_report.created_at', sortDir)
          .execute();

    const organizationReports = organizationReportsRows.map(report => ({
      id: report.id,
      title: report.title,
      message: report.message,
      created_at: report.created_at,
      reported_organization: {
        id: report.reported_organization_id,
        name: report.reported_organization_name,
        email: report.reported_organization_email,
      },
      reporter_volunteer: {
        id: report.reporter_volunteer_id,
        first_name: report.reporter_volunteer_first_name,
        last_name: report.reporter_volunteer_last_name,
        email: report.reporter_volunteer_email,
      },
    }));

    const volunteerReports = volunteerReportsRows.map(report => ({
      id: report.id,
      title: report.title,
      message: report.message,
      created_at: report.created_at,
      reported_volunteer: {
        id: report.reported_volunteer_id,
        first_name: report.reported_volunteer_first_name,
        last_name: report.reported_volunteer_last_name,
        email: report.reported_volunteer_email,
      },
      reporter_organization: {
        id: report.reporter_organization_id,
        name: report.reporter_organization_name,
        email: report.reporter_organization_email,
      },
    }));

    res.json({
      organizationReports,
      volunteerReports,
    });
  });

  adminRouter.get('/reports/organization/:reportId', async (req, res: Response<AdminGetOrganizationReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    const report = await db
      .selectFrom('organization_report')
      .innerJoin('organization_account as reported_organization', 'reported_organization.id', 'organization_report.reported_organization_id')
      .innerJoin('volunteer_account as reporter_volunteer', 'reporter_volunteer.id', 'organization_report.reporter_volunteer_id')
      .select([
        'organization_report.id as id',
        'organization_report.title as title',
        'organization_report.message as message',
        'organization_report.created_at as created_at',
        'reported_organization.id as reported_organization_id',
        'reported_organization.name as reported_organization_name',
        'reported_organization.email as reported_organization_email',
        'reporter_volunteer.id as reporter_volunteer_id',
        'reporter_volunteer.first_name as reporter_volunteer_first_name',
        'reporter_volunteer.last_name as reporter_volunteer_last_name',
        'reporter_volunteer.email as reporter_volunteer_email',
      ])
      .where('organization_report.id', '=', reportId)
      .where('reported_organization.is_deleted', '=', false)
      .where('reported_organization.is_disabled', '=', false)
      .executeTakeFirst();

    if (!report) {
      res.status(404);
      throw new Error('Organization report not found.');
    }

    res.json({
      id: report.id,
      title: report.title,
      message: report.message,
      created_at: report.created_at,
      reported_organization: {
        id: report.reported_organization_id,
        name: report.reported_organization_name,
        email: report.reported_organization_email,
      },
      reporter_volunteer: {
        id: report.reporter_volunteer_id,
        first_name: report.reporter_volunteer_first_name,
        last_name: report.reporter_volunteer_last_name,
        email: report.reporter_volunteer_email,
      },
    });
  });

  adminRouter.get('/reports/volunteer/:reportId', async (req, res: Response<AdminGetVolunteerReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    const report = await db
      .selectFrom('volunteer_report')
      .innerJoin('volunteer_account as reported_volunteer', 'reported_volunteer.id', 'volunteer_report.reported_volunteer_id')
      .innerJoin('organization_account as reporter_organization', 'reporter_organization.id', 'volunteer_report.reporter_organization_id')
      .select([
        'volunteer_report.id as id',
        'volunteer_report.title as title',
        'volunteer_report.message as message',
        'volunteer_report.created_at as created_at',
        'reported_volunteer.id as reported_volunteer_id',
        'reported_volunteer.first_name as reported_volunteer_first_name',
        'reported_volunteer.last_name as reported_volunteer_last_name',
        'reported_volunteer.email as reported_volunteer_email',
        'reporter_organization.id as reporter_organization_id',
        'reporter_organization.name as reporter_organization_name',
        'reporter_organization.email as reporter_organization_email',
      ])
      .where('volunteer_report.id', '=', reportId)
      .where('reported_volunteer.is_deleted', '=', false)
      .where('reported_volunteer.is_disabled', '=', false)
      .executeTakeFirst();

    if (!report) {
      res.status(404);
      throw new Error('Volunteer report not found.');
    }

    res.json({
      id: report.id,
      title: report.title,
      message: report.message,
      created_at: report.created_at,
      reported_volunteer: {
        id: report.reported_volunteer_id,
        first_name: report.reported_volunteer_first_name,
        last_name: report.reported_volunteer_last_name,
        email: report.reported_volunteer_email,
      },
      reporter_organization: {
        id: report.reporter_organization_id,
        name: report.reporter_organization_name,
        email: report.reporter_organization_email,
      },
    });
  });

  adminRouter.post('/reports/organization/:reportId/reject', async (req, res: Response<AdminRejectOrganizationReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    const report = await db
      .selectFrom('organization_report')
      .select(['id'])
      .where('id', '=', reportId)
      .executeTakeFirst();

    if (!report) {
      res.status(404);
      throw new Error('Organization report not found.');
    }

    await db
      .deleteFrom('organization_report')
      .where('id', '=', reportId)
      .execute();

    res.json({});
  });

  adminRouter.post('/reports/organization/:reportId/accept', async (req, res: Response<AdminAcceptOrganizationReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    let notifications: PostingDeletedNotification[] = [];

    try {
      await executeTransaction(db, async (trx) => {
        const report = await trx
          .selectFrom('organization_report')
          .select(['id', 'reported_organization_id'])
          .where('id', '=', reportId)
          .executeTakeFirst();

        if (!report) {
          throw new Error('Organization report not found.');
        }

        const organization = await trx
          .selectFrom('organization_account')
          .select(['id', 'is_disabled'])
          .where('id', '=', report.reported_organization_id)
          .executeTakeFirst();

        if (!organization) {
          throw new Error('Organization account not found.');
        }

        if (!organization.is_disabled) {
          await trx
            .updateTable('organization_account')
            .set({
              is_disabled: true,
              token_version: sql`token_version + 1`,
            })
            .where('id', '=', organization.id)
            .execute();

          notifications = await cleanupDisabledOrganization(trx, organization.id);
        }

        await trx
          .deleteFrom('organization_report')
          .where('reported_organization_id', '=', organization.id)
          .execute();

        await trx
          .deleteFrom('volunteer_report')
          .where('reporter_organization_id', '=', organization.id)
          .execute();
      });
    } catch (error) {
      if (error instanceof Error && (error.message === 'Organization report not found.' || error.message === 'Organization account not found.')) {
        res.status(404);
      }
      throw error;
    }

    await Promise.allSettled(notifications.map(n => sendPostingDeletedEmail(n)));

    res.json({});
  });

  adminRouter.post('/reports/volunteer/:reportId/reject', async (req, res: Response<AdminRejectVolunteerReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    const report = await db
      .selectFrom('volunteer_report')
      .select(['id'])
      .where('id', '=', reportId)
      .executeTakeFirst();

    if (!report) {
      res.status(404);
      throw new Error('Volunteer report not found.');
    }

    await db
      .deleteFrom('volunteer_report')
      .where('id', '=', reportId)
      .execute();

    res.json({});
  });

  adminRouter.post('/reports/volunteer/:reportId/accept', async (req, res: Response<AdminAcceptVolunteerReportResponse>) => {
    const reportId = zod.coerce.number().int().positive().parse(req.params.reportId);

    try {
      await executeTransaction(db, async (trx) => {
        const report = await trx
          .selectFrom('volunteer_report')
          .select(['id', 'reported_volunteer_id'])
          .where('id', '=', reportId)
          .executeTakeFirst();

        if (!report) {
          throw new Error('Volunteer report not found.');
        }

        const volunteer = await trx
          .selectFrom('volunteer_account')
          .select(['id', 'is_disabled'])
          .where('id', '=', report.reported_volunteer_id)
          .executeTakeFirst();

        if (!volunteer) {
          throw new Error('Volunteer account not found.');
        }

        if (!volunteer.is_disabled) {
          await trx
            .updateTable('volunteer_account')
            .set({
              is_disabled: true,
              token_version: sql`token_version + 1`,
            })
            .where('id', '=', volunteer.id)
            .execute();

          await cleanupDisabledVolunteer(trx, volunteer.id);
        }

        await trx
          .deleteFrom('volunteer_report')
          .where('reported_volunteer_id', '=', volunteer.id)
          .execute();

        await trx
          .deleteFrom('organization_report')
          .where('reporter_volunteer_id', '=', volunteer.id)
          .execute();
      });
    } catch (error) {
      if (error instanceof Error && (error.message === 'Volunteer report not found.' || error.message === 'Volunteer account not found.')) {
        res.status(404);
      }
      throw error;
    }

    res.json({});
  });

  adminRouter.post('/reports/organization/:organizationId/disable', async (req, res: Response<AdminDisableOrganizationAccountResponse>) => {
    const organizationId = zod.coerce.number().int().positive().parse(req.params.organizationId);

    let notifications: PostingDeletedNotification[] = [];

    try {
      await executeTransaction(db, async (trx) => {
        const organization = await trx
          .selectFrom('organization_account')
          .select(['id', 'is_disabled'])
          .where('id', '=', organizationId)
          .executeTakeFirst();

        if (!organization) {
          throw new Error('Organization account not found.');
        }

        if (!organization.is_disabled) {
          await trx
            .updateTable('organization_account')
            .set({
              is_disabled: true,
              token_version: sql`token_version + 1`,
            })
            .where('id', '=', organizationId)
            .execute();

          notifications = await cleanupDisabledOrganization(trx, organizationId);
        }

        await trx
          .deleteFrom('organization_report')
          .where('reported_organization_id', '=', organizationId)
          .execute();

        await trx
          .deleteFrom('volunteer_report')
          .where('reporter_organization_id', '=', organizationId)
          .execute();
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Organization account not found.') {
        res.status(404);
      }
      throw error;
    }

    await Promise.allSettled(notifications.map(n => sendPostingDeletedEmail(n)));

    res.json({});
  });

  adminRouter.post('/reports/volunteer/:volunteerId/disable', async (req, res: Response<AdminDisableVolunteerAccountResponse>) => {
    const volunteerId = zod.coerce.number().int().positive().parse(req.params.volunteerId);

    try {
      await executeTransaction(db, async (trx) => {
        const volunteer = await trx
          .selectFrom('volunteer_account')
          .select(['id', 'is_disabled'])
          .where('id', '=', volunteerId)
          .executeTakeFirst();

        if (!volunteer) {
          throw new Error('Volunteer account not found.');
        }

        if (!volunteer.is_disabled) {
          await trx
            .updateTable('volunteer_account')
            .set({
              is_disabled: true,
              token_version: sql`token_version + 1`,
            })
            .where('id', '=', volunteerId)
            .execute();

          await cleanupDisabledVolunteer(trx, volunteerId);
        }

        await trx
          .deleteFrom('volunteer_report')
          .where('reported_volunteer_id', '=', volunteerId)
          .execute();

        await trx
          .deleteFrom('organization_report')
          .where('reporter_volunteer_id', '=', volunteerId)
          .execute();
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Volunteer account not found.') {
        res.status(404);
      }
      throw error;
    }

    res.json({});
  });

  adminRouter.post('/reviewOrganizationRequest', async (req, res: Response<AdminOrganizationRequestReviewResponse>, next) => {
    const { requestId, accepted, reason } = zod.object({
      requestId: zod.number(),
      accepted: zod.boolean(),
      reason: zod.string().nullable(),
    }).parse(req.body);

    const organizationRequest = await db
      .selectFrom('organization_request')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst();

    if (!organizationRequest) {
      res.status(404);
      next(new Error('Organization request with id ' + requestId + ' not found.'));
      return;
    }

    if (!accepted) {
      await sendOrganizationRejectionEmail(organizationRequest, reason);
      await db
        .deleteFrom('organization_request')
        .where('id', '=', requestId)
        .execute();
      res.json({});
      return;
    }

    const existingOrganization = await db
      .selectFrom('organization_account')
      .select('id')
      .where('email', '=', organizationRequest.email)
      .executeTakeFirst();

    if (existingOrganization) {
      res.status(409);
      throw new Error('An organization account with this email already exists');
    }

    const existingVolunteer = await db
      .selectFrom('volunteer_account')
      .select('id')
      .where('email', '=', organizationRequest.email)
      .executeTakeFirst();

    if (existingVolunteer) {
      res.status(409);
      throw new Error('A volunteer account with this email already exists');
    }

    const password = Math.random().toString(36).slice(-8);

    const insertedOrganization = await executeTransaction(db, async (trx) => {
      await trx
        .deleteFrom('organization_request')
        .where('id', '=', requestId)
        .execute();

      return await trx
        .insertInto('organization_account')
        .values({
          name: organizationRequest.name,
          email: organizationRequest.email,
          phone_number: organizationRequest.phone_number,
          url: organizationRequest.url,
          latitude: Number(organizationRequest.latitude),
          longitude: Number(organizationRequest.longitude),
          location_name: organizationRequest.location_name,
          password: await hash(password),
        })
        .returning(organizationPrivateResponseColumns)
        .executeTakeFirst();
    });

    if (!insertedOrganization) {
      res.status(500);
      throw new Error('Failed to create organization account');
    }

    await recomputeOrganizationVector(insertedOrganization.id, db);

    await sendOrganizationAcceptanceEmail(organizationRequest, password);

    res.json({
      organization: insertedOrganization,
    });
  });

  adminRouter.post('/reset-password', createResetPassword(db));

  adminRouter.use('/crises', createAdminCrisesRouter(db));
  adminRouter.use('/certificate-settings', createAdminCertificateSettingsRouter(db));

  return adminRouter;
}

export default createAdminRouter;
