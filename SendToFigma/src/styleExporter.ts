import { cloneJsonCompatible } from "../../shared/utils";
import { fillsAndStrokes2Json, processBlendMode } from "./serializers/universal";
import { normalizeExportFontName, parseTextStyleRange } from "./serializers/text";
import { normalizeExportTextRanges } from "./serializers/textRanges";

type ExportStyle = {
    id: string;
    name: string;
    styleType: "PAINT" | "TEXT" | "EFFECT";
    [key: string]: any;
};

type StyleDiagnostic = { code: string; styleId: string; nodeId: string; message: string };
const styles = new Map<string, ExportStyle | null>();
const diagnostics: StyleDiagnostic[] = [];
const diagnosticKeys = new Set<string>();

function diagnose(code: string, styleId: string, nodeId: string, message: string) {
    const key = `${code}:${styleId}:${message}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ code, styleId, nodeId, message });
}

function readStyleId(value: any): string | null {
    return typeof value === "string" && value.length > 0 && value !== mg.mixed && value !== String(mg.mixed)
        ? value : null;
}

function convertStyle(style: any, id: string): ExportStyle {
    if (typeof style.name !== "string" || !style.name) throw new Error("样式名称为空");
    const base = { id, name: style.name, styleType: style.type };
    if (style.type === "PAINT") {
        const paints = cloneJsonCompatible<any[]>(style.paints, []);
        // The receiver's local-style importer supports solid/gradient paints.
        // Do not bind a partially converted or empty image style over the
        // node's already exported inline image fills.
        if (!paints.length || paints.some(paint => !paint ||
            ["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].indexOf(paint.type) < 0)) {
            throw new Error("接收端不支持该填充样式，保留图层内联填充");
        }
        if (paints.some(paint => paint.type === "SOLID" && (!paint.color ||
            [paint.color.r, paint.color.g, paint.color.b].some(value => !Number.isFinite(value))))) {
            throw new Error("填充样式缺少有效颜色，保留图层内联填充");
        }
        const converted = fillsAndStrokes2Json(paints, []).fills;
        if (converted.length !== paints.length) throw new Error("填充样式未完整转换");
        for (const paint of converted) {
            if (paint.blendMode === "PASS_THROUGH") paint.blendMode = "NORMAL";
        }
        return { ...base, paints: converted };
    }
    if (style.type === "TEXT") {
        const fontName = normalizeExportFontName(cloneJsonCompatible(style.fontName, null));
        if (!fontName || !fontName.family || !fontName.style || !Number.isFinite(style.fontSize) || style.fontSize <= 0) {
            throw new Error("文字样式缺少字体或字号，保留图层内联文字属性");
        }
        const lineHeight = cloneJsonCompatible<any>(style.lineHeight, { unit: "AUTO" });
        if (lineHeight.unit !== "AUTO" &&
            (["PIXELS", "PERCENT"].indexOf(lineHeight.unit) < 0 || !Number.isFinite(lineHeight.value) || lineHeight.value < 0)) {
            throw new Error("文字样式行高无效，保留图层内联文字属性");
        }
        if (lineHeight.unit === "PERCENT") {
            // Receiver currently accepts PIXELS/AUTO for named text styles.
            lineHeight.unit = "PIXELS";
            lineHeight.value = style.fontSize * lineHeight.value / 100;
        }
        const result: ExportStyle = {
            ...base, fontName, fontSize: style.fontSize, lineHeight,
            textCase: style.textCase, textDecoration: style.decoration
        };
        if (Number.isFinite(style.letterSpacing)) {
            result.letterSpacing = { unit: style.letterSpacingUnit === "PERCENT" ? "PERCENT" : "PIXELS", value: style.letterSpacing };
        }
        return result;
    }
    if (style.type === "EFFECT") {
        const effects = cloneJsonCompatible<any[]>(style.effects, []);
        if (!effects.length) throw new Error("效果样式为空，保留图层内联效果");
        return { ...base, effects: effects.map(effect => {
            const common = { type: effect.type, radius: effect.radius, visible: effect.isVisible !== false };
            if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") return common;
            if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") throw new Error("接收端不支持该效果样式");
            return {
                ...common, color: effect.color, offset: effect.offset, spread: effect.spread,
                blendMode: processBlendMode(effect.blendMode),
                ...(typeof effect.showShadowBehindNode === "boolean" ? { showShadowBehindNode: effect.showShadowBehindNode } : {})
            };
        }) };
    }
    throw new Error(`接收端不支持 ${style.type} 样式，保留图层内联属性`);
}

function resolveStyle(value: any, expectedType: ExportStyle["styleType"], nodeId: string): string | null {
    const id = readStyleId(value);
    if (!id) return null;
    if (!styles.has(id)) {
        try {
            const source = mg.getStyleById(id);
            if (!source) {
                diagnose("STYLE_EXPORT_MISSING", id, nodeId, "源样式不可读，保留图层内联属性");
                styles.set(id, null);
            } else {
                styles.set(id, convertStyle(source, id));
            }
        } catch (error) {
            styles.set(id, null);
            diagnose("STYLE_EXPORT_UNSUPPORTED", id, nodeId, String(error instanceof Error ? error.message : error));
        }
    }
    const style = styles.get(id);
    if (!style) return null;
    if (style.styleType !== expectedType) {
        diagnose("STYLE_REFERENCE_TYPE_MISMATCH", id, nodeId, `需要 ${expectedType}，实际为 ${style.styleType}`);
        return null;
    }
    return id;
}

export function collectNodeStyleRefs(node: any, record: any): void {
    const nodeId = String(node.id || record.id || "");
    const read = (key: string): any => {
        try { return node[key]; }
        catch (error) {
            diagnose("STYLE_REFERENCE_UNREADABLE", "", nodeId, `${key}: ${String(error instanceof Error ? error.message : error)}`);
            return undefined;
        }
    };
    try {
        const refs: Array<[string, any, ExportStyle["styleType"]]> = [
            ["fillStyleRef", read("fillStyleId"), "PAINT"],
            ["strokeStyleRef", read("strokePaintStyleId") || read("strokeFillStyleId") || read("strokeStyleId"), "PAINT"],
            ["effectStyleRef", read("effectStyleId"), "EFFECT"]
        ];
        for (const [field, sourceId, type] of refs) {
            const id = resolveStyle(sourceId, type, nodeId);
            if (id) record[field] = id;
        }
        if (node.type !== "TEXT") return;
        const characters = String(node.characters || "");
        const rawEntries = read("textStyles");
        const entries = Array.isArray(rawEntries) ? rawEntries : [];
        const length = Array.from(characters).length;
        const ranges: Array<{ start: number; end: number; styleRef: string }> = [];
        for (const entry of entries) {
            const range = parseTextStyleRange(entry, length);
            const id = range && resolveStyle(entry.textStyleId, "TEXT", nodeId);
            if (range && id) ranges.push({ ...range, styleRef: id });
        }
        const normalized = normalizeExportTextRanges(characters, ranges, node.listStyles || []);
        const mapped = normalized.styledTextSegments || [];
        if (entries.length === 1 && mapped.length === 1 && mapped[0].start === 0 && mapped[0].end === normalized.characters.length) {
            record.textStyleRef = mapped[0].styleRef;
        } else if (mapped.length) {
            record.textStyleRanges = mapped;
        }
    } catch (error) {
        diagnose("STYLE_REFERENCE_UNREADABLE", "", nodeId, String(error instanceof Error ? error.message : error));
    }
}

export function getExportStyles(): ExportStyle[] {
    return Array.from(styles.values()).filter((style): style is ExportStyle => style !== null);
}

export function getExportStyleDiagnostics(): StyleDiagnostic[] {
    return diagnostics.slice();
}

export function resetExportStyles(): void {
    styles.clear();
    diagnostics.length = 0;
    diagnosticKeys.clear();
}
