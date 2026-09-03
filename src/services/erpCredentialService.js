"use strict";

const crypto = require("crypto");
const { encrypt, decrypt } = require("../utils/cryptoUtil");

const PREFIX = "enc:v1:";

function encryptSecret(value) {
  if (value === undefined || value === null || value === "") return null;
  const plain = String(value);
  return PREFIX + encrypt(plain);
}

function decryptSecret(value) {
  if (value === undefined || value === null || value === "") return null;
  const stored = String(value);

  // Backward compatible with existing ERP rows that may still contain a
  // legacy plaintext credential. New writes always use encrypted storage.
  if (!stored.startsWith(PREFIX)) return stored;

  return decrypt(stored.slice(PREFIX.length));
}

function verifySecret(candidate, storedValue) {
  if (candidate === undefined || candidate === null || storedValue === undefined || storedValue === null) {
    return false;
  }

  const expected = decryptSecret(storedValue);
  if (expected === null) return false;

  const a = Buffer.from(String(candidate), "utf8");
  const b = Buffer.from(String(expected), "utf8");

  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(Math.max(a.length, 1)), Buffer.alloc(Math.max(a.length, 1)));
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

module.exports = { PREFIX, encryptSecret, decryptSecret, verifySecret };
