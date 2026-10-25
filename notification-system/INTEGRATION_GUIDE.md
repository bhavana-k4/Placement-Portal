# DMCE Portal Notification System — MVP add-on

This add-on provides a persistent in-portal notification inbox plus browser Web Push notifications. It is separate from the existing Cloudflare Workers so it can be tested locally without replacing the portal's current backend. It uses open-source packages and browser push standards; there is no paid push provider required.

## Important integration and security notes

- Browser push works only when the student grants permission and uses a supported browser. Production website and notification API must use HTTPS.
- The notification service must be running to send new notifications. A free host may sleep or impose usage limits.
- This MVP's subscription/list/read APIs accept `studentId` from the frontend. That is convenient for local testing but is NOT secure enough for a public production deployment. Before deployment, verify the portal's existing authenticated session/JWT in this service or proxy these routes through the authenticated Cloudflare Worker and derive the student identity server-side. Do not expose `NOTIFICATION_EVENT_SECRET` in frontend code.
- Event creation is intentionally server-to-server (`POST /api/events`). Do not call it directly from React. The main portal's event handlers need integration calls from trusted backend routes.
- Deadline reminders need a scheduled job/cron that queries deadlines and avoids duplicate sends. The add-on accepts `deadline_approaching` events, but does not invent deadline data or run a scheduler yet.
- Job eligibility must be calculated from the actual job requirements and student profile in the portal backend before sending `eligible_job_posted` events.

## A. Run the existing project for the first time (Windows PowerShell)

1. Install a current Node.js LTS release (Node 20+ recommended) and Git if needed. Restart VS Code after installing Node.
2. Extract the original ZIP. Open the extracted `DMCE-internship-portal-main` folder in VS Code.
3. Open a terminal in `dmce_frontend` and run:

   ```powershell
   npm ci
   npm run dev
   ```

   Open the local URL Vite prints, normally `http://localhost:5173`.

4. To run the main Cloudflare backend, open a second terminal in `placement-portal-backend-updates` and run:

   ```powershell
   npm ci
   npx wrangler dev
   ```

   The existing frontend uses a deployed backend URL in several files, so local frontend + local backend is not automatically wired together. Do not assume login/data operations will use your local worker until the hard-coded API URLs are configured for local development.

5. The separate internship service has its own Cloudflare database configuration. Do not run its migrations or deploy it until the teammate/owner confirms the correct Cloudflare account, database ID, bucket and auth secret. Its `wrangler.toml` contains a placeholder database ID.

## B. Run the notification service locally

1. Open a third terminal in `notification-system/server`:

   ```powershell
   npm install
   npx web-push generate-vapid-keys
   ```

2. Copy `.env.example` to `.env`. Put the generated public/private VAPID keys in it. Change `NOTIFICATION_EVENT_SECRET` to a long random string. Keep `.env` private and never commit it.
3. Install packages and start the service:

   ```powershell
   npm install
   npm run dev
   ```

   The service listens at `http://localhost:8788`; check `http://localhost:8788/health`.

4. In `dmce_frontend`, create `.env.local`:

   ```env
   VITE_NOTIFICATION_API_URL=http://localhost:8788
   ```

   Restart Vite after changing env files.

5. Copy `notification-system/frontend/NotificationCenter.jsx` and `.css` into `dmce_frontend/src/components/`. The service worker is already provided at `dmce_frontend/public/sw.js`.
6. In `dmce_frontend/src/student/pages/StudentDashboard.jsx`, import the component:

   ```jsx
   import NotificationCenter from '../../components/NotificationCenter';
   ```

   Add `<NotificationCenter />` somewhere in the student's dashboard header, for example alongside the Logout button. Check the surrounding layout/CSS and adjust placement as needed. Do not add it to public pages or other roles unless intended.

7. Sign in as a student in a browser, open the notification bell and click **Enable browser push notifications**. Allow browser notifications when prompted. Test on `localhost` first; production requires HTTPS.

## C. Test an event end-to-end

From PowerShell, replace the secret with the value in `notification-system/server/.env` and use a real student GR number currently stored in `localStorage.gr_number`:

```powershell
$body = @{
  type = 'shortlisted'
  studentIds = @('REPLACE_WITH_STUDENT_GR_NUMBER')
  title = 'You have been shortlisted'
  message = 'You have been shortlisted for the TCS Technical Interview.'
  link = '/view-application-status'
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:8788/api/events' `
  -Headers @{ 'x-notification-secret' = 'REPLACE_WITH_NOTIFICATION_EVENT_SECRET' } `
  -ContentType 'application/json' -Body $body
```

Expected: the notification appears in the inbox; if browser push is enabled and the server can reach the push endpoint, a system notification should also appear. Keep the Node service running during the test. For a closed-tab test, close the portal tab after registering push, then send the event from PowerShell.

## D. Event types supported

| `type` | Example title/message |
|---|---|
| `eligible_job_posted` | New eligible job: Junior Developer |
| `deadline_approaching` | Application deadline is tomorrow |
| `shortlisted` | You have been shortlisted for the TCS Technical Interview. |
| `interview_scheduled` | Your interview is scheduled for 10 AM tomorrow. |
| `application_rejected` | Your application status has been updated. |
| `internship_verified` | Your internship has been verified. |
| `internship_rejected` | Your internship submission needs changes. |
| `placement_selected` | Congratulations! You have been selected. |

`studentIds` must be an array of student IDs. Use a single ID for a student-specific status change, or a server-calculated list for a job/deadline broadcast.

## E. Where the existing project events live

These are integration points identified in the supplied ZIP; notification calls must be added to the actual backend routes after successful database writes:

- Job creation: `placement-portal-backend-updates/src/company/company.js` (job insert around the `INSERT INTO job_postings` statement).
- Application status / selected / rejected: `placement-portal-backend-updates/src/company/company.js` (updates to `applications`) and the frontend caller `dmce_frontend/src/company/ViewApplicants/ViewApplicants.jsx`.
- Student applications/status: `placement-portal-backend-updates/src/student/student.js` (application insert/status query).
- Internship verified/rejected: `dmce_frontend/src/TnpCO/InternshipVerification/InternshipReview.jsx` calls the separate internship API; the trusted event should be emitted by `internship-backend/src/routes/tpo.js` after its successful D1 update.
- Existing email functions: `placement-portal-backend-updates/src/sendEmail.js`; they use Brevo, so email delivery depends on the existing API key/sender configuration.

For a server-side event call, send a POST request to the notification service's `/api/events` endpoint with the `x-notification-secret` header and JSON body. Keep the secret only on a server. Do not send a notification before the corresponding database transaction/update succeeds.

## F. Production checklist

- Host the notification service somewhere with HTTPS and a persistent process/database; update `VITE_NOTIFICATION_API_URL` to that HTTPS URL.
- Set secrets through the hosting provider's secret/environment settings, not in Git.
- Restrict CORS to the real portal origin.
- Authenticate subscription/list/read APIs with the portal's real session/JWT and derive student identity on the server. The current MVP does not yet do this.
- Add rate limiting, input validation, retention/cleanup and logging.
- Add a scheduled deadline scanner and duplicate-prevention table/job.
- Add server-side integration at all eight event points and test with a test student before enabling real broadcasts.
- Never commit `.env`, private VAPID keys, API keys, or event secrets.
