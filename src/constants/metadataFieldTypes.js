// src/constants/metadataFieldTypes.js
//
// Shared vocabulary for the Dynamic Metadata Template Engine / Form Builder.
// Purely additive — new file, does not touch any existing constant.

const FIELD_TYPES = {
  TEXT: "TEXT",
  TEXTAREA: "TEXTAREA",
  NUMBER: "NUMBER",
  CURRENCY: "CURRENCY",
  DATE: "DATE",
  TIME: "TIME",
  CHECKBOX: "CHECKBOX",
  RADIO: "RADIO",
  DROPDOWN: "DROPDOWN",
  MULTI_SELECT: "MULTI_SELECT",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  URL: "URL",
  PASSWORD: "PASSWORD",
  SIGNATURE: "SIGNATURE",
  BARCODE: "BARCODE",
  QR: "QR",
  AUTO_NUMBER: "AUTO_NUMBER",
  FORMULA: "FORMULA",
  HIDDEN: "HIDDEN",
  LOOKUP: "LOOKUP",
  FILE: "FILE",
  IMAGE: "IMAGE",
};

// Field types that support an `options` array ([{label, value}])
const OPTION_BASED_FIELD_TYPES = [
  FIELD_TYPES.RADIO,
  FIELD_TYPES.DROPDOWN,
  FIELD_TYPES.MULTI_SELECT,
];

// Field types for which OCR mapping makes no sense (system-managed values)
const NON_OCR_FIELD_TYPES = [
  FIELD_TYPES.AUTO_NUMBER,
  FIELD_TYPES.FORMULA,
  FIELD_TYPES.HIDDEN,
  FIELD_TYPES.SIGNATURE,
  FIELD_TYPES.FILE,
  FIELD_TYPES.IMAGE,
];

const TEMPLATE_VERSION_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  ARCHIVED: "ARCHIVED",
};

const TEMPLATE_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
};

const CONFIDENCE_LEVELS = {
  HIGH: "High",
  MID: "Mid",
  LOW: "Low",
};

module.exports = {
  FIELD_TYPES,
  OPTION_BASED_FIELD_TYPES,
  NON_OCR_FIELD_TYPES,
  TEMPLATE_VERSION_STATUS,
  TEMPLATE_STATUS,
  CONFIDENCE_LEVELS,
};
