// src/services/chunkingService.js
//
// Splits raw extracted text into overlapping chunks suitable for embedding.
// Prefers to break on paragraph/sentence boundaries near the target size
// rather than mid-word, while still guaranteeing every chunk stays within
// chunkSize (a single very long "sentence" is hard-split as a last resort).

const { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } = require("../constants/aiConstants");

function splitIntoSentences(text) {
  // Cheap sentence splitter: good enough for invoices/reports/contracts;
  // does not need to be linguistically perfect for RAG chunk boundaries.
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} text - full extracted document text (single page today,
 *   since OcrService currently rasterizes/OCRs only page 1 of PDFs).
 * @param {object} opts
 * @param {number} [opts.chunkSize]
 * @param {number} [opts.overlap]
 * @param {number} [opts.pageNumber] - page this text came from; stamped on every chunk for citations.
 * @returns {Array<{ content: string, pageNumber: number }>}
 */
function chunkText(text, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(opts.overlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2));
  const pageNumber = opts.pageNumber || 1;

  const clean = (text || "").replace(/\u0000/g, "").trim();
  if (!clean) return [];

  const sentences = splitIntoSentences(clean);
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
  };

  for (const sentence of sentences) {
    // A single sentence longer than chunkSize: hard-split it.
    if (sentence.length > chunkSize) {
      pushCurrent();
      current = "";
      for (let i = 0; i < sentence.length; i += chunkSize - overlap) {
        chunks.push(sentence.slice(i, i + chunkSize));
      }
      continue;
    }

    if ((current + " " + sentence).trim().length > chunkSize) {
      pushCurrent();
      // Start next chunk with overlap tail of the previous one for context continuity.
      const overlapTail = current.slice(Math.max(0, current.length - overlap));
      current = (overlapTail + " " + sentence).trim();
    } else {
      current = (current + " " + sentence).trim();
    }
  }
  pushCurrent();

  return chunks.map((content) => ({ content, pageNumber }));
}

module.exports = { chunkText };
