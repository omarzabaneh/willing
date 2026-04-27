import { zodResolver } from '@hookform/resolvers/zod';
import {
  Check,
  AlertTriangle,
  Calendar,
  CalendarX2,
  Cake,
  Edit3,
  House,
  ListChecks,
  Lock,
  LockOpen,
  MapPin,
  RefreshCcw,
  Save,
  Send,
  ShieldCheck,
  Tag,
  Trash2,
  Users,
  SquareArrowRight,
  X,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';

import AuthContext from '../auth/AuthContext.tsx';
import Alert from '../components/Alert.tsx';
import Button from '../components/Button.tsx';
import CalendarInfo from '../components/CalendarInfo.tsx';
import Card from '../components/Card.tsx';
import CustomMessageModal from '../components/CustomMessageModal.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ColumnLayout from '../components/layout/ColumnLayout.tsx';
import PageContainer from '../components/layout/PageContainer.tsx';
import PageHeader from '../components/layout/PageHeader.tsx';
import LinkButton from '../components/LinkButton.tsx';
import Loading from '../components/Loading.tsx';
import LocationPicker from '../components/LocationPicker.tsx';
import OrganizationProfilePicture from '../components/OrganizationProfilePicture.tsx';
import PostingDateTime from '../components/PostingDateTime.tsx';
import CrisisCard from '../components/postings/CrisisCard.tsx';
import { hasPostingEnded as hasPostingEndedByTime } from '../components/postings/postingUtils.ts';
import usePostingStatusNow from '../components/postings/usePostingStatusNow.ts';
import SkillsInput from '../components/skills/SkillsInput.tsx';
import SkillsList from '../components/skills/SkillsList.tsx';
import { ToggleButton } from '../components/ToggleButton.tsx';
import VolunteerInfoCollapse from '../components/VolunteerInfoCollapse.tsx';
import { useModal } from '../contexts/useModal.ts';
import useNotifications from '../notifications/useNotifications';
import { postingEditFormSchema, type PostingEditFormData } from '../schemas/posting';
import { executeAndShowError, FormField } from '../utils/formUtils.tsx';
import requestServer from '../utils/requestServer.ts';
import useAsync from '../utils/useAsync';
import { useOrganization } from '../utils/useUsers.ts';

import type {
  OrganizationCrisisResponse,
  OrganizationCrisesResponse,
  PostingApplicationsReponse,
  PostingEnrollmentsResponse,
  PostingResponse,
  OrganizationProfileResponse,
  VolunteerCrisisResponse,
  VolunteerPostingResponse,
} from '../../../server/src/api/types.ts';
import type { Crisis } from '../../../server/src/db/tables/index.ts';
import type { PostingApplication, PostingEnrollment, PostingWithContext, PostingWithSkills } from '../../../server/src/types.ts';

const parseLocalDateParts = (value: string | Date) => {
  if (typeof value === 'string') {
    const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (isoDateMatch) {
      return {
        year: Number(isoDateMatch[1]),
        month: Number(isoDateMatch[2]),
        day: Number(isoDateMatch[3]),
      };
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
  };
};

const normalizeDateOnlyValue = (value: string | Date) => {
  const dateParts = parseLocalDateParts(value);
  if (!dateParts) return '';

  return `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
};

const normalizeDateOnlyList = (values: string[]) => values
  .map(normalizeDateOnlyValue)
  .filter((value): value is string => Boolean(value));

const buildDateRangeInclusive = (startValue: string | Date, endValue: string | Date) => {
  const startParts = parseLocalDateParts(startValue);
  const endParts = parseLocalDateParts(endValue);

  if (!startParts || !endParts) {
    return [] as string[];
  }

  const start = new Date(startParts.year, startParts.month - 1, startParts.day);
  const end = new Date(endParts.year, endParts.month - 1, endParts.day);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
    return [] as string[];
  }

  const dates: string[] = [];
  const cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    dates.push(normalizeDateOnlyValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
};

const getDateInputValue = (value: Date | string) => {
  const dateParts = parseLocalDateParts(value);
  if (!dateParts) return '';

  return `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
};

const getTimeInputValue = (timeValue: string | undefined) => (timeValue ?? '').slice(0, 5);

const getPostingStartDateTime = (posting: PostingWithSkills) => {
  const datePart = getDateInputValue(posting.start_date);
  const timePart = (posting.start_time ?? '').slice(0, 5) || '00:00';
  return new Date(`${datePart}T${timePart}`);
};

const formatDisplayDate = (value?: string) => {
  if (!value) return '-';

  const dateParts = parseLocalDateParts(value);
  if (dateParts) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(dateParts.year, dateParts.month - 1, dateParts.day));
  }

  return value;
};

