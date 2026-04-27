import { Router, type Response } from 'express';
import { sql, type Kysely } from 'kysely';
import zod from 'zod';

import createAttendanceRouter from './attendance.ts';
import {
  type PostingDiscoverResponse,
  type PostingCreateResponse,
  type PostingListResponse,
  type PostingResponse,
  type PostingEnrollmentsResponse,
  type PostingUpdateResponse,
  type PostingDeleteResponse,
  type PostingApplicationsReponse,
  type PostingApplicationAcceptanceResponse,
  type PostingApplicationRejectionResponse,
} from './posting.types.ts';
import { getPostingEnrollments } from './postingEnrollments.ts';
import executeTransaction from '../../../db/executeTransaction.ts';
import {
  type Database,
  type PostingWithoutVectors,
  type PostingSkill,
  type VolunteerSkill,
  newPostingSchema,
} from '../../../db/tables/index.ts';
import {
  recomputeOrganizationCompositeVectorOnly,
  recomputeOrganizationHistoryVectorOnly,
  recomputePostingContextVectorOnly,
  recomputePostingContextVectorsForOrganization,
  recomputePostingVectors,
  recomputeVolunteerExperienceVector,
} from '../../../services/embeddings/updates.ts';
import { hasPostingEnded } from '../../../services/posting/postingTime.ts';
import { rejectEndedPendingApplicationsForPostings } from '../../../services/posting/rejectEndedPendingApplications.ts';
import {
  sendPostingDeletedEmail,
  sendVolunteerApplicationAcceptedEmail,
  sendVolunteerApplicationRejectedEmail,
} from '../../../services/resend/emails.ts';
import {
  parseListQuery,
  parseOptionalBooleanQueryParam,
  parseOptionalNumberQueryParam,
} from '../utils/listQuery.ts';
import {
  applyPostingDateTimeFilters,
  applySharedPostingSort,
  buildSearchRegexPattern,
  normalizeSearchTerms,
  parsePostingDateTimeFilters,
} from '../utils/postingList.ts';
import { buildPostingsWithContext, postingWithContextSelectColumns } from '../volunteer/postingWithContext.ts';

const postingUpdateSchema = newPostingSchema.partial().extend({
  crisis_id: zod.number().int().positive().nullable().optional(),
});

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

const withPostingEndedFlag = <T extends { end_date: Date | string | null | undefined; end_time?: string | null }>(posting: T) => ({
  ...posting,
  has_ended: hasPostingEnded(posting),
});

const normalizeSkillList = (skills: string[]) => Array.from(new Set(skills.map(skill => skill.trim()).filter(Boolean))).sort();
const areSkillListsEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};
const formatDateToIso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const normalizeStoredDate = (value: Date | string | null | undefined) => {
  if (value instanceof Date) return formatDateToIso(value);
  if (typeof value === 'string') {
    const datePart = value.split('T')[0]?.trim();
    return datePart || undefined;
  }
  return undefined;
};
const parseIsoDateParts = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
};
const getPostingDates = (startDate: Date | string, endDate: Date | string): string[] => {
  const normalizedStartDate = normalizeStoredDate(startDate);
  const normalizedEndDate = normalizeStoredDate(endDate);
  const startParts = normalizedStartDate ? parseIsoDateParts(normalizedStartDate) : undefined;
  const endParts = normalizedEndDate ? parseIsoDateParts(normalizedEndDate) : undefined;

  if (!startParts || !endParts) {
    return [];
  }

  const result: string[] = [];
  const current = new Date(startParts.year, startParts.month - 1, startParts.day);
  const end = new Date(endParts.year, endParts.month - 1, endParts.day);

  while (current.getTime() <= end.getTime()) {
    result.push(formatDateToIso(current));
    current.setDate(current.getDate() + 1);
  }

  return result;
};
const areDatesEqual = (left: Date | undefined, right: Date | undefined) => (left?.getTime() ?? null) === (right?.getTime() ?? null);
const areTimeValuesEqual = (left: string | undefined, right: string | undefined) => (left ?? null) === (right ?? null);
const isPostingFull = (maxVolunteers: number | null | undefined, enrollmentCount: number) => maxVolunteers !== undefined && maxVolunteers !== null && enrollmentCount >= maxVolunteers;

const postingIdParamsSchema = zod.object({
  id: zod.coerce.number().int().positive('ID must be a positive number'),
});

const assertCrisisExists = async (crisisId: number, db: Kysely<Database>, res: Response) => {
  const crisis = await db
    .selectFrom('crisis')
    .select(['id'])
    .where('id', '=', crisisId)
    .executeTakeFirst();

  if (!crisis) {
    res.status(400);
    throw new Error('Selected crisis tag does not exist');
  }
};

const getPostingCrisis = async (crisisId: number | null | undefined, db: Kysely<Database>) => {
  if (crisisId == null) return undefined;
  return db
    .selectFrom('crisis')
    .selectAll()
    .where('id', '=', crisisId)
    .executeTakeFirst();
};

