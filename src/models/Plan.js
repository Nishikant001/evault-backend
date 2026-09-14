const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Plan catalog — FREE / PAID today, Professional / Enterprise / Premium can
// be added later purely as new rows (see seeders/planSeeder.js). No
// business logic should ever switch on plan.name; only on PlanFeature rows
// (via subscriptionMiddleware) or, for the couple of hard-wired FREE/PAID
// rules (watermark, local-only storage), on Tenant.tenantType.
const Plan = sequelize.define(
  "Plan",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    isTrialable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    trialDurationDays: { type: DataTypes.INTEGER, allowNull: true },
    priceMonthly: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    priceYearly: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "plans",
    timestamps: true,
  },
);

module.exports = Plan;
