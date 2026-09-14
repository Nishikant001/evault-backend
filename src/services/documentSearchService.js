// src/services/documentSearchService.js
//
// UNIVERSAL DOCUMENT SEARCH — dedicated service (kept separate from
// vectorSearchService.js on purpose, see documentAIController.js's
// metadataSearch/ocrKeywordSearch, which stay untouched and available as
// they were).
//
// This is the "plain keyword" search the frontend's global search bar
// calls: it is NOT AI/LLM based, is fully DB-side (no
// `Document.findAll()` + JS substring loop over the whole tenant), and
// searches everywhere the brief asked for in one pass:
//   - documents columns (originalFileName, sapDocumentId, sapPhioId,
//     tcode, sourceType, sapSyncStatus, sapRaw*Code, uploadStatus)
//   - documents.metadata / documents.ocrMetadata (JSON, incl. extractedText)
//   - document_metadata.rawOcrJson / mappedMetadataJson (JSON, dynamic —
//     no field name is ever hardcoded)
//   - Category.name / DocumentType.name
//   - Department.name / Department.code (master DB — matched departmentIds
//     are folded into the same WHERE as a plain IN (...) list)
//
// SECURITY: tenantId is only ever taken from the caller-provided
// `tenantId` argument, which every call site in documentController.js
// sources from req.user.tenantId (never from the query string). The
// Dynamic User Assignment Engine's resolveScope() is re-used exactly as
// listDocuments() uses it, so a restricted user gets the same
// documentTypeId narrowing here as everywhere else — the search can
// never surface a document listDocuments() wouldn't already show them.
//
// PERFORMANCE: filtering + pagination happen in MySQL (LIMIT/OFFSET,
// indexed columns in the WHERE, CAST(...AS CHAR) LIKE only reached for
// rows MySQL is already scanning). The only work done in Node is turning
// the current PAGE (≤ maxLimit rows) into matchedFields/snippet for
// display — never the whole tenant's document set.

const { QueryTypes, Op } = require("sequelize");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EXCLUDED_UPLOAD_STATUSES = ["FAILED", "REJECTED"];

// ── helpers ──────────────────────────────────────────────────────

/** Collapse internal whitespace, trim. Never mutates stored values —
 * normalization is for MATCHING only (brief section 7). */
function normalizeQuery(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Escape LIKE wildcards in user input so `%`/`_` typed by a user are
 * treated as literal characters, not SQL wildcards. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Recursively walk any JSON value (object/array/primitive) and collect
 * every "path -> stringValue" pair that contains `needle` (case
 * insensitive). Dynamic on purpose — never assumes a fixed field name,
 * per brief section 6. */
function collectJsonMatches(value, needle, pathPrefix, out, maxHits = 5) {
  if (out.length >= maxHits || value === null || value === undefined) return;
  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      collectJsonMatches(
        val,
        needle,
        pathPrefix ? `${pathPrefix}.${key}` : key,
        out,
        maxHits,
      );
      if (out.length >= maxHits) return;
    }
    return;
  }
  const strVal = String(value);
  if (strVal.toLowerCase().includes(needle)) {
    out.push({ field: pathPrefix || "value", value: strVal });
  }
}

