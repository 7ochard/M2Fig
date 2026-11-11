import { PageExportTarget } from "../../shared/types";
import { isOutOfMemoryError, safeRead, yieldToEventLoop } from "../../shared/utils";
import { captureConnectorSvg } from "./connectorSvgExporter";

type InstanceMetadata = {
  mainComponentId?: string;
  missingMainComponentId?: string;
  instanceStructureFallback?: boolean;
  instanceScale?: number;
};

type NodeShape = {
  type: string;
  children: string[];
  isMask: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor?: number;
};

const dependencyNodes: { [id: string]: any } = {};
const instanceMetadata: { [id: string]: InstanceMetadata } = {};
let exportDiagnostics: any[] = [];
let unreadableNodes = new WeakSet<object>();
let unreadableDiagnosticKeys = new Set<string>();
let exportChildIds: { [id: string]: string[] } = Object.create(null);
let unresolvedGridDiagnostic: any = null;
let unresolvedImageDiagnostic: any = null;

export function getExportChildIds(id: string): string[] | undefined {
  return exportChildIds[id];
}

export function recordUnresolvedLayoutGrids(): void {
  if (!unresolvedGridDiagnostic) {
    unresolvedGridDiagnostic = {
      code: "LAYOUT_GRID_UNRESOLVED", affectedNodeCount: 0,
      message: "为避免逐容器切换选择，空布局网格未触发宿主懒解析；辅助网格可能未恢复。"
    };
    exportDiagnostics.push(unresolvedGridDiagnostic);
  }
  unresolvedGridDiagnostic.affectedNodeCount++;
}

export function recordUnresolvedImagePaints(paintCount: number, documentNodeLimit: number): void {
  if (!unresolvedImageDiagnostic) {
    unresolvedImageDiagnostic = {
      code: "IMAGE_PAINT_UNRESOLVED", reason: "document-node-limit", documentNodeLimit,
      affectedNodeCount: 0, affectedPaintCount: 0,
      message: "大文件已跳过逐图 SVG/PNG 渲染和容器克隆探测；保留原图及已读取的裁剪、滤镜属性，私有裁剪或色相可能存在差异。"
    };
    exportDiagnostics.push(unresolvedImageDiagnostic);
  }
  unresolvedImageDiagnostic.affectedNodeCount++;
  unresolvedImageDiagnostic.affectedPaintCount += paintCount;
}

export function recordUnreadableExportNode(node: any, parent: string | null, index: number, error: unknown): void {
  if (isOutOfMemoryError(error)) throw error;
  if (node && (typeof node === "object" || typeof node === "function")) unreadableNodes.add(node);
  const message = error instanceof Error ? error.message : String(error);
  const id = safeRead(() => node && node.id, "") || /node with id ["']([^"']+)["']/i.exec(message)?.[1] || "";
  const key = `${id}:${parent}:${index}:${message}`;
  if (unreadableDiagnosticKeys.has(key)) return;
  unreadableDiagnosticKeys.add(key);
  exportDiagnostics.push({ code: "UNREADABLE_SOURCE_NODE", id, parent, index, error: message });
}

export function isReadableExportNode(node: any, parent: string | null = null, index = 0): boolean {
  if (!node || unreadableNodes.has(node)) return false;
  try {
    if (!node.id || !node.type) throw new Error("源图层缺少可读取的 ID 或类型");
    return true;
  } catch (error) {
    recordUnreadableExportNode(node, parent, index, error);
    return false;
  }
}

export function resetExportDependencies(): void {
  for (const id in dependencyNodes) delete dependencyNodes[id];
  for (const id in instanceMetadata) delete instanceMetadata[id];
  exportDiagnostics = [];
  unreadableNodes = new WeakSet<object>();
  unreadableDiagnosticKeys = new Set<string>();
  exportChildIds = Object.create(null);
  unresolvedGridDiagnostic = null;
  unresolvedImageDiagnostic = null;
}

// External definitions can be exposed by mainComponent even when the host's
// getNodeById cannot resolve their ids. Keep only their read-only host handles.
export function resolveExportNode(id: string, parent: string | null = null, index = 0): SceneNode | null {
  try {
    const node = dependencyNodes[id] || mg.getNodeById(id) as SceneNode | null;
    return isReadableExportNode(node, parent, index) ? node : null;
  } catch (error) {
    recordUnreadableExportNode(null, parent, index, error);
    return null;
  }
}

