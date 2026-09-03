# Subscription Management System — Implementation Changelog

Companion to `subscription-system-analysis-and-plan.md` (the approved plan).
Everything below is additive; no existing PAID-tenant route, controller, or
SAP behavior was changed except where noted with "guarded, not modified."

## New files
- `src/migrations/20260803010000-add-tenant-type-to-tenants.js`
- `src/migrations/20260803010100-add-mobile-number-to-users.js`
- `src/migrations/20260803010200-create-plans.js`
- `src/migrations/20260803010300-create-plan-features.js`
- `src/migrations/20260803010400-create-subscriptions.js`
- `src/migrations/20260803010500-create-subscription-histories.js`
- `src/migrations/20260803010600-create-otp-verifications.js`
- `src/migrations/20260803010700-add-local-file-path-to-documents.js`
- `src/models/Plan.js`, `PlanFeature.js`, `Subscription.js`, `SubscriptionHistory.js`, `OtpVerification.js`
- `src/constants/subscriptionConstants.js`
- `src/seeders/planSeeder.js` (run automatically on boot, after `superAdminSeeder`)
- `src/middleware/subscriptionMiddleware.js`
- `src/services/subscriptionService.js`
- `src/services/otpService.js`
- `src/services/notificationService.js`
- `src/services/watermarkService.js` (**requires `npm install pdf-lib`**, already added to `package.json`)
- `src/services/subscriptionScheduler.js` (daily cron, 02:00 by default — `SUBSCRIPTION_SCHEDULER_CRON` env override)
- `src/services/localFinalizationService.js`
- `src/controllers/subscriptionController.js`
- `src/controllers/planController.js`
- `src/routes/subscriptionRoutes.js` → mounted at `/api/subscriptions`
- `src/routes/planRoutes.js` → mounted at `/api/plans`

## Modified files
- `src/models/Tenant.js` — added `tenantType` (default `PAID`)
- `src/models/User.js` — added `mobileNumber` (nullable, unique)
- `src/models/Document.js` — added `localFilePath` (nullable)
- `src/models/index.js` — new associations for Plan/PlanFeature/Subscription/SubscriptionHistory
- `src/middleware/authMiddleware.js` — now also attaches `req.tenant` (full row); `req.user` shape unchanged
- `src/app.js` — mounts `subscriptionRoutes`/`planRoutes`, calls `seedPlans()`, starts `subscriptionScheduler`
- `src/routes/sapSyncRoutes.js` — router-level `requireSAP` gate added (all routes)
- `src/routes/masterDataRoutes.js` — `requireSAP` gate added (both routes; they call `sapEntityResolver`)
- `src/routes/documentAIRoutes.js` — router-level `requireAI` gate added (all routes)
- `src/routes/chatRoutes.js` — router-level `requireFeature(AI_CHAT)` gate added
- `src/routes/aiSettingsRoutes.js` — router-level `requireAI` gate added
- `src/routes/documentRoutes.js` — `loadSubscription` on every route (non-blocking, for FREE/PAID branching); `requireActiveSubscription()` on upload/finalize/generate-tcode/delete only (view/download/list stay available after trial expiry); `requirePaidPlan()` added to `/:id/sap`
- `src/controllers/documentController.js`:
  - `finalizeDocument` — FREE tenants call `localFinalizationService.finalizeDocumentLocally` (no SAP code path reachable); PAID unchanged
  - `viewDocument` — FREE tenants serve the local file through `watermarkService`; PAID unchanged (still fetches from SAP as before)
  - `downloadDocument` — same FREE/PAID split as `viewDocument`
- `package.json` — added `pdf-lib` dependency

## What you need to do before deploying
1. `npm install pdf-lib` (PDF watermarking dependency).
2. Run migrations: `npx sequelize-cli db:migrate` (or your existing migration command).
3. Confirm an email/SMS provider — `notificationService.js` currently logs to console until `EMAIL_PROVIDER=smtp` / `SMS_PROVIDER=twilio` + credentials are set (see comments at the top of that file).
4. Restart the app once — `planSeeder.js` runs automatically and (a) creates the FREE/PAID plans, (b) backfills a `PAID`/`ACTIVE` `Subscription` row for every tenant that existed before this deploy, so nothing changes for current customers.
5. Sanity-check one PAID tenant end-to-end (SAP sync, AI chat/search, upload/view/download) before enabling FREE registration publicly — `POST /api/subscriptions/register/send-otp` and `/register/verify-otp` are live as soon as the app boots.

## Known gaps / follow-ups (flagged, not silently decided)
- ~~Thumbnails/print~~ — **closed**: `GET /api/documents/:id/thumbnail` added (see below).
- ~~In-app notifications~~ — **closed**: `notifications` table + `/api/notifications` added (see below).
- **Watermark branding**: uses "Excelligent" as the company name (per your note) with a tiled diagonal style matching your reference image. If you have an actual logo file, `watermarkService.watermarkImage`/`watermarkPdf` can be extended to stamp it in the corner in addition to the tiled text — let me know if you want that added.
- **SuperAdmin plan endpoints** (`/api/plans`, `/api/subscriptions/:tenantId/*`) have no frontend yet — they're ready for one.
- **"Print"** still isn't a distinct backend concept in this codebase (client prints whatever `/view` or `/download` returns) — since both are watermarked for FREE, print output is watermarked too, just not via a dedicated endpoint.

## Round 2 additions (in-app notifications + thumbnails)
- `src/migrations/20260803010800-create-notifications.js`, `src/models/Notification.js`
- `src/services/notificationCenterService.js` — create/list/mark-read; `userId=null` = tenant-wide
- `src/controllers/notificationController.js` + `src/routes/notificationRoutes.js` → mounted at `/api/notifications`
  - `GET /api/notifications` (supports `?unreadOnly=true`), `PUT /api/notifications/:id/read`, `PUT /api/notifications/read-all`
- `src/services/subscriptionScheduler.js` — now also writes a tenant-wide `Notification` row (`TRIAL_REMINDER`/`TRIAL_EXPIRED`) alongside the email/SMS reminder; reordered so the "expires today" (remaining=0) reminder fires before the subscription flips to `EXPIRED`
- `src/services/subscriptionService.js` — `convertFreeToPaid`/`upgradePlan` now also create a `SUBSCRIPTION_CHANGED` in-app notification
- `src/services/thumbnailService.js` — new, generates a downscaled PNG preview (first page for PDFs, via the same `pdfjs-dist`+`canvas` pattern as `ocrService.js`)
- `src/controllers/documentController.js` — new `getDocumentThumbnail`: FREE tenants get the local file thumbnailed then watermarked (same watermark as `/view`/`/download`); PAID tenants get it fetched from SAP and thumbnailed, no watermark
- `src/routes/documentRoutes.js` — new `GET /api/documents/:id/thumbnail`

