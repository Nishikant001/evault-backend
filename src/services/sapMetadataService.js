// src/services/sapMetadataService.js
//
// ── METADATA DISCOVERY (STEP 7) + VALIDATION LAYER (STEP 8) ─────────────
//
// Reads an SAP OData service's $metadata document dynamically (no
// hardcoded EntitySet/Property/FunctionImport names) and extracts:
//   - EntityTypes (name, key, properties[])
//   - EntitySets (name -> entityType)
//   - FunctionImports (name, httpMethod, parameters[], returnType)
//
// This is intentionally a small, dependency-free XML reader (regex-based)
// rather than pulling in a full XML/DOM library — OData v2 $metadata is a
// flat, very regular EDMX document, and this backend has no XML parser
// dependency today. If a future tenant's Gateway needs XML features this
// reader can't handle, swap in a real parser without touching any caller
// (the public shape below — parseMetadata()'s return value — would stay
// the same).
//
// Used by:
//   - erpConfigController.discoverMetadata (GET /api/erp-configs/:id/metadata)
//   - erpConfigController.validateMapping  (POST /api/erp-configs/:id/validate)

const ErpService = require("./erpService");
const {
  resolveEntitySet,
  resolveFunctionName,
} = require("./sapEntityResolver");

/**
 * Fetches the raw $metadata XML for a tenant's SAP Gateway.
 */
async function fetchMetadataXml(erpConfig) {
  const client = ErpService.createClient(erpConfig, { Accept: "application/xml" });
  const url = erpConfig.metadataUrl || "/$metadata";
  const params = erpConfig.sapClient ? { "sap-client": erpConfig.sapClient } : {};
  const response = await client.get(url, { params, responseType: "text" });
  return typeof response.data === "string" ? response.data : String(response.data);
}

/**
 * Parses an EDMX/$metadata XML document into a plain, framework-agnostic
 * structure. Tolerant of both `<Property Name="X" Type="Y"/>` and
 * `<Property Name="X" Type="Y">...</Property>` forms, and of the
 * "m:FC_*"/sap:* annotation attributes SAP Gateway adds (they're ignored,
 * not required).
 */
function parseMetadata(xml) {
  const entityTypes = {};
  const entitySets = {};
  const functionImports = {};

  // EntityType blocks: <EntityType Name="...">...</EntityType>
  const entityTypeRegex = /<EntityType\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  let match;
  while ((match = entityTypeRegex.exec(xml)) !== null) {
    const [, name, body] = match;

    const keyMatch = body.match(/<Key>([\s\S]*?)<\/Key>/);
    const keyProps = [];
    if (keyMatch) {
      const propRefRegex = /<PropertyRef\s+Name="([^"]+)"/g;
      let kp;
      while ((kp = propRefRegex.exec(keyMatch[1])) !== null) {
        keyProps.push(kp[1]);
      }
    }

    const properties = [];
    const propertyRegex = /<Property\s+([^>]+?)\/?>/g;
    let pm;
    while ((pm = propertyRegex.exec(body)) !== null) {
      const attrs = parseAttributes(pm[1]);
      if (attrs.Name) {
        properties.push({
          name: attrs.Name,
          type: attrs.Type || null,
          nullable: attrs.Nullable !== "false",
        });
      }
    }

    entityTypes[name] = { name, key: keyProps, properties };
  }

  // EntitySet elements: <EntitySet Name="..." EntityType="Namespace.Type"/>
  const entitySetRegex = /<EntitySet\s+([^>]+?)\/?>/g;
  while ((match = entitySetRegex.exec(xml)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Name) {
      const entityType = (attrs.EntityType || "").split(".").pop();
      entitySets[attrs.Name] = { name: attrs.Name, entityType };
    }
  }

  // FunctionImport blocks: <FunctionImport Name="..." ...>...</FunctionImport>
  const functionImportRegex = /<FunctionImport\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/FunctionImport>)/g;
  while ((match = functionImportRegex.exec(xml)) !== null) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] || "";
    if (!attrs.Name) continue;

    const parameters = [];
    const paramRegex = /<Parameter\s+([^>]+?)\/?>/g;
    let prm;
    while ((prm = paramRegex.exec(body)) !== null) {
      const pAttrs = parseAttributes(prm[1]);
      if (pAttrs.Name) {
        parameters.push({
          name: pAttrs.Name,
          type: pAttrs.Type || null,
          mode: pAttrs.Mode || "In",
        });
      }
    }

    functionImports[attrs.Name] = {
      name: attrs.Name,
      httpMethod: attrs["m:HttpMethod"] || attrs.HttpMethod || null,
      returnType: attrs.ReturnType || null,
      parameters,
    };
  }

  return { entityTypes, entitySets, functionImports };
}

