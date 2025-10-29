import{connect as C}from'cloudflare:sockets'
const W=new Map,U=new Uint8Array([207,164,66,231,10,98,92,23,153,27,78,44,147,137,198,95]),
M=new Uint8Array(32768),P=new Array(12),E=[new Response(null,{status:400}),new Response(null,{status:502})],
A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]&1,n=s[b];return[y?s[b]+'.'+s[b+1]+'.'+s[b+2]+'.'+s[b+3]:new TextDecoder().decode(s.subarray(b+1,b+1+n)),p,y?b+4:b+1+n,s[0]]},
B=(h,p)=>{const s=C({hostname:h,port:p});return s.opened.then(()=>s,()=>0).catch(()=>0)}
let m=0,l=0
export default{async fetch(r){
if(r.headers.get('upgrade')!=='websocket')return E[1]
const h=r.headers.get('sec-websocket-protocol');if(!h)return E[0]
const d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/')),n=d.length;if(n<18)return E[0]
const t=m+n<32768,s=t?new Uint8Array(M.buffer,m,m+=n):l?P[--l]||new Uint8Array(n):new Uint8Array(n),F=()=>{t?m>24576&&(m=0)||(m-=n):l<12&&!P[l]&&(P[l++]=s)}
for(let i=n;i--;)s[i]=d.charCodeAt(i)
if(s[0]){F();return E[0]}
for(let i=16;i--;)if(s[i+1]^U[i]){F();return E[0]}
const[x,p,z,v]=A(s),k=await B(x,p)||await B('proxy.xxxxxxxx.tk',50001);if(!k){F();return E[1]}
const{0:c,1:ws}=new WebSocketPair,w=k.writable.getWriter(),f=[1,0,1]
ws.accept();W.set(ws,f);n>z&&w.write(s.subarray(z)).catch(()=>f[0]=0);F()
const L=()=>f[0]&&(f[0]=0,w.releaseLock(),((c)=>{try{ws.close(c)}catch{};try{k.close()}catch{};W.delete(ws);W.size>999&&W.clear()})(f[1]))
ws.addEventListener('message',e=>f[0]&&w.write(e.data).catch(()=>f[0]=0))
ws.addEventListener('close',()=>{f[1]=1e3;L()})
ws.addEventListener('error',()=>{f[1]=1006;L()})
k.readable.pipeTo(new WritableStream({write(d){if(f[0]){if(f[2]){const u=new Uint8Array(d),h=new Uint8Array(u.length+2);h[0]=v;h.set(u,2);ws.send(h.buffer);f[2]=0}else ws.send(d)}},close(){f[1]=1e3;L()},abort(){f[1]=1006;L()}})).catch(()=>{})
return new Response(null,{status:101,webSocket:c})
}}