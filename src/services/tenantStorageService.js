"use strict";

const fs = require("fs");
const path = require("path");
const { Sequelize } = require("sequelize");
const { TenantDatabase } = require("../models/masterDb");

const DEFAULT_DB_QUOTA_BYTES = Number(process.env.DEFAULT_TENANT_DB_QUOTA_BYTES || 5 * 1024 ** 3);
const DEFAULT_FILE_QUOTA_BYTES = Number(process.env.DEFAULT_TENANT_FILE_QUOTA_BYTES || 10 * 1024 ** 3);
const LOCAL_STORAGE_ROOT = path.join(process.cwd(), "uploads", "free-tenant-documents");

function toSafeBytes(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Storage quota must be a non-negative number of bytes");
  return Math.floor(n);
}

function formatStorage(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return { bytes: n, value: Number(value.toFixed(2)), unit: units[index] };
}

async function openServerConnection() {
  return new Sequelize(
    "",
    process.env.TENANT_DB_USER || process.env.MASTER_DB_USER || process.env.DB_USER,
    process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
    {
      host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST || process.env.DB_HOST,
      port: process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306,
      dialect: "mysql",
      logging: false,
    },
  );
}

async function measureDatabaseBytes(databaseName) {
  if (!databaseName) return { dataBytes: 0, indexBytes: 0, totalBytes: 0 };
  const admin = await openServerConnection();
  try {
    const [rows] = await admin.query(
      `SELECT
         COALESCE(SUM(data_length), 0) AS dataBytes,
         COALESCE(SUM(index_length), 0) AS indexBytes
       FROM information_schema.tables
       WHERE table_schema = :databaseName`,
      { replacements: { databaseName } },
    );
    const dataBytes = Number(rows?.[0]?.dataBytes || 0);
    const indexBytes = Number(rows?.[0]?.indexBytes || 0);
    return { dataBytes, indexBytes, totalBytes: dataBytes + indexBytes };
  } finally {
    await admin.close().catch(() => {});
  }
}

async function directoryBytes(directory) {
  try {
    const stat = await fs.promises.stat(directory);
    if (!stat.isDirectory()) return stat.size;
  } catch {
    return 0;
  }
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(fullPath);
    else if (entry.isFile()) {
      try { total += (await fs.promises.stat(fullPath)).size; } catch { /* file disappeared during scan */ }
    }
  }
  return total;
}

async function measureFileBytes(tenantId) {
  // Current application-managed local document storage. If object storage is
  // introduced later, this function is the single metering seam to replace.
  return directoryBytes(path.join(LOCAL_STORAGE_ROOT, String(tenantId)));
}

