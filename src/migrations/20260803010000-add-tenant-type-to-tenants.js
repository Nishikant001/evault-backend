"use strict";

// Subscription Management System — Step 1.
// Additive, nullable-safe column with a hard DEFAULT of 'PAID'. Every row
// that exists at migration time (i.e. every current customer) becomes
// tenantType='PAID' automatically — zero behavior change for them. Only
// newly created FREE-tenant registrations will ever set this to 'FREE'.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("tenants", "tenantType", {
      type: Sequelize.ENUM("FREE", "PAID"),
      allowNull: false,
      defaultValue: "PAID",
      comment:
        "FREE = self-registered trial tenant (no SAP/AI access, watermarked documents, local storage only). PAID = existing enterprise tenant, unchanged behavior.",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("tenants", "tenantType");
  },
};
