import { localConnectorSvg } from "./appliers/connectorSvg";
import { localEllipseArcSvg } from "./appliers/ellipseArcSvg";
import { roundedArcNetwork } from "./appliers/roundedArc";
import { state } from "./state";
import { getReceiveCreateType } from "./layerRules";
import { safeSet, isSceneNode, yieldToEventLoop } from "../../shared/utils";
import { applyVectorNetwork } from "./appliers/vector";
import { getFixedMixedTextLines } from "./appliers/multilineText";
import { unwrapSingleVectorSvg } from "./appliers/svgFallback";
import { createConnectorVectorNetworkFromData } from "./appliers/connector";

const POSTPROCESS_YIELD_INTERVAL_MS = 50;
const SHELL_PLACEHOLDER_PLUGIN_DATA_KEY = "mastergo2figma.shellPlaceholder";

type PostprocessProgressCallback = (done: number, total: number) => Promise<void> | void;

export function appendRestoredNode(parent: PageNode | SceneNode, node: SceneNode): boolean {
    if ("appendChild" in parent) {
        (parent as any).appendChild(node);
        return true;
    }
    console.warn("Unable to append restored node because parent cannot contain children:", node.name, parent.name);
    safeRemove(node);
    return false;
}

export function isRemovedNode(node: any): boolean {
    return !node || !!node.removed;
}

export function safeRemove(node: BaseNode) {
    if ((node as any).removed) return;

    try {
        node.remove();
        state.recordNodeRemoval();
    } catch (e) {
        console.warn("Unable to remove node:", node.name, e);
    }
}

export function isShellContainer(node: BaseNode): boolean {
    return node.type === "FRAME" ||
        node.type === "GROUP" ||
        node.type === "SECTION" ||
        node.type === "COMPONENT" ||
        node.type === "INSTANCE" ||
        node.type === "COMPONENT_SET";
}

export function clearMaskFlag(node: SceneNode) {
    const nodeAny = node as any;
    if (!("isMask" in nodeAny)) return;

    try {
        nodeAny.isMask = false;
    } catch (e) {
        console.warn("Unable to clear mask before removing imported rectangle:", node.name, e);
    }
}

export function markShellPlaceholderNode(node: SceneNode, data: any) {
    if (!data || data.shellPlaceholder !== true) return;
    const nodeAny = node as any;
    if (typeof nodeAny.setPluginData !== "function") return;

    try {
        nodeAny.setPluginData(SHELL_PLACEHOLDER_PLUGIN_DATA_KEY, "1");
        state.shellPlaceholderCandidates.push(node);
    } catch (e) {
        console.warn("Unable to mark shell placeholder:", node.name, e);
    }
}

export function isShellPlaceholderNode(node: BaseNode): boolean {
    const nodeAny = node as any;
    if (typeof nodeAny.getPluginData !== "function") return false;

    try {
        return nodeAny.getPluginData(SHELL_PLACEHOLDER_PLUGIN_DATA_KEY) === "1";
    } catch (_) {
        return false;
    }
}

export function isInsideInstance(node: BaseNode): boolean {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (parent.type === "INSTANCE") return true;
        parent = parent.parent;
    }
    return false;
}

export async function cleanupImportedContainerShells(root: BaseNode, progress?: PostprocessProgressCallback, candidates?: SceneNode[]) {
    const nodes = candidates ? collectCandidateCleanupNodes(root, candidates) : collectCleanupNodes(root);
    const total = Math.max(1, nodes.length);
    let done = 0;
    let lastYieldAt = Date.now();

    for (let index = nodes.length - 1; index >= 0; index--) {
        cleanupImportedContainerShell(nodes[index]);
        done++;
        const pending = maybeYieldPostprocess(done, total, lastYieldAt, progress);
        if (pending) lastYieldAt = await pending;
    }
}

function collectCandidateCleanupNodes(root: BaseNode, candidates: SceneNode[]): BaseNode[] {
    if (isInsideInstance(root)) return [];
    const parents = new Map<string, { node: BaseNode; depth: number }>();
    for (const candidate of candidates) {
        if (isRemovedNode(candidate) || candidate.type !== "RECTANGLE") continue;
        const parent = candidate.parent;
        if (!parent || parents.has(parent.id)) continue;
        let ancestor: BaseNode | null = parent;
        let depth = 0;
        while (ancestor && ancestor.type !== "INSTANCE" && ancestor !== root) {
            ancestor = ancestor.parent;
            depth++;
        }
        if (ancestor === root && root.type !== "INSTANCE") parents.set(parent.id, { node: parent, depth });
    }
    // Match the tree walk's descendant-before-parent cleanup when placeholders
    // live in nested native groups. No unrelated children snapshots are read.
    return [...parents.values()].sort((a, b) => a.depth - b.depth).map(entry => entry.node);
}

function collectCleanupNodes(root: BaseNode): BaseNode[] {
    const nodes: BaseNode[] = [];
    // This DFS never descends into INSTANCE nodes, so a traversed node can only
    // be "inside an instance" if the root itself is — check that once instead
    // of walking the ancestor chain for every node (was O(n·depth) bridge reads).
    const rootInsideInstance = isInsideInstance(root);
    const stack: BaseNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as BaseNode;
        if (!("children" in node)) continue;
        if (isSceneNode(node) && (node.type === "INSTANCE" || rootInsideInstance)) continue;
        nodes.push(node);
        // node.children already returns a fresh snapshot array; no spread copy needed.
        const children = (node as any).children as BaseNode[];
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push(children[index]);
        }
    }
    return nodes;
}

