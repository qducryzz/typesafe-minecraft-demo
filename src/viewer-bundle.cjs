const fs=require('node:fs');
const path=require('node:path');
// The pinned viewer ships a prebuilt browser bundle. Patch it so it can live
// on the dashboard page (no nested iframe — Grok preview blocks those).
function viewerBundle(){
 const source=fs.readFileSync(path.join(path.dirname(require.resolve('prismarine-viewer')),'public/index.js'),'utf8');
 const replacements=[
  ['i(8007)({path:window.location.pathname+"socket.io"})','i(8007)({path:"/view/socket.io"})'],
  ['const l=new THREE.WebGLRenderer;l.setPixelRatio(window.devicePixelRatio||1),l.setSize(window.innerWidth,window.innerHeight),document.body.appendChild(l.domElement);',
   'const l=new THREE.WebGLRenderer({antialias:!0,alpha:!1,preserveDrawingBuffer:!0});const mount=document.getElementById("view")||document.body;const fit=()=>{const b=mount.getBoundingClientRect();return[Math.max(2,b.width||window.innerWidth),Math.max(2,b.height||window.innerHeight)]};let[vw,vh]=fit();l.setPixelRatio(Math.min(window.devicePixelRatio||1,2));l.setSize(vw,vh,!1);mount.appendChild(l.domElement);l.domElement.style.cssText="position:absolute;inset:0;width:100%;height:100%;display:block;";'],
  ['window.addEventListener("resize",(()=>{u.camera.aspect=window.innerWidth/window.innerHeight,u.camera.updateProjectionMatrix(),l.setSize(window.innerWidth,window.innerHeight)}))',
   'window.addEventListener("resize",(()=>{const b=(document.getElementById("view")||document.body).getBoundingClientRect();const w=Math.max(2,b.width),h=Math.max(2,b.height);u.camera.aspect=w/h;u.camera.updateProjectionMatrix();l.setSize(w,h,!1)}))'],
 ];
 let out=source;
 for(const [from,to] of replacements){
  if(out.split(from).length!==2)throw new Error('Viewer bundle changed; missing '+from.slice(0,48));
  out=out.replace(from,to);
 }
 const anchor='const u=new r(l);';
 if(out.split(anchor).length!==2)throw new Error('Viewer bundle changed; review the animation bridge before upgrading prismarine-viewer.');
 return out.replace(anchor,anchor+'window.dispatchEvent(new CustomEvent("demo-viewer-ready",{detail:{viewer:u,socket:o}}));');
}
module.exports={viewerBundle};
