"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("notifications", "type", {
      type: Sequelize.ENUM(
        "TRIAL_REMINDER",
        "TRIAL_EXPIRED",
        "SUBSCRIPTION_CHANGED",
        "SYSTEM",
        "COMMUNICATION_MESSAGE",
        "COMMUNICATION_MISSED_CALL",
        "APPROVAL_SUBMITTED",
        "APPROVAL_PENDING",
        "APPROVAL_APPROVED",
        "APPROVAL_COMPLETED",
        "APPROVAL_REJECTED",
        "APPROVAL_SENT_BACK",
        "APPROVAL_CANCELLED"
      ),
      allowNull: false,
      defaultValue: "SYSTEM",
    });

    await queryInterface.addColumn(
      "notifications",
      "metadata",
      {
        type: Sequelize.JSON,
        allowNull: true,
      }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn(
      "notifications",
      "metadata"
    );

    await queryInterface.changeColumn("notifications", "type", {
      type: Sequelize.ENUM(
        "TRIAL_REMINDER",
        "TRIAL_EXPIRED",
        "SUBSCRIPTION_CHANGED",
        "SYSTEM",
        "COMMUNICATION_MESSAGE",
        "COMMUNICATION_MISSED_CALL"
      ),
      allowNull: false,
      defaultValue: "SYSTEM",
    });
  },
};