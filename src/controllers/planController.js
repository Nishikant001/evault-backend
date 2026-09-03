// src/controllers/planController.js
//
// SuperAdmin CRUD for the Plan/PlanFeature catalog. This is what lets
// Professional/Enterprise/Premium be added later purely through the API
// — no code deploy required, no changes to subscriptionMiddleware.js or
// any controller that gates on featureKey.

const { Plan, PlanFeature } = require("../models/master");

class PlanController {
  static async list(req, res) {
    try {
      const plans = await Plan.findAll({ include: [{ model: PlanFeature, as: "features" }] });
      return res.status(200).json({ success: true, data: plans });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async create(req, res) {
    try {
      const { code, name, isTrialable, trialDurationDays, priceMonthly, priceYearly, features } = req.body;
      if (!code || !name) {
        return res.status(400).json({ success: false, message: "code and name are required" });
      }

      const plan = await Plan.create({
        code,
        name,
        isTrialable: !!isTrialable,
        trialDurationDays: trialDurationDays || null,
        priceMonthly: priceMonthly || null,
        priceYearly: priceYearly || null,
        isActive: true,
      });

      if (Array.isArray(features)) {
        for (const featureKey of features) {
          await PlanFeature.create({ planId: plan.id, featureKey, enabled: true });
        }
      }

      return res.status(201).json({ success: true, data: plan });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const plan = await Plan.findByPk(id);
      if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

      const { name, isTrialable, trialDurationDays, priceMonthly, priceYearly, isActive } = req.body;
      await plan.update({
        ...(name !== undefined && { name }),
        ...(isTrialable !== undefined && { isTrialable }),
        ...(trialDurationDays !== undefined && { trialDurationDays }),
        ...(priceMonthly !== undefined && { priceMonthly }),
        ...(priceYearly !== undefined && { priceYearly }),
        ...(isActive !== undefined && { isActive }),
      });

      return res.status(200).json({ success: true, data: plan });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /** Upserts a single feature flag for a plan — used to toggle capabilities on/off without touching code. */
  static async setFeature(req, res) {
    try {
      const { id } = req.params;
      const { featureKey, enabled, limitValue } = req.body;
      if (!featureKey) return res.status(400).json({ success: false, message: "featureKey is required" });

      const [feature] = await PlanFeature.findOrCreate({
        where: { planId: id, featureKey },
        defaults: { enabled: !!enabled, limitValue: limitValue ?? null },
      });

      feature.enabled = !!enabled;
      if (limitValue !== undefined) feature.limitValue = limitValue;
      await feature.save();

      return res.status(200).json({ success: true, data: feature });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = PlanController;
