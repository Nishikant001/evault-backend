// src/services/sapService.js
const axios = require("axios");
const ErpService = require("./erpService");
const {
  resolveFunctionName,
  resolveUploadResponseFields,
} = require("./sapEntityResolver");
class SapService {
  static _client(erpConfig, extraHeaders = {}, timeoutOverride = null) {
    return ErpService.createClient(erpConfig, extraHeaders);
  }

  // STEP 1 — Fetch CSRF token + session cookies
  static async fetchCsrfToken(erpConfig) {
    const client = erpConfig.sapClient || "100";

    const response = await this._client(erpConfig, {
      "x-csrf-token": "Fetch",
    }).get(`/?sap-client=${client}`);

    const csrfToken = response.headers["x-csrf-token"];
    const rawCookies = response.headers["set-cookie"];

    const cookieString = Array.isArray(rawCookies)
      ? rawCookies.map((c) => c.split(";")[0]).join("; ")
      : rawCookies;

    console.log("CSRF   :", csrfToken);
    console.log("COOKIE :", cookieString);

    return { csrfToken, cookieString };
  }

  // STEP 2 — Generate upload URL
// STEP 2 — Generate upload URL
// STEP 2 — Generate upload URL
static async generateUploadUrlViaBatch(
  erpConfig,
  csrfToken,
  cookieString,
  fileName,
  description,
  fileBuffer,
  docMeta = {}
) {
  const client = erpConfig.sapClient || "100";
  const base64Content = fileBuffer.toString("base64");

  const boundary = "batch_" + Date.now();
  const changesetBoundary = "changeset_" + Date.now();

  // Dynamic per-tenant: which FunctionImport actually generates the
  // upload URL on THIS tenant's SAP Gateway (default: "GenerateUploadUrl",
  // matching the current Golyan behavior — see sapEntityResolver.js).
  const uploadFunctionName = resolveFunctionName(erpConfig, "upload");

           const innerUrl =
    `${uploadFunctionName}?DocType='${encodeURIComponent(docMeta.docTypeCode || "")}'` +
    `&DocumentType='PDF'` +
    `&Category='${encodeURIComponent(docMeta.categoryCode || "")}'` +
    `&Department='${encodeURIComponent(docMeta.departmentCode || "")}'` +
    `&Description='${encodeURIComponent(description)}'` +
    `&Filename='${encodeURIComponent(fileName)}'` +
    `&Content='${base64Content}'` +
    `&sap-client=${client}`;

  const body =
    `--${boundary}\r\n` +
    `Content-Type: multipart/mixed; boundary=${changesetBoundary}\r\n\r\n` +
    `--${changesetBoundary}\r\n` +
    `Content-Type: application/http\r\n` +
    `Content-Transfer-Encoding: binary\r\n\r\n` +
    `POST ${innerUrl} HTTP/1.1\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `\r\n` +
    `--${changesetBoundary}--\r\n` +
    `--${boundary}--`;

  const response = await this._client(erpConfig, {
    "Content-Type": `multipart/mixed; boundary=${boundary}`,
    "x-csrf-token": csrfToken,
    Cookie: cookieString,
  }).post(`/$batch?sap-client=${client}`, body);

  console.log("BATCH RESPONSE:", response.data);

  const raw = response.data.toString();

  // XML se values nikalne ke liye helper
  const extractTag = (xml, tag) => {
    const match = xml.match(new RegExp(`<d:${tag}[^>]*>([^<]*)</d:${tag}>`));
    return match ? match[1].trim() : null;
  };

  const responseFields = resolveUploadResponseFields(erpConfig);
  const documentId = extractTag(raw, responseFields.documentId);
  const uploadUrl  = extractTag(raw, responseFields.uploadUrl);
  const phioId     = extractTag(raw, responseFields.phioId);

  if (!documentId) {
    throw new Error("SAP batch response se Documentid nahi mila: " + raw);
  }

  console.log("PARSED SAP RESULT:", { documentId, uploadUrl, phioId });

  return { documentId, phioId, uploadUrl };
}

  // STEP 3 — PUT binary to SAP Content Server
  static async uploadBinaryToSap(uploadUrl, fileBuffer, mimeType) {
    try {
      console.log("PUT to :", uploadUrl);
      console.log("Mime   :", mimeType);
      console.log("Size   :", fileBuffer.length, "bytes");

      const response = await axios.put(uploadUrl, fileBuffer, {
        headers: { "Content-Type": mimeType },
      });

      console.log("PUT Status :", response.status);

      // ✅ SAP Content Server returns 201 on success
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(
          `SAP binary upload unexpected status: ${response.status}`,
        );
      }

      return true;
    } catch (error) {
      console.log(
        "STEP 3 ERROR:",
        error.response?.status,
        JSON.stringify(error.response?.data),
      );
      throw new Error(
        error.response?.data?.error?.message?.value ||
          error.message ||
          "SAP binary PUT failed",
      );
    }
  }
  // READ — single document by SAP DocumentId
  static async getDocumentById(erpConfig, sapDocumentId) {
    try {
      const response = await this._client(erpConfig, {
        "Content-Type": "application/json",
      }).get(`/DocumentSet('${sapDocumentId}')`);

      return response.data;
    } catch (error) {
      throw new Error(
        error.response?.data?.error?.message?.value || error.message,
      );
    }
  }

  static async getDocumentBinary(erpConfig, sapDocumentId) {
    try {
      const response = await this._client(erpConfig).get(
        `/DocumentSet('${sapDocumentId}')/$value`,
        { responseType: "arraybuffer" },
      );

      const buffer = response.data;

      // ✅ NEW: empty body ko bhi error treat karo
      if (!buffer || buffer.length === 0) {
        throw new Error(
          "No physical files linked to this Document ID (empty response from SAP)",
        );
      }

      return {
        buffer,
        contentType:
          response.headers["content-type"] || "application/octet-stream",
      };
    } catch (error) {
      console.log("Status:", error.response?.status);

      if (error.response?.data) {
        const data = Buffer.from(error.response.data).toString("utf8");
        console.log("SAP Error:", data);
        try {
          const json = JSON.parse(data);
          throw new Error(
            json.error?.message?.value || json.error?.message || data,
          );
        } catch {
          throw new Error(data);
        }
      }

      throw new Error(error.message);
    }
  }
  static async testConnection(erpConfig, progress = () => {}) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    progress("🚀 Starting connection...");
    await delay(1000);

    const client = erpConfig.sapClient || "100";

    progress("🌐 Connecting to SAP endpoint...");
    await delay(1000);

    const response = await this._client(erpConfig, {
      "x-csrf-token": "Fetch",
    }).get(`/?sap-client=${client}`);

    progress("🔐 CSRF token received");
    await delay(1000);

    progress(`✅ HTTP Status: ${response.status}`);
    await delay(1000);

    progress("🎯 SAP connection successful");

    return true;
  }

  static async confirmUpload(
    erpConfig,
    csrfToken,
    cookieString,
    { filename, application, phioId, documentId },
  ) {
    const client = erpConfig.sapClient || "100";
    const confirmFunctionName = resolveFunctionName(erpConfig, "confirm");

    const url =
      `/${confirmFunctionName}?Filename='${encodeURIComponent(filename)}'` +
      `&Application='${application}'` +
      `&Phioid='${phioId}'` +
      `&Documentid='${documentId}'` +
      `&sap-client=${client}`;

    console.log("================================");
    console.log("CONFIRM UPLOAD");
    console.log("URL :", url);
    console.log("Filename :", filename);
    console.log("Application :", application);
    console.log("DocumentId :", documentId);
    console.log("PhioId :", phioId);
    console.log("================================");

    try {
      const response = await this._client(
        erpConfig,
        {
          "x-csrf-token": csrfToken,
          Cookie: cookieString,
          "Content-Type": "application/json",
        },
        30000,
      ).post(url, {});

      console.log("CONFIRM SUCCESS");
      console.log(JSON.stringify(response.data, null, 2));

      return response.data;
    } catch (error) {
      console.log("========== SAP ERROR ==========");

      console.log("Status :", error.response?.status);

      console.log(JSON.stringify(error.response?.data, null, 2));

      throw error;
    }
  }

static async uploadDocumentToSap(erpConfig, fileBuffer, mimeType, fileName, docMeta = {}) {
  const { csrfToken, cookieString } = await this.fetchCsrfToken(erpConfig);
  const description = `${docMeta.documentTypeName || "DOC"}-${docMeta.categoryName || ""}`.substring(0, 40);

  const { documentId, phioId, uploadUrl } = await this.generateUploadUrlViaBatch(
  erpConfig,
  csrfToken,
  cookieString,
  fileName,
  description,
  fileBuffer,
  docMeta,
);

  if (uploadUrl && uploadUrl !== "LINKAGE_CONFIRMED") {
    await this.uploadBinaryToSap(uploadUrl, fileBuffer, mimeType);
  }

  await this.confirmUpload(erpConfig, csrfToken, cookieString, {
    filename: fileName,
    application: erpConfig.applicationCode || "ZDMS",
    phioId,
    documentId,
  });

  return { documentId, phioId };
}

  // STEP X — Upload document directly via xstring (base64) content in FunctionImport body
  static async uploadDocumentXstring(
    erpConfig,
    csrfToken,
    cookieString,
    {
      fileBuffer,
      fileName,
      mimeType,
      documentType = "PDF",
      description = "DocumentUpload",
    },
  ) {
    const client = erpConfig.sapClient || "100";

    // OData xstring/binary fields expect base64 in JSON body
    const base64Content = fileBuffer.toString("base64");

    const xstringFunctionName = resolveFunctionName(erpConfig, "uploadXstring");
    const url = `/${xstringFunctionName}?sap-client=${client}`;

    const payload = {
      Filename: fileName,
      DocumentType: documentType,
      Description: description.substring(0, 40),
      Mimetype: mimeType,
      Content: base64Content, // 👈 xstring as base64 string
    };

    console.log("======================================");
    console.log("UploadDocumentXstring START");
    console.log("Filename:", fileName, "| Size:", fileBuffer.length, "bytes");
    console.time("UploadDocumentXstring");

    try {
      const response = await this._client(erpConfig, {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-csrf-token": csrfToken,
        Cookie: cookieString,
      }).post(url, payload);

      console.timeEnd("UploadDocumentXstring");
      console.log("RAW SAP RESPONSE:", JSON.stringify(response.data, null, 2));

      const responseFields = resolveUploadResponseFields(erpConfig);
      const result =
        response.data?.d?.[xstringFunctionName] ||
        response.data?.d ||
        response.data;

      return {
        documentId: result[responseFields.documentId],
        phioId: result[responseFields.phioId] || null,
      };
    } catch (error) {
      console.log(
        "UploadDocumentXstring ERROR:",
        error.response?.status,
        JSON.stringify(error.response?.data),
      );
      throw new Error(
        error.response?.data?.error?.message?.value || error.message,
      );
    }
  }

  static async uploadDocumentToSapXstring(
    erpConfig,
    fileBuffer,
    mimeType,
    fileName,
    docMeta = {},
  ) {
    const { csrfToken, cookieString } = await this.fetchCsrfToken(erpConfig);

    const description =
      `${docMeta.documentTypeName || "DOC"}-${docMeta.categoryName || ""}`.substring(
        0,
        40,
      );

    const { documentId, phioId } = await this.uploadDocumentXstring(
      erpConfig,
      csrfToken,
      cookieString,
      {
        fileBuffer,
        fileName,
        mimeType,
        description,
      },
    );

    return { documentId, phioId };
  }
  // ── SAP Master / Document Synchronization support ──────────────
  // Generic OData entity-set reader used by the SAP Master Synchronization
  // and SAP Document Synchronization module (sapMasterSyncService.js /
  // sapDocumentSyncService.js). Purely additive — does not alter any of
  // the upload/retrieval methods above. Handles standard OData v2 JSON
  // envelopes ({ d: { results: [...] } } or { d: [...] }) and follows
  // server-side paging via the "__next" link when the SAP system returns
  // more rows than fit in one page.
  //
  // @param {object} erpConfig
  // @param {string} entitySetName e.g. "DepartmentSet"
  // @param {object} [options]
  // @param {string} [options.filter] raw OData $filter expression (already URL-safe)
  // @param {number} [options.pageSize=200]
  // @returns {Promise<Array<object>>} every row across all pages
  static async fetchEntitySet(erpConfig, entitySetName, options = {}) {
    const client = erpConfig.sapClient || "100";
    const pageSize = options.pageSize || 200;
    const httpClient = this._client(erpConfig, { Accept: "application/json" });

    const results = [];
    let skip = 0;
    let nextRelativeUrl = null;

    // First page uses our own query string; subsequent pages follow SAP's
    // own "__next" link verbatim (it already encodes the correct $skiptoken
    // or $skip for that gateway).
    while (true) {
      let response;

      if (nextRelativeUrl) {
        response = await httpClient.get(nextRelativeUrl);
      } else {
        const params = [`sap-client=${client}`, `$format=json`, `$top=${pageSize}`, `$skip=${skip}`];
        if (options.filter) {
          params.push(`$filter=${encodeURIComponent(options.filter)}`);
        }
        response = await httpClient.get(`/${entitySetName}?${params.join("&")}`);
      }

      const body = response.data;
      const d = body && body.d !== undefined ? body.d : body;
      const rows = Array.isArray(d) ? d : d?.results || [];

      results.push(...rows);

      const nextLink = !Array.isArray(d) ? d?.__next : null;
      if (nextLink) {
        // __next is typically an absolute URL; keep only path+query so it
        // works against the axios instance's configured baseURL.
        try {
          const parsed = new URL(nextLink);
          nextRelativeUrl = `${parsed.pathname}${parsed.search}`;
        } catch {
          nextRelativeUrl = nextLink;
        }
        continue;
      }

      if (rows.length < pageSize) break;
      skip += pageSize;

      // Safety valve — never loop forever against a misbehaving gateway.
      if (skip > 500000) break;
    }

    return results;
  }
}

module.exports = SapService;
