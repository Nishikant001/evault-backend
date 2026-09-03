"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE cross_department_document_requests
      MODIFY COLUMN status ENUM(
        'PENDING',
        'DOCUMENT_SELECTED',
        'APPROVED',
        'SHARED',
        'REJECTED',
        'REVOKED',
        'EXPIRED'
      ) NOT NULL DEFAULT 'PENDING';
    `);

    await queryInterface.addColumn(
      "cross_department_document_requests",
      "share_id",
      { type: Sequelize.BIGINT.UNSIGNED, allowNull: true }
    );

    await queryInterface.addIndex(
      "cross_department_document_requests",
      ["tenant_id", "share_id"],
      { name: "idx_cddr_share" }
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex(
      "cross_department_document_requests",
      "idx_cddr_share"
    );

    await queryInterface.removeColumn(
      "cross_department_document_requests",
      "share_id"
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE cross_department_document_requests
      MODIFY COLUMN status ENUM(
        'PENDING',
        'APPROVED',
        'REJECTED',
        'CANCELLED',
        'EXPIRED'
      ) NOT NULL DEFAULT 'PENDING';
    `);
  },
};