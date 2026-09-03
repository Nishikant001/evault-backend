// src/services/notificationService.js
//
// Real email + SMS dispatcher for the Subscription Management System
// (OTP delivery, trial-expiry reminders). This is deliberately separate
// from notificationHookService.js, which stays exactly as-is (approval
// engine lifecycle hooks, no email/SMS by original design) — this module
// does not touch that one.
//
// ── SMS Gateway (Task 1: Replace SMS Stub) ─────────────────────────────
// Development Mode (default): every OTP/SMS is only console-logged, exactly
// like the original stub — nothing is ever sent, nothing ever crashes.
//   [Notification:SMS:STUB] to=... message="..."
//
// Production Mode: set SMS_PROVIDER to one of the supported gateways below
// and NODE_ENV=production (or SMS_FORCE_LIVE=true to send in any env, e.g.
// for staging). The provider is never hardcoded — it's entirely driven by
// env vars, so switching gateways is a config change, not a code change.
//
//   SMS_PROVIDER=twilio
//     TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//     (requires `npm install twilio`)
//
//   SMS_PROVIDER=msg91
//     MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_ROUTE (default "4"),
//     MSG91_TEMPLATE_ID (optional, required only if your MSG91 account is
//     DLT-template-gated)
//     (uses axios — already a project dependency, no install needed)
//
//   SMS_PROVIDER=fast2sms
//     FAST2SMS_API_KEY, FAST2SMS_SENDER_ID (optional, quick/route SMS)
//     (uses axios — already a project dependency, no install needed)
//
//   SMS_PROVIDER=aws_sns
//     AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//     (requires `npm install @aws-sdk/client-sns`)
//
// Every branch is wrapped so a missing package / bad credential / gateway
// outage NEVER throws — it logs the error and falls back to the console
// stub, preserving the original "never throw" contract used everywhere
// else in this service (and by notificationHookService.fire()).
//
// Email keeps its original behavior unchanged:
//   - Email: set EMAIL_PROVIDER=smtp and SMTP_HOST/PORT/USER/PASS/FROM
//            (requires `npm install nodemailer`)
// Until configured, every call logs to the console instead of throwing.

const SMS_PROVIDERS = {
  CONSOLE: "console",
  TWILIO: "twilio",
  MSG91: "msg91",
  FAST2SMS: "fast2sms",
  AWS_SNS: "aws_sns",
};

/** True only when a real (non-console) SMS provider should actually fire a network call. */
function isLiveSmsEnabled() {
  const provider = (process.env.SMS_PROVIDER || SMS_PROVIDERS.CONSOLE).toLowerCase();
  if (provider === SMS_PROVIDERS.CONSOLE || !provider) return false;
  // Production Mode = SMS gateway integration; Development Mode = console log.
  // SMS_FORCE_LIVE lets staging/QA opt in to a live gateway without NODE_ENV=production.
  return process.env.NODE_ENV === "production" || process.env.SMS_FORCE_LIVE === "true";
}

class NotificationService {
  static async sendEmail(to, subject, body) {
    try {
      if (process.env.EMAIL_PROVIDER === "smtp") {
        // Lazy require so the package is only needed once actually configured.
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === "true",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || "no-reply@excelligent.com",
          to,
          subject,
          text: body,
        });
        return { sent: true, channel: "smtp" };
      }

