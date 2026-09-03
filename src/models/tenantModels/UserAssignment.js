// src/models/tenantModels/UserAssignment.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/UserAssignment.js — only
// the require/export wrapper differs.
// src/models/UserAssignment.js
//
// Dynamic User Assignment Engine
// ───────────────────────────────
// Lets a TenantAdmin grant a user access at exactly ONE of three
// hierarchy levels, without touching any existing Category / DocumentType
// / Document logic:
//
//   DEPARTMENT     → departmentId set, categoryId & documentTypeId null
//                    user gets the whole department (all its categories,
//                    all their document types, all documents under them).
//   CATEGORY       → categoryId set (departmentId auto-filled from it),
//                    documentTypeId null. User is restricted to that one
//                    category (and everything under it).
//   DOCUMENT_TYPE  → documentTypeId set (categoryId & departmentId
//                    auto-filled from it). User is restricted to that one
//                    document type (and its documents).
//
// `status` gives soft revoke/re-grant (ACTIVE/INACTIVE) so history is
// preserved instead of being hard-deleted — consistent with how the rest
// of this codebase soft-deletes (Category/DocumentType `status` field).
//
// Level 4 (Document) is intentionally NOT modelled yet — `documentId` is
// left out of this table on purpose. The service layer already resolves
// access from department/category/documentType, so adding a nullable
// `documentId` column + one more branch in userAssignmentService later is
// a non-breaking, additive change (future-ready, per requirement).

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "UserAssignment",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
      comment: "The user being granted access",
    },
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "categories", key: "id" },
    },
    documentTypeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "document_types", key: "id" },
    },
    assignmentLevel: {
      type: DataTypes.ENUM("DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE"),
      allowNull: false,
      comment: "Which column (departmentId / categoryId / documentTypeId) is authoritative for this row",
    },
    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
      comment: "userId of the TenantAdmin/SuperAdmin who granted this access",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
      comment: "INACTIVE = revoked, kept for audit/history instead of hard delete",
    },
  },
  {
    tableName: "user_assignments",
    timestamps: true,
    indexes: [
      { fields: ["tenantId", "userId"] },
      { fields: ["tenantId", "userId", "departmentId"] },
      { fields: ["tenantId", "userId", "categoryId"] },
      { fields: ["tenantId", "userId", "documentTypeId"] },
      {
        unique: true,
        fields: ["userId", "assignmentLevel", "departmentId", "categoryId", "documentTypeId"],
        name: "unique_user_assignment_target",
      },
    ],
  }
);

