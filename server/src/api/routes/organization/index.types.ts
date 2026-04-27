import { type ResetPasswordResponse } from '../../../auth/resetPassword.ts';
import { type Crisis, type OrganizationAccountWithoutPassword, type OrganizationAccountWithoutPasswordAndVector, type PostingWithoutVectors, type PostingSkill } from '../../../db/tables/index.ts';
import { type SuccessResponse } from '../../../types.ts';

import type { VolunteerProfileData } from '../../../services/volunteer/index.ts';

export type OrganizationRequestResponse = SuccessResponse;

export type OrganizationGetLogoFileResponse = never;
export type OrganizationGetSignatureFileResponse = never;
export type OrganizationVolunteerCvDownloadResponse = never;

export type OrganizationProfileResponse = {
  organization: OrganizationAccountWithoutPasswordAndVector;
  postings: (PostingWithoutVectors & { skills: PostingSkill[]; enrollment_count: number })[];
};

export type OrganizationGetMeResponse = {
  organization: OrganizationAccountWithoutPassword;
};

export type OrganizationUpdateProfileResponse = {
  organization: OrganizationAccountWithoutPassword;
};

export type OrganizationUploadLogoResponse = {
  organization: OrganizationAccountWithoutPassword;
};

export type OrganizationDeleteLogoResponse = {
  organization: OrganizationAccountWithoutPassword;
};

export type OrganizationPinnedCrisesResponse = {
  crises: Crisis[];
};

export type OrganizationCrisesResponse = {
  crises: Crisis[];
};

export type OrganizationCrisisResponse = {
  crisis: Crisis;
};

export type OrganizationVolunteerProfileResponse = {
  profile: VolunteerProfileData;
};

export type OrganizationReportVolunteerResponse = SuccessResponse;

export type OrganizationResetPasswordResponse = ResetPasswordResponse;

export type OrganizationSearchResult = {
  id: number;
  name: string;
  description: string | null;
  location_name: string | null;
  logo_path: string | null;
  posting_count: number;
};

export type OrganizationOrganizationSearchResponse = {
  organizations: OrganizationSearchResult[];
};
