# AGENTS.md

This file gives coding agents project-specific instructions for working in this repository.

## Project Overview

Willing is a full-stack TypeScript app:

- `client/`: React + Vite + React Router + Tailwind + DaisyUI
- `server/`: Express + Kysely + PostgreSQL + Zod

The server runs DB migrations automatically on startup in development mode.

## Current Sprint

- Active sprint: Sprint 5. See `docs/sprints/sprint-5.md` for planned features and schema changes.

## Product Purpose and Flow

Willing connects volunteers with organizations that publish real-world help opportunities.

### Core Domain Concepts

- **Volunteer**: End-user who creates a profile, adds skills, discovers postings, applies, enrolls, may later be marked as attended by organizations, and can generate certificates.
- **Organization**: Account type that gets approved by an admin. Can create postings, accept volunteers, edit profile, and allow certificate generation.
- **Admin**: Platform moderator who reviews organization onboarding requests and manages crisis definitionsand pinning.
- **Posting**: A volunteer opportunity created by an organization (title, description, time window, location, skills, optional maximum number of volunteers, optional minimum age, optional linked crisis event, either open (anyone that applies is accepted) or review-based (requires acceptance from the organization), and can also be closed (closed manually by an organization to disallow volunteers from signing up anymore)).
- **Enrollment application**: A volunteer's application to a posting (optional message included).
- **Enrollment**: Accepted application record; later can be marked attended.
- **Partial enrollment**: A posting-level behavior controlled by `allows_partial_attendance` that lets volunteers apply to selected posting dates instead of the full posting range.
- **Crisis**: A specific real-world event bounded in time (for example, Beirut Port Explosion 2020, Lebanon War 2026), not a generic type or tag. Crises can be pinned to highlight priority events and surface urgent opportunities.

### High-Level User Journey

