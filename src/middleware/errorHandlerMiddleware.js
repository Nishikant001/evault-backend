// src/middleware/errorHandlerMiddleware.js
//
// PRODUCTION DEPLOYMENT — final safety net.
//
// Express 5's DEFAULT error handler renders a stack trace (and, in some
// cases, internal file paths) whenever NODE_ENV !== "production", and
// even in production it can leak the error's raw `message` (which may
// contain SQL, a file path, or a driver-level DB error string) straight
// to the client. Mounted LAST in app.js — after every route — so any
// error that reaches here (thrown, rejected, or passed to next(err)) is
// answered with a fixed, safe JSON body instead.
//
// Rules enforced here (brief "Do not expose stack traces / database
// credentials / internal DB names"):
//   - Never send err.stack to the client.
//   - Never send the raw err.message from a database driver (Sequelize/
//     mysql2 errors routinely embed table/column/SQL fragments).
//   - Full detail (message + stack) still goes to the server log, via
//     the same structuredLog() used elsewhere, so it's fully debuggable
//     from the server side.
const { structuredLog } = require("./requestContextMiddleware");

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: "Not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandlerMiddleware(err, req, res, next) {
  structuredLog({
    requestId: req.requestId,
    event: "unhandled_error",
    host: req.hostname,
    route: req.originalUrl,
    status: err.statusCode || 500,
  });
  // Full error (message + stack) goes to server-side stderr only — never
  // to the response body.
  console.error(`[${req.requestId}] Unhandled error:`, err);

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  // Deliberately generic — no err.message passthrough. Known, expected
  // application errors should already have been caught and turned into
  // a proper res.status(...).json(...) response by their own route
  // handler; anything reaching this point is unexpected by definition.
  const message = statusCode === 500 ? "Internal server error" : "Request could not be completed";

  res.status(statusCode).json({ success: false, message });
}

module.exports = { notFoundHandler, errorHandlerMiddleware };
