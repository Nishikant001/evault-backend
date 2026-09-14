// src/models/masterDb/OtpVerification.js — PHASE A, real Master DB model.
// Field-for-field identical to legacy src/models/OtpVerification.js.
// This runs entirely pre-tenant (a phone number isn't attached to any
// tenant yet at OTP time), so it's unambiguously platform-level.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const OtpVerification = masterSequelize.define(
  "OtpVerification",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    mobileNumber: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: true },
    otpHash: { type: DataTypes.STRING, allowNull: false },
    purpose: {
      type: DataTypes.ENUM("REGISTRATION", "LOGIN"),
      allowNull: false,
      defaultValue: "REGISTRATION",
    },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "otp_verifications",
    timestamps: true,
  },
);

module.exports = OtpVerification;
