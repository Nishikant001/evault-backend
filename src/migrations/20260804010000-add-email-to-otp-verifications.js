"use strict";

// Task 2 — New Registration Flow: Step 1 now collects Phone + Email
// together (not just Phone), so the OTP row needs to carry the email the
// person typed until Step 2 (Owner Name / Company Name / Password) creates
// the Tenant + User. Nullable so existing LOGIN-purpose OTP rows (which
// never had an email) are unaffected.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("otp_verifications", "email", {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("otp_verifications", "email");
  },
};
