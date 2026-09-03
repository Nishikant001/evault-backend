"use strict";

const cron = require("node-cron");
const { measureAllTenantStorage } = require("./tenantStorageService");

let task = null;

async function runStorageMeter() {
  try {
    const rows = await measureAllTenantStorage();
    console.log(`[TenantStorage] Metered ${rows.length} tenant databases.`);
    return rows;
  } catch (error) {
    console.error("[TenantStorage] Meter run failed:", error.message);
    return [];
  }
}

function startTenantStorageScheduler() {
  if (task) return task;
  // Every hour at minute 10. The scan is intentionally outside request
  // handling so dashboard reads never need to scan every database.
  task = cron.schedule("10 * * * *", runStorageMeter, { scheduled: true });
  if (typeof task.start === "function") task.start();
  return task;
}

function stopTenantStorageScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { runStorageMeter, startTenantStorageScheduler, stopTenantStorageScheduler };