export function applyExportInstanceMetadata(record: any): void {
  const metadata = instanceMetadata[record.id];
  if (metadata) Object.assign(record, metadata);
}

export async function prepareExportDependencies(
  targets: PageExportTarget[],
  getChildren: (node: any) => SceneNode[]
): Promise<{ targets: PageExportTarget[]; hasInstances: boolean; diagnostics: any[]; nodeCount: number; rootCount: number }> {
  resetExportDependencies();
  const canvasIds = new Set<string>();
  const dependencyIds = new Set<string>();
  const shapes: { [id: string]: NodeShape } = {};
  const referencedComponents: any[] = [];
  const candidates: any[] = [];
  const diagnostics = exportDiagnostics;
  let scanned = 0;

  async function scan(roots: any[], dependency: boolean, parentId: string | null = null): Promise<void> {
    const stack = roots.map((node, index) => ({ node, parentId, index })).reverse();
    const included = dependency ? dependencyIds : canvasIds;
    while (stack.length > 0) {
      const item = stack.pop()!;
      const { node } = item;
      if (!isReadableExportNode(node, item.parentId, item.index)) continue;
      const id = safeRead(() => node.id, "");
      if (!id) continue;
      if (included.has(id)) continue;
      const type = safeRead(() => node.type, "");
      if (type === "CONNECTOR") {
        try {
          await captureConnectorSvg(node);
        } catch (error) {
          recordUnreadableExportNode(node, item.parentId, item.index, error);
          continue;
        }
      }
      included.add(id);
      if (dependency) dependencyNodes[id] = node;
      const children = getChildren(node).filter((child, index) => isReadableExportNode(child, id, index));
      exportChildIds[id] = children.map(child => child.id);
      shapes[id] = {
        type, children: exportChildIds[id],
        isMask: safeRead(() => node.isMask, false),
        width: safeRead(() => node.width, 0), height: safeRead(() => node.height, 0),
        x: safeRead(() => node.x, 0), y: safeRead(() => node.y, 0),
        scaleFactor: safeRead(() => node.scaleFactor, undefined)
      };
      if (type === "INSTANCE") {
        const component = safeRead(() => node.mainComponent, null);
        const componentId = component && safeRead(() => component.id, "");
        if (componentId && safeRead(() => component.type, "") === "COMPONENT") {
          instanceMetadata[id] = { mainComponentId: componentId };
          dependencyNodes[componentId] = component;
          referencedComponents.push(component);
        } else {
          instanceMetadata[id] = { missingMainComponentId: componentId || "", instanceStructureFallback: true };
          diagnostics.push({ code: "COMPONENT_DEFINITION_MISSING", nodeId: id, componentId: componentId || "" });
        }
      }
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index], parentId: id, index });
      }
      if (++scanned % 500 === 0) await yieldToEventLoop();
    }
  }

  for (const target of targets) {
    target.nodes = target.nodes || getChildren(target.page);
    await scan(target.nodes, false, target.page.id);
  }

  for (let index = 0; index < referencedComponents.length; index++) {
    const component = referencedComponents[index];
    if (canvasIds.has(component.id) || dependencyIds.has(component.id)) continue;
    const parent = safeRead(() => component.parent, null);
    const root = parent && safeRead(() => parent.type, "") === "COMPONENT_SET" ? parent : component;
    candidates.push(root);
    await scan([root], true);
  }

  // Keep a pure-id topology for the serialization pass. Descendants rejected
  // while probing connectors must not remain in their parent's child list.
  for (const id in exportChildIds) {
    exportChildIds[id] = exportChildIds[id].filter(childId => exportChildIds[childId] !== undefined);
    shapes[id].children = exportChildIds[id];
  }
  for (const target of targets) {
    target.nodes = (target.nodes || []).filter(node => exportChildIds[safeRead(() => node.id, "")] !== undefined);
  }

  // An outer dependency can contain a master already discovered on its own.
  // Emit it only through that outer root so source ids remain globally unique.
  const candidateIds = new Set(candidates.map(node => node.id));
  const roots = candidates.filter(node => {
    const seen = new Set<string>([node.id]);
    let parent = safeRead(() => node.parent, null);
    while (parent && !seen.has(parent.id)) {
      if (candidateIds.has(parent.id)) return false;
      seen.add(parent.id);
      parent = safeRead(() => parent.parent, null);
    }
    return true;
  });

  const signatures: { [id: string]: number } = {};
  const internedSignatures = new Map<string, number>();
  const activeSignatures = new Set<string>();
  function signature(id: string): number {
    if (signatures[id] !== undefined) return signatures[id];
    const node = shapes[id];
    if (!node || activeSignatures.has(id)) return -1;
    activeSignatures.add(id);
    const type = node.type === "INSTANCE" ? "FRAME" : node.type;
    const maskComponent = node.isMask ? instanceMetadata[id]?.mainComponentId || "" : "";
    // Child fingerprints are integers, not recursively JSON-escaped strings.
    // A deeply nested design therefore keeps linear-size structural keys.
    const key = JSON.stringify([type, maskComponent, node.children.map(signature)]);
    activeSignatures.delete(id);
    if (!internedSignatures.has(key)) internedSignatures.set(key, internedSignatures.size);
    return signatures[id] = internedSignatures.get(key) as number;
  }

  function matchesScale(actualId: string, expectedId: string, scale: number): boolean {
    const actual = shapes[actualId];
    const expected = shapes[expectedId];
    if (!actual || !expected || actual.children.length !== expected.children.length) return false;
    const close = (a: number, b: number) => Math.abs(a - b * scale) <= 0.02;
    if (!close(actual.width, expected.width) || !close(actual.height, expected.height) ||
        !close(actual.x, expected.x) || !close(actual.y, expected.y)) return false;
    return actual.children.every((id, index) => matchesScale(id, expected.children[index], scale));
  }

  for (const id in instanceMetadata) {
    const metadata = instanceMetadata[id];
    if (!metadata.mainComponentId) continue;
    const actual = shapes[id];
    const expected = shapes[metadata.mainComponentId];
    const sameStructure = expected && actual.children.length === expected.children.length &&
      actual.children.every((child, index) => signature(child) === signature(expected.children[index]));
    if (!sameStructure) {
      metadata.instanceStructureFallback = true;
    } else if (typeof actual.scaleFactor === "number" && Number.isFinite(actual.scaleFactor) && actual.scaleFactor > 0) {
      // The native scale and the instance's resizable outer box are independent.
      // Receiver rescales first, then restores the exact exported outer box.
      if (Math.abs(actual.scaleFactor - 1) > 0.00001) metadata.instanceScale = actual.scaleFactor;
    } else if (expected.width > 0 && expected.height > 0) {
      const scale = actual.width / expected.width;
      const heightScale = actual.height / expected.height;
      if (Math.abs(scale - 1) > 0.00001 || Math.abs(heightScale - 1) > 0.00001) {
        if (scale > 0 && Math.abs(scale - heightScale) <= 0.0001 &&
            actual.children.every((child, index) => matchesScale(child, expected.children[index], scale))) {
          metadata.instanceScale = scale;
        } else {
          metadata.instanceStructureFallback = true;
        }
      }
    }
    if (metadata.instanceStructureFallback) {
      diagnostics.push({ code: "INSTANCE_STRUCTURE_FALLBACK", nodeId: id, componentId: metadata.mainComponentId });
    }
  }

  const nodeCount = Object.keys(exportChildIds).length;
  const rootCount = targets.reduce((count, target) => count + (target.nodes || []).length, 0);
  if (roots.length === 0) return { targets, hasInstances: Object.keys(instanceMetadata).length > 0, diagnostics, nodeCount, rootCount };
  let dependencyPageId = "mastergo2figma-dependencies";
  const pageIds = new Set(targets.map(target => String(target.page.id)));
  while (pageIds.has(dependencyPageId)) dependencyPageId += "-1";
  // This is a plain export descriptor, never an actual page in MasterGo.
  const dependencyPage = { id: dependencyPageId, name: "迁移依赖", get children() { return roots.slice(); } };
  return {
    targets: [{ page: dependencyPage, nodes: roots.slice(), isDependencyPage: true }, ...targets],
    hasInstances: Object.keys(instanceMetadata).length > 0,
    diagnostics, nodeCount, rootCount: rootCount + roots.length
  };
}
