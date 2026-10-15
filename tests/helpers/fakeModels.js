// Minimal in-memory stand-ins for Sequelize models (tests only).
function makeModel(defaults = {}) {
  const rows = [];
  const wrap = (data) => { const row = { ...data, update: async (u) => { Object.assign(row, u); return row; } }; return row; };
  return {
    _rows: rows,
    findOne: async ({ where }) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) || null,
    create: async (d) => { const r = wrap({ id: rows.length + 1, ...defaults, ...d }); rows.push(r); return r; },
    upsert: async (d) => { let r = rows.find((x) => x.documentId === d.documentId); if (r) Object.assign(r, d); else { r = wrap({ id: rows.length + 1, ...defaults, ...d }); rows.push(r); } return [r, false]; },
  };
}
const makeModels = () => ({ OcrSettings: makeModel({ engineMode: "TESSERACT", isProviderEnabled: false, fallbackToTesseract: true }), DocumentMetadata: makeModel({ correctionHistory: [], status: "PENDING_REVIEW" }) });
module.exports = { makeModel, makeModels };
