// src/services/metadataValidationService.js
//
// Pure validation logic for the Dynamic Metadata Template Engine.
// No DB access here except the duplicate-document check, which is scoped
// to a single simple query. Kept dependency-free (no external validation
// libs) so it drops straight into the existing project without new
// packages.

const { FIELD_TYPES } = require("../constants/metadataFieldTypes");

// GSTIN: 2 digit state code + 10 char PAN + 1 entity code + 1 default 'Z' + 1 checksum
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i;
const PHONE_REGEX = /^[+]?[0-9\s\-()]{7,15}$/;

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

// Safely evaluate a FORMULA field's expression, e.g. "quantity * unitPrice"
// or "subTotal + gstAmount". Only field internalNames + numbers + basic
// arithmetic operators are permitted — anything else is rejected before
// ever reaching `new Function`.
function evaluateFormula(formula, valuesByInternalName) {
  if (!formula || typeof formula !== "string") return null;

  const allowedTokenPattern = /^[a-zA-Z0-9_+\-*/().\s]*$/;
  if (!allowedTokenPattern.test(formula)) {
    throw new Error(`Formula contains disallowed characters: ${formula}`);
  }

  const identifiers = Array.from(
    new Set((formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []))
  );

  const scopeArgs = [];
  const scopeVals = [];
  for (const id of identifiers) {
    const raw = valuesByInternalName[id];
    const num = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
    scopeArgs.push(id);
    scopeVals.push(Number.isFinite(num) ? num : 0);
  }

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...scopeArgs, `"use strict"; return (${formula});`);
    const result = fn(...scopeVals);
    return Number.isFinite(result) ? result : null;
  } catch (err) {
    throw new Error(`Formula evaluation failed for "${formula}": ${err.message}`);
  }
}

/**
 * Validate a single field's value against its MetadataField.validation config.
 * @returns {string[]} array of error messages (empty = valid)
 */
function validateFieldValue(field, value, allValues = {}) {
  const errors = [];
  const rules = field.validation || {};
  const type = field.fieldType;

  // FORMULA fields have no independent "value" to check — they're derived.
  // Validate the formula's own syntax/safety directly and stop there.
  if (type === FIELD_TYPES.FORMULA) {
    if (rules.formula) {
      try {
        evaluateFormula(rules.formula, allValues);
      } catch (err) {
        errors.push(err.message);
      }
    }
    return errors;
  }

  // ── Required ─────────────────────────────────────────────
  if (field.required && isEmpty(value)) {
    errors.push(`${field.label} is required`);
    return errors; // no point validating further if it's missing
  }

  if (isEmpty(value)) return errors; // optional & empty — nothing else to check

  const strValue = String(value);

  // ── Type-specific checks ─────────────────────────────────
  switch (type) {
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY: {
      const num = Number(strValue.replace(/,/g, ""));
      if (Number.isNaN(num)) {
        errors.push(`${field.label} must be numeric`);
        break;
      }
      if (rules.min !== undefined && num < rules.min) {
        errors.push(`${field.label} must be >= ${rules.min}`);
      }
      if (rules.max !== undefined && num > rules.max) {
        errors.push(`${field.label} must be <= ${rules.max}`);
      }
      break;
    }

    case FIELD_TYPES.DATE: {
      const parsed = Date.parse(strValue);
      if (Number.isNaN(parsed)) {
        errors.push(`${field.label} must be a valid date`);
      }
      break;
    }

    case FIELD_TYPES.EMAIL: {
      if (!EMAIL_REGEX.test(strValue)) {
        errors.push(`${field.label} must be a valid email address`);
      }
      break;
    }

    case FIELD_TYPES.URL: {
      if (!URL_REGEX.test(strValue)) {
        errors.push(`${field.label} must be a valid URL`);
      }
      break;
    }

    case FIELD_TYPES.PHONE: {
      if (!PHONE_REGEX.test(strValue)) {
        errors.push(`${field.label} must be a valid phone number`);
      }
      break;
    }

    default:
      break;
  }

  // ── GST validation (explicit opt-in, independent of fieldType) ──
  if (rules.gstValidation && !GSTIN_REGEX.test(strValue.toUpperCase())) {
    errors.push(`${field.label} must be a valid GSTIN`);
  }

  // ── Generic regex (works for any field type) ─────────────
  if (rules.regex) {
    try {
      const re = new RegExp(rules.regex);
      if (!re.test(strValue)) {
        errors.push(`${field.label} does not match the required format`);
      }
    } catch (err) {
      errors.push(`${field.label} has an invalid validation regex configured`);
    }
  }

  // ── min/max length for text-like fields ───────────────────
  if ([FIELD_TYPES.TEXT, FIELD_TYPES.TEXTAREA].includes(type)) {
    if (rules.min !== undefined && strValue.length < rules.min) {
      errors.push(`${field.label} must be at least ${rules.min} characters`);
    }
    if (rules.max !== undefined && strValue.length > rules.max) {
      errors.push(`${field.label} must be at most ${rules.max} characters`);
    }
  }

  return errors;
}

/**
 * Validate a full metadata object against a list of MetadataField rows.
 * @returns {{ valid: boolean, errors: Record<string,string[]> }}
 */
function validateMetadata(fields, metadataValues = {}) {
  const errors = {};

  for (const field of fields) {
    if (field.status === "INACTIVE") continue;
    const fieldErrors = validateFieldValue(
      field,
      metadataValues[field.internalName],
      metadataValues
    );
    if (fieldErrors.length) {
      errors[field.internalName] = fieldErrors;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Duplicate document validation: for every field flagged `unique: true` in
 * its validation rules, check whether another CONFIRMED DocumentMetadata
 * row (for the same tenant's documents) already carries the same value.
 */
async function checkDuplicates(models, { fields, metadataValues, tenantId, documentTypeId, excludeDocumentId }) {
  const { DocumentMetadata, Document } = models;
  const { Op } = require("sequelize");

  const duplicates = {};
  const uniqueFields = fields.filter((f) => f.validation && f.validation.unique && !isEmpty(metadataValues[f.internalName]));

  if (!uniqueFields.length) return duplicates;

  const docWhere = { tenantId, documentTypeId, status: "ACTIVE" };
  if (excludeDocumentId) docWhere.id = { [Op.ne]: excludeDocumentId };

  const candidateDocs = await Document.findAll({ where: docWhere, attributes: ["id"] });
  const candidateIds = candidateDocs.map((d) => d.id);
  if (!candidateIds.length) return duplicates;

  const existingMetadata = await DocumentMetadata.findAll({
    where: { documentId: { [Op.in]: candidateIds } },
  });

  for (const field of uniqueFields) {
    const targetValue = String(metadataValues[field.internalName]).trim().toLowerCase();
    const clash = existingMetadata.find((row) => {
      const val = row.mappedMetadataJson && row.mappedMetadataJson[field.internalName];
      return val !== undefined && val !== null && String(val).trim().toLowerCase() === targetValue;
    });
    if (clash) {
      duplicates[field.internalName] = `${field.label} "${metadataValues[field.internalName]}" already exists on document #${clash.documentId}`;
    }
  }

  return duplicates;
}

module.exports = {
  validateFieldValue,
  validateMetadata,
  evaluateFormula,
  checkDuplicates,
  GSTIN_REGEX,
};
