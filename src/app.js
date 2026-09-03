// src/app.js
require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const morgan       = require("morgan");
const helmet       = require("helmet");
const compression  = require("compression");
const cookieParser = require("cookie-parser");
const rateLimit    = require("express-rate-limit");
const hpp          = require("hpp");
const swaggerUi    = require("swagger-ui-express");
const swaggerSpec  = require("./swagger");
const { corsOptions } = require("./config/corsOptions");
const { requestContextMiddleware } = require("./middleware/requestContextMiddleware");
const hostContextMiddleware = require("./middleware/hostContextMiddleware");
const { notFoundHandler, errorHandlerMiddleware } = require("./middleware/errorHandlerMiddleware");
const healthRoutes = require("./routes/healthRoutes"); // PRODUCTION DEPLOYMENT — GET /health, /health/tenant
const crossDepartmentDocumentRoutes =
  require("./routes/crossDepartmentDocumentRoutes");
// PHASE G — the legacy shared-DB connection (src/config/database.js) and
// its `require("./models")` model set are NO LONGER loaded by the
// production app. They still exist on disk as migration tooling only
// (src/database/legacyMigration/*, scripts/migrateLegacyToTenant.js) —
// see PHASE_G_LEGACY_REMOVAL_REPORT.md. Production boots against the
// Master DB only; every tenant request is then routed to its own
// physical database by tenantResolverMiddleware.js.
const masterSequelize = require("./config/masterDatabase");
require("./models/masterDb");

// ── Route imports ──────────────────────────────────────────
const authRoutes         = require("./routes/authRoutes");
const tenantRoutes       = require("./routes/tenantRoutes");
const userRoutes         = require("./routes/userRoutes");
const auditRoutes        = require("./routes/auditRoutes");
const masterDataRoutes   = require("./routes/masterDataRoutes");
const companyCodeRoutes  = require("./routes/companyCodeRoutes");  // NEW (enterprise hierarchy)
const plantRoutes        = require("./routes/plantRoutes");        // NEW (enterprise hierarchy)
const departmentRoutes   = require("./routes/departmentRoutes");   // NEW
const categoryRoutes     = require("./routes/categoryRoutes");     // NEW
const documentTypeRoutes = require("./routes/documentTypeRoutes"); // NEW
const documentRoutes     = require("./routes/documentRoutes");     // NEW (replaces old /api/sap)
const checkInOutRoutes   = require("./routes/checkInOutRoutes");   // NEW (Enterprise Check-In / Check-Out)
const vaultRoutes        = require("./routes/vaultRoutes");        // NEW (SAP machine-to-machine Vault API — Basic Auth, no JWT/portal middleware)
const erpConfigRoutes = require("./routes/erpConfigRoutes");
const approvalWorkflowRoutes = require("./routes/approvalWorkflowRoutes"); // NEW (Approval Matrix Builder)
const approvalRoutes         = require("./routes/approvalRoutes");         // NEW (Approval Engine runtime)
const userAssignmentRoutes   = require("./routes/userAssignmentRoutes");   // NEW (Dynamic User Assignment Engine)
const sapSyncRoutes          = require("./routes/sapSyncRoutes");          // NEW (SAP Master + Document Synchronization)
const sapSyncScheduler       = require("./services/sapSyncScheduler");     // NEW (Cron Scheduler for SAP Sync)
const metadataTemplateRoutes = require("./routes/metadataTemplateRoutes"); // NEW (Dynamic Metadata Template Engine)
const metadataFieldRoutes    = require("./routes/metadataFieldRoutes");    // NEW (Form Builder fields + OCR aliases)
const documentMetadataRoutes = require("./routes/documentMetadataRoutes"); // NEW (per-document dynamic metadata)
const aiSettingsRoutes      = require("./routes/aiSettingsRoutes");       // NEW (AI Document Assistant — providers + settings)
const chatRoutes            = require("./routes/chatRoutes");            // NEW (AI Document Assistant — RAG chat)
const documentAIRoutes      = require("./routes/documentAIRoutes");      // NEW (AI Document Assistant — summarize/compare/classify/search)
const subscriptionRoutes    = require("./routes/subscriptionRoutes");    // NEW (Subscription Management System — FREE registration/login + plan admin)
const planRoutes            = require("./routes/planRoutes");
const tenantModuleRoutes    = require("./routes/tenantModuleRoutes");            // NEW (Subscription Management System — plan/feature catalog admin)
const notificationRoutes    = require("./routes/notificationRoutes");    // NEW (Subscription Management System — in-app dashboard notifications)
const subscriptionScheduler = require("./services/subscriptionScheduler"); // NEW (daily trial expiry + reminder notifications)
const tenantStorageScheduler = require("./services/tenantStorageScheduler"); // hourly tenant DB/file storage metering
const communicationRoutes   = require("./routes/communicationRoutes");   // MERGE (Internal Communication Module — 1-to-1 chat + voice messages)
const communicationSocketService = require("./services/communicationSocketService"); // MERGE (Socket.IO — real-time chat/presence/calls)