function cleanupImportedContainerShell(root: BaseNode) {
    if (!isSceneNode(root) || !isShellContainer(root)) return;

    // children is a fresh snapshot per access, and we return right after the
    // single removal below, so iterating it directly is safe.
    const shellChildren = (root as any).children as SceneNode[];
    for (const child of shellChildren) {
        if (child.type === "RECTANGLE" && isShellPlaceholderNode(child)) {
            clearMaskFlag(child);
            safeRemove(child);
            return;
        }
    }
}

function maybeYieldPostprocess(
    done: number,
    total: number,
    lastYieldAt: number,
    progress?: PostprocessProgressCallback
): Promise<number> | null {
    const now = Date.now();
    if (done < total && now - lastYieldAt < POSTPROCESS_YIELD_INTERVAL_MS) {
        return null;
    }
    return (async () => {
        if (progress) await progress(done, total);
        await yieldToEventLoop();
        return Date.now();
    })();
}

function recordCreatedNode<T extends SceneNode>(node: T): T {
    state.recordNodeCreation("createNodeFromData");
    return node;
}

export function hasUsableVectorNetwork(vectorNetwork: any): boolean {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}

export async function createNodeFromData(data: any): Promise<SceneNode | null> {
    let node: SceneNode | null = null;
    const type = getReceiveCreateType(data);

    try {
        switch (type) {
            case "SVG":
                if (typeof data.svgMarkup === "string" && data.svgMarkup.trim()) {
                    node = recordCreatedNode(figma.createNodeFromSvg(data.svgMarkup));
                    node = unwrapSingleVectorSvg(node as FrameNode, data);
                } else {
                    node = recordCreatedNode(figma.createFrame());
                }
                break;
            case "PEN":
            case "VECTOR":
                const vector = recordCreatedNode(figma.createVector());
                node = vector;
                break;
            case "ELLIPSE":
                const arcSvg = localEllipseArcSvg(data);
                if (arcSvg) { node = recordCreatedNode(figma.createNodeFromSvg(arcSvg)); break; }
                if (roundedArcNetwork(data)) { node = recordCreatedNode(figma.createVector()); break; }
                const ellipse = recordCreatedNode(figma.createEllipse());
                node = ellipse;
                if (data.arcData) safeSet(ellipse, "arcData", data.arcData);
                break;
            case "RECTANGLE":
                node = recordCreatedNode(figma.createRectangle());
                break;
            case "STAR":
                const star = recordCreatedNode(figma.createStar());
                node = star;
                safeSet(star, "pointCount", data.pointCount || 5);
                safeSet(star, "innerRadius", data.innerRadius || 0.38);
                break;
            case "LINE":
                node = recordCreatedNode(figma.createLine());
                break;
            case "POLYGON":
                const polygon = recordCreatedNode(figma.createPolygon());
                node = polygon;
                safeSet(polygon, "pointCount", data.pointCount || 3);
                break;
            case "TEXT":
                node = recordCreatedNode(getFixedMixedTextLines(data) ? figma.createFrame() : figma.createText());
                break;
            case "SECTION":
                node = recordCreatedNode(figma.createSection());
                break;
            case "COMPONENT":
                node = recordCreatedNode(figma.createComponent());
                break;
            case "SLICE":
                node = recordCreatedNode(figma.createSlice());
                break;
            case "CONNECTOR":
                const connectorSvg = localConnectorSvg(data);
                if (connectorSvg) { node = recordCreatedNode(figma.createNodeFromSvg(connectorSvg)); break; }
                const connectorVector = recordCreatedNode(figma.createVector());
                node = connectorVector;
                if (!data.connectorFallbackPolyline) data.connectorFallbackPolyline = true;
                if (!data.connectorRouteExplicit || !hasUsableVectorNetwork(data.vectorNetwork)) {
                    data.vectorNetwork = createConnectorVectorNetworkFromData(data, null);
                }
                if (data.vectorNetwork) await applyVectorNetwork(connectorVector, data.vectorNetwork, data);
                state.fallbackConnectorCount++;
                if (!state.connectorFallbackLogged) {
                    state.connectorFallbackLogged = true;
                    console.warn("CONNECTOR restored as VECTOR polyline because createConnector is unavailable/disabled");
                }
                break;
            case "BOOLEAN_OPERATION":
                node = recordCreatedNode(figma.createFrame());
                break;
            case "FRAME":
                node = recordCreatedNode(figma.createFrame());
                break;
            case "GROUP":
                node = recordCreatedNode(figma.createFrame());
                node.name = "GROUP_PLACEHOLDER";
                break;
            default:
                console.warn("Unsupported type:", type);
                break;
        }
    } catch (error) {
        console.warn("Unable to create node, removing partial node:", data?.name || data?.id || type, error);
        if (node) safeRemove(node);
        return null;
    }

    if (node) markShellPlaceholderNode(node, data);

    return node;
}
