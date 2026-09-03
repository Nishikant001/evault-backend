// src/models/ApprovalLevel.js
//
// A single ordered step ("Branch Manager", "Department Head", ...) in an
// ApprovalWorkflow chain. Levels are unlimited and fully tenant-defined —
// nothing about the chain length or approver type is hardcoded.
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ApprovalLevel = sequelize.define(
  "ApprovalLevel",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    approvalWorkflowId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "approval_workflows", key: "id" },
    },
    levelNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "1-indexed sequence position within the workflow",
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Label shown in the matrix builder, e.g. "Branch Manager"',
    },
    // Reserved for future PARALLEL approval — when true, this level does
    // not need to wait for a strictly-prior level to run sequentially.
    isParallel: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "approval_levels",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["approvalWorkflowId", "levelNumber"],
        name: "unique_level_per_workflow",
      },
    ],
  }
);

module.exports = ApprovalLevel;
