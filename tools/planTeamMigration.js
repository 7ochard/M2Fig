#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readUrl(value, service) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${service} URL`); }
  const hosts = service === "mastergo" ? ["mastergo.com", "www.mastergo.com"] : ["figma.com", "www.figma.com"];
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.port || url.username || url.password) {
    throw new Error(`Invalid ${service} URL host or protocol`);
  }
  return url;
}

function readSource(file) {
  if (!file || typeof file.name !== "string" || !file.name.trim()) throw new Error("MasterGo file name must not be empty");
  const url = readUrl(file.url, "mastergo");
  const direct = /^\/file\/(\d+)\/?$/.exec(url.pathname);
  const queryIds = url.searchParams.getAll("file");
  let id;
  if (direct) {
    id = direct[1];
    if (queryIds.length > 1 || (queryIds.length === 1 && queryIds[0] !== id)) {
      throw new Error("Conflicting MasterGo URL file IDs");
    }
  } else if (/^\/goto\/[^/]+\/?$/.test(url.pathname) && queryIds.length === 1 && /^\d+$/.test(queryIds[0])) {
    id = queryIds[0];
  } else {
    throw new Error("MasterGo URL must identify one file");
  }
  if (typeof file.id !== "string" || file.id !== id) throw new Error("MasterGo id does not match URL");
  return { id, name: file.name, url: url.href };
}

function readTarget(value) {
  const file = typeof value === "string" ? { url: value } : value;
  if (!file || typeof file !== "object") throw new Error("Invalid Figma target");
  const url = readUrl(file.url, "figma");
  const target = /^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
  if (!target) throw new Error("Figma URL must identify a Design file");
  const id = target[1];
  for (const key of ["fileKey", "id"]) {
    if (file[key] !== undefined && file[key] !== id) throw new Error(`Figma ${key} does not match URL`);
  }
  const result = { mode: "existing", editorType: "design", fileKey: id, url: url.href };
  for (const key of ["name", "fileName"]) {
    if (file[key] !== undefined) {
      if (typeof file[key] !== "string") throw new Error("Figma target name must be a string");
      result[key] = file[key];
    }
  }
  for (const key of ["createdByBridge", "planKey", "projectId"]) {
    if (file[key] !== undefined) result[key] = file[key];
  }
  return result;
}

function validateObservation(target, observation) {
  if (observation === undefined) return;
  if (!target || !observation || observation.fileKey !== target.fileKey) throw new Error("Target observation fileKey does not match target");
  if (observation.fileName !== undefined && observation.fileName !== null && typeof observation.fileName !== "string") {
    throw new Error("Target observation fileName must be a string or null");
  }
  if (observation.isEmpty !== undefined && observation.isEmpty !== null && typeof observation.isEmpty !== "boolean") {
    throw new Error("Target observation isEmpty must be boolean or unknown");
  }
}

function resolveMigrationTarget(sourceName, target, observation) {
  if (typeof sourceName !== "string" || !sourceName.trim()) throw new Error("Source name must not be empty");
  const createNew = { mode: "create-new", fileName: sourceName, editorType: "design" };
  const existing = target === undefined ? undefined : readTarget(target);
  validateObservation(existing, observation);
  if (!existing) return { target: createNew };
  if (observation?.isEmpty === true && typeof observation.fileName === "string" && observation.fileName.trim() && observation.fileName !== sourceName) {
    return { target: createNew, previousTarget: existing };
  }
  return { target: existing };
}

function hasConfirmationEvidence(value) {
  return value === true || (typeof value === "string" && value.trim().length > 0) ||
    (!!value && typeof value === "object" && Object.keys(value).length > 0);
}

function userConfirmed(task) {
  return task.userConfirmed === true || task.userReportedImportSuccess === true ||
    (task.importCompleted === true && (hasConfirmationEvidence(task.acceptanceEvidence) || hasConfirmationEvidence(task.userConfirmation)));
}

function planTeamMigration(inventory, previousRun) {
  if (!inventory || typeof inventory.teamName !== "string" || !inventory.teamName.trim() ||
      !Array.isArray(inventory.mastergo)) {
    throw new Error("Expected teamName and mastergo[] inventory");
  }
  const previousById = new Map();
  if (previousRun !== undefined) {
    if (previousRun.teamName !== inventory.teamName) throw new Error("Resume teamName does not match inventory");
    if (!Array.isArray(previousRun.tasks)) throw new Error("Resume run must contain tasks[]");
    for (const task of previousRun.tasks) {
      const id = task?.source?.id;
      if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Resume task has no valid source.id");
      if (previousById.has(id)) throw new Error(`Duplicate resume source.id: ${id}`);
      previousById.set(id, task);
    }
  }
  const seenIds = new Set();
  const tasks = inventory.mastergo.map(file => {
    const source = readSource(file);
    if (seenIds.has(source.id)) throw new Error(`Duplicate MasterGo id: ${source.id}`);
    seenIds.add(source.id);
    const previous = previousById.get(source.id);
    const priorTarget = previous?.target && (previous.target.fileKey || previous.target.url) ? readTarget(previous.target) : undefined;
    const preserved = previous?.previousTarget ? readTarget(previous.previousTarget) : undefined;
    const suppliedTarget = file.target === undefined ? undefined : readTarget(file.target);
    if (priorTarget && suppliedTarget && priorTarget.fileKey !== suppliedTarget.fileKey && preserved?.fileKey !== suppliedTarget.fileKey) {
      throw new Error(`Resume target conflict for source ${source.id}`);
    }
    const chosenTarget = priorTarget || suppliedTarget;
    validateObservation(suppliedTarget || chosenTarget, file.targetObservation);
    const base = { ...structuredClone(previous || {}), scope: "whole-file", source };
    if (previous && userConfirmed(previous)) {
      if (!priorTarget) throw new Error(`User-confirmed source ${source.id} has no recorded real target`);
      return { ...base, target: priorTarget, status: "skipped-user-confirmed", userConfirmed: true, importCompleted: true };
    }
    // A preserved old target's observation cannot replace the run's newer target.
    const activeObservation = file.targetObservation?.fileKey === chosenTarget?.fileKey ? file.targetObservation : undefined;
    const decision = resolveMigrationTarget(source.name, chosenTarget, activeObservation);
    const priorStatus = previous?.status === "skipped-user-confirmed" ? undefined : previous?.status;
    return { ...base, ...decision, status: decision.previousTarget ? "pending-source-zip" : priorStatus || "pending-source-zip" };
  });
  return { teamName: inventory.teamName, scope: "whole-file", tasks };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const [input, output] = args;
    if (!(args.length === 2 || (args.length === 4 && args[2] === "--resume")) || !input || !output) {
      throw new Error("Usage: node tools/planTeamMigration.js <inventory.json> <plan.json> [--resume run.json]");
    }
    const inventory = JSON.parse(fs.readFileSync(input, "utf8").replace(/^\uFEFF/, ""));
    const previous = args.length === 4 ? JSON.parse(fs.readFileSync(args[3], "utf8").replace(/^\uFEFF/, "")) : undefined;
    const plan = planTeamMigration(inventory, previous);
    fs.writeFileSync(output, JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ output: path.resolve(output), tasks: plan.tasks.length }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { planTeamMigration, resolveMigrationTarget };