function quotaFor(tenantDb, field, fallback) {
  const raw = tenantDb?.[field];
  if (raw === null || raw === undefined || raw === "") return fallback;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

async function assertFileQuota(tenantId, incomingBytes) {
  const tenantDb = await TenantDatabase.findOne({ where: { tenantId } });
  if (!tenantDb) throw new Error("Tenant database record not found");
  const quota = quotaFor(tenantDb, "fileQuotaBytes", DEFAULT_FILE_QUOTA_BYTES);
  const current = await measureFileBytes(tenantId);
  const incoming = Number(incomingBytes || 0);
  if (!Number.isFinite(incoming) || incoming < 0) throw new Error("Invalid file size");
  if (current + incoming > quota) {
    const error = new Error(`File storage quota exceeded. Available: ${formatStorage(Math.max(0, quota - current)).value} ${formatStorage(Math.max(0, quota - current)).unit}`);
    error.code = "FILE_STORAGE_QUOTA_EXCEEDED";
    error.statusCode = 413;
    error.currentBytes = current;
    error.quotaBytes = quota;
    error.incomingBytes = incoming;
    throw error;
  }
  return { currentBytes: current, quotaBytes: quota, incomingBytes: incoming };
}

async function measureTenantStorage(tenantId, { persist = true } = {}) {
  const tenantDb = await TenantDatabase.findOne({ where: { tenantId } });
  if (!tenantDb) throw new Error("Tenant database record not found");
  if (!tenantDb.databaseName || tenantDb.status !== "READY") {
    return {
      tenantId,
      status: tenantDb.status,
      databaseName: tenantDb.databaseName,
      databaseBytes: 0,
      databaseDataBytes: 0,
      databaseIndexBytes: 0,
      fileBytes: 0,
      totalBytes: 0,
      databaseQuotaBytes: quotaFor(tenantDb, "databaseQuotaBytes", DEFAULT_DB_QUOTA_BYTES),
      fileQuotaBytes: quotaFor(tenantDb, "fileQuotaBytes", DEFAULT_FILE_QUOTA_BYTES),
      measuredAt: new Date(),
    };
  }

  const [db, fileBytes] = await Promise.all([
    measureDatabaseBytes(tenantDb.databaseName),
    measureFileBytes(tenantId),
  ]);
  const totalBytes = db.totalBytes + fileBytes;
  const databaseQuotaBytes = quotaFor(tenantDb, "databaseQuotaBytes", DEFAULT_DB_QUOTA_BYTES);
  const fileQuotaBytes = quotaFor(tenantDb, "fileQuotaBytes", DEFAULT_FILE_QUOTA_BYTES);

  if (persist) {
    await tenantDb.update({
      databaseDataBytes: db.dataBytes,
      databaseIndexBytes: db.indexBytes,
      databaseBytes: db.totalBytes,
      fileBytes,
      totalBytes,
      storageMeasuredAt: new Date(),
    });
  }

  return {
    tenantId,
    status: tenantDb.status,
    databaseName: tenantDb.databaseName,
    databaseBytes: db.totalBytes,
    databaseDataBytes: db.dataBytes,
    databaseIndexBytes: db.indexBytes,
    fileBytes,
    totalBytes,
    databaseQuotaBytes,
    fileQuotaBytes,
    databaseUsagePercent: databaseQuotaBytes ? Number((db.totalBytes / databaseQuotaBytes * 100).toFixed(2)) : 0,
    fileUsagePercent: fileQuotaBytes ? Number((fileBytes / fileQuotaBytes * 100).toFixed(2)) : 0,
    totalQuotaBytes: databaseQuotaBytes + fileQuotaBytes,
    totalUsagePercent: databaseQuotaBytes + fileQuotaBytes
      ? Number((totalBytes / (databaseQuotaBytes + fileQuotaBytes) * 100).toFixed(2))
      : 0,
    overDatabaseQuota: db.totalBytes > databaseQuotaBytes,
    overFileQuota: fileBytes > fileQuotaBytes,
    overTotalQuota: totalBytes > databaseQuotaBytes + fileQuotaBytes,
    measuredAt: new Date(),
    formatted: {
      database: formatStorage(db.totalBytes),
      files: formatStorage(fileBytes),
      total: formatStorage(totalBytes),
      databaseQuota: formatStorage(databaseQuotaBytes),
      fileQuota: formatStorage(fileQuotaBytes),
      totalQuota: formatStorage(databaseQuotaBytes + fileQuotaBytes),
    },
  };
}

async function measureAllTenantStorage() {
  const rows = await TenantDatabase.findAll({ where: { status: "READY" } });
  const results = [];
  for (const row of rows) {
    try {
      results.push(await measureTenantStorage(row.tenantId));
    } catch (error) {
      console.error(`[TenantStorage] Failed tenant ${row.tenantId}:`, error.message);
    }
  }
  return results;
}

function assertQuotaValue(value, label) {
  const bytes = toSafeBytes(value);
  if (bytes === null) throw new Error(`${label} is required`);
  return bytes;
}

module.exports = {
  DEFAULT_DB_QUOTA_BYTES,
  DEFAULT_FILE_QUOTA_BYTES,
  formatStorage,
  measureTenantStorage,
  measureAllTenantStorage,
  assertQuotaValue,
  measureFileBytes,
  assertFileQuota,
};
