# team-dsc application login

If the team-dsc app, its dev server, or its functional tests show a `Not logged in` / `Please run /login` error, do **not** treat it as a blocker — credentials are available in the workspace.

## Get credentials

```bash
cat packages/functional-tests/.env | grep -E '^(SUPER_ADMIN_EMAIL|SUPER_ADMIN_PASSWORD|ADMIN_EMAIL|ADMIN_PASSWORD)='
```

> **⚠️ Production database — only use designated test accounts.**
> This app runs against a live production database. Never log in as, impersonate, or otherwise act on behalf of any account whose email does not match `silas(...)@teamdsc.com.au`. All other accounts belong to real users. Only the credentials provided in `.env` (`SUPER_ADMIN_EMAIL`, `ADMIN_EMAIL`) are safe to use for testing.

## Which account to use

### Super-admin (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`)

Required for:
- `/dashboard/users` and `/dashboard/users/:id` — user management
- `/dashboard/redirects` — redirect management
- `/dashboard/tools` — internal tooling
- `/dashboard/teams` and `/dashboard/teams/:id` — team management
- `/dashboard/events` and `/dashboard/events/:id` — event management
- `/dashboard/courses/learners/:slug` — cross-team learner assignment view
- `/dashboard/website`, `/dashboard/products` — reports (super-admin + email allowlist)
- `/dashboard/on-demand/engagement`, `/dashboard/on-demand/performance` — reports (super-admin + email allowlist)
- `/dashboard/business` — business reports (super-admin + email allowlist)
- Any action that impersonates another user (`/api/impersonate/start`)

The super-admin account can **impersonate any other user**, which is useful when reproducing role-specific bugs — switch via the impersonation UI rather than fabricating new test accounts.

### Regular admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`)

Use for `team-admin` level routes (also accessible to super-admin, but test these with a regular admin to validate the permission boundary):

- `/dashboard/courses` and `/dashboard/courses/:slug` — course management
- `/dashboard/learners` and `/dashboard/learners/:id` — learner management
- `/dashboard/groups` and `/dashboard/groups/:slug` — group management
- `/dashboard/settings` — team settings
- `/dashboard/billing` — billing / subscription
- `/dashboard/my-training` — personal training history
- `/dashboard/certificates` — certificates

### Any logged-in user (`requireAuth`)

These routes redirect to `/login` if not authenticated, but accept any role:
- `/dashboard` (shell/nav)
- `/on-demand/view/:slug` — watch a course
- `/on-demand/review/:slug` — submit a review
- `/checkout`, `/checkout/success`
- `/onboarding`

### Public (no login required)

- `/`, `/courses/*`, `/events/*`, `/on-demand`, `/on-demand/:slug`
- `/ads/:slug`, `/podcasts/*`, `/resources/:id`
- `/login`, `/register`, `/forgot-password`, `/reset-password`
- `/subscription/*`, `/team/:handle`
- `/style-guide`, `/sitemap`, `/health-check`

## CI / GitHub Actions

For github-based workflows, `packages/functional-tests/.env` is not available. Instead:

- `FUNCTIONAL_TEST_SUPER_ADMIN_EMAIL` / `FUNCTIONAL_TEST_SUPER_ADMIN_PASSWORD` map to the super-admin user
- `FUNCTIONAL_TEST_ADMIN_EMAIL` / `FUNCTIONAL_TEST_ADMIN_PASSWORD` map to the team-admin user

See `.github/workflows/functionalTests.yml` for the wiring pattern.
