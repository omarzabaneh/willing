import {
  AlertCircle,
  Award,
  Building,
  Download,
  FileText,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useVolunteer } from '../../auth/useUsers';
import Button from '../../components/Button';
import Card from '../../components/Card';
import CertificatePreview from '../../components/certificates/CertificatePreview';
import {
  CERTIFICATE_PREVIEW_HEIGHT,
  CERTIFICATE_PREVIEW_WIDTH,
  MAX_CERTIFICATE_ORGANIZATIONS,
  getCertificatePreviewStyles,
} from '../../components/certificates/certificatePreview.constants';
import PageContainer from '../../components/layout/PageContainer';
import PageHeader from '../../components/layout/PageHeader';
import Loading from '../../components/Loading';
import requestServer from '../../utils/requestServer';
import useAsync from '../../utils/useAsync';

import type { VolunteerCertificateIssueResponse, VolunteerCertificateResponse } from '../../../../server/src/api/types';

const CERTIFICATE_PREVIEW_ID = 'certificate-preview';
const formatHours = (value: number) => Math.floor(value);

const getOrganizationEligibilityStatus = (organization: VolunteerCertificateResponse['organizations'][number]) => {
  if (organization.is_deleted) {
    return {
      label: 'Organization deleted',
      className: 'badge badge-error',
    };
  }

  if (organization.is_disabled) {
    return {
      label: 'Organization disabled',
      className: 'badge badge-error',
    };
  }

  if (organization.eligible) {
    return {
      label: 'Eligible',
      className: 'badge badge-success',
    };
  }

  if (!organization.certificate_feature_enabled) {
    return {
      label: 'Certificates not enabled',
      className: 'badge badge-warning',
    };
  }

  if (
    organization.hours_threshold !== null
    && organization.hours < organization.hours_threshold
  ) {
    return {
      label: 'Threshold not reached',
      className: 'badge badge-info',
    };
  }

  return {
    label: 'Setup incomplete',
    className: 'badge badge-ghost',
  };
};

