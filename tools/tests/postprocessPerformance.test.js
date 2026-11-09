const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('../../ReceiveFromMasterGo/node_modules/esbuild');
const { createHook } = require('node:async_hooks');

function load(figmaOverrides = {}) {
  const result = esbuild.buildSync({
    stdin: { contents: [
      'export * from "./ReceiveFromMasterGo/src/deferredLayout";',
      'export * from "./ReceiveFromMasterGo/src/nodeCreator";',
      'export * from "./ReceiveFromMasterGo/src/appliers/text";',
      'export { state } from "./ReceiveFromMasterGo/src/state";',
      'export { rebuildAvailableFontIndex } from "./ReceiveFromMasterGo/src/fontLoader";'
    ].join('\n'), resolveDir: path.resolve(__dirname, '../..') },
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'figma', result.outputFiles[0].text)(mod, mod.exports, {
    mixed: Symbol('mixed'), loadFontAsync: async () => {}, ...figmaOverrides
  });
  return mod.exports;
}

function node(id, type, parent = null, extra = {}) {
  return { id, type, parent, removed: false, x: 0, y: 0, width: 10, height: 10,
    constraints: { horizontal: 'MIN', vertical: 'MIN' },
    resize(width, height) { this.width = width; this.height = height; }, ...extra };
}

test('static layout records avoid six rounds of host parent reads', async t => {
  const api = load();
  const count = 400;
  const parent = node('parent', 'FRAME', null, { layoutMode: 'NONE' });
  let parentReads = 0;
  for (let i = 0; i < count; i++) {
    const child = node(String(i), 'RECTANGLE');
    Object.defineProperty(child, 'parent', { get() { parentReads++; return parent; } });
    api.deferLayoutRestore(child, { layoutMode: 'NONE', x: 1, y: 2, width: 10, height: 10 }, false);
  }
  let promises = 0;
  const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promises++; } });
  hook.enable();
  try { await api.applyDeferredLayoutRestores(); } finally { hook.disable(); }
  assert.ok(parentReads <= count * 3, `static records read parent ${parentReads} times for ${count} nodes`);
  // The hook also sees the test runner's bounded async bookkeeping; the old
  // six per-record awaits allocate thousands of promises for this fixture.
  assert.ok(promises < count, `static layout processing allocated ${promises} promises`);
  t.diagnostic(JSON.stringify({ count, parentReads, promises }));
  assert.equal(api.state.deferredLayoutRestores.length, 0);
});

