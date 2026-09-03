"use strict";

// MASTER DB migration. Consolidates the legacy shared-DB
// create-otp-verifications + add-email-to-otp-verifications migrations
// into one create, since the Master DB is starting fresh (email is part
// of the base table here, not a later ALTER).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("otp_verifications", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      mobileNumber: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: true },
      otpHash: { type: Sequelize.STRING, allowNull: false },
      purpose: {
        type: Sequelize.ENUM("REGISTRATION", "LOGIN"),
        allowNull: false,
        defaultValue: "REGISTRATION",
      },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      verifiedAt: { type: Sequelize.DATE, allowNull: true },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("otp_verifications", ["mobileNumber", "purpose"]);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("otp_verifications");
  },
};
