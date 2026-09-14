// src/utils/withDeadlockRetry.js
async function withDeadlockRetry(fn, { retries = 3, baseDelayMs = 50 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isDeadlock = error?.parent?.code === "ER_LOCK_DEADLOCK" || error?.original?.code === "ER_LOCK_DEADLOCK";
      if (!isDeadlock || attempt === retries) throw error;
      const jitter = Math.random() * baseDelayMs;
      await new Promise((r) => setTimeout(r, attempt * baseDelayMs + jitter));
    }
  }
}
module.exports = withDeadlockRetry;