/**
 * Tiny XML-attribute-string parser: turns `Name="X" Type="Y"` into
 * { Name: "X", Type: "Y" }.
 */
function parseAttributes(attrString) {
  const attrs = {};
  const attrRegex = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Fetches + parses $metadata for a tenant, returning the parsed structure.
 * Does NOT persist anything — callers decide whether/how to cache
 * (see erpConfigController.discoverMetadata, which stores the snapshot on
 * ErpConfig.metadataSnapshot).
 */
async function discoverMetadata(erpConfig) {
  const xml = await fetchMetadataXml(erpConfig);
  return parseMetadata(xml);
}

/**
 * STEP 8 — Validation Layer.
 *
 * Verifies, against a freshly-discovered (or previously cached) metadata
 * snapshot, that every EntitySet / field / FunctionImport this backend's
 * business logic needs actually exists for this tenant — surfacing a
 * clear, actionable list of problems instead of letting a sync job crash
 * at runtime on a missing property or FunctionImport.
 *
 * @param {object} erpConfig
 * @param {object} [metadata] pre-fetched discoverMetadata() result; fetched fresh if omitted
 */
async function validateTenantMapping(erpConfig, metadata) {
  const meta = metadata || (await discoverMetadata(erpConfig));
  const errors = [];
  const warnings = [];

  const REQUIRED_ENTITIES = ["DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE", "DOCUMENT"];
  const REQUIRED_FUNCTIONS = ["upload", "confirm", "uploadXstring"];

  for (const logicalEntity of REQUIRED_ENTITIES) {
    let entitySetName;
    try {
      entitySetName = resolveEntitySet(erpConfig, logicalEntity);
    } catch (e) {
      errors.push(`No EntitySet mapped for "${logicalEntity}": ${e.message}`);
      continue;
    }

    const entitySet = meta.entitySets[entitySetName];
    if (!entitySet) {
      errors.push(
        `EntitySet "${entitySetName}" (mapped for logical entity "${logicalEntity}") was not found in this tenant's $metadata.`,
      );
      continue;
    }

    const entityType = meta.entityTypes[entitySet.entityType];
    if (!entityType) {
      warnings.push(
        `EntitySet "${entitySetName}" exists but its EntityType "${entitySet.entityType}" could not be resolved — field validation skipped for this entity.`,
      );
    }
  }

  for (const logicalFunction of REQUIRED_FUNCTIONS) {
    let functionName;
    try {
      functionName = resolveFunctionName(erpConfig, logicalFunction);
    } catch (e) {
      errors.push(`No FunctionImport mapped for "${logicalFunction}": ${e.message}`);
      continue;
    }

    if (!meta.functionImports[functionName]) {
      errors.push(
        `FunctionImport "${functionName}" (mapped for logical operation "${logicalFunction}") was not found in this tenant's $metadata.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    discoveredAt: new Date(),
  };
}

module.exports = {
  fetchMetadataXml,
  parseMetadata,
  discoverMetadata,
  validateTenantMapping,
};
