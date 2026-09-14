const { SystemModule, TenantModule, Tenant } = require("../models/masterDb");

async function listModules() {
  return SystemModule.findAll({ order: [["moduleName", "ASC"]] });
}

async function getTenantAssignments(tenantId) {
  return TenantModule.findAll({
    where: { tenantId },
    include: [{ model: SystemModule, attributes: ["id", "moduleKey", "moduleName", "description", "icon", "routeKey", "isDefault", "isActive"] }],
    order: [[SystemModule, "moduleName", "ASC"]],
  });
}

async function getEnabledModulesForTenant(tenantId) {
  return SystemModule.findAll({
    where: { isActive: true },
    include: [{ model: TenantModule, as: "tenantAssignments", where: { tenantId, isEnabled: true }, required: true, attributes: [] }],
    order: [["moduleName", "ASC"]],
  });
}

async function assertTenantModule(tenantId, moduleKey) {
  const module = await SystemModule.findOne({ where: { moduleKey, isActive: true } });
  if (!module) return { allowed: false, reason: "MODULE_NOT_ACTIVE" };
  const assignment = await TenantModule.findOne({ where: { tenantId, moduleId: module.id, isEnabled: true } });
  return assignment ? { allowed: true, module } : { allowed: false, reason: "MODULE_NOT_ASSIGNED", module };
}

async function assertTenantExists(tenantId) {
  return Tenant.findByPk(tenantId);
}

// New tenants retain today's behavior by receiving only modules marked as
// default/core. Newly registered optional modules remain unassigned until
// SuperAdmin explicitly grants them.
async function ensureDefaultTenantModules(tenantId, assignedBy = null) {
  const defaults = await SystemModule.findAll({ where: { isActive: true, isDefault: true }, attributes: ["id"] });
  if (!defaults.length) return;
  const now = new Date();
  await TenantModule.bulkCreate(
    defaults.map((module) => ({ tenantId, moduleId: module.id, isEnabled: true, assignedBy, assignedAt: now, createdAt: now, updatedAt: now })),
    { ignoreDuplicates: true },
  );
}

module.exports = { listModules, getTenantAssignments, getEnabledModulesForTenant, assertTenantModule, assertTenantExists, ensureDefaultTenantModules };
