const fs=require('fs'),path=require('path'),{JSDOM,VirtualConsole}=require('jsdom');
const ASSETS=path.join(__dirname,'uploadserver_preview','assets'),SAMPLES='/tmp/serve_test';
const LIBS=['hljs.min.js','hljs-dockerfile.min.js','marked.umd.js','purify.min.js','papaparse.min.js','diff2html.core.min.js','json-viewer.js'];
const SHELL='<!DOCTYPE html><html data-theme="dark"><head></head><body><header><a id="backlink"></a><nav id="crumbs"></nav><span id="kind"></span><span id="meta"></span><a id="rawlink"></a></header><main id="content"><div class="loading">Loading</div></main></body></html>';
const CASES=[
 {file:'bad.json', check:h=>/codewrap/.test(h)&&/Not valid JSON/.test(h), label:'invalid JSON -> source + notice'},
 {file:'page.html', check:h=>/class="htmlframe"/.test(h)&&/sandbox=""/.test(h)&&/src="\/page\.html"/.test(h)&&!/<h1>hi<\/h1>/.test(h), label:'html live preview in a sandboxed iframe'},
 {file:'blob.bin', check:h=>/Binary file/.test(h), label:'binary detected'},
 {file:'config.json', check:h=>/andypf-json-viewer/.test(h), label:'valid JSON uses web component'},
];
function run(tc){return new Promise(res=>{
 const url='http://x/__view__?path='+encodeURIComponent('/'+tc.file);
 const dom=new JSDOM(SHELL,{url,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
 const w=dom.window; w.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
 w.fetch=p=>{let rel=decodeURIComponent(String(p).split('?')[0]).replace(/^\//,'');const buf=fs.readFileSync(path.join(SAMPLES,rel));
   return Promise.resolve({ok:true,status:200,statusText:'OK',headers:{get:k=>k.toLowerCase()==='content-length'?String(buf.length):null},text:()=>Promise.resolve(buf.toString('utf8'))});};
 const add=c=>{const s=w.document.createElement('script');s.textContent=c;w.document.body.appendChild(s);};
 for(const l of LIBS)add(fs.readFileSync(path.join(ASSETS,l),'utf8'));
 add(fs.readFileSync(path.join(ASSETS,'viewer.js'),'utf8'));
 setTimeout(()=>{const h=w.document.getElementById('content').innerHTML;let ok=false;try{ok=tc.check(h)}catch(e){}
   res({file:tc.file,label:tc.label,ok,snip:h.replace(/\s+/g,' ').slice(0,110)});},300);
});}
(async()=>{let p=0;for(const tc of CASES){const r=await run(tc);if(r.ok)p++;console.log(`[${r.ok?'PASS':'FAIL'}] ${r.file.padEnd(13)} ${r.label}`);if(!r.ok)console.log('        snip: '+r.snip);}console.log(`\n${p}/${CASES.length} edge cases passed`);process.exit(p===CASES.length?0:1);})();