const seedMasterSuperAdmin = require("../scripts/seedMasterSuperAdmin");
const seedMasterPlans = require("../scripts/seedMasterPlans");

const app = express();

// ── PHASE H — trust proxy (wildcard subdomain routing depends on the
// real Host header reaching req.hostname correctly). Disabled by default
// (secure: Express ignores X-Forwarded-* entirely, so a directly-exposed
// process can't be fooled by a spoofed header from an untrusted client).
// Set TRUST_PROXY_HOPS to the exact number of reverse proxies in front
// of this process (Nginx/Cloudflare/load balancer — brief "Express
// Proxy") to have Express trust exactly that many hops' worth of
// X-Forwarded-* headers, no more. A single reverse proxy (the common
// case): TRUST_PROXY_HOPS=1. Never set this to `true` in production —
// that trusts an unbounded chain of forwarded headers from anyone.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

// ── Security & utility middleware ──────────────────────────
app.use(cors(corsOptions));
app.use(helmet());
app.use(compression());
app.use(cookieParser());
app.use(hpp());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.json());
app.use(morgan("dev"));

// ── PHASE H — request correlation id, then hostname -> tenant identity.
// Mounted globally, before every route, so brief tests like
// "unknown.app.YOUR_DOMAIN -> 404" hold for ANY route on that hostname,
// not just authenticated ones — see hostContextMiddleware.js header for
// the full reasoning and the split of responsibility with
// tenantResolverMiddleware (which still does JWT -> connection, extended
// this phase to cross-check against req.hostContext). Public routes
// (health, registration, OTP, SuperAdmin auth — brief "Public APIs") are
// completely unaffected as long as they're reached via a non-tenant
// hostname (the bare API domain, an admin/reserved subdomain, or any
// environment where BASE_DOMAIN isn't configured at all). ─────────────
app.use(requestContextMiddleware);
app.use(hostContextMiddleware);

// ── Health checks (PRODUCTION DEPLOYMENT) ───────────────────
// Public, unauthenticated, mounted before every business route. Nginx /
// load balancer / orchestrator should poll GET /health.
app.use(healthRoutes);

// ── Routes ─────────────────────────────────────────────────
app.use("/api/auth",           authRoutes);
app.use("/api/tenants",        tenantRoutes);
app.use("/api/users",          userRoutes);
app.use("/api/audit-logs",     auditRoutes);
app.use("/api/master-data",    masterDataRoutes);

// Enterprise hierarchy: Tenant -> Company Code -> Plant -> Department -> ...
app.use("/api/company-codes",  companyCodeRoutes);
app.use("/api/plants",         plantRoutes);

// Department master + tenant-department assignments
app.use("/api/departments",    departmentRoutes);

// Tenant's categories (under assigned departments)
app.use("/api/categories",     categoryRoutes);

// Tenant's document types (under categories)
app.use("/api/document-types", documentTypeRoutes);

// Documents (upload → SAP + metadata → DB)
app.use("/api/documents",      documentRoutes);

// Enterprise Check-In / Check-Out (lock / unlock / version-on-checkin)
app.use("/api/documents",      checkInOutRoutes);

// SAP machine-to-machine Vault API (Basic Auth against Master DB
// ErpConfig — SAP is not a portal user, so this is intentionally NOT
// behind auth/role/subscription middleware). See routes/vaultRoutes.js
// and middleware/sapVaultAuthMiddleware.js for the full auth + tenant
// resolution flow.
app.use("/api/v1/vault",       vaultRoutes);