const formatDisplayTime = (value?: string) => {
  if (!value) return '-';

  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value;

  const normalizedHours = ((hours % 24) + 24) % 24;
  const suffix = normalizedHours >= 12 ? 'PM' : 'AM';
  const hour12 = normalizedHours % 12 === 0 ? 12 : normalizedHours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

function PostingPage() {
  const auth = useContext(AuthContext);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const isVolunteerView = auth.user?.role !== 'organization';
  const organizationAccount = useOrganization();
  const account = isVolunteerView ? null : organizationAccount;

  const [posting, setPosting] = useState<PostingWithSkills | PostingWithContext | null>(null);
  const [enrollments, setEnrollments] = useState<PostingEnrollment[]>([]);
  const [applications, setApplications] = useState<PostingApplication[]>([]);
  const [hasPendingApplication, setHasPendingApplication] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [selectedCrisisId, setSelectedCrisisId] = useState<number | undefined>(undefined);
  const [availableCrises, setAvailableCrises] = useState<OrganizationCrisesResponse['crises']>([]);
  const [currentPostingCrisis, setCurrentPostingCrisis] = useState<Crisis | undefined>(undefined);
  const [position, setPosition] = useState<[number, number]>([33.90192863620578, 35.477959277880416]);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingClosed, setTogglingClosed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [processingApplicationId, setProcessingApplicationId] = useState<number | null>(null);
  const [isApplyModalOpen, setIsApplyModalOpen] = useState(false);
  const [selectedApplicationDates, setSelectedApplicationDates] = useState<string[]>([]);
  const [selectedVolunteerDates, setSelectedVolunteerDates] = useState<string[]>([]);
  const [postingDates, setPostingDates] = useState<string[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [postingEnrollmentCount, setPostingEnrollmentCount] = useState(0);
  const [postingOrganization, setPostingOrganization] = useState<{ id: number; name: string; logoPath?: string | null } | null>(null);
  const notifications = useNotifications();
  const modal = useModal();

  const form = useForm<PostingEditFormData>({
    resolver: zodResolver(postingEditFormSchema),
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: {
      automatic_acceptance: true,
      is_closed: false,
      allows_partial_attendance: false,
    },
  });

  const isOpen = useWatch({
    control: form.control,
    name: 'automatic_acceptance',
    defaultValue: true,
  });
  const startDate = useWatch({ control: form.control, name: 'start_date' }) ?? '';
  const startTime = useWatch({ control: form.control, name: 'start_time' }) ?? '';
  const endDate = useWatch({ control: form.control, name: 'end_date' }) ?? '';
  const endTime = useWatch({ control: form.control, name: 'end_time' }) ?? '';
  const statusNow = usePostingStatusNow();
  const hasEnded = useMemo(() => (
    posting
      ? Boolean(('has_ended' in posting ? posting.has_ended : false) || hasPostingEndedByTime(posting, statusNow))
      : false
  ), [posting, statusNow]);

  const selectedCrisisName = useMemo(() => {
    if (selectedCrisisId == null) return null;
    return availableCrises.find(crisis => crisis.id === selectedCrisisId)?.name
      ?? (currentPostingCrisis?.id === selectedCrisisId ? currentPostingCrisis.name : `Crisis #${selectedCrisisId}`);
  }, [availableCrises, currentPostingCrisis, selectedCrisisId]);

  const selectedCrisis = useMemo(() => {
    if (selectedCrisisId == null) return null;
    return availableCrises.find(crisis => crisis.id === selectedCrisisId)
      ?? (currentPostingCrisis?.id === selectedCrisisId ? currentPostingCrisis : null);
  }, [availableCrises, currentPostingCrisis, selectedCrisisId]);

  const loadCrisesRequest = useCallback(async () => {
    const response = await requestServer<OrganizationCrisesResponse>('/organization/crises', {
      includeJwt: true,
    });
    setAvailableCrises(response.crises);
    return response.crises;
  }, []);

  const {
    loading: loadingCrises,
    error: crisesError,
    trigger: loadCrises,
  } = useAsync<OrganizationCrisesResponse['crises'], []>(loadCrisesRequest, {
    notifyOnError: false,
  });

  useEffect(() => {
    if (isVolunteerView) {
      setAvailableCrises([]);
      return;
    }

    void loadCrises();
  }, [isVolunteerView, loadCrises]);

  useEffect(() => {
    if (selectedCrisisId == null) {
      setCurrentPostingCrisis(undefined);
      return;
    }

    const existingMatch = availableCrises.find(crisis => crisis.id === selectedCrisisId);
    if (existingMatch) {
      setCurrentPostingCrisis(existingMatch);
      return;
    }

    if (currentPostingCrisis?.id === selectedCrisisId) {
      return;
    }

    let isCancelled = false;

    const loadCurrentCrisis = async () => {
      try {
        const response = isVolunteerView
          ? await requestServer<VolunteerCrisisResponse>(`/volunteer/crises/${selectedCrisisId}`, {
              includeJwt: true,
            })
          : await requestServer<OrganizationCrisisResponse>(`/organization/crises/${selectedCrisisId}`, {
              includeJwt: true,
            });

        if (!isCancelled) {
          setCurrentPostingCrisis(response.crisis);
        }
      } catch {
        if (!isCancelled) {
          setCurrentPostingCrisis(undefined);
        }
      }
    };

    loadCurrentCrisis();

    return () => {
      isCancelled = true;
    };
  }, [availableCrises, currentPostingCrisis?.id, isVolunteerView, selectedCrisisId]);

  const loadPostingRequest = useCallback(async () => {
    if (!id) return;

    if (isVolunteerView) {
      const postingResponse = await requestServer<VolunteerPostingResponse>(
        `/volunteer/posting/${id}`,
        { includeJwt: true },
      );

      setPosting(postingResponse.posting);
      setCurrentPostingCrisis(undefined);
      setEnrollments([]);
      setHasPendingApplication(postingResponse.posting.application_status === 'pending');
      setIsEnrolled(postingResponse.posting.application_status === 'registered');
      setPostingEnrollmentCount(postingResponse.posting.enrollment_count);
      const normalizedPostingDates = normalizeDateOnlyList(postingResponse.posting_dates ?? []);
      const computedPostingDates = buildDateRangeInclusive(
        postingResponse.posting.start_date,
        postingResponse.posting.end_date ?? postingResponse.posting.start_date,
      );
      const normalizedStartDate = normalizeDateOnlyValue(postingResponse.posting.start_date);
      const normalizedEndDate = normalizeDateOnlyValue(
        postingResponse.posting.end_date ?? postingResponse.posting.start_date,
      );
      const mergedPostingDates = Array.from(new Set([
        ...normalizedPostingDates,
        ...computedPostingDates,
        normalizedStartDate,
        normalizedEndDate,
      ].filter(Boolean))).sort();
      setPostingDates(mergedPostingDates);
      setSelectedVolunteerDates(normalizeDateOnlyList(postingResponse.selected_dates ?? []));
      setSkills(postingResponse.posting.skills.map(s => s.name));
      setSelectedCrisisId(postingResponse.posting.crisis_id ?? undefined);
      setPosition([
        postingResponse.posting.latitude ?? 33.90192863620578,
        postingResponse.posting.longitude ?? 35.477959277880416,
      ]);

      try {
        const organizationResponse = await requestServer<OrganizationProfileResponse>(
          `/organization/${postingResponse.posting.organization_id}`,
          { includeJwt: true },
        );

        setPostingOrganization({
          id: organizationResponse.organization.id,
          name: organizationResponse.organization.name,
          logoPath: organizationResponse.organization.logo_path,
        });
      } catch {
        setPostingOrganization({
          id: postingResponse.posting.organization_id,
          name: 'Organization',
          logoPath: postingResponse.posting.organization_logo_path,
        });
      }

      form.reset({
        title: postingResponse.posting.title,
        description: postingResponse.posting.description,
        location_name: postingResponse.posting.location_name,
        start_date: getDateInputValue(postingResponse.posting.start_date),
        start_time: getTimeInputValue(postingResponse.posting.start_time),
        end_date: postingResponse.posting.end_date ? getDateInputValue(postingResponse.posting.end_date) : '',
        end_time: getTimeInputValue(postingResponse.posting.end_time),
        max_volunteers: postingResponse.posting.max_volunteers?.toString() ?? '',
        minimum_age: postingResponse.posting.minimum_age?.toString() ?? '',
        automatic_acceptance: postingResponse.posting.automatic_acceptance,
        is_closed: postingResponse.posting.is_closed,
        allows_partial_attendance: postingResponse.posting.allows_partial_attendance,
      });

      return;
    }

    const postingResponse = await requestServer<PostingResponse>(`/organization/posting/${id}`, { includeJwt: true });
    const canManageFetchedPosting = account?.id === postingResponse.posting.organization_id;

    const postingWithSkills = {
      ...postingResponse.posting,
      skills: postingResponse.skills,
    };

    setPosting(postingWithSkills);
    setCurrentPostingCrisis(postingResponse.crisis);
    if (canManageFetchedPosting) {
      const enrollmentsResponse = await requestServer<PostingEnrollmentsResponse>(`/organization/posting/${id}/enrollments`, { includeJwt: true });
      setEnrollments(enrollmentsResponse.enrollments);
      setPostingEnrollmentCount(enrollmentsResponse.enrollments.length);

      if (!postingResponse.posting.automatic_acceptance) {
        const applicationsResponse = await requestServer<PostingApplicationsReponse>(
          `/organization/posting/${id}/applications`,
          { includeJwt: true },
        );
        setApplications(applicationsResponse.applications);
      } else {
        setApplications([]);
      }
    } else {
      setIsEditMode(false);
      setEnrollments([]);
      setApplications([]);
      setPostingEnrollmentCount(0);
    }

    setIsEnrolled(false);
    setHasPendingApplication(false);
    setSelectedVolunteerDates([]);
    setSkills(postingResponse.skills.map(s => s.name));
    setSelectedCrisisId(postingResponse.posting.crisis_id ?? undefined);
    setPosition([
      postingResponse.posting.latitude ?? 33.90192863620578,
      postingResponse.posting.longitude ?? 35.477959277880416,
    ]);

    try {
      const organizationResponse = await requestServer<OrganizationProfileResponse>(
        `/organization/${postingResponse.posting.organization_id}`,
        { includeJwt: true },
      );

      setPostingOrganization({
        id: organizationResponse.organization.id,
        name: organizationResponse.organization.name,
        logoPath: organizationResponse.organization.logo_path,
      });
    } catch {
      setPostingOrganization({
        id: postingResponse.posting.organization_id,
        name: 'Organization',
        logoPath: undefined,
      });
    }

    form.reset({
      title: postingResponse.posting.title,
      description: postingResponse.posting.description,
      location_name: postingResponse.posting.location_name,
      start_date: getDateInputValue(postingResponse.posting.start_date),
      start_time: getTimeInputValue(postingResponse.posting.start_time),
      end_date: postingResponse.posting.end_date ? getDateInputValue(postingResponse.posting.end_date) : '',
      end_time: getTimeInputValue(postingResponse.posting.end_time),
      max_volunteers: postingResponse.posting.max_volunteers?.toString() ?? '',
      minimum_age: postingResponse.posting.minimum_age?.toString() ?? '',
      automatic_acceptance: postingResponse.posting.automatic_acceptance,
      is_closed: postingResponse.posting.is_closed,
      allows_partial_attendance: postingResponse.posting.allows_partial_attendance,
    });
  }, [id, form, isVolunteerView, account]);

  const {
    loading,
    error: fetchError,
    trigger: loadPosting,
  } = useAsync<void, []>(loadPostingRequest, {
    notifyOnError: true,
  });

  useEffect(() => {
    void loadPosting();
  }, [loadPosting]);

  const { trigger: updatePosting } = useAsync(
    async (postingId: string, payload: Record<string, unknown>) => requestServer<PostingResponse>(
      `/organization/posting/${postingId}`,
      {
        method: 'PUT',
        body: payload,
        includeJwt: true,
      },
    ),
    { notifyOnError: true },
  );

  const { trigger: deletePosting } = useAsync(
    async (postingId: string) => requestServer(`/organization/posting/${postingId}`, {
      method: 'DELETE',
      includeJwt: true,
    }),
    { notifyOnError: true },
  );

  const { trigger: applyToPosting } = useAsync(
    async (postingId: string, message?: string, dates?: string[]) => requestServer(`/volunteer/posting/${postingId}/enroll`, {
      method: 'POST',
      body: {
        message,
        dates,
      },
      includeJwt: true,
    }),
    { notifyOnError: true },
  );

  const { trigger: withdrawFromPosting } = useAsync(
    async (postingId: string) => requestServer(`/volunteer/posting/${postingId}/enroll`, {
      method: 'DELETE',
      includeJwt: true,
    }),
    { notifyOnError: true },
  );

  const { trigger: acceptPostingApplication } = useAsync(
    async (postingId: string, applicationId: number) => requestServer(
      `/organization/posting/${postingId}/applications/${applicationId}/accept`,
      { method: 'POST', includeJwt: true },
    ),
    { notifyOnError: true },
  );

  const { trigger: loadPostingEnrollments } = useAsync(
    async (postingId: string) => requestServer<PostingEnrollmentsResponse>(
      `/organization/posting/${postingId}/enrollments`,
      { includeJwt: true },
    ),
    { notifyOnError: true },
  );

  const { trigger: rejectPostingApplication } = useAsync(
    async (postingId: string, applicationId: number) => requestServer(
      `/organization/posting/${postingId}/applications/${applicationId}`,
      { method: 'DELETE', includeJwt: true },
    ),
    { notifyOnError: true },
  );

  const onSave = form.handleSubmit(async (data) => {
    if (!isEditMode || !posting || !id || !account?.id) return;

    await executeAndShowError(form, async () => {
      setSaving(true);

      try {
        const payload = {
          title: data.title.trim(),
          description: data.description.trim(),
          location_name: data.location_name.trim(),
          latitude: position[0],
          longitude: position[1],
          max_volunteers: data.max_volunteers === '' ? null : data.max_volunteers ? Number(data.max_volunteers) : undefined,
          minimum_age: data.minimum_age === '' ? null : data.minimum_age ? Number(data.minimum_age) : undefined,
          automatic_acceptance: data.automatic_acceptance,
          allows_partial_attendance: data.allows_partial_attendance,
          is_closed: data.is_closed,
          skills: skills.length > 0 ? skills : undefined,
          crisis_id: selectedCrisisId ?? null,
          start_date: data.start_date,
          start_time: data.start_time,
          end_date: data.end_date,
          end_time: data.end_time,
        };

        const response = await updatePosting(id, payload);

        const updatedPosting = {
          ...response.posting,
          skills: response.skills,
        };

        setPosting(updatedPosting);
        setCurrentPostingCrisis(response.crisis);
        setSkills(response.skills.map(s => s.name));
        setSelectedCrisisId(response.posting.crisis_id ?? undefined);
        notifications.push({
          type: 'success',
          message: 'Posting updated successfully.',
        });
        setIsEditMode(false);
      } finally {
        setSaving(false);
      }
    });
  });

  const onCancelEdit = useCallback(() => {
    if (!posting) return;
    form.reset({
      title: posting.title,
      description: posting.description,
      location_name: posting.location_name,
      start_date: getDateInputValue(posting.start_date),
      start_time: getTimeInputValue(posting.start_time),
      end_date: posting.end_date ? getDateInputValue(posting.end_date) : '',
      end_time: getTimeInputValue(posting.end_time),
      max_volunteers: posting.max_volunteers?.toString() ?? '',
      minimum_age: posting.minimum_age?.toString() ?? '',
      automatic_acceptance: posting.automatic_acceptance,
      is_closed: posting.is_closed,
      allows_partial_attendance: posting.allows_partial_attendance,
    });
    setSkills(posting.skills.map((s: { name: string }) => s.name));
    setSelectedCrisisId(posting.crisis_id ?? undefined);
    setPosition([
      posting.latitude ?? 33.90192863620578,
      posting.longitude ?? 35.477959277880416,
    ]);
    setIsEditMode(false);
  }, [form, posting]);

  const onDelete = useCallback(async () => {
    if (!id) return;

    const choice = await modal.promptModal({
      title: 'Delete Posting',
      content: 'Are you sure you want to delete this posting? This action cannot be undone.',
      actions: [
        { value: 'cancel', label: 'Cancel', color: 'ghost' },
        { value: 'delete', label: 'Delete posting', color: 'error' },
      ],
      cancelable: true,
    });

    if (choice !== 'delete') return;

    try {
      setDeleting(true);
      await deletePosting(id);
      notifications.push({
        type: 'success',
        message: 'Posting deleted successfully.',
      });
      navigate('/organization');
    } finally {
      setDeleting(false);
    }
  }, [deletePosting, id, modal, navigate, notifications]);

  const onToggleClosed = async () => {
    if (!id || !posting) return;
    try {
      setTogglingClosed(true);
      const response = await updatePosting(id, { is_closed: !posting.is_closed });
      const updatedPosting = { ...response.posting, skills: response.skills };
      setPosting(updatedPosting);
      form.setValue('is_closed', response.posting.is_closed);
      notifications.push({
        type: 'success',
        message: response.posting.is_closed ? 'Posting closed successfully.' : 'Posting reopened successfully.',
      });
    } finally {
      setTogglingClosed(false);
    }
  };

  const closeApplyModal = useCallback(() => {
    setIsApplyModalOpen(false);
    setSelectedApplicationDates([]);
  }, []);

  const openApplyModal = useCallback(() => {
    if (!id || hasPendingApplication || isEnrolled || hasEnded) return;
    setSelectedApplicationDates([]);
    setIsApplyModalOpen(true);
  }, [id, hasPendingApplication, isEnrolled, hasEnded]);

  const submitApplication = useCallback(async (message?: string) => {
    if (!id || hasPendingApplication || isEnrolled || hasEnded || !posting) return;

    if (posting.allows_partial_attendance && !isSingleDayPosting) {
      if (selectedApplicationDates.length === 0) {
        notifications.push({ type: 'error', message: 'Please select at least one date to apply.' });
        return;
      }
    }

    try {
      setApplying(true);

      await applyToPosting(id, message, posting.allows_partial_attendance ? selectedApplicationDates : undefined);

      setHasPendingApplication(true);
      setIsApplyModalOpen(false);
      notifications.push({
        type: 'success',
        message: 'Application submitted successfully.',
      });

      await loadPosting();
    } finally {
      setApplying(false);
    }
  }, [applyToPosting, id, hasPendingApplication, isEnrolled, hasEnded, notifications, loadPosting, posting, postingDates, selectedApplicationDates]);

  const canWithdrawFromPosting = useMemo(() => {
    if (!posting) return false;
    return !hasEnded;
  }, [hasEnded, posting]);

  const withdrawApplication = useCallback(async () => {
    if (!id || (!hasPendingApplication && !isEnrolled)) return;
    if (!canWithdrawFromPosting) {
      notifications.push({
        type: 'error',
        message: 'This posting has already ended and can no longer be withdrawn.',
      });
      return;
    }

    const choice = await modal.promptModal({
      title: isEnrolled ? 'Leave Position' : 'Withdraw Application',
      content: isEnrolled
        ? 'Are you sure you want to leave this position?'
        : 'Are you sure you want to withdraw your application?',
      actions: [
        { value: 'cancel', label: 'Cancel', color: 'ghost' },
        { value: 'confirm', label: isEnrolled ? 'Leave position' : 'Withdraw application', color: 'error' },
      ],
      cancelable: true,
    });

    if (choice !== 'confirm') return;

    try {
      setWithdrawing(true);
      await withdrawFromPosting(id);

      setHasPendingApplication(false);
      setIsEnrolled(false);
      notifications.push({
        type: 'success',
        message: isEnrolled ? 'Left volunteering position.' : 'Application withdrawn successfully.',
      });

      await loadPosting();
    } finally {
      setWithdrawing(false);
    }
  }, [canWithdrawFromPosting, hasPendingApplication, id, isEnrolled, loadPosting, modal, notifications, withdrawFromPosting]);

  const acceptApplication = useCallback(async (applicationId: number) => {
    if (!id) return;

    try {
      setProcessingApplicationId(applicationId);

      await acceptPostingApplication(id, applicationId);

      const enrollmentsResponse = await loadPostingEnrollments(id);
      setEnrollments(enrollmentsResponse.enrollments);

      setApplications(prev => prev.filter(app => app.application_id !== applicationId));
      notifications.push({
        type: 'success',
        message: 'Application accepted successfully.',
      });
    } finally {
      setProcessingApplicationId(null);
    }
  }, [acceptPostingApplication, id, loadPostingEnrollments, notifications]);

  const rejectApplication = useCallback(async (applicationId: number) => {
    if (!id) return;

    const choice = await modal.promptModal({
      title: 'Reject Application',
      content: 'Are you sure you want to reject this application?',
      actions: [
        { value: 'cancel', label: 'Cancel', color: 'ghost' },
        { value: 'reject', label: 'Reject application', color: 'error' },
      ],
      cancelable: true,
    });

    if (choice !== 'reject') return;

    try {
      setProcessingApplicationId(applicationId);
      await rejectPostingApplication(id, applicationId);

      setApplications(prev => prev.filter(app => app.application_id !== applicationId));
      notifications.push({
        type: 'success',
        message: 'Application rejected.',
      });
    } finally {
      setProcessingApplicationId(null);
    }
  }, [id, modal, notifications, rejectPostingApplication]);

  const onMapPositionPick = useCallback((coords: [number, number]) => {
    setPosition(coords);
  }, []);

  const formValues = useWatch({ control: form.control });

  const formattedStartDate = useMemo(() => formatDisplayDate(startDate), [startDate]);
  const formattedStartTime = useMemo(() => formatDisplayTime(startTime), [startTime]);
  const formattedEndDate = useMemo(() => formatDisplayDate(endDate), [endDate]);
  const formattedEndTime = useMemo(() => formatDisplayTime(endTime), [endTime]);

  const applicationStatus = useMemo(() => {
    if (isEnrolled) {
      return {
        label: 'Accepted',
        description: 'Your application was accepted and you are enrolled in this posting.',
        badgeClassName: 'badge-success',
      };
    }

    if (hasPendingApplication) {
      return {
        label: 'Pending',
        description: 'Your application is waiting for the organization to review it.',
        badgeClassName: 'badge-warning',
      };
    }

    return {
      label: 'Not Applied',
      description: 'You have not applied to this posting yet.',
      badgeClassName: 'badge-ghost',
    };
  }, [hasPendingApplication, isEnrolled]);

  const formattedSelectedDates = useMemo(() => (
    (selectedVolunteerDates ?? []).map(date => formatDisplayDate(date))
  ), [selectedVolunteerDates]);

  const applicationDaysLabel = useMemo(() => {
    if (!posting || (!isEnrolled && !hasPendingApplication)) return null;
    if (!posting.allows_partial_attendance) {
      if (startDate === endDate && startDate) return formatDisplayDate(startDate);
      return 'All days';
    }
    if (formattedSelectedDates.length === 0) return null;
    return formattedSelectedDates.join(', ');
  }, [endDate, formattedSelectedDates, hasPendingApplication, isEnrolled, posting, startDate]);

  const shouldShowCommitmentCard = useMemo(() => {
    if (!posting) return false;
    return startDate !== endDate;
  }, [endDate, posting, startDate]);

  const isSingleDayPosting = startDate === endDate;

  const fullPostingDates = useMemo(() => {
    if (!posting?.allows_partial_attendance) return [];
    const maxVolunteers = posting.max_volunteers;
    if (maxVolunteers == null) return [];

    const dateCapacity = 'date_capacity' in posting ? (posting.date_capacity ?? {}) : {};
    return postingDates.filter(date => (dateCapacity[date] ?? 0) >= maxVolunteers);
  }, [posting, postingDates]);

  const postingDateDetails = useMemo(() => {
    if (!posting || !postingDates.length) return {};
    const maxVolunteers = posting.max_volunteers;
    if (maxVolunteers == null) return {};

    const combinedCapacity = 'date_capacity' in posting ? (posting.date_capacity ?? {}) : {};
    const confirmedCapacity = 'confirmed_date_capacity' in posting
      ? (posting.confirmed_date_capacity ?? {})
      : combinedCapacity;

    return postingDates.reduce<Record<string, string>>((acc, date) => {
      const confirmedEnrolled = confirmedCapacity[date] ?? 0;
      const isFull = (combinedCapacity[date] ?? 0) >= maxVolunteers;
      acc[date] = isFull
        ? 'Full'
        : `${confirmedEnrolled}/${maxVolunteers}`;
      return acc;
    }, {});
  }, [posting, postingDates]);

  const canOpenAttendancePage = useMemo(() => {
    if (isVolunteerView || !posting) return false;
    return new Date() >= getPostingStartDateTime(posting);
  }, [isVolunteerView, posting]);
  const canManagePosting = useMemo(() => {
    if (isVolunteerView || !posting || !account?.id) return false;
    return posting.organization_id === account.id;
  }, [isVolunteerView, posting, account]);

  const currentEnrollmentCount = useMemo(() => {
    if (!posting) return 0;
    return isVolunteerView ? postingEnrollmentCount : enrollments.length;
  }, [isVolunteerView, posting, postingEnrollmentCount, enrollments.length]);

  const maxVolunteers = posting?.max_volunteers;
  const shouldShowVolunteerProgress = Boolean(maxVolunteers != null && (!posting?.allows_partial_attendance || isSingleDayPosting));

  const overMaxVolunteerCount = useMemo(() => {
    if (!maxVolunteers) return 0;
    return Math.max(0, currentEnrollmentCount - maxVolunteers);
  }, [currentEnrollmentCount, maxVolunteers]);

  const volunteerProgressPercent = useMemo(() => {
    if (!maxVolunteers || maxVolunteers <= 0) return 0;
    return Math.min(100, Math.round((currentEnrollmentCount / maxVolunteers) * 100));
  }, [currentEnrollmentCount, maxVolunteers]);

  const remainingSpots = useMemo(() => {
    if (maxVolunteers == null) return undefined;
    return Math.max(0, maxVolunteers - currentEnrollmentCount);
  }, [currentEnrollmentCount, maxVolunteers]);
  if (loading) {
    return (
      <div className="grow bg-base-200">
        <div className="p-6 md:container mx-auto">
          <div className="flex justify-center mt-8">
            <Loading size="xl" />
          </div>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="grow bg-base-200">
        <div className="p-6 md:container mx-auto">
          <Alert color="error">
            {fetchError.message}
          </Alert>
          <Button
            style="outline"
            className="mt-4"
            onClick={() => void loadPosting()}
            Icon={RefreshCcw}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!posting) {
    return (
      <div className="grow bg-base-200">
        <div className="p-6 md:container mx-auto">
          <Alert color="warning">
            Posting not found.
          </Alert>
          <LinkButton style="outline" className="mt-4" to="/organization" Icon={House}>
            Back to Home
          </LinkButton>
        </div>
      </div>
    );
  }

  return (
    <PageContainer>
      <CustomMessageModal
        open={isApplyModalOpen}
        submitting={applying}
        onClose={closeApplyModal}
        onSubmit={submitApplication}
        title="Apply to posting"
        placeholder="You can add an optional message to tell the organization why you're interested in this opportunity"
      >
        {posting?.allows_partial_attendance && !isSingleDayPosting && (
          <div className="mt-3">
            <p className="text-sm font-medium mb-2">Select your available days (partial attendance)</p>
            <CalendarInfo
              selectionMode="multiple"
              selectedDates={selectedApplicationDates}
              onSelectedDatesChange={setSelectedApplicationDates}
              allowedDates={postingDates}
              disabledDates={fullPostingDates}
              dateDetails={postingDateDetails}
            />
            <p className="text-xs text-muted mt-2">You must select at least one available day. Full days are unavailable.</p>
          </div>
        )}
      </CustomMessageModal>

      <PageHeader
        title="Posting Details"
        subtitle={isVolunteerView
          ? 'Review details before applying'
          : canManagePosting
            ? 'View and manage your posting'
            : 'Review posting details'}
        icon={ListChecks}
        showBack
        defaultBackTo={isVolunteerView ? '/volunteer' : '/organization'}
        actions={canManagePosting && (isEditMode
          ? (
              <span className="flex gap-2 flex-wrap justify-end">
                <Button style="outline" onClick={onCancelEdit} disabled={saving} Icon={X} size="sm">
                  Cancel
                </Button>
                <Button color="primary" onClick={onSave} loading={saving} Icon={Save} size="sm">
                  Save Changes
                </Button>
              </span>
            )
          : (
              <span className="flex gap-2 flex-wrap justify-end">
                <LinkButton
                  to={`/organization/posting/${posting.id}/attendance`}
                  color="info"
                  style="outline"
                  disabled={!canOpenAttendancePage}
                  Icon={ListChecks}
                  size="sm"
                >
                  Attendance
                </LinkButton>
                <Button
                  color="primary"
                  onClick={() => setIsEditMode(true)}
                  style="outline"
                  Icon={Edit3}
                  size="sm"
                >
                  Edit
                </Button>
                <Button
                  color={posting?.is_closed ? 'success' : 'warning'}
                  onClick={onToggleClosed}
                  disabled={!posting}
                  loading={togglingClosed}
                  Icon={posting?.is_closed ? LockOpen : Lock}
                  size="sm"
                >
                  {posting?.is_closed ? 'Reopen' : 'Close'}
                </Button>
                <Button
                  color="error"
                  onClick={onDelete}
                  loading={deleting}
                  Icon={Trash2}
                  size="sm"
                >
                  Delete
                </Button>
              </span>
            )
        )}
      />

      <ColumnLayout
        sidebar={(
          <>
            <Card>
              <div className="flex items-start gap-3 mb-4">
                {postingOrganization && (
                  <OrganizationProfilePicture
                    organizationName={postingOrganization.name}
                    organizationId={postingOrganization.id}
                    logoPath={postingOrganization.logoPath}
                    size={48}
                    linkToOrganizationPage
                    linkClassName="shrink-0"
                  />
                )}

                <div className="min-w-0">
                  <h4 className="text-xl font-bold truncate">{formValues.title}</h4>
                  {postingOrganization && (
                    <Link
                      to={`/organization/${postingOrganization.id}`}
                      className="text-primary text-xs hover:underline"
                    >
                      {postingOrganization.name}
                    </Link>
                  )}
                </div>
              </div>

              {isEditMode
                ? (
                    <div className="space-y-4">
                      <FormField
                        form={form}
                        label="Title"
                        name="title"
                        type="text"
                        placeholder="Enter posting title"
                        Icon={Edit3}
                      />
                      <FormField
                        form={form}
                        label="Description"
                        name="description"
                        type="textarea"
                        placeholder="Describe the opportunity"
                      />
                      <FormField
                        form={form}
                        label="Location Name"
                        name="location_name"
                        type="text"
                        placeholder="e.g. Downtown Community Center"
                        Icon={MapPin}
                      />
                      <FormField
                        form={form}
                        label="Max Volunteers"
                        name="max_volunteers"
                        type="number"
                        placeholder="Optional"
                        Icon={Users}
                      />
                      <FormField
                        form={form}
                        label="Min Age"
                        name="minimum_age"
                        type="number"
                        placeholder="Optional"
                        Icon={ShieldCheck}
                      />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                          <CalendarInfo
                            selectionMode="range"
                            rangeLabel="Date Range"
                            disablePastDates
                            rangeValue={{ from: startDate, to: endDate }}
                            onRangeChange={({ from, to }) => {
                              form.setValue('start_date', from, {
                                shouldDirty: true,
                                shouldTouch: true,
                                shouldValidate: true,
                              });
                              form.setValue('end_date', to, {
                                shouldDirty: true,
                                shouldTouch: true,
                                shouldValidate: true,
                              });
                            }}
                            className="w-full"
                          />
                          {form.formState.errors.start_date?.message && (
                            <p className="text-error text-sm mt-1">{form.formState.errors.start_date.message as string}</p>
                          )}
                          {form.formState.errors.end_date?.message && (
                            <p className="text-error text-sm mt-1">{form.formState.errors.end_date.message as string}</p>
                          )}
                        </div>

                        <fieldset className="fieldset w-full">
                          <label className="label">
                            <span className="label-text font-medium">Start Time</span>
                          </label>
                          <input
                            type="time"
                            className="input input-bordered w-full focus:input-primary"
                            value={startTime}
                            onChange={(event) => {
                              form.setValue('start_time', event.target.value, {
                                shouldDirty: true,
                                shouldTouch: true,
                                shouldValidate: true,
                              });
                            }}
                          />
                        </fieldset>

                        <fieldset className="fieldset w-full">
                          <label className="label">
                            <span className="label-text font-medium">End Time</span>
                          </label>
                          <input
                            type="time"
                            className="input input-bordered w-full focus:input-primary"
                            value={endTime}
                            onChange={(event) => {
                              form.setValue('end_time', event.target.value, {
                                shouldDirty: true,
                                shouldTouch: true,
                                shouldValidate: true,
                              });
                            }}
                          />
                        </fieldset>
                      </div>
                    </div>
                  )
                : (
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-semibold opacity-70 uppercase">Description</label>
                        <p className="text-sm opacity-80 whitespace-pre-wrap">{formValues.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin size={16} className="text-primary" />
                        <span className="text-sm">{formValues.location_name}</span>
                      </div>
                      <PostingDateTime
                        className="w-full"
                        startDate={formattedStartDate}
                        endDate={formValues.end_date ? formattedEndDate : undefined}
                        startTime={formattedStartTime}
                        endTime={formValues.end_time ? formattedEndTime : undefined}
                      />
                      <div className="space-y-2">
                        {formValues.minimum_age && (
                          <div className="flex items-center gap-2">
                            <Cake size={16} className="text-primary" />
                            <div>
                              <p className="text-xs opacity-70 font-semibold">MIN AGE</p>
                              <span className="text-sm">
                                {formValues.minimum_age}
                                +
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
            </Card>

            <Card
              title="Capacity"
              description={shouldShowVolunteerProgress
                ? 'Number of volunteers still needed'
                : 'Number of volunteers registered across all dates'}
              color="secondary"
              Icon={Users}
              right={shouldShowVolunteerProgress
                ? (
                    <span className={`text-sm font-semibold ${remainingSpots === 0 ? 'text-error' : 'text-success'}`}>
                      {(remainingSpots ?? 0) > 0
                        ? `${remainingSpots} spot${remainingSpots === 1 ? '' : 's'} remaining`
                        : 'No spots remaining'}
                    </span>
                  )
                : (
                    <span className="text-sm opacity-70">
                      {`${currentEnrollmentCount} volunteer${currentEnrollmentCount === 1 ? '' : 's'}`}
                    </span>
                  )}
            >
              <div className="space-y-2">
                {shouldShowVolunteerProgress && (
                  <>
                    <progress
                      className="progress progress-secondary w-full"
                      value={volunteerProgressPercent}
                      max={100}
                      aria-label="Volunteer capacity progress"
                    />
                    <p className="text-xs opacity-70">
                      {`${currentEnrollmentCount} / ${maxVolunteers} volunteers`}
                    </p>
                  </>
                )}
                {!shouldShowVolunteerProgress && maxVolunteers == null && (
                  <p className="text-xs opacity-70">No maximum number of volunteers set</p>
                )}
                {shouldShowVolunteerProgress && maxVolunteers != null && overMaxVolunteerCount > 0 && (
                  <p className="text-xs text-error font-semibold">
                    {`${overMaxVolunteerCount} volunteer${overMaxVolunteerCount === 1 ? '' : 's'} over max`}
                  </p>
                )}
              </div>
            </Card>

            {isEditMode
              ? (
                  <Card
                    title="Crisis Tag"
                    description="Add a crisis tag to this posting."
                    color="accent"
                    coloredText={true}
                    Icon={AlertTriangle}
                  >
                    <fieldset className="fieldset">
                      <label className="label">
                        <span className="label-text font-medium">Selected Crisis</span>
                      </label>
                      <select
                        className="select select-bordered w-full"
                        value={selectedCrisisId?.toString() ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedCrisisId(value ? Number(value) : undefined);
                        }}
                        disabled={saving || loadingCrises}
                      >
                        <option value="">No crisis tag</option>
                        {availableCrises.map(crisis => (
                          <option key={crisis.id} value={crisis.id.toString()}>
                            {crisis.name}
                            {!crisis.pinned ? ' (Unpinned)' : ''}
                          </option>
                        ))}
                      </select>
                      {loadingCrises && <span className="label-text-alt opacity-70">Loading crisis tags...</span>}
                      {crisesError && <span className="label-text-alt text-error">{crisesError.message}</span>}
                    </fieldset>
                  </Card>
                )
              : selectedCrisis
                ? (
                    <CrisisCard
                      crisis={selectedCrisis}
                      link={isVolunteerView ? `/volunteer/crises/${selectedCrisis.id}/postings` : `/organization/crises/${selectedCrisis.id}/postings`}
                    />
                  )
                : (
                    <Card
                      title={selectedCrisisName || 'No Crisis'}
                      color="accent"
                      coloredText={true}
                      Icon={AlertTriangle}
                    />
                  )}

            <Card
              title="Status"
              description="Posting visibility."
              color={isOpen ? 'primary' : 'secondary'}
              Icon={isOpen ? LockOpen : Lock}
            >
              {isEditMode
                ? (
                    <>
                      <ToggleButton
                        form={form}
                        name="automatic_acceptance"
                        label="Posting Type"
                        disabled={saving}
                        options={[
                          {
                            value: true,
                            label: 'Open Posting',
                            description: 'Volunteers are accepted automatically.',
                            Icon: LockOpen,
                            btnColor: 'btn-primary',
                          },
                          {
                            value: false,
                            label: 'Review-Based',
                            description: 'Volunteers must be approved by the organization.',
                            Icon: Lock,
                            btnColor: 'btn-secondary',
                          },
                        ]}
                      />

                    </>
                  )
                : (
                    <span className={`badge gap-2 ${hasEnded ? 'badge-neutral' : posting?.is_closed ? 'badge-error' : isOpen ? 'badge-primary' : 'badge-secondary'}`}>
                      {hasEnded ? <CalendarX2 size={12} /> : posting?.is_closed ? <Lock size={12} /> : isOpen ? <LockOpen size={12} /> : <Lock size={12} />}
                      {hasEnded ? 'Ended' : posting?.is_closed ? 'Closed' : isOpen ? 'Open' : 'Review Based'}
                    </span>
                  )}
              <p className="text-xs opacity-70 mt-2">
                {hasEnded
                  ? 'This posting has ended.'
                  : posting?.is_closed
                    ? 'This posting is closed and no longer accepting applications.'
                    : isOpen
                      ? 'Volunteers are accepted automatically.'
                      : 'Volunteers must be accepted by the organization.'}
              </p>
              {!isEditMode && canManagePosting && (
                null
              )}
            </Card>

            {canManagePosting && (
              <Card
                title="Location"
                description={isEditMode ? 'Pick the location on the map.' : 'Posting location on map.'}
                Icon={MapPin}
              >
                <LocationPicker
                  position={position}
                  setPosition={onMapPositionPick}
                  readOnly={!isEditMode}
                />
              </Card>
            )}

          </>
        )}
      >
        {shouldShowCommitmentCard && (
          <Card
            title={posting?.allows_partial_attendance ? 'Partial attendance' : 'Full commitment'}
            description={posting?.allows_partial_attendance
              ? 'Volunteers can choose specific days instead of committing to the full posting range.'
              : 'Volunteers must commit to the full posting date range when they apply.'}
            Icon={Calendar}
          />
        )}

        {isVolunteerView && (
          <Card
            title="Application Status"
            Icon={ShieldCheck}
          >

            <span className={`badge mt-1 w-fit ${applicationStatus.badgeClassName}`}>
              {applicationStatus.label}
            </span>
            <p className="text-sm opacity-70 mt-2">
              {applicationStatus.description}
            </p>
            {applicationDaysLabel && (
              <div className="mt-3">
                <p className="text-xs font-medium uppercase tracking-wide opacity-60">Applied Days</p>
                <p className="text-sm mt-1">{applicationDaysLabel}</p>
              </div>
            )}

            <div className="mt-3 flex justify-end">
              {isEnrolled
                ? (
                    <span
                      className={canWithdrawFromPosting ? 'inline-block' : 'tooltip tooltip-top inline-block'}
                      data-tip={canWithdrawFromPosting ? undefined : 'This posting has ended.'}
                    >
                      <Button
                        color="error"
                        style="outline"
                        onClick={withdrawApplication}
                        loading={withdrawing}
                        disabled={!canWithdrawFromPosting}
                        className={!canWithdrawFromPosting ? 'pointer-events-none' : undefined}
                        Icon={SquareArrowRight}
                      >
                        Leave Position
                      </Button>
                    </span>
                  )
                : hasPendingApplication
                  ? (
                      <span
                        className={canWithdrawFromPosting ? 'inline-block' : 'tooltip tooltip-top inline-block'}
                        data-tip={canWithdrawFromPosting ? undefined : 'This posting has ended.'}
                      >
                        <Button
                          color="error"
                          style="outline"
                          onClick={withdrawApplication}
                          loading={withdrawing}
                          disabled={!canWithdrawFromPosting}
                          className={!canWithdrawFromPosting ? 'pointer-events-none' : undefined}
                          Icon={SquareArrowRight}
                        >
                          Withdraw Application
                        </Button>
                      </span>
                    )
                  : hasEnded
                    ? (
                        <span className="text-sm text-error font-medium">This posting has ended</span>
                      )
                    : (
                        <Button
                          color="primary"
                          onClick={openApplyModal}
                          loading={applying}
                          Icon={Send}
                        >
                          Apply
                        </Button>
                      )}
            </div>
          </Card>
        )}

        <Card
          title="Required Skills"
          description="Skills needed for this opportunity."
          Icon={Tag}
        >
          {isEditMode
            ? (
                <SkillsInput skills={skills} setSkills={setSkills} />
              )
            : (
                <SkillsList skills={posting.skills} enableLimit={false} />
              )}
        </Card>

        {(isVolunteerView || !canManagePosting) && (
          <Card
            title="Location"
            description={isEditMode ? 'Pick the location on the map.' : 'Posting location on map.'}
            Icon={MapPin}
          >
            <LocationPicker
              position={position}
              setPosition={onMapPositionPick}
              readOnly={!isEditMode}
            />
          </Card>
        )}

        {canManagePosting && !isOpen && (
          <Card
            title="Enrollment Applications"
            right={
              <span className="badge badge-primary">{applications.length}</span>
            }
          >
            {applications.length === 0
              ? (
                  <EmptyState
                    title="No pending applications"
                    description="Wait for volunteers to apply to show here."
                    Icon={Users}
                  />
                )
              : (
                  <div className="space-y-2">
                    {applications.map(app => (
                      <VolunteerInfoCollapse
                        key={app.application_id}
                        volunteer={app}
                        profileLink={`/organization/volunteer/${app.volunteer_id}`}
                        actions={(
                          <span className="flex gap-2">
                            <Button
                              color="success"
                              style="soft"
                              onClick={() => acceptApplication(app.application_id)}
                              loading={processingApplicationId === app.application_id}
                              Icon={Check}
                            >
                              Accept
                            </Button>
                            <Button
                              color="error"
                              style="soft"
                              onClick={() => rejectApplication(app.application_id)}
                              loading={processingApplicationId === app.application_id}
                              Icon={X}
                            >
                              Reject
                            </Button>
                          </span>
                        )}
                      />
                    ))}
                  </div>
                )}
          </Card>
        )}

        {canManagePosting && (
          <Card
            title="Enrolled Volunteers"
            right={
              <span className="badge badge-primary">{enrollments.length}</span>
            }
          >

            {enrollments.length === 0
              ? (
                  <EmptyState
                    title="No volunteers have enrolled yet"
                    description="Wait for volunteers to enroll to show here."
                    Icon={Users}
                  />
                )
              : (
                  <div className="space-y-2">
                    {enrollments.map(volunteer => (
                      <VolunteerInfoCollapse
                        key={volunteer.enrollment_id}
                        volunteer={volunteer}
                        profileLink={`/organization/volunteer/${volunteer.volunteer_id}`}
                      />
                    ))}
                  </div>
                )}
          </Card>
        )}
      </ColumnLayout>
    </PageContainer>
  );
}

export default PostingPage;
