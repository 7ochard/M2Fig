"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { readZipEntries } = require("./read_zip_entries.js");
const { validateV2Package } = require("../ReceiveFromMasterGo/src/ui/packageValidation.js");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node tools/inspectBridgePackage.js <migration.zip> [report.json]");
  process.exit(2);
}
const entries = readZipEntries(input);
const manifestPaths = Object.keys(entries).filter(name => name === "manifest.json" || name.endsWith("/manifest.json"));
if (manifestPaths.length !== 1) throw new Error("Expected exactly one migration manifest.json");
const validation = validateV2Package(entries, { manifestPath: manifestPaths[0] });
if (!validation.ok) {
  console.error(JSON.stringify({ ok: false, errors: validation.errors }, null, 2));
  process.exit(1);
}
const manifest = validation.manifest;
const records = Array.from(validation.records.values(), item => item.record);
const byId = new Map(records.map(record => [record.id, record]));
const instances = records.filter(record => record.props?.sourceType === "INSTANCE" || record.props?.type === "INSTANCE" || record.mainComponentId);
const components = records.filter(record => record.props?.type === "COMPONENT");
const diagnostics = manifest.diagnostics || [];
const countBy = values => values.reduce((counts, key) => { counts[key] = (counts[key] || 0) + 1; return counts; }, {});
const bytes = fs.readFileSync(input);
const report = {
  ok: true,
  input: path.resolve(input),
  bytes: bytes.length,
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  canonicalDigest: validation.canonicalDigest,
  designPageCount: manifest.pages.filter(page => !page.isDependencyPage).length,
  dependencyPageCount: manifest.pages.filter(page => page.isDependencyPage).length,
  pages: manifest.pages.map(page => ({ id: page.id, name: page.name, layerCount: page.layerCount, isDependencyPage: !!page.isDependencyPage })),
  recordCount: records.length,
  assetCount: Object.keys(manifest.assets || {}).length,
  componentCount: components.length,
  emptyComponentIds: components.filter(record => !record.childIds?.length).map(record => record.id),
  sourceInstanceCount: instances.length,
  structureFallbackCount: instances.filter(record => record.instanceStructureFallback).length,
  unresolvedMainIds: [...new Set(instances.filter(record => !byId.has(record.mainComponentId)).map(record => record.mainComponentId || "missing"))],
  diagnosticCodes: countBy(diagnostics.map(item => item.code || "UNKNOWN")),
  diagnostics,
  limitation: "Package validity does not verify actual Figma component links, fonts, layout or rendering."
};
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n", "utf8");
const { diagnostics: details, ...summary } = report;
console.log(JSON.stringify({ ...summary, diagnosticExamples: details.slice(0, 4) }, null, 2));