function createPostingRouter(db: Kysely<Database>) {
  const postingRouter = Router();

  postingRouter.post('/', async (req, res: Response<PostingCreateResponse>) => {
    const body = newPostingSchema.parse(req.body);
    const orgId = req.userJWT!.id;
    const { skills, ...postingBody } = body;

    const now = new Date();
    const todayIso = formatDateToIso(now);
    if (formatDateToIso(body.start_date) < todayIso) {
      res.status(400);
      throw new Error('Start date cannot be in the past');
    }
    if (formatDateToIso(body.end_date) < todayIso) {
      res.status(400);
      throw new Error('End date cannot be in the past');
    }
    if (formatDateToIso(body.start_date) === todayIso && body.start_time) {
      const parts = body.start_time.split(':').map(Number);
      const startDateTime = new Date(now);
      startDateTime.setHours(parts[0] ?? 0, parts[1] ?? 0, 0, 0);
      if (startDateTime < now) {
        res.status(400);
        throw new Error('Start time cannot be in the past');
      }
    }

    if (body.crisis_id != null) {
      await assertCrisisExists(body.crisis_id, db, res);
    }

    const result = await executeTransaction(db, async (trx) => {
      const postingInsertValues = {
        organization_id: orgId,
        ...postingBody,
      } as Partial<PostingWithoutVectors>;

      const newPosting = await trx
        .insertInto('posting')
        .values(postingInsertValues as never)
        .returning('id')
        .executeTakeFirst();

      if (!newPosting) {
        throw new Error('Failed to create posting');
      }

      if (skills && skills.length > 0) {
        const skillRows = skills.map(name => ({ posting_id: newPosting.id, name }));
        await trx.insertInto('posting_skill').values(skillRows).execute();
      }

      return { postingId: newPosting.id };
    });

    await recomputePostingVectors(result.postingId, db);

    const posting = withPostingEndedFlag(await db
      .selectFrom('posting')
      .select(postingResponseColumns)
      .where('id', '=', result.postingId)
      .executeTakeFirstOrThrow());

    const insertedSkills = await db
      .selectFrom('posting_skill')
      .selectAll()
      .where('posting_id', '=', result.postingId)
      .execute();

    res.json({ posting, skills: insertedSkills });
  });

  postingRouter.get('/', async (req, res: Response<PostingListResponse>) => {
    const orgId = req.userJWT!.id;
    const { search, sortBy, sortDir } = parseListQuery(req.query, {
      allowedSortBy: ['start_date', 'created_at', 'title'],
      defaultSortBy: 'start_date',
      defaultSortDir: 'asc',
    });

    const hideFull = parseOptionalBooleanQueryParam(req.query.hide_full) ?? false;
    const postingFilter = typeof req.query.posting_filter === 'string' ? req.query.posting_filter : 'all';
    const isClosedFilter = parseOptionalBooleanQueryParam(req.query.is_closed);
    const automaticAcceptanceFilter = parseOptionalBooleanQueryParam(req.query.automatic_acceptance);
    const crisisIdFilter = parseOptionalNumberQueryParam(req.query.crisis_id);
    const dateTimeFilters = parsePostingDateTimeFilters(req.query);

    let postingsQuery = db
      .selectFrom('posting')
      .select(postingResponseColumns)
      .where('organization_id', '=', orgId);

    if (search) {
      const terms = normalizeSearchTerms(search);
      postingsQuery = postingsQuery.where(({ and, or }) => and(
        terms.map((term) => {
          const searchPattern = buildSearchRegexPattern(term);
          return or([
            sql<boolean>`lower(posting.title) ~ ${searchPattern}`,
            sql<boolean>`lower(posting.description) ~ ${searchPattern}`,
            sql<boolean>`lower(posting.location_name) ~ ${searchPattern}`,
          ]);
        }),
      ));
    }

    if (isClosedFilter !== undefined) {
      postingsQuery = postingsQuery.where('posting.is_closed', '=', isClosedFilter);
    }

    if (postingFilter === 'open') {
      postingsQuery = postingsQuery.where('posting.automatic_acceptance', '=', true);
    } else if (postingFilter === 'review') {
      postingsQuery = postingsQuery.where('posting.automatic_acceptance', '=', false);
    } else if (postingFilter === 'partial') {
      postingsQuery = postingsQuery.where('posting.allows_partial_attendance', '=', true);
    } else if (postingFilter === 'full') {
      postingsQuery = postingsQuery.where('posting.allows_partial_attendance', '=', false);
    } else if (postingFilter === 'tagged') {
      postingsQuery = postingsQuery.where('posting.crisis_id', 'is not', null);
    } else if (postingFilter === 'untagged') {
      postingsQuery = postingsQuery.where('posting.crisis_id', 'is', null);
    }

    if (automaticAcceptanceFilter !== undefined) {
      postingsQuery = postingsQuery.where('posting.automatic_acceptance', '=', automaticAcceptanceFilter);
    }

    if (crisisIdFilter !== undefined) {
      postingsQuery = postingsQuery.where('posting.crisis_id', '=', crisisIdFilter);
    }

    postingsQuery = applyPostingDateTimeFilters(postingsQuery, dateTimeFilters);

    if (sortBy === 'title') {
      postingsQuery = postingsQuery.orderBy('posting.title', sortDir);
    } else {
      postingsQuery = applySharedPostingSort(postingsQuery, sortBy, sortDir);
    }

    const postings = await postingsQuery.execute();
    const postingIds = postings.map(p => p.id);

    const skills = postingIds.length > 0
      ? await db
          .selectFrom('posting_skill')
          .selectAll()
          .where('posting_id', 'in', postingIds)
          .execute()
      : [];

    const skillsByPostingId = new Map<number, PostingSkill[]>();
    skills.forEach((skill) => {
      if (!skillsByPostingId.has(skill.posting_id)) {
        skillsByPostingId.set(skill.posting_id, []);
      }
      skillsByPostingId.get(skill.posting_id)!.push(skill);
    });

    const enrollmentCounts = postingIds.length > 0
      ? await db
          .selectFrom('enrollment')
          .select(['posting_id', sql<number>`count(enrollment.id)`.as('count')])
          .where('posting_id', 'in', postingIds)
          .groupBy('posting_id')
          .execute()
      : [];

    const countsByPostingId = new Map<number, number>();
    enrollmentCounts.forEach((row) => {
      countsByPostingId.set(row.posting_id, Number(row.count ?? 0));
    });

    const postingsWithSkills = postings.map((posting) => {
      const enrollmentCount = countsByPostingId.get(posting.id) ?? 0;
      return {
        ...withPostingEndedFlag(posting),
        skills: skillsByPostingId.get(posting.id) || [],
        enrollment_count: enrollmentCount,
        is_full: isPostingFull(posting.max_volunteers, enrollmentCount),
      };
    });

    const visiblePostings = hideFull
      ? postingsWithSkills.filter(posting => !posting.is_full)
      : postingsWithSkills;

    res.json({ postings: visiblePostings });
  });

  postingRouter.get('/discover', async (req, res: Response<PostingDiscoverResponse>) => {
    const { location_name, skill } = req.query;
    const dateTimeFilters = parsePostingDateTimeFilters(req.query);
    const hideFull = parseOptionalBooleanQueryParam(req.query.hide_full) ?? false;
    const crisisIdFilter = parseOptionalNumberQueryParam(req.query.crisis_id);
    const postingFilter = typeof req.query.posting_filter === 'string' ? req.query.posting_filter : 'all';
    const { search, sortBy, sortDir } = parseListQuery(req.query, {
      allowedSortBy: ['recommended', 'start_date', 'created_at', 'title'],
      defaultSortBy: 'recommended',
      defaultSortDir: 'desc',
    });
    const skillFilter = typeof skill === 'string' ? skill.trim() : '';

    let query = db
      .selectFrom('posting')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .leftJoin('crisis', 'crisis.id', 'posting.crisis_id')
      .select(postingWithContextSelectColumns)
      .where('posting.is_closed', '=', false)
      .where(({ or }) => or([
        sql<boolean>`(posting.end_date + posting.end_time) >= now()`,
        sql<boolean>`posting.end_date IS NULL`,
      ]))
      .where('organization_account.is_deleted', '=', false)
      .where('organization_account.is_disabled', '=', false);

    if (skillFilter) {
      query = query.where(({ exists, selectFrom }) => exists(
        selectFrom('posting_skill')
          .select('posting_skill.id')
          .whereRef('posting_skill.posting_id', '=', 'posting.id')
          .where('posting_skill.name', 'ilike', `%${skillFilter}%`),
      ));
    }

    if (location_name) {
      query = query.where('posting.location_name', 'ilike', `%${location_name}%`);
    }

    if (crisisIdFilter !== undefined) {
      query = query.where('posting.crisis_id', '=', crisisIdFilter);
    }

    if (postingFilter === 'open') {
      query = query.where('posting.automatic_acceptance', '=', true);
    } else if (postingFilter === 'review') {
      query = query.where('posting.automatic_acceptance', '=', false);
    } else if (postingFilter === 'partial') {
      query = query.where('posting.allows_partial_attendance', '=', true);
    } else if (postingFilter === 'full') {
      query = query.where('posting.allows_partial_attendance', '=', false);
    } else if (postingFilter === 'tagged') {
      query = query.where('posting.crisis_id', 'is not', null);
    } else if (postingFilter === 'untagged') {
      query = query.where('posting.crisis_id', 'is', null);
    }

    if (search) {
      const terms = normalizeSearchTerms(search);
      query = query.where(({ and, exists, selectFrom, or }) => and(
        terms.map((term) => {
          const likePattern = `%${term}%`;

          return or([
            sql<boolean>`lower(posting.title) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(posting.title), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(posting.description) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(posting.description), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(posting.location_name) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(posting.location_name), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            sql<boolean>`lower(organization_account.name) LIKE ${likePattern}`,
            sql<boolean>`regexp_replace(lower(organization_account.name), '[^a-z0-9]+', '', 'g') LIKE ${likePattern}`,
            exists(
              selectFrom('posting_skill')
                .select('posting_skill.id')
                .whereRef('posting_skill.posting_id', '=', 'posting.id')
                .where(sql<boolean>`lower(posting_skill.name) LIKE ${likePattern}`),
            ),
          ]);
        }),
      ));

      const normalizedSearch = search.toLowerCase();
      const titleRelevance = sql<number>`
      CASE
        WHEN lower(posting.title) = ${normalizedSearch} THEN 3
        WHEN lower(posting.title) LIKE ${`${normalizedSearch}%`} THEN 2
        WHEN lower(posting.title) LIKE ${`%${normalizedSearch}%`} THEN 1
        ELSE 0
      END
    `;
      query = query.orderBy(sql`${titleRelevance} desc`);
    }

    query = applyPostingDateTimeFilters(query, dateTimeFilters);

    const fallbackSortBy = sortBy === 'recommended' ? 'start_date' : sortBy;
    query = applySharedPostingSort(query, fallbackSortBy, sortDir);

    const postings = await query.execute();
    const postingsWithContext = await buildPostingsWithContext(db, {
      volunteerId: 0,
      postings,
    });

    const normalizedPostings = postingsWithContext.map(posting => ({
      ...posting,
      application_status: 'none' as const,
    }));

    const visiblePostings = hideFull
      ? normalizedPostings.filter(posting => !isPostingFull(posting.max_volunteers, posting.enrollment_count))
      : normalizedPostings;

    res.json({ postings: visiblePostings });
  });

  postingRouter.get('/:id', async (req, res: Response<PostingResponse>) => {
    const { id: postingId } = postingIdParamsSchema.parse(req.params);

    const postingRow = await db
      .selectFrom('posting')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .select(postingResponseColumns)
      .where('posting.id', '=', postingId)
      .where('organization_account.is_deleted', '=', false)
      .where('organization_account.is_disabled', '=', false)
      .executeTakeFirst();

    if (!postingRow) {
      res.status(404);
      throw new Error('Posting not found');
    }

    const posting = withPostingEndedFlag(postingRow);

    const [skills, crisis, enrollmentCountRow] = await Promise.all([
      db
        .selectFrom('posting_skill')
        .selectAll()
        .where('posting_id', '=', postingId)
        .execute(),
      getPostingCrisis(posting.crisis_id, db),
      db
        .selectFrom('enrollment')
        .select(sql<number>`count(enrollment.id)`.as('count'))
        .where('posting_id', '=', postingId)
        .executeTakeFirst(),
    ]);

    const enrollmentCount = Number(enrollmentCountRow?.count ?? 0);

    res.json({
      posting,
      skills,
      is_full: isPostingFull(posting.max_volunteers, enrollmentCount),
      ...(crisis ? { crisis } : {}),
    });
  });

  postingRouter.get('/:id/enrollments', async (req, res: Response<PostingEnrollmentsResponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId } = postingIdParamsSchema.parse(req.params);

    const posting = await db
      .selectFrom('posting')
      .select(['id'])
      .where('posting.id', '=', postingId)
      .where('posting.organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    const enrollments = await getPostingEnrollments(db, postingId);
    res.json({ enrollments });
  });

  postingRouter.put('/:id', async (req, res: Response<PostingUpdateResponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId } = postingIdParamsSchema.parse(req.params);
    const body = postingUpdateSchema.parse(req.body);
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const hasBodyField = (field: string) => Object.prototype.hasOwnProperty.call(rawBody, field);

    const posting = await db
      .selectFrom('posting')
      .select([
        'id',
        'crisis_id',
        'title',
        'description',
        'location_name',
        'automatic_acceptance',
        'start_date',
        'start_time',
        'end_date',
        'end_time',
        'minimum_age',
        'max_volunteers',
        'is_closed',
        'allows_partial_attendance',
      ])
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    const isEndedPosting = hasPostingEnded(posting);
    const isEndedLifecycleChange = isEndedPosting && (
      (hasBodyField('is_closed') && body.is_closed !== posting.is_closed)
      || (body.start_date !== undefined && normalizeStoredDate(body.start_date) !== normalizeStoredDate(posting.start_date))
      || (body.end_date !== undefined && normalizeStoredDate(body.end_date) !== normalizeStoredDate(posting.end_date))
      || (body.start_time !== undefined && !areTimeValuesEqual(body.start_time, posting.start_time ?? undefined))
      || (body.end_time !== undefined && !areTimeValuesEqual(body.end_time, posting.end_time ?? undefined))
      || (hasBodyField('automatic_acceptance') && body.automatic_acceptance !== posting.automatic_acceptance)
      || (hasBodyField('allows_partial_attendance') && body.allows_partial_attendance !== posting.allows_partial_attendance)
    );

    if (isEndedLifecycleChange) {
      res.status(403);
      throw new Error('Cannot change posting availability after it has ended');
    }

    const now = new Date();
    const todayIso = formatDateToIso(now);
    if (body.start_date !== undefined && formatDateToIso(body.start_date) !== formatDateToIso(posting.start_date) && formatDateToIso(body.start_date) < todayIso) {
      res.status(400);
      throw new Error('Start date cannot be in the past');
    }
    if (body.end_date !== undefined && formatDateToIso(body.end_date) !== formatDateToIso(posting.end_date) && formatDateToIso(body.end_date) < todayIso) {
      res.status(400);
      throw new Error('End date cannot be in the past');
    }

    const effectiveStartDate = body.start_date ?? posting.start_date;
    const effectiveStartTime = body.start_time ?? posting.start_time;
    if (formatDateToIso(effectiveStartDate) === todayIso && effectiveStartTime) {
      const parts = effectiveStartTime.split(':').map(Number);
      const startDateTime = new Date(now);
      startDateTime.setHours(parts[0] ?? 0, parts[1] ?? 0, 0, 0);
      if (startDateTime < now) {
        res.status(400);
        throw new Error('Start time cannot be in the past');
      }
    }

    if (body.crisis_id !== undefined && body.crisis_id !== null && body.crisis_id !== posting.crisis_id) {
      await assertCrisisExists(body.crisis_id, db, res);
    }

    const existingSkills = await db
      .selectFrom('posting_skill')
      .select('name')
      .where('posting_id', '=', postingId)
      .execute();

    const normalizedExistingSkills = normalizeSkillList(existingSkills.map(skill => skill.name));
    const normalizedIncomingSkills = body.skills !== undefined ? normalizeSkillList(body.skills) : undefined;
    const didSkillsChange = normalizedIncomingSkills !== undefined
      ? !areSkillListsEqual(normalizedIncomingSkills, normalizedExistingSkills)
      : false;

    const shouldRecomputePostingVectors = (
      (body.title !== undefined && body.title !== posting.title)
      || (body.description !== undefined && body.description !== posting.description)
      || (body.location_name !== undefined && body.location_name !== posting.location_name)
      || (body.start_date !== undefined && !areDatesEqual(body.start_date, posting.start_date))
      || (body.end_date !== undefined && !areDatesEqual(body.end_date, posting.end_date))
      || (body.start_time !== undefined && !areTimeValuesEqual(body.start_time, posting.start_time))
      || (body.end_time !== undefined && !areTimeValuesEqual(body.end_time, posting.end_time))
      || (body.minimum_age !== undefined && (body.minimum_age ?? null) !== (posting.minimum_age ?? null))
      || (body.max_volunteers !== undefined && (body.max_volunteers ?? null) !== (posting.max_volunteers ?? null))
      || didSkillsChange
    );
    const didClosedStateChange = body.is_closed !== undefined && body.is_closed !== posting.is_closed;

    await executeTransaction(db, async (trx) => {
      const postingFields: Record<string, unknown> = {};
      if (body.title !== undefined) postingFields.title = body.title;
      if (body.description !== undefined) postingFields.description = body.description;
      if (body.latitude !== undefined) postingFields.latitude = body.latitude;
      if (body.longitude !== undefined) postingFields.longitude = body.longitude;
      if (body.max_volunteers !== undefined) postingFields.max_volunteers = body.max_volunteers;
      if (body.start_date !== undefined) postingFields.start_date = body.start_date;
      if (body.start_time !== undefined) postingFields.start_time = body.start_time;
      if (body.end_date !== undefined) postingFields.end_date = body.end_date;
      if (body.end_time !== undefined) postingFields.end_time = body.end_time;
      if (body.minimum_age !== undefined) postingFields.minimum_age = body.minimum_age;
      if (body.automatic_acceptance !== undefined) postingFields.automatic_acceptance = body.automatic_acceptance;
      if (body.is_closed !== undefined) postingFields.is_closed = body.is_closed;
      if (body.allows_partial_attendance !== undefined) postingFields.allows_partial_attendance = body.allows_partial_attendance;
      if (body.location_name !== undefined) postingFields.location_name = body.location_name;
      if (body.crisis_id !== undefined) postingFields.crisis_id = body.crisis_id;

      if (Object.keys(postingFields).length > 0) {
        await trx
          .updateTable('posting')
          .set(postingFields)
          .where('id', '=', postingId)
          .where('organization_id', '=', orgId)
          .execute();
      }

      if (didSkillsChange) {
        await trx
          .deleteFrom('posting_skill')
          .where('posting_id', '=', postingId)
          .execute();

        if (normalizedIncomingSkills && normalizedIncomingSkills.length > 0) {
          await trx
            .insertInto('posting_skill')
            .values(normalizedIncomingSkills.map(name => ({ posting_id: postingId, name })))
            .execute();
        }
      }
    });

    if (shouldRecomputePostingVectors) {
      await recomputePostingVectors(postingId, db);
    }
    if (didClosedStateChange) {
      await recomputeOrganizationHistoryVectorOnly(orgId, db);
      await recomputeOrganizationCompositeVectorOnly(orgId, db);
      await recomputePostingContextVectorsForOrganization(orgId, db);
    }

    const updatedPosting = withPostingEndedFlag(await db
      .selectFrom('posting')
      .select(postingResponseColumns)
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirstOrThrow());

    const [skills, crisis] = await Promise.all([
      db
        .selectFrom('posting_skill')
        .selectAll()
        .where('posting_id', '=', postingId)
        .execute(),
      getPostingCrisis(updatedPosting.crisis_id, db),
    ]);

    res.json({ posting: updatedPosting, skills, ...(crisis ? { crisis } : {}) });
  });

  postingRouter.delete('/:id', async (req, res: Response<PostingDeleteResponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId } = postingIdParamsSchema.parse(req.params);

    const posting = await db
      .selectFrom('posting')
      .select(['id'])
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    const impactedVolunteerRows = await db
      .selectFrom('enrollment')
      .select('volunteer_id')
      .where('posting_id', '=', postingId)
      .where('attended', '=', true)
      .execute();

    const enrolledVolunteerEmailContexts = await db
      .selectFrom('enrollment')
      .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment.volunteer_id')
      .innerJoin('posting', 'posting.id', 'enrollment.posting_id')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .select([
        'volunteer_account.id as volunteer_id',
        'volunteer_account.email as volunteer_email',
        'volunteer_account.first_name',
        'volunteer_account.last_name',
        'posting.title as posting_title',
        'organization_account.name as organization_name',
      ])
      .where('enrollment.posting_id', '=', postingId)
      .where('volunteer_account.is_deleted', '=', false)
      .where('volunteer_account.is_disabled', '=', false)
      .where('organization_account.is_deleted', '=', false)
      .execute();

    await executeTransaction(db, async (trx) => {
      await trx.deleteFrom('posting_skill').where('posting_id', '=', postingId).execute();
      await trx.deleteFrom('enrollment_application_date').where('application_id', 'in', trx
        .selectFrom('enrollment_application')
        .select('id')
        .where('posting_id', '=', postingId)).execute();
      await trx.deleteFrom('enrollment_date').where('posting_id', '=', postingId).execute();
      await trx.deleteFrom('enrollment_application').where('posting_id', '=', postingId).execute();
      await trx.deleteFrom('enrollment').where('posting_id', '=', postingId).execute();
      await trx.deleteFrom('posting').where('id', '=', postingId).execute();
    });

    const impactedVolunteerIds = Array.from(new Set(impactedVolunteerRows.map(row => row.volunteer_id)));
    await Promise.all(impactedVolunteerIds.map(volunteerId => recomputeVolunteerExperienceVector(volunteerId, db)));
    await recomputeOrganizationHistoryVectorOnly(orgId, db);
    await recomputeOrganizationCompositeVectorOnly(orgId, db);
    await recomputePostingContextVectorsForOrganization(orgId, db);

    await Promise.allSettled(
      enrolledVolunteerEmailContexts.map(emailContext =>
        sendPostingDeletedEmail({
          volunteerEmail: emailContext.volunteer_email,
          volunteerName: `${emailContext.first_name} ${emailContext.last_name}`,
          postingTitle: emailContext.posting_title,
          organizationName: emailContext.organization_name,
        }).catch((err) => {
          console.error(`Failed to send deletion notification email for posting ${postingId} to volunteer ${emailContext.volunteer_id}:`, err);
        }),
      ),
    );

    res.json({});
  });

  postingRouter.get('/:id/applications', async (req, res: Response<PostingApplicationsReponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId } = postingIdParamsSchema.parse(req.params);

    const posting = await db
      .selectFrom('posting')
      .select(['id', 'automatic_acceptance', 'is_closed', 'max_volunteers'])
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    if (posting.automatic_acceptance) {
      res.json({ applications: [] });
      return;
    }

    const rejectedPostingIds = await rejectEndedPendingApplicationsForPostings(db, [postingId]);

    if (rejectedPostingIds.has(postingId)) {
      res.json({ applications: [] });
      return;
    }

    const applications = await db
      .selectFrom('enrollment_application')
      .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment_application.volunteer_id')
      .select([
        'enrollment_application.id as application_id',
        'enrollment_application.volunteer_id',
        'enrollment_application.message',
        'enrollment_application.created_at',
        'volunteer_account.first_name',
        'volunteer_account.last_name',
        'volunteer_account.email',
        'volunteer_account.date_of_birth',
        'volunteer_account.gender',
        'volunteer_account.cv_path',
      ])
      .where('enrollment_application.posting_id', '=', postingId)
      .where('volunteer_account.is_deleted', '=', false)
      .where('volunteer_account.is_disabled', '=', false)
      .execute();

    const volunteerIds = applications.map(a => a.volunteer_id);
    const skills = volunteerIds.length > 0
      ? await db
          .selectFrom('volunteer_skill')
          .selectAll()
          .where('volunteer_id', 'in', volunteerIds)
          .execute()
      : [];
    const applicationIds = applications.map(application => application.application_id);
    const applicationDates = applicationIds.length > 0
      ? await db
          .selectFrom('enrollment_application_date')
          .select([
            'application_id',
            sql<string>`to_char(enrollment_application_date.date, 'YYYY-MM-DD')`.as('date'),
          ])
          .where('application_id', 'in', applicationIds)
          .execute()
      : [];

    const skillsByVolunteerId = new Map<number, VolunteerSkill[]>();
    skills.forEach((skill) => {
      if (!skillsByVolunteerId.has(skill.volunteer_id)) {
        skillsByVolunteerId.set(skill.volunteer_id, []);
      }
      skillsByVolunteerId.get(skill.volunteer_id)!.push(skill);
    });
    const requestedDatesByApplicationId = new Map<number, string[]>();
    applicationDates.forEach((dateRow) => {
      if (!requestedDatesByApplicationId.has(dateRow.application_id)) {
        requestedDatesByApplicationId.set(dateRow.application_id, []);
      }
      requestedDatesByApplicationId.get(dateRow.application_id)!.push(dateRow.date);
    });

    const applicationsWithSkills = applications.map(app => ({
      ...app,
      message: app.message,
      skills: skillsByVolunteerId.get(app.volunteer_id) ?? [],
      requested_dates: requestedDatesByApplicationId.get(app.application_id)?.sort() ?? [],
    }));

    res.json({ applications: applicationsWithSkills });
  });

  postingRouter.post('/:id/applications/:applicationId/accept', async (req, res: Response<PostingApplicationAcceptanceResponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId, applicationId } = zod.object({
      id: zod.coerce.number().int().positive(),
      applicationId: zod.coerce.number().int().positive(),
    }).parse(req.params);

    const posting = await db
      .selectFrom('posting')
      .select(['id', 'automatic_acceptance', 'is_closed', 'max_volunteers', 'allows_partial_attendance', 'start_date', 'end_date', 'end_time'])
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    if (posting.automatic_acceptance) {
      res.status(400);
      throw new Error('Cannot accept applications for open postings');
    }

    const application = await db
      .selectFrom('enrollment_application')
      .select(['id', 'volunteer_id', 'posting_id', 'message'])
      .where('id', '=', applicationId)
      .executeTakeFirst();

    if (!application) {
      res.status(404);
      throw new Error('Application not found');
    }

    if (application.posting_id !== postingId) {
      res.status(403);
      throw new Error('Application does not belong to this posting');
    }

    const emailContext = await db
      .selectFrom('enrollment_application')
      .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment_application.volunteer_id')
      .innerJoin('posting', 'posting.id', 'enrollment_application.posting_id')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .select([
        'volunteer_account.email as volunteer_email',
        'volunteer_account.first_name',
        'volunteer_account.last_name',
        'volunteer_account.is_deleted as volunteer_is_deleted',
        'volunteer_account.is_disabled as volunteer_is_disabled',
        'organization_account.name as organization_name',
        'posting.title as posting_title',
      ])
      .where('enrollment_application.id', '=', applicationId)
      .where('enrollment_application.posting_id', '=', postingId)
      .where('posting.organization_id', '=', orgId)
      .executeTakeFirst();

    if (!emailContext) {
      res.status(404);
      throw new Error('Application not found');
    }

    if (emailContext.volunteer_is_deleted || emailContext.volunteer_is_disabled) {
      res.status(400);
      throw new Error('Cannot accept application from an inactive volunteer');
    }

    const appDates = await db
      .selectFrom('enrollment_application_date')
      .select('date')
      .where('application_id', '=', applicationId)
      .execute();
    const acceptedDateStrings = appDates
      .map(row => normalizeStoredDate(row.date))
      .filter((date): date is string => Boolean(date));
    const enrollmentDateStrings = acceptedDateStrings.length > 0
      ? acceptedDateStrings
      : getPostingDates(posting.start_date, posting.end_date);

    await executeTransaction(db, async (trx) => {
      const lockedPosting = await trx
        .selectFrom('posting')
        .select([
          'id',
          'is_closed',
          'max_volunteers',
          'end_date',
          'end_time',
        ])
        .where('id', '=', postingId)
        .where('organization_id', '=', orgId)
        .forUpdate()
        .executeTakeFirst();

      if (!lockedPosting) {
        res.status(404);
        throw new Error('Posting not found');
      }

      if (hasPostingEnded(lockedPosting)) {
        res.status(403);
        throw new Error('This posting has ended');
      }

      if (lockedPosting.max_volunteers !== undefined && lockedPosting.max_volunteers !== null) {
        const enrollmentCountRow = await trx
          .selectFrom('enrollment')
          .select(sql<number>`count(enrollment.id)`.as('count'))
          .where('posting_id', '=', postingId)
          .executeTakeFirst();

        if (Number(enrollmentCountRow?.count ?? 0) >= lockedPosting.max_volunteers) {
          res.status(403);
          throw new Error('This posting has reached the maximum number of volunteers');
        }
      }

      const enrollment = await trx
        .insertInto('enrollment')
        .values({
          volunteer_id: application.volunteer_id,
          posting_id: application.posting_id,
          message: application.message ?? undefined,
          attended: false,
        })
        .returningAll()
        .executeTakeFirst();

      if (!enrollment) {
        throw new Error('Failed to create enrollment');
      }

      if (enrollmentDateStrings.length > 0) {
        await trx
          .insertInto('enrollment_date')
          .values(enrollmentDateStrings.map(date => ({
            enrollment_id: enrollment.id,
            posting_id: postingId,
            date: new Date(`${date}T00:00:00.000Z`),
            attended: false,
          })))
          .execute();
      }

      await trx
        .deleteFrom('enrollment_application_date')
        .where('application_id', '=', applicationId)
        .execute();

      await trx
        .deleteFrom('enrollment_application')
        .where('id', '=', applicationId)
        .execute();
    });

    await recomputePostingContextVectorOnly(postingId, db);
    const acceptedDates = enrollmentDateStrings;
    if (emailContext) {
      try {
        await sendVolunteerApplicationAcceptedEmail({
          volunteerEmail: emailContext.volunteer_email,
          volunteerName: `${emailContext.first_name} ${emailContext.last_name}`,
          organizationName: emailContext.organization_name,
          postingTitle: emailContext.posting_title,
          acceptedDates,
        });
      } catch (err) {
        console.error('Failed to send acceptance email:', err);
      }
    }

    res.json({});
  });

  postingRouter.delete('/:id/applications/:applicationId', async (req, res: Response<PostingApplicationRejectionResponse>) => {
    const orgId = req.userJWT!.id;
    const { id: postingId, applicationId } = zod.object({
      id: zod.coerce.number().int().positive(),
      applicationId: zod.coerce.number().int().positive(),
    }).parse(req.params);

    const posting = await db
      .selectFrom('posting')
      .select(['id', 'automatic_acceptance'])
      .where('id', '=', postingId)
      .where('organization_id', '=', orgId)
      .executeTakeFirst();

    if (!posting) {
      res.status(404);
      throw new Error('Posting not found');
    }

    const application = await db
      .selectFrom('enrollment_application')
      .selectAll()
      .where('id', '=', applicationId)
      .executeTakeFirst();

    if (!application) {
      res.status(404);
      throw new Error('Application not found');
    }

    if (application.posting_id !== postingId) {
      res.status(403);
      throw new Error('Application does not belong to this posting');
    }

    const emailContext = await db
      .selectFrom('enrollment_application')
      .innerJoin('volunteer_account', 'volunteer_account.id', 'enrollment_application.volunteer_id')
      .innerJoin('posting', 'posting.id', 'enrollment_application.posting_id')
      .innerJoin('organization_account', 'organization_account.id', 'posting.organization_id')
      .select([
        'volunteer_account.email as volunteer_email',
        'volunteer_account.first_name',
        'volunteer_account.last_name',
        'organization_account.name as organization_name',
        'posting.title as posting_title',
      ])
      .where('enrollment_application.id', '=', applicationId)
      .where('enrollment_application.posting_id', '=', postingId)
      .where('posting.organization_id', '=', orgId)
      .executeTakeFirst();

    await executeTransaction(db, async (trx) => {
      await trx
        .deleteFrom('enrollment_application_date')
        .where('application_id', '=', applicationId)
        .execute();

      await trx
        .deleteFrom('enrollment_application')
        .where('id', '=', applicationId)
        .execute();
    });

    if (emailContext) {
      try {
        await sendVolunteerApplicationRejectedEmail({
          volunteerEmail: emailContext.volunteer_email,
          volunteerName: `${emailContext.first_name} ${emailContext.last_name}`,
          organizationName: emailContext.organization_name,
          postingTitle: emailContext.posting_title,
        });
      } catch (err) {
        console.error('Failed to send rejection email:', err);
      }
    }

    res.json({});
  });

  postingRouter.use(createAttendanceRouter(db));

  return postingRouter;
}

export default createPostingRouter;