test('layout phases retain fixed sizes, stretch insets and absolute constrained positions', async () => {
  const api = load();
  const page = node('page', 'PAGE');
  const parent = node('parent', 'FRAME', page, { layoutMode: 'NONE', width: 140, height: 70,
    primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' });
  const fixed = node('fixed', 'FRAME', parent, { layoutMode: 'NONE', width: 50, height: 10,
    primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' });
  const stretch = node('stretch', 'RECTANGLE', parent, {
    constraints: { horizontal: 'STRETCH', vertical: 'STRETCH' } });
  const pinned = node('pinned', 'RECTANGLE', parent, { width: 30, height: 10,
    constraints: { horizontal: 'MAX', vertical: 'CENTER' } });
  const entries = [
    [parent, { layoutMode: 'HORIZONTAL', width: 200, height: 100, primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' }],
    [fixed, { layoutMode: 'VERTICAL', width: 40, height: 20, x: 4, y: 5, primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' }],
    [stretch, { layoutMode: 'NONE', layoutPositioning: 'ABSOLUTE', width: 160, height: 60, x: 10, y: 10 }],
    [pinned, { layoutMode: 'NONE', layoutPositioning: 'ABSOLUTE', width: 30, height: 10, x: 160, y: 40 }]
  ];
  for (const [target, layout] of entries) {
    api.state.restoredLayoutByNodeId[target.id] = layout;
    api.deferLayoutRestore(target, layout, false);
  }
  await api.applyDeferredLayoutRestores();
  assert.deepEqual([parent.width, parent.height, parent.layoutMode], [200, 100, 'HORIZONTAL']);
  assert.deepEqual([fixed.width, fixed.height, fixed.x, fixed.y], [40, 20, 4, 5]);
  assert.deepEqual([stretch.width, stretch.height], [160, 60]);
  assert.deepEqual([pinned.x, pinned.y], [160, 40]);
});

test('shell candidate cleanup does not walk unrelated containers or instance descendants', async t => {
  const api = load();
  api.state.shellPlaceholderCandidates = [];
  let reads = 0;
  const page = node('page', 'PAGE');
  const shell = node('shell', 'FRAME', page);
  const instance = node('instance', 'INSTANCE', page);
  const makePlaceholder = (id, parent) => {
    const data = {};
    const placeholder = node(id, 'RECTANGLE', parent, {
      isMask: true,
      setPluginData(key, value) { data[key] = value; },
      getPluginData(key) { return data[key] || ''; },
      remove() { this.removed = true; }
    });
    api.markShellPlaceholderNode(placeholder, { shellPlaceholder: true });
    return placeholder;
  };
  const placeholder = makePlaceholder('placeholder', shell);
  const instancePlaceholder = makePlaceholder('instance-placeholder', instance);
  const kept = node('kept', 'RECTANGLE', shell, { getPluginData() { return ''; } });
  const children = [shell, instance];
  Object.defineProperty(shell, 'children', { get() { reads++; return [placeholder, kept]; } });
  Object.defineProperty(instance, 'children', { get() { reads++; return [instancePlaceholder]; } });
  for (let i = 0; i < 500; i++) {
    const untouched = node(`untouched-${i}`, 'FRAME', page);
    Object.defineProperty(untouched, 'children', { get() { reads++; return []; } });
    children.push(untouched);
  }
  Object.defineProperty(page, 'children', { get() { reads++; return children; } });
  await api.cleanupImportedContainerShells(page, undefined, api.state.shellPlaceholderCandidates);
  assert.equal(placeholder.removed, true);
  assert.equal(placeholder.isMask, false);
  assert.equal(kept.removed, false);
  assert.equal(instancePlaceholder.removed, false);
  assert.ok(reads <= 2, `candidate cleanup took ${reads} children snapshots`);
  t.diagnostic(JSON.stringify({ unrelatedContainers: 500, childrenSnapshots: reads }));
});

function prepareFonts(api) {
  api.state.documentFonts = [{ fontName: { family: 'Inter', style: 'Regular' } },
    { fontName: { family: 'Available', style: 'Regular' } }];
  api.rebuildAvailableFontIndex();
}

test('import missing-font candidates avoid page scans and preserve removed/manual-font semantics', async () => {
  const api = load();
  prepareFonts(api);
  const missing = node('missing', 'TEXT', null, {
    name: '[Font Missing][Available][Regular] Label', characters: 'label', fontName: { family: 'Inter', style: 'Regular' }
  });
  const manual = node('manual', 'TEXT', null, {
    name: '[Font Missing][Unavailable][Regular] Manual', characters: 'label', fontName: { family: 'Available', style: 'Regular' }
  });
  const removed = { ...missing, id: 'removed', removed: true };
  const page = { async loadAsync() { throw Error('candidate import must not load pages'); },
    findAll() { throw Error('candidate import must not scan pages'); } };
  const result = await api.restoreMissingFontTextLayers([page], [missing, missing, manual, removed]);
  assert.equal(result.scannedTextNodeCount, 2);
  assert.equal(result.candidateTextNodeCount, 2);
  assert.equal(result.restoredTextNodeCount, 1);
  assert.equal(result.manuallyResolvedTextNodeCount, 1);
  assert.equal(missing.name, 'Label');
  assert.equal(manual.name, 'Manual');
  assert.equal(missing.fontName.family, 'Available');
});

test('manual refresh retains full-page discovery and candidate registration records missing fonts only', async () => {
  const api = load();
  prepareFonts(api);
  api.state.missingFontTextCandidates = [];
  const missing = node('missing', 'TEXT', null, {
    name: '[Font Missing][Available][Regular] Label', characters: 'label', fontName: { family: 'Inter', style: 'Regular' }
  });
  api.registerMissingFontTextCandidate(missing);
  api.registerMissingFontTextCandidate({ ...missing, name: 'normal' });
  assert.deepEqual(api.state.missingFontTextCandidates, [missing]);
  let loads = 0, scans = 0;
  const page = { async loadAsync() { loads++; }, findAll() { scans++; return [missing]; } };
  const result = await api.restoreMissingFontTextLayers([page]);
  assert.equal(loads, 1);
  assert.equal(scans, 1);
  assert.equal(result.restoredTextNodeCount, 1);
});

test('nested shell cleanup preserves descendant-first order and ignores other pages', async () => {
  const api = load();
  const page = node('page', 'PAGE'), other = node('other', 'PAGE');
  const outer = node('outer', 'GROUP', page), inner = node('inner', 'FRAME', outer);
  const unrelated = node('unrelated', 'FRAME', other);
  const removals = [];
  const make = (parent, id) => node(id, 'RECTANGLE', parent, {
    isMask: true, getPluginData() { return '1'; },
    remove() { this.removed = true; removals.push(id); }
  });
  const a = make(outer, 'a'), b = make(inner, 'b'), c = make(unrelated, 'c');
  outer.children = [a, inner]; inner.children = [b]; unrelated.children = [c];
  await api.cleanupImportedContainerShells(page, undefined, [a, b, a, c]);
  assert.deepEqual(removals, ['b', 'a']);
  assert.equal(c.removed, false);
});

test('missing-font registration follows actual text restoration rather than scanning unrelated text', async () => {
  const api = load();
  prepareFonts(api);
  const text = node('text', 'TEXT', null, { name: 'Source' });
  await api.applyTextProperties(text, { characters: 'Text', fontName: { family: 'Unavailable', style: 'Regular' } });
  assert.deepEqual(api.state.missingFontTextCandidates, [text]);
  assert.equal(text.name, '[Font Missing][Unavailable][Regular] Source');
  assert.deepEqual(text.fontName, { family: 'Inter', style: 'Regular' });
  assert.equal(text.characters, 'Text');
});

test('factory statistics count explicit API calls and successful removals without counting implicit SVG children', async () => {
  let seq = 0;
  const make = type => node(String(++seq), type, null, {
    name: type, remove() { this.removed = true; }, getPluginData() { return ''; }
  });
  const api = load({ createRectangle() { return make('RECTANGLE'); },
    createNodeFromSvg() { return { ...make('FRAME'), children: [make('VECTOR'), make('VECTOR')] }; } });
  api.state.resetRestoreRuntimeStats(2, 1);
  const rectangle = await api.createNodeFromData({ type: 'RECTANGLE' });
  const svg = await api.createNodeFromData({ type: 'SVG', receiveCreateOverride: 'SVG', svgMarkup: '<svg/>' });
  assert.equal(svg.children.length, 2);
  assert.equal(api.state.activeRestoreStats.apiCreationCount, 2);
  assert.equal(api.state.activeRestoreStats.creationCounts.createNodeFromData, 2);
  api.safeRemove(rectangle);
  api.safeRemove(rectangle);
  assert.equal(api.state.activeRestoreStats.transientRemovalCount, 1);
});