1. Users land on the public home page and choose a role path.
2. Volunteers sign up/login, complete profile data and skills, then browse/search postings.
3. Organizations submit an onboarding request with location and contact details.
4. Admin reviews each organization request and approves or rejects.
5. Approved organizations log in, create/edit/open/close postings, and review applications.
6. Volunteers apply to postings; organizations accept/reject applications.
7. Accepted volunteers become enrollments and can be marked attended after participation.
8. Organizations add profile pictures, a minimum threshold of hours (to be added to a volunteer's certificate), a signatory name and position, and a signature.
9. The admin adds a signature, name, and position.
10. Volunteers generate certificates with total number of hours, admin signature, and eligible organizations.
11. Users check if certificates are valid through the website.

### Partial Enrollment Flow

1. Organizations choose `allows_partial_attendance` during posting creation.
2. If partial attendance is disabled, volunteers apply for the full posting range and should not select dates.
3. If partial attendance is enabled, volunteers select one or more posting dates, but not all posting dates.
4. Pending requested dates are stored in `enrollment_application_date`.
5. Accepted/enrolled dates are stored in `enrollment_date`.
6. Review-based acceptance must copy requested dates from `enrollment_application_date` into `enrollment_date`.
7. Withdrawal is currently full-withdraw only. Do not reintroduce per-day withdrawal UI or API behavior unless explicitly requested.
8. Organization attendance is per day. Organizations can navigate any posting day, but volunteers should only appear on days they actually signed up for.

### Crisis Flow

1. Admin creates crisis entries and may pin active/important crises.
2. Organizations can link postings to a specific crisis event where relevant.
3. Volunteer-facing discovery can prioritize/filter opportunities related to current crises.
4. Pinned crises communicate urgency across the platform and guide organization posting context.

### Certificate Verification Flow

- Public certificate verification is available at `/certificate/verify` (client) and `/public/certificate/verify` (server), with no login required.
- Certificate authenticity is based on a signed payload token (HMAC), not stored/generated PDF files.
- A certificate is valid only when both checks pass:
  1. token signature + payload validation
  2. DB consistency checks against volunteer/org attendance-hour facts
- Verification route must keep abuse protection (rate limiting/throttling) in place.
- `CERTIFICATE_VERIFICATION_SECRET` is server-only and must never be exposed to client code.

### Access and Ownership Model

- Volunteers only manage their own profile, applications, and enrollments.
- Organizations only manage their own postings and related applicant/enrollment decisions.
- Admin does not run postings; admin governs organization access and the crisis event catalog.

### Reporting & Moderation Flow

- **Volunteer → Organization reports** are submitted from the organization profile page via `client/src/pages/OrganizationProfile.tsx`.
- **Organization → Volunteer reports** are submitted from the organization volunteer profile page via `client/src/pages/organization/OrganizationVolunteerProfile.tsx`.
- Both report forms reuse `client/src/components/reporting/ReportForm.tsx` and the shared report type constants in `client/src/components/reporting/reportType.constants.ts`.
- Admin report review lives in `client/src/pages/admin/AdminReports.tsx` and report detail view in `client/src/pages/admin/AdminReportDetail.tsx`.
- Backend report creation is handled in `server/src/api/routes/volunteer/index.ts` and `server/src/api/routes/organization/index.ts`.
- Admin moderation and disable actions are handled in `server/src/api/routes/admin/index.ts`.
- Disabling an account marks `is_disabled = true`, increments token version, removes related report rows, and prevents login in `server/src/api/routes/user.ts`.

## Repository Map

- `client/src/main.tsx`: route tree and page wiring
- `client/src/auth/*`: auth context, guards, user hooks
- `client/src/utils/requestServer.ts`: shared HTTP helper (includes JWT support)
- `client/src/utils/formUtils.tsx`: reusable form components (`FormField`, `FormRootError`, helpers)
- `client/src/schemas/auth.ts`: client-side form schemas

- `server/src/api/index.ts`: API router mounting (`/user`, `/admin`, `/organization`, `/volunteer`)
- `server/src/api/authorization.ts`: JWT parsing + role guard middleware
- `server/src/api/routes/**`: domain route handlers
- `server/src/db/tables.ts`: canonical Zod schemas + TS types for DB entities
- `server/src/db/migrations/*`: ordered SQL schema evolution
- `server/src/scripts/seed.ts`: dev seed data

## Setup and Run Commands

Run from repository root unless noted.

### Database

```bash
cd server
docker compose up -d
```

If `npm start` fails with migration `AggregateError`, check Postgres is listening on `5432`.

### Server

```bash
cd server
npm install
npm start
```

Useful server scripts:

- `npm run dev` (nodemon)
- `npm run migrate`
- `npm run seed`
- `npm run create-admin`
- `npm run lint`

### Client

```bash
cd client
npm install
npm start
```

Useful client scripts:

- `npm run build`
- `npm run lint`

## Backend Testing Conventions

1. Server tests are colocated with the modules they cover (e.g., `server/src/api/routes/posting.test.ts`). Use matching filenames to keep discovery simple.
2. Shared infrastructure lives under `server/src/tests/`. Vitest is configured with `globalSetup: server/src/tests/globalSetup.ts` and `setupFiles: [server/src/tests/setup.ts]`.
3. `server/src/tests/setup.ts` runs before test files and handles DB test initialization (`beforeAll`) plus per-test isolation (`beforeEach`) via `truncateAllTables()`. Do not duplicate table-truncation hooks in individual tests unless a test has a special isolation need.
4. `server/src/tests/globalSetup.ts` handles suite lifecycle (`setup`/`teardown`): it ensures cleanup (DB connection destroy + upload dir cleanup) after the run.
5. Reuse `server/src/tests/helpers/database.ts` for schema resets or truncation logic instead of repeating raw SQL. Add any reusable seed/fixture helpers under `server/src/tests/fixtures/`.
6. Keep each test focused on one targeted behavior (one success path or one failure path). Do not bundle multiple role checks or unrelated assertions in a single test.
7. For auth-protected endpoints, split access-control tests by actor (unauthenticated, wrong role(s), correct role) into separate tests.
8. Add explicit edge-case coverage for each endpoint you touch (validation boundaries, missing data, invalid identifiers, empty-state responses, and provider/dependency failures where applicable).
9. Prefer descriptive test names that state both condition and expected outcome (e.g., "returns 400 when query is not a string").

### New Route Testing Checklist

Every new route must have comprehensive tests covering **all behavioral paths and edge cases**:

- **Authorization & Access Control**: Test unauthenticated, wrong role, and correct role access
- **Input Validation**: Test valid payload, missing required fields, wrong data types, boundary values, invalid enums
- **Business Logic & State**: Test success path, resource not found, invalid state transitions, missing dependencies
- **Response Shape**: Verify correct HTTP status, response matches `*Response` type, no sensitive data leaks
- **Edge Cases**: Empty results, concurrent writes, boundary conditions, dependency failures
- **Test Names**: Use descriptive names stating condition and expected outcome (e.g., "returns 400 when email is already registered")

Create tests as `<name>.test.ts` alongside your route file.

### Partial Enrollment Test Expectations

- Cover both open and review-based posting behavior when partial attendance logic changes.
- Test `GET` response shapes that expose `requested_dates`, `selected_dates`, or `posting_dates`.
- Test date-range edge cases carefully; end dates must be included.
- Avoid `toISOString().split('T')[0]` assertions for date-only DB values in tests. Prefer local calendar-date formatting helpers or SQL-side `YYYY-MM-DD` strings.
- When using fixture helpers from `server/src/tests/fixtures/`, pass the active test transaction as the first argument.

## Frontend Testing Conventions

Frontend tests use a single jsdom-based Vitest setup. We split them by **location and purpose**:

- **Unit tests** live next to the component, hook, schema, or utility they cover.
- **Integration tests** live under `client/src/tests/`, and may use subfolders there when grouping by feature or page improves organization.

Frontend integration tests render components with mocked dependencies and verify UI behavior — they do **not** test the full client-to-DB flow, and that is intentional. This keeps tests simple to set up and fast to run.

### Core Rules

1. **Always mock `requestServer`** — never let frontend tests hit a real server or network. Every test file that involves a component which calls `requestServer` must mock it at the top of the file

   Set the mock's resolved value in `beforeEach` and reset it in `afterEach`

2. **Only test things that can break due to logic** — do not write tests that assert static JSX renders. 

3. **Always wrap renders in `MemoryRouter` and `AuthContext.Provider`** — use a shared `renderPage(role?)` helper per test file to avoid repetition. Build auth context with a `buildAuthContext(role?)` factory that accepts an optional role.

4. **Split role checks across focused tests** — do not bundle multiple role assertions in a single test. Each test should cover one condition and one expected outcome.

5. **Use `data-testid` sparingly** — only add `data-testid` attributes to elements that cannot be reliably selected by role, label, or text, and where the test would otherwise be brittle. Document why the testid was needed.

### What to Test on a Given Page

Ask: *"Could this break silently if a developer changes the conditional logic?"* If yes, test it. If the element is always rendered regardless of any condition, skip it.

### File Conventions

- Use `@testing-library/react`, `@testing-library/jest-dom/vitest`, and `vitest`.
- Use `screen` for queries after render; use destructured helpers (`getByText`, `queryByText`, etc.) only when it keeps the test more readable.
- Unit test filenames should be `*.test.tsx` colocated with the file they cover.
- Integration test filenames should be `*.test.tsx`, stored under `client/src/tests/`.
- When integration coverage grows, create subfolders under `client/src/tests/` by feature, page, or domain instead of flattening everything into one directory.

### Test Mode

The current client test setup uses a single jsdom-based Vitest config:

- Config: `vitest.config.ts`
- Environment: `jsdom`
- Use for rendered component tests, hooks, schema validation, DOM assertions, and pure logic tests
- Discovery rules:
  - `src/**/*.unit.test.{ts,tsx}` for colocated unit tests
  - `src/tests/**/*.test.{ts,tsx}` for integration tests
- Run with: `npm run test` or `npm run test:unit`

### Mocking `requestServer`

Every test file that renders a component calling `requestServer` must mock it:

```typescript
vi.mock('../utils/requestServer', () => ({
  __esModule: true,
  default: vi.fn(),
}));
```

Set the mock's resolved value in `beforeEach`, reset in `afterEach`.

## Core Engineering Rules

1. Reuse canonical schemas and types from `server/src/db/tables.ts`.
2. Do not recreate table schemas manually in route files or forms if reusable schema composition works.
3. Prefer schema composition (`omit`, `pick`, `extend`, `partial`) over duplicating validation logic.
4. For protected client API calls, use `requestServer(path, options)`.
5. Do not hardcode user IDs. Use auth context on client and `req.userJWT!.id` on server.
6. Keep response and payload shapes consistent across client and server.
7. Keep changes minimal and targeted; avoid unrelated refactors.
8. For transactional DB logic, prefer `executeTransaction` from `server/src/db/executeTransaction.ts` instead of raw `db.transaction().execute(...)`, especially because tests often pass controlled transactions.

## Type Safety Requirements

**This project is VERY STRICT with types.** All API responses must be properly typed.

## Implementation Reality

- All routes have `*Response` types under `server/src/api/routes/**/`.ts and are re-exported from `server/src/api/types.ts`.
- Frontend calls use `requestServer<...>` with typed response interfaces from `server/src/api/types`.
- `server` source uses `.ts` imports during development/build, while runtime ESM docs mention `.js` for distribution output path compatibility.
- `useAsync` is used throughout client pages for async action handling, matching the conventions.

### Backend Type Rules

1. **Every route module must have a corresponding `.types.ts` file** in the same directory.
2. Each `.types.ts` file must export TypeScript types for **all JSON responses** returned by routes in that module.
3. Response types should be named with a `*Response` suffix (e.g., `GetUserResponse`, `CreatePostingResponse`).
4. **All `.types.ts` files must be imported and re-exported** in `server/src/api/types.ts` for centralized access.

### Frontend Type Rules

1. **IN ALL CASES**, when calling `requestServer()`, the frontend must pass the appropriate `*Response` type from `server/src/api/types.ts`.
2. Never use `any` or untyped responses for API calls. Never create separate client-side types that mirror server responses; always reuse the server-defined types for consistency.
3. Import response types from `server/src/api/types` using relative paths (e.g., `../../../server/src/api/types` from `client/src/auth/` or `../../../../server/src/api/types` from `client/src/pages/*/`).

## Client Form Conventions

1. **Always** use `react-hook-form` with `zodResolver(schema)` for form validation.
2. Wrap form submissions in `executeAndShowError(form, async () => {...})` from `formUtils.tsx` for consistent error handling.
3. Reuse and compose server schemas from `server/src/db/tables.ts` for client-side validation.
4. Use reusable form primitives from `client/src/utils/formUtils.tsx` (`FormField`, `FormRootError`).
5. `FormField` supports `registerOptions` for custom react-hook-form registration behavior and `inputProps` for native input attributes when needed.
6. Import response types from server using relative paths (e.g., `../../../../server/src/api/types`).
7. Keep existing DaisyUI/Tailwind visual language unless explicitly asked to redesign.
8. Handle loading, error, and success states explicitly.

## Async Hook Conventions

1. Prefer `useAsync` with an **inline async function** when the request logic is local to one component.
2. Prefer the `trigger` returned by `useAsync` for manual refresh/retry flows instead of separate duplicate loader functions.
3. Keep a request function outside `useAsync` only when that same function must be reused across multiple hooks or call sites.
4. For request failures, prefer `useAsync` notification handling via `notifyOnError` instead of catching inside the function passed to `useAsync` only to push error notifications.

## Reusable Components

All components are in `client/src/components/`. **Use these instead of recreating similar logic.**

### Component Selection Rules (Strict)

1. For pages that use `PageHeader`, wrapping page content with `PageContainer` is required. Skip it only for intentionally full-bleed layouts (for example map/canvas-first views) and document the reason in the PR/task notes.
2. Use `Hero` when you want centered title/description copy and, optionally, a card panel next to it; do not build custom split-hero wrappers for this pattern.
3. For card-like content containers with title/description/actions, use `Card` instead of hand-written bordered/shadowed wrappers. This component supports being given children without any props, which allows to customize fully how it looks like. This component has a `padding` boolean prop that specifically allows to disable inner padding when the default padding is not desired for a specific use case. This is useful for example when you want to use the card component just for its border and shadow but want to handle spacing with other utilities or custom styles.
4. For no-data/no-results states inside pages, use `EmptyState` instead of ad-hoc icon+text blocks.
5. For navigational actions that route to another page, use `LinkButton`; do not use `Button` with imperative `navigate(...)` unless navigation is conditional after async logic.
6. For icon-only secondary actions, use `IconButton`; do not style bare `<button>` elements for these actions.
7. Use raw HTML primitives (`<button>`, `<section>`, custom wrappers) only when a reusable component cannot satisfy requirements without hacks. If so, keep the implementation minimal and aligned with existing DaisyUI classes.
8. Do not duplicate reusable components in page/component files. Extend existing components with optional props when reuse is clearly needed across multiple screens.

### Layout Components (`client/src/components/layout/`)

- **`ColumnLayout`**: Responsive column layout with a sidebar and main content. Required props: `sidebar`, `children`. Optional prop: `stickySidebar` (default `true`).
- **`PageContainer`**: Standard authenticated page shell with `bg-base-200`, responsive centered content, and vertical spacing. Required prop: `children`.
- **`PageHeader`**: Reusable page header for page-level titles and actions. Required prop: `title`. Optional props: `subtitle`, `showBack`, `defaultBackTo`, `actions`, `icon`, `badge`, `variant`.
- **`Hero`**: Use for centered title/description callouts with an optional adjacent card-like content area. Required prop: `children`. Optional props: `title`, `description`, `Icon`.
- **`Footer`**: Standard footer with company/contact/GitHub info.

### Navbar Components (`client/src/components/layout/navbars/`)

- **`Navbar`**: Base shared navbar primitive with left logo. Optional props: `center`, `right`.
- **`LoggedOutNavbar`**: Navbar variant for unauthenticated/public pages.
- **`UserNavbar`**: Navbar variant for shared authenticated user pages.
- **`VolunteerNavbar`**: Navbar variant for volunteer dashboard pages.
- **`OrganizationNavbar`**: Navbar variant for organization dashboard pages.
- **`AdminNavbar`**: Navbar variant for admin dashboard pages.

### Button Components (`client/src/components/`)

- **`Button`**: Default action control for form submits and in-page actions. Supports optional `Icon`, `loading`, `size`, `color`, `style`, and `layout` (`wide`/`block`).
- **`IconButton`**: Compact square icon-only action. Requires `Icon`; use for secondary utility actions (for example edit/delete/open details), not primary page CTAs.
- **`LinkButton`**: Navigation action that routes with React Router (`to`, optional `state`) while keeping button styling. Use this for navigation, not imperative `navigate` calls on click where a link is sufficient.
- **`Card`**: Reusable content container with optional heading metadata and actions. Optional props: `title`, `description`, `Icon`, `left`, `right`, `link`, `color`, `coloredText`, `padding` (default `true`), `children`.
- Prefer these reusable components over raw `<button>`/`<Link>` when DaisyUI button styling is desired.
- Use `loading` for async actions and keep controls disabled during submission (`Button`/`IconButton` already disable while loading).
- Keep variants semantically consistent: use `color="primary"` for main actions, `ghost`/`outline` for secondary actions, and `error` only for destructive actions.
- Keep button text action-oriented and short (e.g., "Apply", "Save", "Approve"), and use an icon only when it improves recognition.
- For action-icon consistency, prefer these mappings when available:
   - Save/update actions → `Save`
   - Cancel/close actions → `X`
   - Apply/submit/send actions → `Send`
   - Create/add actions → `Plus`
   - Edit actions → `Edit3` or `Pencil`
   - Delete/remove actions → `Trash2`
   - Retry/refresh/reset actions → `RotateCcw` or `RefreshCcw`
   - Approve/accept actions → `Check` or `CheckCircle`
   - Reject/decline actions → `X` or `XCircle`

### Skill Components (`client/src/components/skills/`)

- **`SkillsList`**: Skill badge list. Required prop: `skills`. Optional props: `action`, `enableLimit` (default `true`), `limit` (default `5`).
- **`SkillsInput`**: Controlled skill-entry input with add/remove behavior. Required props: `skills`, `setSkills`.

### Home Components (`client/src/components/home/`)

- **`StatsCarousel`**: In `client/src/components/home/StatsCarousel.tsx`; used in `HomePage` for the active stats carousel with navigation and keyboard controls.

### Certificate Components (`client/src/components/certificates/`)

- **`CertificatePreview`**: Shared certificate renderer used by both generation and verification screens so they stay visually and structurally identical. Use `certificatePreview.constants.ts` for shared sizing (`CERTIFICATE_PREVIEW_WIDTH`, `CERTIFICATE_PREVIEW_HEIGHT`, `MAX_CERTIFICATE_ORGANIZATIONS`) and `getCertificatePreviewStyles(...)` for typography/print style injection.

### Posting Components (`client/src/components/postings/` + shared posting cards)

- **`PostingCard`**: Standard volunteer opportunity card (title, description, location, dates, constraints, skills). Required prop: `posting`. Optional prop: `organization`.
- **`PostingSearchView`**: Reusable posting discovery shell with page header, search, date filters, and result states. Required props: `title`, `subtitle`. Optional props: `icon`, `badge`, `showBack`, `defaultBackTo`, `initialFilters`, `emptyMessage`, `filterPostings`, `fetchUrl`, `crisisBasePath`, `crisesFetchBasePath`, `enableCrisisFilter`, `crisisOptions`, `enableOrganizationSearch`, `showEntityTabs`. Keep entity-specific top-row filters wired through `extraFields` so postings, organizations, and crises all use the same `search + extra field + sort` layout path.
- **`PostingFiltersCard`**: Shared search/filter card used by posting discovery pages. Required props: `defaultValues`, `onApply`, `getHasAdvancedFiltersApplied`, `renderAdvancedFields`, `searchFieldName`, `searchPlaceholder`, `sortFieldName`, `sortOptions`. Optional props: `organizationSortOptions`, `showAdvanced`, `title`, `submitLabel`, `submitIcon`, `topContent`, `extraFields`. Prefer adding entity-specific selectors through `extraFields` rather than creating a custom top-row layout in the parent page.
- **`HorizontalScrollSection`**: Horizontal carousel-style section with scroll controls, edge fades, and empty state. Required props: `title`, `hasItems`. Optional props: `subtitle`, `action`, `emptyState`, `children`.
- **`PostingCollection`**: Shared renderer that switches between `PostingCard` and `PostingList` using global posting view mode context. Required prop: `postings`. Optional props: `showCrisis`, `crisisTagClickable` (default `true`), `crisisBasePath` (default `/volunteer/crises`), `variant`, `cardsContainerClassName`, `listContainerClassName`, `cardItemClassName`, `listItemClassName`, `emptyState`.
- **`PostingViewModeToggle`**: Reusable cards/list toggle UI bound to global posting view mode context.
- **`PostingViewModeProvider`** + **`usePostingViewMode`** (`PostingViewModeContext.tsx` and `PostingViewModeState.ts`): app-level context and hook for shared cards/list mode state with `localStorage` persistence.

### Shared Posting Filter Rules

1. `SharedPostingFilterFields` currently includes `postingFilter` and `organizationCertificateFilter` in addition to search/date/time fields. Any page-local filter type that extends it must provide defaults for both fields.
2. When using `buildSharedPostingQuery(...)`, pass a fully populated object that includes those shared fields even if the current screen does not actively expose both controls.
3. If a search screen needs an entity-specific top-row filter (for example certificate status), return it from `PostingSearchView.extraFields`; do not add a one-off field slot directly inside `PostingFiltersCard`.

### Form and Input Components

- **`PasswordResetCard`**: Self-contained password reset form integrated with auth context and validation/error handling.
- **`ToggleButton`**: React-hook-form-friendly toggle group. Required props: `form`, `name`, `label`, `options`. Optional props: `disabled` (default `false`), `compact` (default `false`). Option-level optional fields: `description`, `Icon`, `btnColor`.
- **`CalendarInfo`**: Shared date input abstraction supporting form mode and controlled mode. Supports single-date, range (default), and multiple-date selection modes in controlled usage, plus single-date form usage via `dateName`. The picker uses fixed weeks, shows outside days, and includes a native month/year input for direct navigation. Optional common props: `startLabel`, `endLabel`, `className`, `disabledDates`, `dateDetails`.

### Interaction and Workflow Components

- **`Loading`**: DaisyUI loading spinner. Optional prop: `size` (`xs`, `sm`, `md`, `lg`, `xl`; default `md`).
- **`EmptyState`**: Generic empty-state panel with centered icon and text for no-data/result cases. Required props: `title`, `description`, `Icon`.
- **`OrganizationProfilePicture`**: Shared organization avatar/logo renderer with initials fallback. Required props: `organizationName`, `organizationId`. Optional props: `logoPath`, `size` (default `96`), `className`, `linkToOrganizationPage` (default `false`), `linkClassName`, `onLinkClick`.
- **`LocationPicker`**: Leaflet map picker with draggable marker, click-to-place, Lebanon geocoding search, and read-only mode. Required props: `position`, `setPosition`. Optional props: `readOnly` (default `false`), `className`.
- **`OrganizationRequestReviewCard`**: Admin review card for organization onboarding requests. Required props: `request`, `refreshOrganizationRequests`.
- **`VolunteerInfoCollapse`**: Expandable volunteer info block for applications/enrollments. Required prop: `volunteer`. Optional prop: `actions`.
- **`CustomMessageModal`** and **`PostingApplicationMessageModal`**: Application-message modals with max-length validation and submission states. Required props: `open`, `onClose`, `onSubmit`. Optional props: `submitting` (default `false`), `errorMessage`.

## Backend Conventions

1. Route modules should live under `server/src/api/routes/<domain>/`.
2. **Always** annotate route handlers with explicit response types: `async (req, res: Response<TypeNameResponse>) => {...}`.
3. **All TypeScript imports must use `.js` extensions** (for ESM compatibility), e.g., `import x from './file.js'`.
4. Validate request bodies with Zod **at the start** of each route: `const body = schema.parse(req.body)`.
5. When throwing errors, **set status code first**: `res.status(403); throw new Error('message');`.
6. Enforce auth with `authorizeOnly(...)` middleware where needed.
7. Access authenticated user ID via `req.userJWT!.id`.
8. Keep DB operations typed via Kysely and shared table types.
9. Never return `{success: true}` in responses. Success status is inferred by the HTTP status code.
10. Never manually call `res.error({/* ... */})`. Instead, throw an error and let the error handler middleware catch it.
11. For transactional DB logic, use `executeTransaction` from `server/src/db/startTransaction.ts` instead of calling `db.transaction().execute(...)` directly.

## Schema & Type Patterns

1. **Always export both the Zod schema and its inferred TypeScript type:**
   ```typescript
   export const mySchema = zod.object({...});
   export type MyType = zod.infer<typeof mySchema>;
   ```
2. **Prefer schema composition over duplication:**
   - For new entity schemas: `newEntitySchema = entitySchema.omit({ id: true })`
   - For public data: `entityWithoutPasswordSchema = entitySchema.omit({ password: true })`
3. **Reuse canonical schemas from `server/src/db/tables.ts`** in both server routes and client forms.
4. Never recreate table schemas manually when schema composition works.

## Embeddings Scope (Current)

1. Implement embeddings only for currently-backed DB fields and tables.
2. Do not add new domain tables just to support embeddings (e.g. no ad-hoc `volunteer_experience` table) unless explicitly requested in a dedicated DB task.
3. CV is currently a link-only concept; CV text extraction is deferred until CV storage is implemented.
4. When CV extraction is implemented, use a PDF parsing library server-side to extract text from the linked PDF, then feed extracted text into embedding generation.
5. Until experience entities are implemented in DB, do not generate or recompute experience-derived embeddings from synthetic or temporary tables.
6. Vector definitions in current schema:
   `organization_account.org_vector`: embedding of organization profile fields.
   `posting.opportunity_vector`: embedding of posting fields and skills.
   `posting.posting_context_vector`: normalized weighted combination of posting + organization vectors (70/30).
   `volunteer_account.profile_vector`: embedding of volunteer profile fields, skills, and parsed CV text (if available).
   `volunteer_account.experience_vector`: weighted aggregation from attended posting context vectors (latest-first, max 10).

## Migration Rules

1. Never modify old migrations that have likely been applied.
2. Add a new numbered migration file for schema changes (continue sequence in `server/src/db/migrations/`).
3. When adding/removing DB fields:
   - Update migration(s)
   - Update `server/src/db/tables.ts`
   - Update affected insert paths (e.g., signup flows, seed scripts)
4. Verify migration success locally after DB is running.
5. Partial-enrollment schema currently spans both pending and accepted states:
   - `enrollment_application_date` for requested dates
   - `enrollment_date` for accepted/enrolled dates
   Keep both paths in sync when changing partial-attendance behavior.

## Verification Checklist

Before finishing code changes:

1. Client type/build check:
   ```bash
   cd client && npm run type:check && npm run lint:check
   ```
2. Server type check:
   ```bash
   cd server && npm run type:check && npm run lint:check
   ```
3. If backend behavior changed, run server and validate endpoint flow manually.
4. If DB-dependent checks fail due to DB down, state it explicitly and include the exact command needed.

## Notes for Agents

## Documentation Maintenance

1. When reusable components change (new props, behavior, moved location, deprecation), update this file’s component sections in the same task.
2. When hooks or utilities are added or edited (new options, return shape, conventions), update the related guidance in this file in the same task.
3. Treat `AGENTS.md` updates as part of the definition of done for changes that affect shared developer workflows.

AGENTS.md files may exist at multiple levels. The most specific one in the directory tree takes precedence for files under its scope.