// ── Swagger docs ────────────────────────────────────────────
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Health check ────────────────────────────────────────────
app.get("/", (req, res) => res.send("DMS + SAP Integration Running 🚀"));

app.use("/api/erp-configs", erpConfigRoutes);

// Dynamic Approval Workflow Engine
app.use("/api/approval-workflows", approvalWorkflowRoutes);
app.use("/api/approvals",          approvalRoutes);

// Dynamic User Assignment Engine (Department / Category / DocumentType level access)
app.use("/api/user-assignments",   userAssignmentRoutes);

// SAP Master Synchronization + SAP Document Synchronization
app.use("/api/sap-sync",           sapSyncRoutes);

// Dynamic Metadata Template Engine (Form Builder: templates, versions, fields, OCR aliases)
app.use("/api/metadata-templates", metadataTemplateRoutes);
app.use("/api/metadata-fields",    metadataFieldRoutes);

// Per-document dynamic metadata (raw OCR / mapped fields / confidence / corrections)
app.use("/api/documents",          documentMetadataRoutes);
app.use(
  "/api/cross-department-documents",
  crossDepartmentDocumentRoutes
);

// ── AI Document Assistant (RAG chatbot + document AI features) ─────────
app.use("/api/ai",                 aiSettingsRoutes);
app.use("/api/ai/chat",            chatRoutes);
app.use("/api/ai",                 documentAIRoutes);

// Subscription Management System (FREE registration/login, SuperAdmin plan admin)
app.use("/api/subscriptions",      subscriptionRoutes);
app.use("/api/plans",              planRoutes);
app.use("/api/modules",            tenantModuleRoutes);
app.use("/api/notifications",      notificationRoutes);

// ── Internal Communication Module (1-to-1 chat + voice messages) ───────
// MERGE — fully independent from the AI Document Assistant chat system
// above (/api/ai/chat). Every route here uses the SAME authMiddleware ->
// tenantResolverMiddleware chain as every other tenant route in this
// file, so req.models/req.masterModels are already tenant-scoped before
// communicationController ever runs. Real-time delivery (new
// message/typing/presence/calls) is handled separately over Socket.IO —
// see communicationSocketService.init(server) below.
app.use("/api/communication",      communicationRoutes);

// ── 404 + global error handler (PRODUCTION DEPLOYMENT) ──────
// Must be mounted LAST, after every route above, and in this order:
// notFoundHandler first (anything that fell through every route),
// errorHandlerMiddleware second (catches thrown/next(err) errors from
// any route above it) — see errorHandlerMiddleware.js for why this
// exists (Express's own default error handler leaks stack traces).
app.use(notFoundHandler);
app.use(errorHandlerMiddleware);


// ── DB connect (Master DB only — STEP 4/5) ──────────────────
// PHASE G: production no longer authenticates against, or syncs, the old
// shared database. Schema for the Master DB comes from real migrations
// (`npm run migrate:master`), run BEFORE starting the app — never from
// `sequelize.sync({ alter: true })` at boot (STEP 5: that mutates a live
// production schema on every restart, and can only ever describe ONE
// database's shape, which is meaningless now that there are N tenant
// databases with their own schema, versioned separately via
// src/database/tenant/migrationRunner.js during provisioning).
const PORT = process.env.PORT || 3000;

// MERGE — an http.Server wraps `app` so Socket.IO (Internal
// Communication Module — real-time chat/presence/calls) can attach to
// the SAME port as the REST API, rather than needing a second process
// or port. `app.listen(...)` becomes `server.listen(...)` below;
// everything else about how Express handles HTTP requests is unchanged.
const http = require("http");
const server = http.createServer(app);
communicationSocketService.init(server);

masterSequelize
  .authenticate()
  .then(async () => {
    console.log("✅ Master DB connected");
    await seedMasterSuperAdmin();
    await seedMasterPlans();
    sapSyncScheduler.start();
    subscriptionScheduler.start();
tenantStorageScheduler.startTenantStorageScheduler();
    server.listen(PORT, () =>
      console.log(`🚀 Server running on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ Master DB connection error — refusing to start:", err);
    process.exit(1);
  });