// src/services/crossDepartmentDocumentService.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  Op,
} = require("sequelize");

const {
  resolveScope,
  hasDepartmentAccess,
} = require("./userAssignmentService");

const TEMP_ROOT = path.join(
  process.cwd(),
  "storage",
  "temporary-shares"
);

const ALLOWED_DURATIONS = [
  15,
  30,
  60,
  240,
  1440,
  4320,
  10080,
];

function getModels(req) {
  if (!req || !req.models) {
    throw new Error(
      "Tenant models are not available on request"
    );
  }

  return req.models;
}

function getCurrentUserId(req) {
  const userId =
    req.user?.id ??
    req.auth?.userId ??
    req.auth?.id ??
    req.userId;

  if (!userId) {
    const error = new Error(
      "Authenticated user not found"
    );

    error.statusCode = 401;
    throw error;
  }

  const numericUserId = Number(userId);

  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    const error = new Error(
      "Invalid authenticated user ID"
    );

    error.statusCode = 401;
    throw error;
  }

  return numericUserId;
}

function getTenantId(req) {
  const tenantId =
    req.tenant?.id ??
    req.tenantId ??
    req.user?.tenantId ??
    req.auth?.tenantId;

  if (!tenantId) {
    const error = new Error(
      "Tenant context not found"
    );

    error.statusCode = 401;
    throw error;
  }

  const numericTenantId = Number(tenantId);

  if (
    !Number.isInteger(numericTenantId) ||
    numericTenantId <= 0
  ) {
    const error = new Error(
      "Invalid tenant context"
    );

    error.statusCode = 401;
    throw error;
  }

  return numericTenantId;
}

// ============================================================
// RESOLVE REQUESTER DEPARTMENT
// ============================================================
//
// requesterDepartmentId must NEVER come from the frontend.
// It is resolved from the authenticated user's active
// UserAssignment.
//
// UserAssignment.departmentId is already populated for:
//   DEPARTMENT
//   CATEGORY
//   DOCUMENT_TYPE
//
// This also supports OLD requests where requesterDepartmentId
// was saved as NULL.
// ============================================================

async function resolveRequesterDepartmentId(
  req,
  tenantId,
  userId,
  existingDepartmentId = null
) {
  const existingId = Number(existingDepartmentId);

  // Existing request already has department ID.
  if (
    Number.isInteger(existingId) &&
    existingId > 0
  ) {
    return existingId;
  }

  const {
    UserAssignment,
  } = getModels(req);

  if (!UserAssignment) {
    return null;
  }

  const assignment =
    await UserAssignment.findOne({
      where: {
        tenantId,
        userId,
        status: "ACTIVE",
        departmentId: {
          [Op.ne]: null,
        },
      },
      attributes: [
        "id",
        "userId",
        "departmentId",
        "assignmentLevel",
        "createdAt",
      ],
      order: [
        ["createdAt", "ASC"],
      ],
      raw: true,
    });

  const departmentId =
    Number(assignment?.departmentId);

  if (
    Number.isInteger(departmentId) &&
    departmentId > 0
  ) {
    return departmentId;
  }

  return null;
}
async function assertDepartmentAccess(req, departmentId) {
  const tenantId = getTenantId(req);
  const userId = getCurrentUserId(req);
  const role = req.user?.role;

  const allowed = await hasDepartmentAccess(
    getModels(req),
    tenantId,
    userId,
    role,
    departmentId
  );

  if (!allowed) {
    const error = new Error(
      "You are not authorized to manage requests for this department"
    );
    error.statusCode = 403;
    throw error;
  }
}

async function assertShareDepartmentAccess(req, share) {
  const { DocumentAccessRequest } = getModels(req);
  const tenantId = getTenantId(req);

  const request = await DocumentAccessRequest.findOne({
    where: { id: share.requestId, tenantId },
  });

  if (!request) {
    const error = new Error("Document access request not found");
    error.statusCode = 404;
    throw error;
  }

  await assertDepartmentAccess(req, request.requestedDepartmentId);

  return request;
}

function ensureTemporaryRoot() {
  fs.mkdirSync(
    TEMP_ROOT,
    {
      recursive: true,
    }
  );
}

function buildTemporaryFilePath(
  shareId,
  originalName
) {
  ensureTemporaryRoot();

  const safeName = String(
    originalName || "document"
  )
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);

  const random =
    crypto.randomBytes(12).toString("hex");

  return path.join(
    TEMP_ROOT,
    `${shareId}-${random}-${safeName}`
  );
}

function validateDuration(
  durationMinutes
) {
  const duration = Number(
    durationMinutes
  );

  if (
    !Number.isInteger(duration) ||
    !ALLOWED_DURATIONS.includes(duration)
  ) {
    throw new Error(
      "Invalid temporary access duration"
    );
  }

  return duration;
}

function assertSameTenant(
  record,
  tenantId
) {
  if (
    Number(record.tenantId) !==
    Number(tenantId)
  ) {
    const error = new Error(
      "Cross-tenant access denied"
    );

    error.statusCode = 403;

    throw error;
  }
}

