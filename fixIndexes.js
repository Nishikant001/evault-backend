const { sequelize } = require("./src/config/database");

(async () => {
  try {
    console.log("🔍 Finding duplicate indexes...");

    const [indexes] = await sequelize.query(`
      SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND INDEX_NAME != 'PRIMARY'
      ORDER BY TABLE_NAME, COLUMN_NAME;
    `);

    const seen = {};
    const duplicates = [];

    indexes.forEach((idx) => {
      const key = `${idx.TABLE_NAME}-${idx.COLUMN_NAME}`;

      if (!seen[key]) {
        seen[key] = idx.INDEX_NAME;
      } else {
        duplicates.push(idx);
      }
    });

    console.log("⚠️ Duplicate Indexes Found:", duplicates.length);

    for (let dup of duplicates) {
      const dropQuery = `ALTER TABLE ${dup.TABLE_NAME} DROP INDEX ${dup.INDEX_NAME}`;
      console.log("🗑️", dropQuery);

      await sequelize.query(dropQuery);
    }

    console.log("✅ All duplicate indexes removed!");
    process.exit();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
})();