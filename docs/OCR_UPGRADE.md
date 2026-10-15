# e-Vault OCR Upgrade — implementation, deployment and test report

## 1. Root causes found
| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | **Word boxes/confidences were never produced.** tesseract.js v7 only returns `words`/`blocks` when `blocks` output is requested; the old `Tesseract.recognize(img,"eng",{...})` returns `data.words === undefined`. Spatial mapping and OCR confidence in `dynamicOcrMappingService` therefore always ran on empty data. | Reproduced in sandbox (`words: undefined, blocks: null`). | New engine requests `{blocks:true}` and flattens words with confidence, page, line, bbox. |
| 2 | Digital PDFs were rasterised and OCR'd (no native text layer use). | `ocrService.renderPdfToPngs` for every PDF. | `pdftotext -bbox` native extraction per page; OCR only for pages without a meaningful text layer (mixed PDFs supported, no duplicate text). |
| 3 | **Re-running OCR wiped manual corrections** (`upsert` reset `status`, `correctionHistory:[]`, mapped values). | `dynamicOcrMappingService.mapDocument`. | Corrected fields and CONFIRMED records are preserved; history kept. |
| 4 | Date fields: `Date.parse("18-09-2026")` is NaN so day-first dates failed validation; `<input type=date>` needs ISO anyway. | `metadataValidationService`, `FieldRenderer`. | Mapper stores ISO; validator also accepts explicit day-first. |
| 5 | Confidence was inflated (flat 0.7 for missing evidence, flat "High" by format check). | old scorer. | Evidence-weighted heuristic; missing evidence excluded, validation failure caps at LOW, ambiguity at MID. |
| 6 | Review loaded **inactive** fields while the mapper mapped only active ones. | `loadFieldsForVersion`. | ACTIVE only everywhere. |
| 7 | Missing local language file makes tesseract.js throw an **uncaught process-level exception**. | Reproduced. | Pre-validated; becomes a normal job error. |
| 8 | Existing `cryptoUtil` falls back to `"fallback-dev-key"`/`JWT_SECRET`. | `utils/cryptoUtil.js`. | New OCR vault requires a dedicated key, no fallback. (Existing util untouched.) |
| 9 | Review page was already template-driven (not hardcoded). | `Ocrreviewpage.jsx`. | Kept; added status/ambiguity/engine UI. |
| 10 | `ocrProcessingpage` contained an unused fabricated `MOCK_LOGS` list. | file. | Removed; engine shown only from backend data. |

## 2. What changed
**Backend (new)** `src/services/ocr/`: `normalizers.js`, `pdfNative.js`, `preprocess.js` (grayscale, percentile contrast, adaptive/Otsu threshold, skew ±6°, max 3 variants chosen by measured confidence), `tesseractEngine.js` (worker lifecycle, per-page timeout, bounded jobs, PSM 3→6 retry only if weak, temp-dir cleanup), `extractor.js`, `fieldMapper.js` (pure, template-driven), `credentialVault.js`, `ocrSettingsService.js`, `engineSelector.js`, `providers/{baseProvider,googleDocumentAi,index}.js`.
Also: `controllers/ocrSettingsController.js`, `routes/ocrSettingsRoutes.js` (+ mounted in `app.js`), `models/tenantModels/OcrSettings.js` (+ registered), tenant migration `20261011000001-create-ocr-settings.js`, master migration `20261011010000-add-licensed-ocr-module.js`.
**Backend (modified)**: `ocrService.js` (same exports; `process` delegates), `dynamicOcrMappingService.js` (`mapDocument` only), `ocrWorker.js`, `documentMetadataController.js` (active fields, engine info, stale flag, edit provenance), `metadataValidationService.js` (day-first dates), `auditActions.js` (new constants), `package.json` (+`@google-cloud/documentai`, test scripts).
**Frontend**: `features/ocrSettings/{api.js,OcrSettingsPage.jsx}`, route + nav in `App.jsx`/`TenantLayout.jsx`, `Ocrreviewpage.jsx`, `Ocrprocessingpage.jsx`.

## 3. Behaviour
* **Engine selection** (`engineSelector.runOcr`): Tesseract unless tenant is entitled (`licensed_ocr` module, master DB) **and** `engineMode=LICENSED` **and** provider enabled **and** credentials present. Provider called at most once (SDK retries disabled). Failure → Tesseract fallback only if tenant enabled it (labelled as Tesseract), otherwise job FAILED with source file retained for retry. Empty provider output counts as failure. Entitlement revoked → never calls provider.
* **Template binding**: a document keeps the template version it was first mapped with; the GET returns `templateVersionStale` when a newer version is active. Every configured (active) field is returned, empty + `NOT_DETECTED` if not found.
* **Per-field result** (`confidenceJson`): `status` (DETECTED / NEEDS_REVIEW / AMBIGUOUS / INVALID_FORMAT / NOT_DETECTED / MANUALLY_EDITED), heuristic `score` (+`scoreType`), measured `ocrConfidence`, `originalText`, `page`, `candidates`, `warnings`. Heuristic score ≠ probability.
* **Security**: tenant only from JWT; AES-256-GCM with tenant-bound AAD; key only from env; credentials write-only (never returned/logged; errors redacted); SSRF: API host built only from regex-validated location, service-account JSON must have Google `token_uri`; TenantAdmin-only; 10 tests/min/tenant; module checked server-side on test/clear and inside save for licensed fields.

## 4. Deployment
1. **Backup** master and every tenant DB (`mysqldump`).
2. `npm ci` (rebuilds native `canvas`; the shipped node_modules were built for another OS — do not reuse them).
3. System: `poppler-utils` (pdftoppm, pdftotext, pdfinfo), Cairo/Pango libs for `canvas`. `eng.traineddata` is already in `backend/`.
4. Set env from `.env.example` (**`OCR_CREDENTIAL_ENCRYPTION_KEY` required** for licensed credentials).
5. Master: `npm run migrate:master` (adds non-default `licensed_ocr` module; assigned to nobody).
6. Tenants: `node scripts/migrateAllTenants.js` (new tenants get the migration at provisioning).
7. Restart API/workers. Frontend: `npm ci && npm run build`, deploy `dist/`.
8. Super Admin: assign **Licensed OCR Provider** to entitled tenants. Tenant Admin: *OCR Settings* → paste service-account JSON, location, project, processor → Save → Test connection → enable → select Licensed.
9. **Google setup**: create a Document AI processor (e.g. Invoice parser); service account with *Document AI API User* role; note location/processor ID.
**Rollback**: deploy previous build; migrations are additive — `ocr_settings` and the module row are harmless if unused (do not drop). Old `ocrMetadata.extractedText` contract is unchanged.
**Security action**: the uploaded ZIP contained a real `.env`; rotate DB/JWT/ERP secrets. It was excluded from the deliverables.

## 5. Known limitations (disclosed)
* No repeating line-item model exists in the metadata schema; repeated values (e.g. 4 batch numbers) are surfaced as **candidates** on one field, not as rows. Table-structure extraction not implemented.
* Orientation (90/180°) detection not implemented; only skew ±6°.
* Only Google Document AI implemented (adapter contract ready for Azure).
* Google online processing limits (15 pages / 20 MB configured) — larger files fail → fallback if enabled.
* Provider entities are used for mapping only when an entity type equals a field's label/key/alias.
* GSTIN: the acceptance value `21AABCS4821H1Z8` is format-valid but **fails the official check-digit**; the app reports it as "needs review" rather than rejecting it.
* Upload type/size validation in the existing upload route was not audited/changed.