/** Builds a short highlighted-in-place snippet around the first match. */
function buildSnippet(text, needle, radius = 90) {
  if (!text) return null;
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Departments matching the query, restricted to departments this
 * TENANT actually uses (via its own Category rows) — Department itself
 * is master/global data with no tenantId column, so we never trust a
 * raw Department search across the whole platform. */
async function resolveMatchingDepartmentIds({
  models,
  masterModels,
  tenantId,
  needle,
}) {
  if (!needle) return [];
  const categories = await models.Category.findAll({
    where: { tenantId },
    attributes: ["departmentId"],
    group: ["departmentId"],
    raw: true,
  });
  const tenantDeptIds = [
    ...new Set(categories.map((c) => c.departmentId).filter(Boolean)),
  ];
  if (!tenantDeptIds.length) return [];

  const departments = await masterModels.Department.findAll({
    where: {
      id: { [Op.in]: tenantDeptIds },
      [Op.or]: [
        { name: { [Op.like]: `%${needle}%` } },
        { code: { [Op.like]: `%${needle}%` } },
      ],
    },
    attributes: ["id", "name", "code"],
    raw: true,
  });
  return departments;
}

// ── main entry point ────────────────────────────────────────────

/**
 * @param {object} params
 * @param {object} params.models        req.models (tenant-scoped Sequelize models)
 * @param {object} params.masterModels  req.masterModels
 * @param {number} params.tenantId      req.user.tenantId (NEVER from the client)
 * @param {number} params.userId        req.user.id
 * @param {string} params.role          req.user.role
 * @param {string} params.query         raw `q` query param
 * @param {object} [params.filters]     { departmentId, categoryId, documentTypeId, uploadStatus, sourceType, dateFrom, dateTo }
 * @param {number} [params.page]
 * @param {number} [params.limit]
 */
async function searchDocuments({
  models,
  masterModels,
  tenantId,
  userId,
  role,
  query,
  filters = {},
  page = 1,
  limit = DEFAULT_LIMIT,
}) {
  const userAssignmentService = require("./userAssignmentService");
  const sequelize = models.Document.sequelize;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT),
  );
  const offset = (safePage - 1) * safeLimit;

  const normalizedQuery = normalizeQuery(query);
  const hasQuery = normalizedQuery.length > 0;
  const needle = normalizedQuery.toLowerCase();

  // ── Dynamic User Assignment Engine — identical scoping rule to
  // listDocuments() in documentController.js. A restricted user with no
  // allowed document types gets an empty page immediately, no query run. ──
  const scope = await userAssignmentService.resolveScope(
    models,
    tenantId,
    userId,
    role,
  );
  if (scope && !scope.documentTypeIds.length) {
    return {
      data: [],
      pagination: { page: safePage, limit: safeLimit, total: 0, totalPages: 0 },
    };
  }

  // ── Dynamic filters (section 14) — all parameterized, all tenant-scoped ──
  const whereClauses = [
    "d.tenantId = :tenantId",
    "d.status = 'ACTIVE'",
    "d.uploadStatus NOT IN (:excludedStatuses)",
  ];
  const replacements = {
    tenantId,
    excludedStatuses: EXCLUDED_UPLOAD_STATUSES,
    limit: safeLimit,
    offset,
  };

  if (scope) {
    if (
      filters.documentTypeId &&
      !scope.documentTypeIds.includes(Number(filters.documentTypeId))
    ) {
      const err = new Error("You do not have access to this document type");
      err.statusCode = 403;
      throw err;
    }
    whereClauses.push("d.documentTypeId IN (:scopeDocumentTypeIds)");
    replacements.scopeDocumentTypeIds = scope.documentTypeIds;
  }

  if (filters.departmentId) {
    whereClauses.push("d.departmentId = :fDepartmentId");
    replacements.fDepartmentId = filters.departmentId;
  }
  if (filters.categoryId) {
    whereClauses.push("d.categoryId = :fCategoryId");
    replacements.fCategoryId = filters.categoryId;
  }
  if (filters.documentTypeId) {
    whereClauses.push("d.documentTypeId = :fDocumentTypeId");
    replacements.fDocumentTypeId = filters.documentTypeId;
  }
  if (filters.uploadStatus) {
    whereClauses.push("d.uploadStatus = :fUploadStatus");
    replacements.fUploadStatus = filters.uploadStatus;
  }
  if (filters.sourceType) {
    whereClauses.push("d.sourceType = :fSourceType");
    replacements.fSourceType = filters.sourceType;
  }
  if (filters.dateFrom) {
    whereClauses.push("d.createdAt >= :fDateFrom");
    replacements.fDateFrom = filters.dateFrom;
  }
  if (filters.dateTo) {
    whereClauses.push("d.createdAt <= :fDateTo");
    replacements.fDateTo = filters.dateTo;
  }

  // ── The actual universal search predicate (sections 5 & 6) ──
  let matchingDeptIds = [];
  if (hasQuery) {
    const likePattern = `%${escapeLike(normalizedQuery)}%`;
    replacements.likePattern = likePattern;

    matchingDeptIds = await resolveMatchingDepartmentIds({
      models,
      masterModels,
      tenantId,
      needle,
    });
    const deptIds = matchingDeptIds.map((d) => d.id);

    const searchOr = [
      "d.originalFileName LIKE :likePattern ESCAPE '\\\\'",
      "d.sapDocumentId LIKE :likePattern ESCAPE '\\\\'",
      "d.sapPhioId LIKE :likePattern ESCAPE '\\\\'",
      "d.tcode LIKE :likePattern ESCAPE '\\\\'",
      "d.sourceType LIKE :likePattern ESCAPE '\\\\'",
      "d.sapSyncStatus LIKE :likePattern ESCAPE '\\\\'",
      "d.sapRawDepartmentCode LIKE :likePattern ESCAPE '\\\\'",
      "d.sapRawCategoryCode LIKE :likePattern ESCAPE '\\\\'",
      "d.sapRawDocumentTypeCode LIKE :likePattern ESCAPE '\\\\'",
      "d.uploadStatus LIKE :likePattern ESCAPE '\\\\'",
      "CAST(d.metadata AS CHAR) LIKE :likePattern ESCAPE '\\\\'",
      "CAST(d.ocrMetadata AS CHAR) LIKE :likePattern ESCAPE '\\\\'",
      "CAST(dm.rawOcrJson AS CHAR) LIKE :likePattern ESCAPE '\\\\'",
      "CAST(dm.mappedMetadataJson AS CHAR) LIKE :likePattern ESCAPE '\\\\'",
      "c.name LIKE :likePattern ESCAPE '\\\\'",
      "dt.name LIKE :likePattern ESCAPE '\\\\'",
    ];
    if (deptIds.length) {
      searchOr.push("d.departmentId IN (:matchingDeptIds)");
      replacements.matchingDeptIds = deptIds;
    }
    whereClauses.push(`(${searchOr.join(" OR ")})`);
  }

  const whereSql = whereClauses.join(" AND ");

  // ── Deterministic ranking (section 12). Kept as a single SQL CASE
  // expression so ordering happens in MySQL, not after loading rows. ──
  const orderBySql = hasQuery
    ? `
      ORDER BY (CASE
        WHEN d.sapDocumentId = :normalizedQuery OR d.tcode = :normalizedQuery OR CAST(d.id AS CHAR) = :normalizedQuery THEN 1
        WHEN CAST(dm.mappedMetadataJson AS CHAR) LIKE :exactJsonPattern OR CAST(dm.rawOcrJson AS CHAR) LIKE :exactJsonPattern THEN 2
        WHEN d.originalFileName = :normalizedQuery THEN 3
        WHEN CAST(dm.mappedMetadataJson AS CHAR) LIKE :likePattern OR CAST(dm.rawOcrJson AS CHAR) LIKE :likePattern THEN 4
        WHEN CAST(d.ocrMetadata AS CHAR) LIKE :likePattern THEN 5
        WHEN d.originalFileName LIKE :likePattern ESCAPE '\\\\' THEN 6
        ELSE 7
      END) ASC, d.updatedAt DESC
    `
    : "ORDER BY d.updatedAt DESC";

  if (hasQuery) {
    replacements.normalizedQuery = normalizedQuery;
    // Looks-like-an-exact-JSON-string-value heuristic: "value" appearing
    // quote-delimited inside the JSON blob (covers the common case of a
    // dynamic metadata field whose value equals the search term exactly).
    replacements.exactJsonPattern = `%"${escapeLike(normalizedQuery)}"%`;
  }

  const baseFrom = `
    FROM documents d
    LEFT JOIN document_metadata dm ON dm.documentId = d.id
    LEFT JOIN categories c ON c.id = d.categoryId
    LEFT JOIN document_types dt ON dt.id = d.documentTypeId
  `;

  const countRows = await sequelize.query(
    `SELECT COUNT(DISTINCT d.id) AS total ${baseFrom} WHERE ${whereSql}`,
    { replacements, type: QueryTypes.SELECT },
  );
  const total = Number(countRows[0]?.total || 0);

  if (!total) {
    return {
      data: [],
      pagination: { page: safePage, limit: safeLimit, total: 0, totalPages: 0 },
    };
  }

  const rows = await sequelize.query(
    `
      SELECT
        d.id, d.originalFileName, d.mimeType, d.uploadStatus, d.status,
        d.sourceType, d.sapDocumentId, d.sapPhioId, d.tcode,
        d.sapSyncStatus, d.sapRawDepartmentCode, d.sapRawCategoryCode,
        d.sapRawDocumentTypeCode, d.metadata, d.ocrMetadata,
        d.departmentId, d.categoryId, d.documentTypeId,
        d.createdAt, d.updatedAt,
        c.id AS categoryPk, c.name AS categoryName,
        dt.id AS documentTypePk, dt.name AS documentTypeName,
        dm.rawOcrJson, dm.mappedMetadataJson
      ${baseFrom}
      WHERE ${whereSql}
      ${orderBySql}
      LIMIT :limit OFFSET :offset
    `,
    { replacements, type: QueryTypes.SELECT },
  );

  // ── Hydrate Department names (master DB — cross-database, same
  // two-step pattern documentController.hydrateDepartments() already uses). ──
  const deptIds = [...new Set(rows.map((r) => r.departmentId).filter(Boolean))];
  let deptById = new Map();
  if (deptIds.length) {
    const departments = await masterModels.Department.findAll({
      where: { id: { [Op.in]: deptIds } },
      attributes: ["id", "name", "code"],
      raw: true,
    });
    deptById = new Map(departments.map((d) => [d.id, d]));
  }

  // ── Per-row matched-field / snippet detection (page-sized only). ──
  const data = rows.map((row) => {
    const matchedFields = [];
    let snippet = null;

    if (hasQuery) {
      const checkField = (source, field, rawValue) => {
        if (rawValue === null || rawValue === undefined) return;
        const strVal = String(rawValue);
        if (strVal.toLowerCase().includes(needle)) {
          matchedFields.push({ source, field, value: strVal });
        }
      };

      checkField("Document", "originalFileName", row.originalFileName);
      checkField("Document", "sapDocumentId", row.sapDocumentId);
      checkField("Document", "sapPhioId", row.sapPhioId);
      checkField("Document", "tcode", row.tcode);
      checkField("Document", "sapRawDepartmentCode", row.sapRawDepartmentCode);
      checkField("Document", "sapRawCategoryCode", row.sapRawCategoryCode);
      checkField(
        "Document",
        "sapRawDocumentTypeCode",
        row.sapRawDocumentTypeCode,
      );

      // OCR text — check BOTH known locations (brief section 5D): the
      // legacy Document.ocrMetadata.extractedText AND the newer
      // DocumentMetadata.rawOcrJson.extractedText.
      const ocrText =
        (row.ocrMetadata && row.ocrMetadata.extractedText) ||
        (row.rawOcrJson && row.rawOcrJson.extractedText) ||
        null;
      if (ocrText && ocrText.toLowerCase().includes(needle)) {
        matchedFields.push({
          source: "OCR",
          field: "extractedText",
          value: ocrText,
        });
        snippet = buildSnippet(ocrText, needle);
      }

      // Dynamic metadata — walk every nested key, no hardcoded field names.
      if (row.mappedMetadataJson) {
        const hits = [];
        collectJsonMatches(row.mappedMetadataJson, needle, "", hits);
        hits.forEach((h) =>
          matchedFields.push({
            source: "metadata",
            field: h.field,
            value: h.value,
          }),
        );
      }
      if (row.metadata) {
        const hits = [];
        collectJsonMatches(row.metadata, needle, "", hits);
        hits.forEach((h) =>
          matchedFields.push({
            source: "metadata",
            field: h.field,
            value: h.value,
          }),
        );
      }
      // rawOcrJson beyond extractedText (other OCR key/value pairs some
      // documents carry alongside the raw text).
      if (row.rawOcrJson) {
        const { extractedText, ...restOcr } = row.rawOcrJson;
        const hits = [];
        collectJsonMatches(restOcr, needle, "", hits);
        hits.forEach((h) =>
          matchedFields.push({ source: "OCR", field: h.field, value: h.value }),
        );
      }

      if (row.categoryName && row.categoryName.toLowerCase().includes(needle)) {
        matchedFields.push({
          source: "category",
          field: "name",
          value: row.categoryName,
        });
      }
      if (
        row.documentTypeName &&
        row.documentTypeName.toLowerCase().includes(needle)
      ) {
        matchedFields.push({
          source: "documentType",
          field: "name",
          value: row.documentTypeName,
        });
      }
      const dept = deptById.get(row.departmentId);
      if (
        dept &&
        (dept.name?.toLowerCase().includes(needle) ||
          dept.code?.toLowerCase().includes(needle))
      ) {
        matchedFields.push({
          source: "department",
          field: "name",
          value: dept.name,
        });
      }

      if (!snippet && matchedFields.length) {
        snippet =
          matchedFields[0].value?.length > 200
            ? `${matchedFields[0].value.slice(0, 200)}…`
            : matchedFields[0].value;
      }
    }

    return {
      id: row.id,
      documentId: row.id,
      originalFileName: row.originalFileName,
      mimeType: row.mimeType,
      uploadStatus: row.uploadStatus,
      sourceType: row.sourceType,
      sapDocumentId: row.sapDocumentId,
      tcode: row.tcode,
      documentType: row.documentTypePk
        ? { id: row.documentTypePk, name: row.documentTypeName }
        : null,
      category: row.categoryPk
        ? { id: row.categoryPk, name: row.categoryName }
        : null,
      department: deptById.get(row.departmentId) || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      matchedFields: matchedFields.slice(0, 8), // cap payload size per doc
      snippet,
      // Existing routes — frontend reuses the existing viewer, no new one.
      viewUrl: `/documents/${row.id}/view`,
      downloadUrl: `/documents/${row.id}/download`,
    };
  });

  return {
    data,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
}
// ── Advanced search (matches Documentsearchmodal.jsx contract) ──
async function advancedSearch({
  models,
  masterModels,
  tenantId,
  userId,
  role,
  filters = {},
  page = 1,
  limit = 20,
}) {
  const userAssignmentService = require("./userAssignmentService");
  const { Document, Category, DocumentType } = models;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const where = { tenantId, status: "ACTIVE" };

  const scope = await userAssignmentService.resolveScope(
    models,
    tenantId,
    userId,
    role,
  );
  if (scope) {
    if (!scope.documentTypeIds.length) {
      return { data: [], total: 0, page: safePage, totalPages: 0 };
    }
    where.documentTypeId = filters.documentTypeId
      ? filters.documentTypeId
      : { [Op.in]: scope.documentTypeIds };
  }

  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.documentTypeId) where.documentTypeId = filters.documentTypeId;
  if (filters.uploadStatus) where.uploadStatus = filters.uploadStatus;
  if (filters.tcode) where.tcode = { [Op.like]: `%${filters.tcode}%` };

  if (filters.fromDate || filters.toDate) {
    where.createdAt = {};
    if (filters.fromDate) where.createdAt[Op.gte] = new Date(filters.fromDate);
    if (filters.toDate)
      where.createdAt[Op.lte] = new Date(`${filters.toDate}T23:59:59.999Z`);
  }

