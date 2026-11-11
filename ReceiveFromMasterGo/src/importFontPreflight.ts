import { cacheFontLoadFailure, ensureAvailableFontsLoaded, getFontKey, loadFontCached, resolveAvailableFontName } from "./fontLoader";

class FontPreflightTimeout extends Error {}

const NON_FALLBACK_FONT_TIMEOUT_MS = 5000;

function isMandatoryFallbackFont(font: FontName): boolean {
  return font.family === "Inter" && font.style === "Regular";
}

function waitForFont(promise: Promise<void>, font: FontName, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FontPreflightTimeout(
      `Figma 字体服务未响应：${font.family} · ${font.style}。请确认字体辅助程序已启动后重试。`
    )), timeoutMs);
    // Always observe the original promise, even after timeout. Its late
    // rejection must not become an unhandled rejection in a later session.
    promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function preflightImportFonts(
  requests: unknown,
  onProgress: (font: FontName, index: number, total: number) => void,
  timeoutMs = 30000
): Promise<{ loaded: number; failed: number; missing: number }> {
  const counts = { loaded: 0, failed: 0, missing: 0 };
  if (!Array.isArray(requests) || requests.length === 0) return counts;
  const requested = new Map<string, FontName>();
  for (const font of requests) {
    if (font && typeof font.family === "string" && font.family && typeof font.style === "string" && font.style) {
      requested.set(getFontKey(font.family, font.style), { family: font.family, style: font.style });
    }
  }
  if (requested.size === 0) return counts;
  await waitForFont(ensureAvailableFontsLoaded(), { family: "字体目录", style: "读取" }, timeoutMs);
  const resolved = new Map<string, FontName>();
  requested.forEach(font => {
    // applyTextProperties always loads this fixed fallback before writing any
    // text, even if an incomplete catalog did not list it. Preflight the same
    // explicit request; do not substitute it for other uninstalled fonts.
    const available = resolveAvailableFontName(font) ||
      (isMandatoryFallbackFont(font) ? font : null);
    if (available) resolved.set(getFontKey(available.family, available.style), available);
    else counts.missing++;
  });
  let index = 0;
  for (const font of resolved.values()) {
    onProgress(font, ++index, resolved.size);
    const perFontTimeout = isMandatoryFallbackFont(font)
      ? timeoutMs
      : Math.min(timeoutMs, NON_FALLBACK_FONT_TIMEOUT_MS);
    try {
      await waitForFont(loadFontCached(font), font, perFontTimeout);
      counts.loaded++;
    } catch (error) {
      if (error instanceof FontPreflightTimeout) {
        if (isMandatoryFallbackFont(font)) throw error;
        cacheFontLoadFailure(font, error);
      }
      // Keep the cached rejection for the existing text/style callsite. A run
      // font or hung non-fallback font degrades gracefully to [Font Missing].
      counts.failed++;
    }
  }
  return counts;
}