      console.log(`[Notification:Email:STUB] to=${to} subject="${subject}" body="${body}"`);
      return { sent: false, channel: "console-stub" };
    } catch (error) {
      console.log("NotificationService.sendEmail Error:", error.message);
      return { sent: false, error: error.message };
    }
  }

  static async sendSms(to, message) {
    const provider = (process.env.SMS_PROVIDER || SMS_PROVIDERS.CONSOLE).toLowerCase();

    // Development Mode (or no live-send flag) — always console-log, never call a gateway.
    if (!isLiveSmsEnabled()) {
      console.log(`[Notification:SMS:STUB] to=${to} message="${message}"`);
      return { sent: false, channel: "console-stub", provider };
    }

    try {
      switch (provider) {
        case SMS_PROVIDERS.TWILIO:
          return await NotificationService._sendViaTwilio(to, message);
        case SMS_PROVIDERS.MSG91:
          return await NotificationService._sendViaMsg91(to, message);
        case SMS_PROVIDERS.FAST2SMS:
          return await NotificationService._sendViaFast2Sms(to, message);
        case SMS_PROVIDERS.AWS_SNS:
          return await NotificationService._sendViaAwsSns(to, message);
        default:
          console.log(`[Notification:SMS:STUB] to=${to} message="${message}"`);
          return { sent: false, channel: "console-stub", provider };
      }
    } catch (error) {
      console.log(`NotificationService.sendSms Error (provider=${provider}):`, error.message);
      // Gateway failed — fall back to console so the OTP flow never breaks the request.
      console.log(`[Notification:SMS:STUB] to=${to} message="${message}"`);
      return { sent: false, channel: "console-stub", provider, error: error.message };
    }
  }

  // ── Provider adapters (Production Mode) ─────────────────────────────
  // Each adapter only requires its SDK/HTTP client lazily, on first actual
  // use, so tenants who never configure a live gateway never pay the cost
  // of an unused dependency.

  static async _sendViaTwilio(to, message) {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_FROM_NUMBER,
      to,
    });
    return { sent: true, channel: "twilio" };
  }

  static async _sendViaMsg91(to, message) {
    const axios = require("axios");
    const authKey = process.env.MSG91_AUTH_KEY;
    const senderId = process.env.MSG91_SENDER_ID;
    if (!authKey || !senderId) throw new Error("MSG91_AUTH_KEY / MSG91_SENDER_ID not configured");

    await axios.post(
      "https://control.msg91.com/api/v5/flow/",
      {
        // Plain-route fallback body; if MSG91_TEMPLATE_ID is set, MSG91's
        // Flow API is used with the message as a single VAR (DLT-compliant setups).
        template_id: process.env.MSG91_TEMPLATE_ID || undefined,
        sender: senderId,
        short_url: "0",
        mobiles: to,
        VAR: message,
      },
      { headers: { authkey: authKey, "Content-Type": "application/json" } },
    );
    return { sent: true, channel: "msg91" };
  }

  static async _sendViaFast2Sms(to, message) {
    const axios = require("axios");
    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) throw new Error("FAST2SMS_API_KEY not configured");

    await axios.post(
      "https://www.fast2sms.com/dev/bulkV2",
      {
        route: "q",
        message,
        language: "english",
        flash: 0,
        numbers: to,
        sender_id: process.env.FAST2SMS_SENDER_ID || undefined,
      },
      { headers: { authorization: apiKey, "Content-Type": "application/json" } },
    );
    return { sent: true, channel: "fast2sms" };
  }

  static async _sendViaAwsSns(to, message) {
    const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
    const client = new SNSClient({
      region: process.env.AWS_REGION,
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
    await client.send(new PublishCommand({ Message: message, PhoneNumber: to }));
    return { sent: true, channel: "aws_sns" };
  }

  /** Convenience wrapper used by the trial-expiry scheduler / dashboard. */
  static async sendTrialReminder({ email, mobileNumber, tenantName, remainingDays }) {
    const subject = `Excelligent — your trial ${remainingDays <= 0 ? "has expired" : `ends in ${remainingDays} day(s)`}`;
    const body =
      remainingDays <= 0
        ? `Hi, the free trial for ${tenantName} has expired. Upgrade now to keep using Excelligent without interruption.`
        : `Hi, the free trial for ${tenantName} ends in ${remainingDays} day(s). Upgrade now to avoid losing access.`;

    const results = [];
    if (email) results.push(await this.sendEmail(email, subject, body));
    if (mobileNumber) results.push(await this.sendSms(mobileNumber, body));
    return results;
  }
}

module.exports = NotificationService;