const andConditions = [];

if (filters.q) {
  const q = `%${filters.q}%`;

  andConditions.push({
    [Op.or]: [
      { originalFileName: { [Op.like]: q } },
      { tcode: { [Op.like]: q } },
      { sapDocumentId: { [Op.like]: q } },

      require("sequelize").where(
        require("sequelize").literal(
          "CAST(`Document`.`metadata` AS CHAR)"
        ),
        { [Op.like]: q }
      ),

      require("sequelize").where(
        require("sequelize").literal(
          "CAST(`Document`.`ocrMetadata` AS CHAR)"
        ),
        { [Op.like]: q }
      ),
    ],
  });
}

if (filters.poNumber) {
  const p = `%${filters.poNumber}%`;

  andConditions.push({
    [Op.or]: [
      require("sequelize").where(
        require("sequelize").literal(
          "CAST(`Document`.`metadata` AS CHAR)"
        ),
        { [Op.like]: p }
      ),

      require("sequelize").where(
        require("sequelize").literal(
          "CAST(`Document`.`ocrMetadata` AS CHAR)"
        ),
        { [Op.like]: p }
      ),
    ],
  });
}

if (andConditions.length) {
  where[Op.and] = andConditions;
}

  const { count, rows } = await Document.findAndCountAll({
    where,
    include: [
      { model: Category, attributes: ["id", "name"] },
      { model: DocumentType, attributes: ["id", "name"] },
    ],
    order: [["updatedAt", "DESC"]],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  });

  const docs = rows.map((r) => r.toJSON());

  // Hydrate Department (master DB) — same pattern as documentController.hydrateDepartments
  const deptIds = [...new Set(docs.map((d) => d.departmentId).filter(Boolean))];
  if (deptIds.length) {
    const departments = await masterModels.Department.findAll({
      where: { id: { [Op.in]: deptIds } },
      attributes: ["id", "name", "code"],
      raw: true,
    });
    const byId = new Map(departments.map((d) => [d.id, d]));
    docs.forEach((d) => {
      d.Department = d.departmentId ? byId.get(d.departmentId) || null : null;
    });
  }

  return {
    data: docs,
    total: count,
    page: safePage,
    totalPages: Math.ceil(count / safeLimit),
  };
}

module.exports = { searchDocuments, advancedSearch };
