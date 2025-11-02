import{connect as C}from'cloudflare:sockets';
const W=new Map,U=new Uint8Array([207,164,66,231,10,98,92,23,153,27,78,44,147,137,198,95]),M=new Uint8Array(32768),P=Array(12),A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]&1,n=s[b];const h=y?s[b]+'.'+s[b+1]+'.'+s[b+2]+'.'+s[b+3]:new TextDecoder().decode(s.subarray(b+1,b+1+n));const z=y?b+4:b+1+n;return[h,p,z,s[0]]},B=(h,p)=>{try{const s=C({hostname:h,port:p},{allowHalfOpen:!0});return s.opened.then(()=>s).catch(()=>null)}catch{return null}};
let m=0,l=0;
export default{async fetch(r){
if(r.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('Upgrade Required',{status:426,headers:{'Connection':'Upgrade','Upgrade':'websocket'}});
const h=r.headers.get('sec-websocket-protocol');if(!h)return new Response(null,{status:400});
let d;try{d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/'))}catch(e){return new Response(null,{status:400})}
const n=d.length;if(n<18)return new Response(null,{status:400});
const t=m+n<32768;let s;if(t){s=new Uint8Array(M.buffer,m,n);m+=n}else{s=l>0?P[--l]||new Uint8Array(n):new Uint8Array(n)}
const F=()=>{if(t){if(m>24576)m=0}else if(l<12){P[l++]=s.buffer.byteLength===s.length?s:new Uint8Array(s.buffer)}};
for(let i=n;i--;)s[i]=d.charCodeAt(i);
for(let i=16;i--;)if(s[i+1]^U[i]){F();return new Response(null,{status:400})}
const[x,p,z,v]=A(s);const k=await B(x,p)||await B('proxy.xxxxxxxx.tk',50001);if(!k){F();return new Response(null,{status:502})}
const{0:c,1:ws}=new WebSocketPair;ws.accept();const w=k.writable.getWriter();
const state={a:1,f:1},cleanup=()=>{if(!state.a)return;state.a=0;try{w.releaseLock()}catch{}try{k.close()}catch{}try{ws.close(1e3)}catch{};W.delete(ws)};
W.set(ws,cleanup);
if(n>z){w.write(s.subarray(z)).catch(cleanup)}F();
ws.addEventListener('message',e=>{if(state.a)w.write(e.data).catch(cleanup)});
ws.addEventListener('close',cleanup);
ws.addEventListener('error',cleanup);
k.readable.pipeTo(new WritableStream({write(d){if(state.a){if(state.f){state.f=0;const u=new Uint8Array(d),h=new Uint8Array(u.length+2);h[0]=v;h.set(u,2);ws.send(h)}else{ws.send(d)}}},close:cleanup,abort:cleanup})).catch(cleanup);
return new Response(null,{status:101,webSocket:c})
}}