function VolunteerCertificateRequest() {
  const volunteer = useVolunteer();
  const [selectedOrganizationIds, setSelectedOrganizationIds] = useState<number[]>([]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [certificateGeneratedAt, setCertificateGeneratedAt] = useState<Date | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const [certificateScale, setCertificateScale] = useState(1);

  const loadCertificateData = useCallback(async () => {
    return requestServer<VolunteerCertificateResponse>('/volunteer/certificate', { includeJwt: true });
  }, []);

  const { data, loading, error, trigger } = useAsync<VolunteerCertificateResponse, []>(loadCertificateData, {
    immediate: true,
  });
  const {
    loading: issuingCertificate,
    trigger: issueCertificate,
  } = useAsync<VolunteerCertificateIssueResponse, [number[]]>(
    async orgIds => requestServer<VolunteerCertificateIssueResponse>(
      '/volunteer/certificate/issue',
      {
        method: 'POST',
        body: { org_ids: orgIds },
        includeJwt: true,
      },
    ),
    { notifyOnError: true },
  );

  const organizationsWithEligibility = useMemo(
    () => data?.organizations ?? [],
    [data?.organizations],
  );

  const eligibleOrganizations = useMemo(
    () => organizationsWithEligibility.filter(org => org.eligible),
    [organizationsWithEligibility],
  );

  const totalHours = useMemo(
    () => Number(data?.total_hours ?? 0),
    [data?.total_hours],
  );
  const hasNoCompletedHours = totalHours <= 0;

  const selectedOrganizations = useMemo(
    () => organizationsWithEligibility
      .filter(org => selectedOrganizationIds.includes(org.id)),
    [organizationsWithEligibility, selectedOrganizationIds],
  );

  const volunteerName = useMemo(() => {
    const firstName = data?.volunteer.first_name ?? volunteer?.first_name ?? '';
    const lastName = data?.volunteer.last_name ?? volunteer?.last_name ?? '';
    return `${firstName} ${lastName}`.trim() || 'Volunteer';
  }, [data?.volunteer.first_name, data?.volunteer.last_name, volunteer?.first_name, volunteer?.last_name]);

  useEffect(() => {
    const viewportElement = previewViewportRef.current;
    if (!viewportElement) return undefined;

    const updateScale = () => {
      const availableWidth = viewportElement.clientWidth;
      if (!availableWidth) return;
      const nextScale = Math.min(1, availableWidth / CERTIFICATE_PREVIEW_WIDTH);
      setCertificateScale(currentScale => (Math.abs(currentScale - nextScale) < 0.001 ? currentScale : nextScale));
    };

    updateScale();

    const observer = new ResizeObserver(() => {
      updateScale();
    });
    observer.observe(viewportElement);

    return () => {
      observer.disconnect();
    };
  }, [certificateGeneratedAt]);

  const toggleOrganization = (organizationId: number, eligible: boolean) => {
    if (!eligible) return;

    setSelectionError(null);
    setCertificateGeneratedAt(null);
    setVerificationToken(null);
    setIssueError(null);

    setSelectedOrganizationIds((current) => {
      if (current.includes(organizationId)) {
        return current.filter(id => id !== organizationId);
      }

      if (current.length >= MAX_CERTIFICATE_ORGANIZATIONS) {
        setSelectionError(`You can select up to ${MAX_CERTIFICATE_ORGANIZATIONS} organizations.`);
        return current;
      }

      return [...current, organizationId];
    });
  };

  const createCertificate = async () => {
    setSelectionError(null);
    setIssueError(null);

    try {
      const response = await issueCertificate(selectedOrganizationIds);
      setCertificateGeneratedAt(new Date(response.issued_at));
      setVerificationToken(response.verification_token);
    } catch (err) {
      setVerificationToken(null);
      setCertificateGeneratedAt(null);
      setIssueError(err instanceof Error ? err.message : 'Failed to generate certificate token.');
    }
  };

  const downloadCertificateAsPdf = () => {
    if (!certificateGeneratedAt) return;
    window.print();
  };

  return (
    <PageContainer>
      <style>
        {getCertificatePreviewStyles(CERTIFICATE_PREVIEW_ID, true)}
      </style>

      <PageHeader
        title="Generate Certificate"
        subtitle="Review your volunteering stats, then generate your certificate."
        showBack
        defaultBackTo="/volunteer/profile"
        icon={Award}
      />

      {loading && (
        <div className="flex justify-center mt-8">
          <Loading size="xl" />
        </div>
      )}

      {error && (
        <div className="mt-4 no-print">
          <div className="alert alert-error">
            <span>{error.message || 'Failed to load certificate data.'}</span>
          </div>
          <button className="btn btn-outline mt-3" onClick={() => { void trigger(); }}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="grid gap-6 md:grid-cols-3 no-print">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm opacity-70">Total Volunteering Hours</p>
                  <p className="text-3xl font-bold mt-1">{formatHours(totalHours)}</p>
                </div>
                <div className="rounded-full bg-primary/10 p-2 text-primary">
                  <Award size={18} />
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm opacity-70">Organizations Involved</p>
                  <p className="text-3xl font-bold mt-1">{organizationsWithEligibility.length}</p>
                </div>
                <div className="rounded-full bg-secondary/10 p-2 text-secondary">
                  <Building size={18} />
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm opacity-70">Eligible Organizations</p>
                  <p className="text-3xl font-bold mt-1">{eligibleOrganizations.length}</p>
                </div>
                <div className="rounded-full bg-success/10 p-2 text-success">
                  <Users size={18} />
                </div>
              </div>
            </Card>
          </div>

          <Card
            title={`Select Organizations (Max ${MAX_CERTIFICATE_ORGANIZATIONS})`}
            description="Ranked by your attended hours. Only organizations meeting threshold and certificate settings are selectable."
          >
            {selectionError && (
              <div className="alert alert-error mt-3">
                <AlertCircle size={16} />
                <span>{selectionError}</span>
              </div>
            )}
            {issueError && (
              <div className="alert alert-error mt-3">
                <AlertCircle size={16} />
                <span>{issueError}</span>
              </div>
            )}

            <div className="space-y-2 mt-3">
              {organizationsWithEligibility.map((organization, index) => {
                const selected = selectedOrganizationIds.includes(organization.id);
                const eligibilityStatus = getOrganizationEligibilityStatus(organization);
                const certificatesNotEnabled = !organization.certificate_feature_enabled;
                const organizationDeleted = organization.is_deleted;
                const organizationDisabled = organization.is_disabled;

                return (
                  <label
                    key={organization.id}
                    className={`flex items-start justify-between gap-3 rounded-box border p-3 ${
                      organization.eligible ? 'cursor-pointer border-base-300' : 'opacity-60 border-base-300'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="badge badge-ghost shrink-0">{`#${index + 1}`}</span>
                      <div className="min-w-0">
                        <p className="font-semibold">{organization.name}</p>
                        {organizationDeleted && (
                          <p className="text-sm opacity-70">Organization account was deleted</p>
                        )}
                        {organizationDisabled && (
                          <p className="text-sm opacity-70">Organization account is disabled</p>
                        )}
                        {!organizationDeleted && !organizationDisabled && certificatesNotEnabled && (
                          <p className="text-sm opacity-70">Certificates not enabled</p>
                        )}
                        {!organizationDeleted && !organizationDisabled && !certificatesNotEnabled && (
                          <p className="text-sm opacity-70">
                            Hours:
                            {' '}
                            {formatHours(organization.hours)}
                            {' '}
                            |
                            {' '}
                            Threshold:
                            {' '}
                            {organization.hours_threshold ?? '-'}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {(organizationDeleted || organizationDisabled || !certificatesNotEnabled) && (
                        <span className={`${eligibilityStatus.className} text-center`}>{eligibilityStatus.label}</span>
                      )}
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary"
                        checked={selected}
                        disabled={!organization.eligible}
                        onChange={() => toggleOrganization(organization.id, organization.eligible)}
                      />
                    </div>
                  </label>
                );
              })}
            </div>

            {hasNoCompletedHours && (
              <div className="alert alert-warning -mt-5">
                <AlertCircle size={16} />
                <span>You need to complete an opportunity before generating a certificate.</span>
              </div>
            )}

            <div className="mt-4">
              <Button
                className="btn btn-primary"
                onClick={() => { void createCertificate(); }}
                Icon={FileText}
                loading={issuingCertificate}
                disabled={hasNoCompletedHours}
              >
                Create Certificate
              </Button>
            </div>
          </Card>

          {certificateGeneratedAt && (
            <Card
              title="Certificate Preview"
              right={(
                <Button
                  style="outline"
                  onClick={downloadCertificateAsPdf}
                  Icon={Download}
                >
                  Download as PDF
                </Button>
              )}
            >
            </Card>
          )}

          {certificateGeneratedAt && (
            <div className="mt-4">
              <div ref={previewViewportRef} className="w-full certificate-preview-viewport">
                <div
                  className="mx-auto certificate-preview-stage"
                  style={{
                    width: `${CERTIFICATE_PREVIEW_WIDTH * certificateScale}px`,
                    height: `${CERTIFICATE_PREVIEW_HEIGHT * certificateScale}px`,
                  }}
                >
                  <div
                    className="certificate-preview-scaler"
                    style={{
                      width: `${CERTIFICATE_PREVIEW_WIDTH}px`,
                      height: `${CERTIFICATE_PREVIEW_HEIGHT}px`,
                      transform: `scale(${certificateScale})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    <CertificatePreview
                      previewId={CERTIFICATE_PREVIEW_ID}
                      volunteerName={volunteerName}
                      totalHours={totalHours}
                      organizations={selectedOrganizations}
                      platformCertificate={data?.platform_certificate ?? null}
                      generatedAtLabel={certificateGeneratedAt.toLocaleDateString()}
                      verificationToken={verificationToken ?? 'Pending'}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

export default VolunteerCertificateRequest;
