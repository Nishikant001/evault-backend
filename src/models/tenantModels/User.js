// src/models/tenantModels/User.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/User.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    role: {
      type: DataTypes.ENUM(
        "SuperAdmin",
        "TenantAdmin",
        "BranchManager",
        "DeptHead",
        "Manager",
        "Uploader",
        "Viewer",
        "Auditor",
        "Approver",
      ),
      defaultValue: "Viewer",
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Set only for FREE self-registered users (mobile+OTP flow). Existing
    // PAID users keep authenticating by email/password and never touch
    // this column.
    mobileNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "users",
    timestamps: true,
  },
);

