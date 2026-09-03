# Tenant Multi-ERP Connection Update

## Scope

This update changes only the tenant-to-ERP assignment relationship so a single tenant can have multiple ERP connections at the same time.

Examples:

- SAP -> Evault (INBOUND)
- Evault -> SAP (OUTBOUND)
- Additional ERP connections when required

Existing `Tenant.erpConfigId` is retained for backward compatibility. The new `tenant_erp_connections` mapping is authoritative for multi-connection assignments.

## Migration

Run from the backend project root:

```bash
npm run migrate:master
```

The migration creates `tenant_erp_connections` and backfills every existing non-null `tenants.erpConfigId` assignment.

## Frontend

Tenant Register/Edit ERP selection is now multi-select. Each option displays its integration mode:

- INBOUND = SAP -> Evault
- OUTBOUND = Evault -> SAP
- BOTH = both directions

No unrelated ERP/OData configuration or document functionality is changed.
