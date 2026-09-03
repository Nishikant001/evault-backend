const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const OtpVerification = sequelize.define(
  "OtpVerification",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    mobileNumber: { type: DataTypes.STRING, allowNull: false },
    // Task 2 — captured at Step 1 (Phone + Email) alongside the mobile
    // number, carried through to Step 2 when the Tenant/User row is created.
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
