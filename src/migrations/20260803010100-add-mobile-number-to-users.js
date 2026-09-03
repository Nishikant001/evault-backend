"use strict";

// Nullable — existing PAID users authenticate by email/password exactly as
// today and never populate this column. Only FREE self-registered users
// (mobile + OTP flow) set it. Unique so a mobile number maps to one user.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("users", "mobileNumber", {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
      comment: "Set only for FREE self-registered users (mobile+OTP login).",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("users", "mobileNumber");
  },
};
