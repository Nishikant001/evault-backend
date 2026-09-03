const { SystemModule, TenantModule, Tenant } = require("../models/masterDb");
const { getEnabledModulesForTenant } = require("../services/tenantModuleService");

function normalizeModule(row) {
  return {
    id: row.id,
    module_key: row.moduleKey,
    module_name: row.moduleName,
    description: row.description,
    icon: row.icon,
    route_key: row.routeKey,
    is_default: !!row.isDefault,
    enabled: !!row.isActive,
  };
}

class TenantModuleController {
  static async myModules(req, res) {
    try {
      if (req.user.role === "SuperAdmin") {
        const modules = await SystemModule.findAll({ where: { isActive: true }, order: [["moduleName", "ASC"]] });
        return res.json({ success: true, data: modules.map(normalizeModule) });
      }
      const modules = await getEnabledModulesForTenant(req.user.tenantId);
      return res.json({ success: true, data: modules.map(normalizeModule) });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async list(req, res) {
    try {
      const modules = await SystemModule.findAll({ order: [["moduleName", "ASC"]] });
      return res.json({ success: true, data: modules.map(normalizeModule) });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async create(req, res) {
    try {
      const { moduleKey, moduleName, description, icon, routeKey, isActive = true, isDefault = false } = req.body || {};
      if (!moduleKey || !moduleName) return res.status(400).json({ success: false, message: "moduleKey and moduleName are required" });
      const exists = await SystemModule.findOne({ where: { moduleKey } });
      if (exists) return res.status(409).json({ success: false, message: "Module key already exists" });
      const module = await SystemModule.create({ moduleKey, moduleName, description: description || null, icon: icon || null, routeKey: routeKey || null, isActive: !!isActive, isDefault: !!isDefault });
      return res.status(201).json({ success: true, data: normalizeModule(module) });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async update(req, res) {
    try {
      const module = await SystemModule.findByPk(req.params.id);
      if (!module) return res.status(404).json({ success: false, message: "Module not found" });
      const allowed = ["moduleName", "description", "icon", "routeKey", "isDefault", "isActive"];
      for (const key of allowed) if (req.body?.[key] !== undefined) module[key] = req.body[key];
      await module.save();
      return res.json({ success: true, data: normalizeModule(module) });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async tenantAssignments(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.tenantId);
      if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });
      const rows = await TenantModule.findAll({ where: { tenantId: tenant.id }, include: [{ model: SystemModule, attributes: ["id", "moduleKey", "moduleName", "description", "icon", "routeKey", "isDefault", "isActive"] }], order: [[SystemModule, "moduleName", "ASC"]] });
      return res.json({ success: true, data: rows.map((r) => ({ id: r.id, tenantId: r.tenantId, moduleId: r.moduleId, enabled: !!r.isEnabled, assignedAt: r.assignedAt, module: normalizeModule(r.SystemModule) })) });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async assign(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.tenantId);
      const module = await SystemModule.findByPk(req.params.moduleId);
      if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });
      if (!module) return res.status(404).json({ success: false, message: "Module not found" });
      if (!module.isActive) return res.status(400).json({ success: false, message: "Inactive modules cannot be assigned" });
      const [row, created] = await TenantModule.findOrCreate({ where: { tenantId: tenant.id, moduleId: module.id }, defaults: { isEnabled: true, assignedBy: req.user.id, assignedAt: new Date() } });
      if (!created && !row.isEnabled) { row.isEnabled = true; row.assignedBy = req.user.id; row.assignedAt = new Date(); await row.save(); }
      return res.status(created ? 201 : 200).json({ success: true, data: { id: row.id, tenantId: row.tenantId, moduleId: row.moduleId, enabled: row.isEnabled } });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async unassign(req, res) {
    try {
      const row = await TenantModule.findOne({ where: { tenantId: req.params.tenantId, moduleId: req.params.moduleId } });
      if (!row) return res.status(404).json({ success: false, message: "Module assignment not found" });
      await row.destroy();
      return res.json({ success: true, message: "Module unassigned" });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }

  static async setEnabled(req, res) {
    try {
      const row = await TenantModule.findOne({ where: { tenantId: req.params.tenantId, moduleId: req.params.moduleId } });
      if (!row) return res.status(404).json({ success: false, message: "Module assignment not found" });
      if (typeof req.body?.isEnabled !== "boolean") return res.status(400).json({ success: false, message: "isEnabled must be boolean" });
      row.isEnabled = req.body.isEnabled;
      await row.save();
      return res.json({ success: true, data: { id: row.id, tenantId: row.tenantId, moduleId: row.moduleId, enabled: row.isEnabled } });
    } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
  }
}

module.exports = TenantModuleController;
