import crypto from 'crypto';

import { Router, type Request, type Response } from 'express';
import { sql, type Kysely } from 'kysely';
import zod from 'zod';

import {
  type UserDeleteAccountResponse,
  type UserForgotPasswordResetResponse,
  type UserForgotPasswordResponse,
  type UserLoginResponse,
} from './user.types.ts';
import authorizeOnly from '../../auth/authorizeOnly.ts';
import removePassword from '../../auth/removePassword.ts';
import executeTransaction from '../../db/executeTransaction.ts';
import { type Database } from '../../db/tables/index.ts';
import { emailSchema, passwordSchema } from '../../schemas/index.ts';
import { compare, hash } from '../../services/bcrypt/index.ts';
import { generateJWT } from '../../services/jwt/index.ts';
import { sendPasswordResetEmail, sendPostingDeletedEmail } from '../../services/resend/emails.ts';
import { loginInfoSchema } from '../../types.ts';

const organizationLoginColumns = [
  'id',
  'name',
  'email',
  'phone_number',
  'url',
  'latitude',
  'longitude',
  'location_name',
  'password',
  'is_disabled',
  'token_version',
] as const;

const volunteerLoginColumns = [
  'id',
  'first_name',
  'last_name',
  'email',
  'password',
  'date_of_birth',
  'gender',
  'cv_path',
  'description',
  'is_disabled',
  'token_version',
] as const;

const forgotPasswordRequestSchema = zod.object({
  email: emailSchema,
});

const forgotPasswordResetSchema = zod.object({
  key: zod.string().min(1),
  password: passwordSchema,
});

