const test=require('node:test');
const assert=require('node:assert/strict');
const esbuild=require('../../SendToFigma/node_modules/esbuild');
const result=esbuild.buildSync({entryPoints:[require.resolve('../../SendToFigma/src/layoutGridExporter.ts')],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {readResolvedLayoutGrids}=mod.exports;
const grids=[{gridType:'COLUMNS',count:24,gutterSize:20,alignment:'STRETCH'}];
test('empty lazy grids return immediately without selecting a node or touching the document',()=>{
 const node={layoutGrids:[]};
 const page={get selection(){throw Error('selection read');},set selection(v){throw Error('selection write');}};
 const document={get currentPage(){throw Error('page read');},set currentPage(v){throw Error('page write');}};
 assert.deepEqual(readResolvedLayoutGrids(node,page,document),[]);
});
test('an unavailable public grid getter propagates without modifying the source',()=>{
 const node={get layoutGrids(){throw Error('unavailable');}};
 const page={set selection(v){throw Error('selection write');}};
 const document={set currentPage(v){throw Error('page write');}};
 assert.throws(()=>readResolvedLayoutGrids(node,page,document),/unavailable/);
});
test('resolved grids need no selection or page changes',async()=>{
 const document={get currentPage(){throw Error('unneeded');}};
 assert.equal((await readResolvedLayoutGrids({layoutGrids:grids},{},document))[0].count,24);
});
