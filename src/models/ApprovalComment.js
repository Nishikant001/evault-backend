// src/models/ApprovalComment.js
//
// Freeform discussion/remarks thread attached to a DocumentApproval,
// separate from the state-transition ledger in ApprovalHistory. Useful
// for "please attach the PO before I approve" style back-and-forth that
// isn't itself an approve/reject/send-back action.
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ApprovalComment = sequelize.define(
  "ApprovalComment",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    documentApprovalId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "document_approvals", key: "id" },
    },
    levelNumber: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "approval_comments",
    timestamps: true,
    indexes: [{ fields: ["documentApprovalId"] }],
  }
);

module.exports = ApprovalComment;
