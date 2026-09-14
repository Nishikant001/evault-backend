"use strict";

// Purely ADDITIVE — adds one new ENUM value ("REJECTED") so a document
// whose Approval Workflow rejects it can be reflected on the Document
// record itself (for listing/filtering). No existing ENUM value is
// renamed or removed, so every current read/write against
// documents.uploadStatus keeps working unchanged.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE documents
      MODIFY COLUMN uploadStatus ENUM(
        'UPLOADING',
        'OCR_PROCESSING',
        'OCR_COMPLETED',
        'WAITING_FOR_APPROVAL',
        'SAVING_TO_SAP',
        'COMPLETED',
        'FAILED',
        'REJECTED'
      ) DEFAULT 'UPLOADING';
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE documents
      MODIFY COLUMN uploadStatus ENUM(
        'UPLOADING',
        'OCR_PROCESSING',
        'OCR_COMPLETED',
        'WAITING_FOR_APPROVAL',
        'SAVING_TO_SAP',
        'COMPLETED',
        'FAILED'
      ) DEFAULT 'UPLOADING';
    `);
  },
};
