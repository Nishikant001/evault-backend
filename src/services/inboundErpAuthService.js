"use strict";

const { verifySecret } = require("./erpCredentialService");

class InboundErpAuthError extends Error {
  constructor(publicMessage, status, code) {
    super(publicMessage);
    this.name = "InboundErpAuthError";
    this.publicMessage = publicMessage;
    this.status = status;
    this.code = code;
  }
}

async function resolveInboundErpTenantContext({
  username,
  password,
  masterModels,
}) {
  if (
    !masterModels?.ErpConfig ||
    !masterModels?.TenantErpConnection ||
    !masterModels?.Tenant
  ) {
    throw new Error(
      "Inbound ERP authentication models are not available"
    );
  }

  if (!username || !password) {
    throw new InboundErpAuthError(
      "Invalid ERP API credentials",
      401,
      "MISSING_CREDENTIALS"
    );
  }

  const { ErpConfig, TenantErpConnection, Tenant } = masterModels;

  // Find the ERP configuration using the inbound API username.
  const erpConfigs = await ErpConfig.findAll({
    where: { inboundUsername: username },
  });

  if (
    erpConfigs.length !== 1 ||
    !verifySecret(password, erpConfigs[0].inboundPassword)
  ) {
    throw new InboundErpAuthError(
      "Invalid ERP API credentials",
      401,
      "BAD_CREDENTIALS"
    );
  }

  const erpConfig = erpConfigs[0];

  // Inbound must be enabled for this ERP connection.
  if (erpConfig.integrationMode === "OUTBOUND") {
    throw new InboundErpAuthError(
      "ERP connection is not enabled for inbound integration",
      403,
      "INBOUND_DISABLED"
    );
  }

  if (!["ACTIVE", "CONNECTED"].includes(erpConfig.status)) {
    throw new InboundErpAuthError(
      "ERP connection is not active",
      403,
      "ERP_INACTIVE"
    );
  }

  // Resolve tenant through the explicit Multi-ERP assignment.
  const assignments = await TenantErpConnection.findAll({
    where: {
      erpConfigId: erpConfig.id,
      isActive: true,
    },
    include: [
      {
        model: Tenant,
        required: true,
        where: {
          status: "ACTIVE",
          erpEnabled: true,
        },
      },
    ],
  });

  if (assignments.length === 0) {
    throw new InboundErpAuthError(
      "No active tenant is assigned to this ERP connection",
      403,
      "NO_ACTIVE_TENANT"
    );
  }

  if (assignments.length > 1) {
    throw new InboundErpAuthError(
      "ERP connection is assigned to multiple active tenants",
      409,
      "AMBIGUOUS_TENANT"
    );
  }

  return {
    tenant: assignments[0].Tenant,
    erpConfig,
  };
}

module.exports = {
  resolveInboundErpTenantContext,
  InboundErpAuthError,
};