function createUserRouter(db: Kysely<Database>) {
  const userRouter = Router();

  userRouter.post('/login', async (req, res: Response<UserLoginResponse>) => {
    const body = loginInfoSchema.parse(req.body);

    const organizationAccount = await db
      .selectFrom('organization_account')
      .select(organizationLoginColumns)
      .where('organization_account.email', '=', body.email)
      .where('organization_account.is_deleted', '=', false)
      .executeTakeFirst();

    let volunteerAccount;
    if (!organizationAccount) {
      volunteerAccount = await db
        .selectFrom('volunteer_account')
        .select(volunteerLoginColumns)
        .where('volunteer_account.email', '=', body.email)
        .where('volunteer_account.is_deleted', '=', false)
        .executeTakeFirst();
    }

    if (!organizationAccount && !volunteerAccount) {
      res.status(403);
      throw new Error('Invalid email or password');
    }

    if ((organizationAccount && organizationAccount.is_disabled) || (volunteerAccount && volunteerAccount.is_disabled)) {
      res.status(403);
      throw new Error('Account is disabled. If you think this is a mistake contact the Willing admin.');
    }

    const valid = organizationAccount
      ? await compare(body.password, organizationAccount.password)
      : volunteerAccount
        ? await compare(body.password, volunteerAccount.password)
        : false;

    if (!valid) {
      res.status(403);
      throw new Error('Invalid email or password');
    }

    const account = organizationAccount || volunteerAccount!;
    const role = organizationAccount ? 'organization' : 'volunteer';

    const token = await generateJWT({
      id: account.id,
      role,
      token_version: account.token_version,
    });

    res.json({
      token,
      role,
      [role]: removePassword(account),
    });
  });

  userRouter.post('/forgot-password', async (req, res: Response<UserForgotPasswordResponse>) => {
    const body = forgotPasswordRequestSchema.parse(req.body);

    const organizationAccount = await db
      .selectFrom('organization_account')
      .select(['id', 'name', 'email'])
      .where('organization_account.email', '=', body.email)
      .where('organization_account.is_deleted', '=', false)
      .where('organization_account.is_disabled', '=', false)
      .executeTakeFirst();

    let role: 'organization' | 'volunteer' | null = null;
    let volunteerAccount;

    if (organizationAccount) {
      role = 'organization';
    } else {
      volunteerAccount = await db
        .selectFrom('volunteer_account')
        .select(['id', 'first_name', 'last_name', 'email'])
        .where('volunteer_account.email', '=', body.email)
        .where('volunteer_account.is_deleted', '=', false)
        .where('volunteer_account.is_disabled', '=', false)
        .executeTakeFirst();

      if (volunteerAccount) {
        role = 'volunteer';
      }
    }

    if (!organizationAccount && !volunteerAccount) {
      res.json({});
      return;
    }

    const account = organizationAccount || volunteerAccount!;
    const accountName = organizationAccount
      ? organizationAccount.name
      : `${volunteerAccount!.first_name} ${volunteerAccount!.last_name}`;

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

    await db
      .insertInto('password_reset_token')
      .values({
        user_id: account.id,
        role: role!,
        token: resetToken,
        expires_at: expiresAt,
        created_at: new Date(),
      })
      .execute();

    await sendPasswordResetEmail(body.email, accountName, resetToken);

    res.json({});
  });

  userRouter.post('/forgot-password/reset', async (req, res: Response<UserForgotPasswordResetResponse>) => {
    const body = forgotPasswordResetSchema.parse(req.body);

    const resetToken = await db
      .selectFrom('password_reset_token')
      .selectAll()
      .where('password_reset_token.token', '=', body.key)
      .executeTakeFirst();

    if (!resetToken) {
      res.status(400);
      throw new Error('Invalid or expired reset token');
    }

    if (new Date() > resetToken.expires_at) {
      res.status(400);
      throw new Error('Reset token has expired');
    }

    const hashedPassword = await hash(body.password);

    if (resetToken.role === 'organization') {
      const updateResult = await db
        .updateTable('organization_account')
        .where('id', '=', resetToken.user_id)
        .where('is_deleted', '=', false)
        .where('is_disabled', '=', false)
        .set({ password: hashedPassword, token_version: sql`token_version + 1` })
        .executeTakeFirst();

      if (Number(updateResult?.numUpdatedRows ?? 0) === 0) {
        res.status(400);
        throw new Error('Account is no longer active');
      }
    } else if (resetToken.role === 'volunteer') {
      const updateResult = await db
        .updateTable('volunteer_account')
        .where('id', '=', resetToken.user_id)
        .where('is_deleted', '=', false)
        .where('is_disabled', '=', false)
        .set({ password: hashedPassword, token_version: sql`token_version + 1` })
        .executeTakeFirst();

      if (Number(updateResult?.numUpdatedRows ?? 0) === 0) {
        res.status(400);
        throw new Error('Account is no longer active');
      }
    }

    await db
      .deleteFrom('password_reset_token')
      .where('password_reset_token.id', '=', resetToken.id)
      .execute();

    res.json({});
  });

  userRouter.delete('/account', authorizeOnly('organization', 'volunteer'), async (req: Request, res: Response<UserDeleteAccountResponse>) => {
    const { password, local_date: localDate, local_time: localTime } = zod.object({
      password: zod.string().min(1),
      local_date: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      local_time: zod.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    }).parse(req.body);
    const userId = req.userJWT!.id;
    const role = req.userJWT!.role as 'organization' | 'volunteer';

    const table = role === 'organization' ? 'organization_account' as const : 'volunteer_account' as const;

    const account = await db
      .selectFrom(table)
      .select('password')
      .where('id', '=', userId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();

    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    const passwordMatch = await compare(password, account.password);
    if (!passwordMatch) {
      res.status(403);
      throw new Error('Incorrect password');
    }

    const now = new Date();
    const fallbackDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fallbackTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`;

    const requestDate = localDate ?? fallbackDate;
    const requestTime = localTime
      ? (localTime.length === 5 ? `${localTime}:00` : localTime)
      : fallbackTime;

    const today = sql<Date>`CAST(${requestDate} AS date)`;
    const currentTime = sql<string>`CAST(${requestTime} AS time)`;
    const isPostingRunningNow = sql<boolean>`
      (posting.start_date < ${today}
        OR (posting.start_date = ${today} AND posting.start_time <= ${currentTime}))
      AND
      (posting.end_date > ${today}
        OR (posting.end_date = ${today} AND posting.end_time >= ${currentTime}))
    `;

    if (role === 'volunteer') {
      const activeEnrollment = await db
        .selectFrom('enrollment')
        .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
        .select('enrollment.id')
        .where('enrollment.volunteer_id', '=', userId)
        .where('enrollment.attended', '=', false)
        .where(sql<boolean>`(posting.end_date > ${today} OR (posting.end_date = ${today} AND posting.end_time >= ${currentTime}))`)
        .limit(1)
        .executeTakeFirst();

      if (activeEnrollment) {
        res.status(409);
        throw new Error('You cannot delete your account while you are enrolled in active postings. Please withdraw from all active postings first.');
      }
    }

    let postingDeletedNotifications: { volunteerEmail: string; volunteerName: string; postingTitle: string; organizationName: string }[] = [];

    await executeTransaction(db, async (trx) => {
      if (role === 'organization') {
        const runningPosting = await trx
          .selectFrom('posting')
          .select('id')
          .where('organization_id', '=', userId)
          .where('is_closed', '=', false)
          .where(isPostingRunningNow)
          .forUpdate()
          .limit(1)
          .executeTakeFirst();

        if (runningPosting) {
          res.status(409);
          throw new Error('You cannot delete your account while you have postings that are currently running. Please wait until they end or close them first.');
        }
      }

      await trx
        .updateTable(table)
        .set({
          is_deleted: true,
          token_version: sql`token_version + 1`,
        })
        .where('id', '=', userId)
        .where('is_deleted', '=', false)
        .execute();

      await trx
        .deleteFrom('password_reset_token')
        .where('role', '=', role)
        .where('user_id', '=', userId)
        .execute();

      if (role === 'organization') {
        // Hard-delete postings that haven't started yet (with FK cleanup)
        const notStartedPostingIds = await trx
          .selectFrom('posting')
          .select(['id', 'title'])
          .where('organization_id', '=', userId)
          .where('start_date', '>', today)
          .execute();

        const notStartedIds = notStartedPostingIds.map(p => p.id);

        if (notStartedIds.length > 0) {
          // Collect enrolled volunteers for email notification before deletion
          const org = await trx
            .selectFrom('organization_account')
            .select('name')
            .where('id', '=', userId)
            .executeTakeFirstOrThrow();

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

          postingDeletedNotifications = enrolledVolunteers.map(v => ({
            volunteerEmail: v.volunteer_email,
            volunteerName: `${v.first_name} ${v.last_name}`,
            postingTitle: v.posting_title,
            organizationName: org.name,
          }));

          await trx.deleteFrom('enrollment_application_date').where('application_id', 'in',
            trx.selectFrom('enrollment_application').select('id').where('posting_id', 'in', notStartedIds),
          ).execute();
          await trx.deleteFrom('enrollment_date').where('posting_id', 'in', notStartedIds).execute();
          await trx.deleteFrom('enrollment_application').where('posting_id', 'in', notStartedIds).execute();
          await trx.deleteFrom('enrollment').where('posting_id', 'in', notStartedIds).execute();
          await trx.deleteFrom('posting_skill').where('posting_id', 'in', notStartedIds).execute();
          await trx.deleteFrom('posting').where('id', 'in', notStartedIds).execute();
        }

        // Close remaining open postings (already ended, since running ones are blocked above)
        await trx
          .updateTable('posting')
          .set({ is_closed: true })
          .where('organization_id', '=', userId)
          .where('is_closed', '=', false)
          .execute();
      } else {
        // Only delete upcoming applications (preserve past ones)
        const upcomingAppIds = await trx
          .selectFrom('enrollment_application')
          .innerJoin('posting', 'posting.id', 'enrollment_application.posting_id')
          .select('enrollment_application.id')
          .where('enrollment_application.volunteer_id', '=', userId)
          .where('posting.end_date', '>=', today)
          .execute();

        const appIds = upcomingAppIds.map(a => a.id);

        if (appIds.length > 0) {
          await trx
            .deleteFrom('enrollment_application_date')
            .where('application_id', 'in', appIds)
            .execute();

          await trx
            .deleteFrom('enrollment_application')
            .where('id', 'in', appIds)
            .execute();
        }

        const nonAttendedEnrollmentIds = await trx
          .selectFrom('enrollment')
          .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
          .select('enrollment.id')
          .where('enrollment.volunteer_id', '=', userId)
          .where('enrollment.attended', '=', false)
          .where('posting.end_date', '>=', today)
          .execute();

        const enrollmentIds = nonAttendedEnrollmentIds.map(e => e.id);

        if (enrollmentIds.length > 0) {
          await trx
            .deleteFrom('enrollment_date')
            .where('enrollment_id', 'in', enrollmentIds)
            .execute();

          await trx
            .deleteFrom('enrollment')
            .where('id', 'in', enrollmentIds)
            .execute();
        }
      }
    });

    await Promise.allSettled(postingDeletedNotifications.map(n => sendPostingDeletedEmail(n)));

    res.json({});
  });

  return userRouter;
}

export default createUserRouter;