function assertNotExpired(share) {
  const now = new Date();

  if (
    share.status === "EXPIRED" ||
    new Date(share.expiresAt) <= now
  ) {
    share.status = "EXPIRED";

    const error = new Error(
      "Temporary document access has expired"
    );

    error.statusCode = 410;

    throw error;
  }
}

function assertRecipient(
  share,
  userId
) {
  if (
    Number(share.recipientUserId) !==
    Number(userId)
  ) {
    const error = new Error(
      "You are not authorized to access this temporary document"
    );

    error.statusCode = 403;

    throw error;
  }
}

async function getRequestById(
  req,
  requestId
) {
  const {
    DocumentAccessRequest,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const request =
    await DocumentAccessRequest.findOne({
      where: {
        id: requestId,
        tenantId,
      },
    });

  if (!request) {
    const error = new Error(
      "Document access request not found"
    );

    error.statusCode = 404;

    throw error;
  }

  return request;
}


// ============================================================
// CREATE REQUEST
// ============================================================

// ============================================================
// CREATE REQUEST
// ============================================================

async function createRequest(
  req,
  payload
) {
  const {
    DocumentAccessRequest,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const requesterUserId =
    getCurrentUserId(req);

  const requestedDepartmentId =
    Number(
      payload.requestedDepartmentId
    );

  if (
    !Number.isInteger(
      requestedDepartmentId
    )
  ) {
    throw new Error(
      "requestedDepartmentId is required"
    );
  }

  if (
    !payload.documentReference ||
    !String(
      payload.documentReference
    ).trim()
  ) {
    throw new Error(
      "documentReference is required"
    );
  }

  // ==========================================================
  // IMPORTANT:
  // Never trust requesterDepartmentId from frontend.
  // Resolve it from the authenticated user's assignment.
  // ==========================================================

  const requesterDepartmentId =
    await resolveRequesterDepartmentId(
      req,
      tenantId,
      requesterUserId
    );

  const request =
    await DocumentAccessRequest.create({
      tenantId,

      requesterUserId,

      requesterDepartmentId,

      requestedDepartmentId,

      // requester automatically becomes recipient
      recipientUserId:
        requesterUserId,

      documentReference:
        String(
          payload.documentReference
        ).trim(),

      reason:
        payload.reason
          ? String(
              payload.reason
            ).trim()
          : null,

      sourceDocumentId: null,

      sourceDocumentVersion: null,

      status: "PENDING",
    });

  return request;
}


// ============================================================
// LIST REQUESTS
// ============================================================

// ============================================================
// LIST REQUESTS
// ============================================================

async function listRequests(
  req,
  filters = {}
) {
  const {
    DocumentAccessRequest,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const role =
    req.user?.role;

  const where = {
    tenantId,
  };

  if (filters.status) {
    where.status =
      filters.status;
  }

  // ==========================================================
  // MY REQUESTS
  // ==========================================================

  if (
    filters.scope === "mine"
  ) {
    where.requesterUserId =
      userId;
  }

  // ==========================================================
  // MANAGE REQUESTS
  // ==========================================================

  else if (
    filters.scope === "manage"
  ) {
    const scope =
      await resolveScope(
        getModels(req),
        tenantId,
        userId,
        role
      );

    if (scope !== null) {
      if (
        !scope.departmentIds.length
      ) {
        return [];
      }

      where.requestedDepartmentId = {
        [Op.in]:
          scope.departmentIds,
      };
    }

    // scope === null
    // means SuperAdmin/TenantAdmin
    // and therefore unrestricted.
  }

  // ==========================================================
  // SPECIFIC REQUESTED DEPARTMENT
  // ==========================================================

  else if (
    filters.requestedDepartmentId
  ) {
    where.requestedDepartmentId =
      Number(
        filters.requestedDepartmentId
      );
  }

  // ==========================================================
  // LOAD REQUESTS
  // ==========================================================

  const rows =
    await DocumentAccessRequest.findAll({
      where,

      order: [
        [
          "createdAt",
          "DESC",
        ],
      ],
    });

  if (!rows.length) {
    return rows;
  }

  // ==========================================================
  // LOAD TEMPORARY SHARES
  // ==========================================================

  const {
    CrossDepartmentDocumentShare,
  } = getModels(req);

  const shares =
    await CrossDepartmentDocumentShare.findAll({
      where: {
        tenantId,

        requestId: {
          [Op.in]:
            rows.map(
              (row) => row.id
            ),
        },

        // Only actually SENT shares should appear
        // in Shared With Me.
        sentAt: {
          [Op.ne]: null,
        },
      },

      order: [
        ["sentAt", "DESC"],
      ],
    });

  const latestShareByRequestId =
    new Map();

  for (
    const share of shares
  ) {
    if (
      !latestShareByRequestId.has(
        share.requestId
      )
    ) {
      latestShareByRequestId.set(
        share.requestId,
        share
      );
    }
  }

  // ==========================================================
  // REQUESTER USER IDs
  // ==========================================================

  const requesterUserIds = [
    ...new Set(
      rows
        .map(
          (row) =>
            Number(
              row.requesterUserId
            )
        )
        .filter(
          (id) =>
            Number.isInteger(id) &&
            id > 0
        )
    ),
  ];

  // ==========================================================
  // RESOLVE MISSING REQUESTER DEPARTMENTS
  // ==========================================================
  //
  // IMPORTANT:
  // Old requests may have requesterDepartmentId = NULL.
  // Resolve those from UserAssignment.
  //
  // This fixes OLD requests without requiring a DB migration
  // or manual SQL update.
  // ==========================================================

  const existingRequesterDepartmentByUserId =
    new Map();

  for (
    const row of rows
  ) {
    const requesterId =
      Number(
        row.requesterUserId
      );

    const departmentId =
      Number(
        row.requesterDepartmentId
      );

    if (
      Number.isInteger(
        requesterId
      ) &&
      requesterId > 0 &&
      Number.isInteger(
        departmentId
      ) &&
      departmentId > 0
    ) {
      existingRequesterDepartmentByUserId.set(
        requesterId,
        departmentId
      );
    }
  }

  const requesterDepartmentByUserId =
    new Map();

  for (
    const userIdValue of requesterUserIds
  ) {
    const existingDepartmentId =
      existingRequesterDepartmentByUserId.get(
        userIdValue
      );

    const resolvedDepartmentId =
      await resolveRequesterDepartmentId(
        req,
        tenantId,
        userIdValue,
        existingDepartmentId
      );

    if (
      Number.isInteger(
        Number(
          resolvedDepartmentId
        )
      ) &&
      Number(
        resolvedDepartmentId
      ) > 0
    ) {
      requesterDepartmentByUserId.set(
        userIdValue,
        Number(
          resolvedDepartmentId
        )
      );
    }
  }

  // ==========================================================
  // ALL DEPARTMENT IDS
  // ==========================================================

  const departmentIds = [
    ...new Set(
      [
        ...rows.map(
          (row) =>
            row.requestedDepartmentId
        ),

        ...rows.map(
          (row) =>
            requesterDepartmentByUserId.get(
              Number(
                row.requesterUserId
              )
            )
        ),
      ]
        .map(Number)
        .filter(
          (id) =>
            Number.isInteger(id) &&
            id > 0
        )
    ),
  ];

  // ==========================================================
  // LOAD REQUESTER USERS
  // ==========================================================

  const requesterById =
    new Map();

  const {
    User,
  } = getModels(req);

  if (
    requesterUserIds.length &&
    User
  ) {
    const users =
      await User.findAll({
        where: {
          id: {
            [Op.in]:
              requesterUserIds,
          },
        },

        attributes: [
          "id",
          "name",
          "email",
        ],

        raw: true,
      });

    for (
      const user of users
    ) {
      requesterById.set(
        Number(user.id),
        user
      );
    }
  }

  // ==========================================================
  // LOAD DEPARTMENTS FROM MASTER DB
  // ==========================================================

  const departmentById =
    new Map();

  if (
    departmentIds.length &&
    req.masterModels?.Department
  ) {
    const departments =
      await req.masterModels.Department.findAll({
        where: {
          id: {
            [Op.in]:
              departmentIds,
          },
        },

        attributes: [
          "id",
          "name",
          "code",
        ],

        raw: true,
      });

    for (
      const department of departments
    ) {
      departmentById.set(
        Number(
          department.id
        ),
        department
      );
    }
  }

  // ==========================================================
  // BUILD FINAL RESPONSE
  // ==========================================================

  return rows.map(
    (row) => {
      const plain =
        row.toJSON();

      // ------------------------------------------------------
      // REQUESTER
      // ------------------------------------------------------

      const requester =
        requesterById.get(
          Number(
            plain.requesterUserId
          )
        );

      if (requester) {
        plain.requester =
          requester;

        plain.requesterName =
          requester.name;

        plain.requesterEmail =
          requester.email;
      } else {
        plain.requester =
          null;

        plain.requesterName =
          null;

        plain.requesterEmail =
          null;
      }

      // ------------------------------------------------------
      // REQUESTER DEPARTMENT
      // ------------------------------------------------------

      const resolvedRequesterDepartmentId =
        requesterDepartmentByUserId.get(
          Number(
            plain.requesterUserId
          )
        );

      if (
        Number.isInteger(
          Number(
            resolvedRequesterDepartmentId
          )
        ) &&
        Number(
          resolvedRequesterDepartmentId
        ) > 0
      ) {
        const requesterDepartment =
          departmentById.get(
            Number(
              resolvedRequesterDepartmentId
            )
          );

        plain.requesterDepartmentId =
          Number(
            resolvedRequesterDepartmentId
          );

        plain.requesterDepartment =
          requesterDepartment ||
          null;

        plain.requesterDepartmentName =
          requesterDepartment?.name ||
          null;

        plain.requesterDepartmentCode =
          requesterDepartment?.code ||
          null;
      } else {
        plain.requesterDepartment =
          null;

        plain.requesterDepartmentName =
          null;

        plain.requesterDepartmentCode =
          null;
      }

      // ------------------------------------------------------
      // REQUESTED DEPARTMENT
      // ------------------------------------------------------

      const requestedDepartment =
        departmentById.get(
          Number(
            plain.requestedDepartmentId
          )
        );

      plain.requestedDepartment =
        requestedDepartment ||
        null;

      plain.requestedDepartmentName =
        requestedDepartment?.name ||
        null;

      plain.requestedDepartmentCode =
        requestedDepartment?.code ||
        null;

      // ------------------------------------------------------
      // SHARE DETAILS
      // ------------------------------------------------------

      const share =
        latestShareByRequestId.get(
          row.id
        );

      if (share) {
        plain.shareId =
          share.id;

        plain.shareStatus =
          share.status;

        plain.shareExpiresAt =
          share.expiresAt;
      }

      return plain;
    }
  );
}


// ============================================================
// REQUEST DETAIL
// ============================================================

async function getRequest(
  req,
  requestId
) {
  return getRequestById(
    req,
    requestId
  );
}


// ============================================================
// SEARCH EXISTING DMS DOCUMENTS (for the request's target department)
// ============================================================

async function searchSourceDocuments(
  req,
  payload = {}
) {
  const {
    Document,
    DocumentType,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

    const request =
    await getRequestById(
      req,
      payload.requestId
    );

  await assertDepartmentAccess(req, request.requestedDepartmentId);

  const where = {
    tenantId,
    departmentId: request.requestedDepartmentId,
    status: "ACTIVE",
  };

    if (payload.query) {
    where[Op.or] = [
      { originalFileName: { [Op.like]: `%${payload.query}%` } },
      { sapDocumentId: { [Op.like]: `%${payload.query}%` } },
      { tcode: { [Op.like]: `%${payload.query}%` } },
    ];
  }

  const page = Number(payload.page) || 1;
  const limit = Number(payload.limit) || 20;

  const result = await Document.findAndCountAll({
    where,
    // DocumentType is tenant-side, so a normal include works here.
    include: [{ model: DocumentType, attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });

  const docs = result.rows.map((row) => row.toJSON());

  // Department lives in the MASTER DB — it can't be Sequelize-included
  // across connections, so hydrate it with a separate lookup. Same
  // two-step pattern documentController.js's hydrateDepartments() uses.
  const departmentIds = [
    ...new Set(docs.map((d) => d.departmentId).filter(Boolean)),
  ];

  if (departmentIds.length && req.masterModels?.Department) {
    const departments = await req.masterModels.Department.findAll({
      where: { id: { [Op.in]: departmentIds } },
      attributes: ["id", "name", "code"],
      raw: true,
    });

    const byId = new Map(departments.map((d) => [d.id, d]));

    for (const doc of docs) {
      doc.Department = doc.departmentId
        ? byId.get(doc.departmentId) || null
        : null;
    }
  }

  return {
    data: docs,
    pagination: {
      page,
      limit,
      total: result.count,
      totalPages: Math.ceil(result.count / limit) || 1,
    },
  };
}


// ============================================================
// REJECT REQUEST
// ============================================================

async function rejectRequest(
  req,
  payload = {}
) {
  const {
    DocumentAccessRequest,
  } = getModels(req);

    const request =
    await getRequestById(
      req,
      payload.requestId
    );

  await assertDepartmentAccess(req, request.requestedDepartmentId);

  request.status = "REJECTED";
  request.rejectionReason = payload.reason || null;
  await request.save();

  return request;
}


// ============================================================
// SELECT EXISTING DMS DOCUMENT
// ============================================================

async function selectDocument(
  req,
  requestId,
  payload
) {
  const {
    Document,
    DocumentAccessRequest,
  } = getModels(req);

   const request =
    await getRequestById(
      req,
      requestId
    );

  await assertDepartmentAccess(req, request.requestedDepartmentId);

  if (
    ![
      "PENDING",
      "DOCUMENT_SELECTED",
    ].includes(request.status)
  ) {
    throw new Error(
      "Document cannot be selected for this request"
    );
  }

  const sourceDocumentId =
    Number(
      payload.sourceDocumentId
    );

  if (
    !Number.isInteger(
      sourceDocumentId
    )
  ) {
    throw new Error(
      "sourceDocumentId is required"
    );
  }

  // IMPORTANT:
  // This lookup uses the EXISTING tenant Document model.
  // No new Document is created.
  const document =
    await Document.findOne({
      where: {
        id: sourceDocumentId,
      },
    });

  if (!document) {
    const error = new Error(
      "Source DMS document not found"
    );

    error.statusCode = 404;

    throw error;
  }

  // Department ownership/authorization must be
  // enforced by the route/controller middleware
  // and existing DMS permission architecture.
  //
  // Do NOT allow requester-side selection.

  request.sourceDocumentId =
    sourceDocumentId;

  request.sourceDocumentVersion =
    payload.sourceDocumentVersion ||
    null;

  request.status =
    "DOCUMENT_SELECTED";

  await request.save();

  return request;
}


// ============================================================
// PREPARE TEMPORARY SHARE
// ============================================================

async function prepareShare(
  req,
  requestId,
  payload
) {
  const {
    DocumentAccessRequest,
    CrossDepartmentDocumentShare,
    Document,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const request =
    await getRequestById(
      req,
      requestId
    );

  await assertDepartmentAccess(req, request.requestedDepartmentId);

  if (
    request.status !==
    "DOCUMENT_SELECTED"
  ) {
    throw new Error(
      "A source document must be selected before preparing the share"
    );
  }

  if (
    !request.sourceDocumentId
  ) {
    throw new Error(
      "Source document is missing"
    );
  }

  const durationMinutes =
    validateDuration(
      payload.durationMinutes
    );

  const document =
    await Document.findOne({
      where: {
        id:
          request.sourceDocumentId,
      },
    });

  if (!document) {
    const error = new Error(
      "Source DMS document no longer exists"
    );

    error.statusCode = 404;

    throw error;
  }

  // ── NEW: resolve the actual file bytes of the source document ──
  // so there is something real to mask/view/download later.
  let sourceBuffer;
  let sourceMimeType = document.mimeType;

  if (document.localFilePath && fs.existsSync(document.localFilePath)) {
    sourceBuffer = fs.readFileSync(document.localFilePath);
  } else if (document.tempFilePath && fs.existsSync(document.tempFilePath)) {
    sourceBuffer = fs.readFileSync(document.tempFilePath);
  } else if (document.sapDocumentId) {
    // PAID tenants: no local copy, file lives in SAP — fetch it same
    // way documentController.viewDocument does.
    const ErpFactory = require("./erpFactory");
    const { Tenant, ErpConfig } = req.masterModels;

    const tenantRow = await Tenant.findByPk(tenantId, {
      include: [{ model: ErpConfig }],
    });

    if (!tenantRow || !tenantRow.ErpConfig) {
      const error = new Error(
        "ERP configuration not assigned to tenant — cannot fetch SAP document"
      );
      error.statusCode = 404;
      throw error;
    }

    const erpService = ErpFactory.getService(tenantRow.ErpConfig);
    const file = await erpService.getDocumentBinary(
      tenantRow.ErpConfig,
      document.sapDocumentId
    );

    sourceBuffer = file.buffer;
    sourceMimeType = file.contentType || sourceMimeType;
  } else {
    console.error(
      "[prepareShare] No file source for document",
      {
        documentId: document.id,
        localFilePath: document.localFilePath,
        tempFilePath: document.tempFilePath,
        sapDocumentId: document.sapDocumentId,
      }
    );

    const error = new Error(
      "Source document file is not available for sharing"
    );
    error.statusCode = 404;
    throw error;
  }

  const now =
    new Date();

  const expiresAt =
    new Date(
      now.getTime() +
        durationMinutes * 60 * 1000
    );

  const share =
    await CrossDepartmentDocumentShare.create(
      {
        tenantId,

        requestId:
          request.id,

        recipientUserId:
          request.recipientUserId,

        sourceDocumentId:
          request.sourceDocumentId,

        sourceDocumentVersion:
          request.sourceDocumentVersion,

        maskingRequired:
          Boolean(
            payload.maskingRequired
          ),

        maskingData:
          null,

        status:
          "PREPARED",

        expiresAt,

        grantedAt:
          now,

        sentAt:
          null,

        sentBy:
          null,

        revokedAt:
          null,

        revokedBy:
          null,

        revokeReason:
          null,

        temporaryStorageKey:
          null,

        temporaryFileName:
          null,

        temporaryMimeType:
          null,
      }
    );

  // ── NEW: write the copied bytes to a per-share temp file and
  // save the reference on the share row. This is what viewShare /
  // downloadShare / maskShare will read from — never the original.
  const tempPath = buildTemporaryFilePath(
    share.id,
    document.originalFileName
  );

   fs.writeFileSync(tempPath, sourceBuffer);

  // Pristine backup — maskShare() always masks from THIS, never from
  // temporaryStorageKey, so repeated mask attempts (Back to Edit, retry,
  // etc.) never stack old masks underneath new ones.
  fs.writeFileSync(`${tempPath}.orig`, sourceBuffer);

  share.temporaryStorageKey = tempPath;
  share.temporaryFileName = document.originalFileName;
  share.temporaryMimeType = sourceMimeType;

  await share.save();

  request.status =
    "APPROVED";

  request.grantedBy =
    userId;

  request.grantedAt =
    now;

  await request.save();

  return share;
}


// ============================================================
// SEND WITHOUT MASKING
// ============================================================

async function sendShare(
  req,
  shareId
) {
  const {
    CrossDepartmentDocumentShare,
    DocumentAccessRequest,
    Document,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const share =
    await CrossDepartmentDocumentShare.findOne(
      {
        where: {
          id: shareId,
          tenantId,
        },
      }
    );

    if (!share) {
    const error = new Error(
      "Temporary document share not found"
    );

    error.statusCode = 404;

    throw error;
  }

  await assertShareDepartmentAccess(req, share);

  if (
    share.status !==
    "PREPARED"
  ) {
    throw new Error(
      "Share is not ready to be sent"
    );
  }
  if (
    new Date(share.expiresAt) <=
    new Date()
  ) {
    share.status =
      "EXPIRED";

    await share.save();

    throw new Error(
      "Temporary share has expired"
    );
  }

  const document =
    await Document.findOne({
      where: {
        id:
          share.sourceDocumentId,
      },
    });

  if (!document) {
    const error = new Error(
      "Source document not found"
    );

    error.statusCode = 404;

    throw error;
  }

  // ── NEW: the temp copy must already exist (created in prepareShare,
  // possibly redacted in maskShare). If it's missing, refuse to send.
  if (
    !share.temporaryStorageKey ||
    !fs.existsSync(share.temporaryStorageKey)
  ) {
    const error = new Error(
      "Prepared document file is missing — cannot send"
    );

    error.statusCode = 404;

    throw error;
  }

  const now =
    new Date();

  share.status =
    "ACTIVE";

  share.sentAt =
    now;

  share.sentBy =
    userId;

  await share.save();

  const request =
    await DocumentAccessRequest.findOne({
      where: {
        id:
          share.requestId,
        tenantId,
      },
    });

  if (request) {
    request.status =
      "SHARED";

    await request.save();
  }

  return share;
}


// ============================================================
// VERIFY RECIPIENT ACCESS
// ============================================================

async function getAccessibleShare(
  req,
  shareId
) {
  const {
    CrossDepartmentDocumentShare,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const share =
    await CrossDepartmentDocumentShare.findOne(
      {
        where: {
          id: shareId,
          tenantId,
        },
      }
    );

  if (!share) {
    const error = new Error(
      "Temporary document share not found"
    );

    error.statusCode = 404;

    throw error;
  }

  console.log(
  "[CrossDepartmentShare] ACCESS CHECK",
  {
    shareId,
    shareTenantId: Number(share.tenantId),
    requestTenantId: Number(tenantId),
    shareRecipientUserId: Number(share.recipientUserId),
    currentUserId: Number(userId),
    status: share.status,
    expiresAt: share.expiresAt,
  }
);

assertSameTenant(
  share,
  tenantId
);

assertRecipient(
  share,
  userId
);

  if (
    share.status ===
    "REVOKED"
  ) {
    const error = new Error(
      "Temporary document share has been revoked"
    );

    error.statusCode = 403;

    throw error;
  }

  if (
    new Date(share.expiresAt) <=
    new Date()
  ) {
    share.status =
      "EXPIRED";

    await share.save();

    const error = new Error(
      "Temporary document share has expired"
    );

    error.statusCode = 410;

    throw error;
  }

  if (
    share.status !==
    "ACTIVE"
  ) {
    const error = new Error(
      "Temporary document is not active"
    );

    error.statusCode = 403;

    throw error;
  }

  return share;
}


// ============================================================
// VIEW
// ============================================================

async function viewShare(
  req,
  shareId
) {
  const share =
    await getAccessibleShare(
      req,
      shareId
    );

  // ── NEW: this is the actual fix — read the real file bytes off
  // disk and return {buffer, mimeType, fileName} like the controller
  // expects, instead of returning the bare Sequelize record.
  if (
    !share.temporaryStorageKey ||
    !fs.existsSync(share.temporaryStorageKey)
  ) {
    const error = new Error(
      "Temporary shared document not found"
    );
    error.statusCode = 404;
    throw error;
  }

  const buffer = fs.readFileSync(share.temporaryStorageKey);

  const now =
    new Date();

  share.lastAccessedAt =
    now;

  share.accessedAt =
    share.accessedAt ||
    now;

  await share.save();

  return {
    buffer,
    mimeType: share.temporaryMimeType,
    fileName: share.temporaryFileName,
  };
}



// ============================================================
// OWNER PREVIEW (masked copy, before sending)
//
// viewShare() above is RECIPIENT-only (assertRecipient requires
// share.recipientUserId === the calling user). The owner previewing
// their own masked copy — via PreviewMaskedCopy.jsx, before the share
// has even been sent — is never the recipient, so that check must not
// apply here. This reuses the same department-based authorization
// maskShare() already uses for the owner side.
// ============================================================

async function ownerPreviewShare(req, shareId) {
  const { CrossDepartmentDocumentShare } = getModels(req);
  const tenantId = getTenantId(req);

  const share = await CrossDepartmentDocumentShare.findOne({
    where: { id: shareId, tenantId },
  });

  if (!share) {
    const error = new Error("Temporary document share not found");
    error.statusCode = 404;
    throw error;
  }

  // Same owner/department authorization maskShare() uses — NOT the
  // recipient check.
  await assertShareDepartmentAccess(req, share);

  if (!share.temporaryStorageKey || !fs.existsSync(share.temporaryStorageKey)) {
    const error = new Error("Temporary shared document not found");
    error.statusCode = 404;
    throw error;
  }

  const buffer = fs.readFileSync(share.temporaryStorageKey);

  return {
    buffer,
    mimeType: share.temporaryMimeType,
    fileName: share.temporaryFileName,
  };
}




// ============================================================
// DOWNLOAD
// ============================================================

async function downloadShare(req, shareId) {
  const error = new Error(
    "Download is not permitted for temporarily shared documents."
  );

  error.statusCode = 403;

  throw error;
}


// ============================================================
// MASK
// ============================================================

async function maskShare(
  req,
  shareId,
  maskingData
) {
  // ── NEW: controller calls this with { masks: [...] } (see
  // crossDepartmentDocumentController.js maskShare), not a bare array.
  // Support both shapes so "maskingData is not iterable" can't happen.
  const masks = Array.isArray(maskingData)
    ? maskingData
    : maskingData?.masks || maskingData?.maskData || maskingData?.annotations || [];

  if (!Array.isArray(masks) || masks.length === 0) {
    throw new Error("Mask data is required");
  }

  const {
    CrossDepartmentDocumentShare,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const share =
    await CrossDepartmentDocumentShare.findOne(
      {
        where: {
          id: shareId,
          tenantId,
        },
      }
    );

    if (!share) {
    const error = new Error(
      "Temporary document share not found"
    );

    error.statusCode = 404;

    throw error;
  }

  await assertShareDepartmentAccess(req, share);

  if (
    share.status !==
    "PREPARED"
  ) {
    throw new Error(
      "Only a prepared share can be masked"
    );
  }

  if (
    !share.maskingRequired
  ) {
    throw new Error(
      "Masking was not requested for this share"
    );
  }

  /*
   * maskingData is stored ONLY against the temporary share.
   * It is never written to Document.
   */

  // ── NEW: actually redact the temp copy, not just save coordinates ──
  if (
    !share.temporaryStorageKey ||
    !fs.existsSync(share.temporaryStorageKey)
  ) {
    throw new Error(
      "Temporary document file missing — cannot mask"
    );
  }

  // ── NEW: normalize + validate every mask before drawing.
  // The actual frontend (MaskDocumentEditor) sends FREEHAND STROKES:
  //   { page, type: "freehand", color, strokeWidth, points: [{x,y}, ...] }
  // where x/y are NORMALIZED fractions (0–1) of the page's width/height,
  // not pixel rectangles. We still accept a plain rectangle shape
  // ({x,y,width,height}) too, in case another caller uses that format.
  //
  // Reference width used to convert the UI's raw pixel `strokeWidth`
  // into a fraction of the page — the mask editor's canvas isn't a
  // fixed size we can otherwise infer. If the frontend can be updated
  // to also send canvasWidth/canvasHeight alongside points, prefer
  // that (see fallback below) for pixel-perfect thickness.
  const DEFAULT_REFERENCE_WIDTH = 800;

  const normalizedMasks = masks.map((m, idx) => {
    const page = Number(m.page ?? 1);
    const isFreehand =
      m.type === "freehand" || Array.isArray(m.points);

    if (isFreehand) {
      const points = Array.isArray(m.points) ? m.points : [];

      if (points.length < 2) {
        const error = new Error(
          `Invalid freehand mask at index ${idx}: ` +
            `at least 2 points are required`
        );
        error.statusCode = 400;
        throw error;
      }

      const normPoints = points.map((p, pIdx) => {
        const x = Number(p.x);
        const y = Number(p.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const error = new Error(
            `Invalid point ${pIdx} in mask at index ${idx}: ` +
              `received ${JSON.stringify(p)} — expected numeric x, y`
          );
          error.statusCode = 400;
          throw error;
        }

        return { x, y };
      });

      const referenceWidth =
        Number(m.canvasWidth) > 0
          ? Number(m.canvasWidth)
          : DEFAULT_REFERENCE_WIDTH;

      const rawStrokeWidth = Number(m.strokeWidth);
      const strokeWidthFraction =
        (Number.isFinite(rawStrokeWidth) && rawStrokeWidth > 0
          ? rawStrokeWidth
          : 12) / referenceWidth;

      return {
        page,
        type: "freehand",
        points: normPoints,
        strokeWidthFraction,
      };
    }

    // ── Rectangle-style mask (legacy / alternate caller) ──
    let x = m.x ?? m.left ?? m.x1;
    let y = m.y ?? m.top ?? m.y1;
    let width = m.width ?? m.w;
    let height = m.height ?? m.h;

    // Support x2/y2 (bottom-right corner) instead of width/height
    if (width == null && m.x2 != null && x != null) {
      width = Number(m.x2) - Number(x);
    }
    if (height == null && m.y2 != null && y != null) {
      height = Number(m.y2) - Number(y);
    }

    x = Number(x);
    y = Number(y);
    width = Number(width);
    height = Number(height);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      const error = new Error(
        `Invalid mask coordinates at index ${idx}: ` +
          `received ${JSON.stringify(m)} — expected numeric x, y, width, height`
      );
      error.statusCode = 400;
      throw error;
    }

    return { page, type: "rect", x, y, width, height };
  });

    // Always mask from the pristine original, never from a previously
  // masked file — otherwise repeated mask attempts stack old strokes
  // underneath new ones. Older shares created before this fix have no
  // ".orig" backup, so fall back to the current file for those.
  const originalPath = `${share.temporaryStorageKey}.orig`;
  const fileBuffer = fs.existsSync(originalPath)
    ? fs.readFileSync(originalPath)
    : fs.readFileSync(share.temporaryStorageKey);

  if (share.temporaryMimeType === "application/pdf") {
    const { PDFDocument, rgb } = require("pdf-lib");
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();

    for (const m of normalizedMasks) {
      const page = pages[m.page - 1];
      if (!page) continue;
      const { width: pageWidth, height: pageHeight } = page.getSize();

      if (m.type === "freehand") {
        const thickness = m.strokeWidthFraction * pageWidth;
        const radius = thickness / 2;

        // Convert each normalized point (top-left origin, y-down) to
        // PDF point-space (bottom-left origin, y-up).
        const pdfPoints = m.points.map((p) => ({
          x: p.x * pageWidth,
          y: pageHeight - p.y * pageHeight,
        }));

        // Draw connected thick line segments, plus a filled circle at
        // every vertex so joints/endpoints don't leave gaps.
        for (let i = 0; i < pdfPoints.length; i++) {
          page.drawCircle({
            x: pdfPoints[i].x,
            y: pdfPoints[i].y,
            size: radius,
            color: rgb(0, 0, 0),
          });

          if (i > 0) {
            page.drawLine({
              start: pdfPoints[i - 1],
              end: pdfPoints[i],
              thickness,
              color: rgb(0, 0, 0),
            });
          }
        }
           } else {
        const rectX = m.x * pageWidth;
        const rectWidth = m.width * pageWidth;
        const rectHeight = m.height * pageHeight;
        const rectY = pageHeight - (m.y * pageHeight) - rectHeight;

        page.drawRectangle({
          x: rectX,
          y: rectY, // PDF origin is bottom-left
          width: rectWidth,
          height: rectHeight,
          color: rgb(0, 0, 0),
        });
      }
    }

    fs.writeFileSync(share.temporaryStorageKey, await pdfDoc.save());
  } else if (
    share.temporaryMimeType &&
    share.temporaryMimeType.startsWith("image/")
  ) {
    const { createCanvas, loadImage } = require("canvas");
    const image = await loadImage(fileBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#000000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const m of normalizedMasks) {
      if (m.type === "freehand") {
        ctx.lineWidth = m.strokeWidthFraction * image.width;
        ctx.beginPath();
        m.points.forEach((p, i) => {
          const px = p.x * image.width;
          const py = p.y * image.height;
          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });
        ctx.stroke();
           } else {
        ctx.fillRect(
          m.x * image.width,
          m.y * image.height,
          m.width * image.width,
          m.height * image.height
        );
      }
    }

    const format =
      share.temporaryMimeType === "image/jpeg"
        ? "image/jpeg"
        : "image/png";
    fs.writeFileSync(share.temporaryStorageKey, canvas.toBuffer(format));
  } else {
    throw new Error(
      "Masking is not supported for this file type"
    );
  }

  share.maskingData =
    normalizedMasks || null;

  share.maskedBy =
    userId;

  share.maskedAt =
    new Date();

  await share.save();

  return share;
}


// ============================================================
// REVOKE
// ============================================================

async function revokeShare(
  req,
  shareId,
  reason
) {
  const {
    CrossDepartmentDocumentShare,
    DocumentAccessRequest,
  } = getModels(req);

  const tenantId =
    getTenantId(req);

  const userId =
    getCurrentUserId(req);

  const share =
    await CrossDepartmentDocumentShare.findOne(
      {
        where: {
          id: shareId,
          tenantId,
        },
      }
    );

   if (!share) {
    const error = new Error(
      "Temporary document share not found"
    );

    error.statusCode = 404;

    throw error;
  }

  await assertShareDepartmentAccess(req, share);

  if (
    [
      "REVOKED",
      "EXPIRED",
    ].includes(
      share.status
    )
  ) {
    return share;
  }
  share.status =
    "REVOKED";

  share.revokedAt =
    new Date();

  share.revokedBy =
    userId;

  share.revokeReason =
    reason
      ? String(reason)
      : null;

  await share.save();

  const request =
    await DocumentAccessRequest.findOne({
      where: {
        id:
          share.requestId,
        tenantId,
      },
    });

  if (request) {
    request.status =
      "REVOKED";

    await request.save();
  }

  return share;
}


// ============================================================
// EXPIRE SHARE
// ============================================================

async function expireShare(
  req,
  share
) {
  const {
    CrossDepartmentDocumentShare,
    DocumentAccessRequest,
  } = getModels(req);
 

  if (
    !share ||
    share.status ===
      "REVOKED"
  ) {
    return share;
  }

  share.status =
    "EXPIRED";

  await share.save();

  const request =
    await DocumentAccessRequest.findOne({
      where: {
        id:
          share.requestId,
        tenantId:
          share.tenantId,
      },
    });

  if (request) {
    request.status =
      "EXPIRED";

    await request.save();
  }

  return share;
}


// ============================================================
// CLEANUP TEMPORARY FILE
// ============================================================

async function cleanupShareFile(
  share
) {
  if (
    !share ||
    !share.temporaryStorageKey
  ) {
    return;
  }

  try {
    if (
      fs.existsSync(
        share.temporaryStorageKey
      )
    ) {
      await fs.promises.unlink(
        share.temporaryStorageKey
      );
    }

    const originalPath = `${share.temporaryStorageKey}.orig`;
    if (fs.existsSync(originalPath)) {
      await fs.promises.unlink(originalPath);
    }
  } catch (error) {
    // Cleanup must not crash the request lifecycle.
    console.error(
      "[CrossDepartmentShare] cleanup failed:",
      error.message
    );
  }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  createRequest,
  listRequests,
  getRequest,
  searchSourceDocuments,
  rejectRequest,
  selectDocument,
  prepareShare,
  sendShare,
  getAccessibleShare,
  viewShare,
  ownerPreviewShare,
  // downloadShare,
  maskShare,
  revokeShare,
  expireShare,
    assertDepartmentAccess,
  cleanupShareFile,
};