import{connect as C}from'cloudflare:sockets'
const W=new Map,U=new Uint8Array([145,203,32,2,109,85,72,237,169,217,101,189,251,27,147,165]), //UUID解码后位置
M=new Uint8Array(32768),P=new Array(12),H=new Uint8Array(2),E=[new Response(null,{status:400}),new Response(null,{status:502})],
A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]&1;return[y?s[b]+'.'+s[b+1]+'.'+s[b+2]+'.'+s[b+3]:new TextDecoder().decode(s.subarray(b+1,b+1+s[b])),p,y?b+4:b+1+s[b]]},
B=(h,p)=>{try{const s=C({hostname:h,port:p});return s.opened.then(()=>s,()=>0)}catch{return Promise.resolve(0)}}
let m=0,l=0
export default{async fetch(r){
if(r.headers.get('upgrade')!=='websocket')return E[1]
const h=r.headers.get('sec-websocket-protocol');if(!h)return E[0]
const d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/')),n=d.length;if(n<18)return E[0]
const t=m+n<32768,s=t?new Uint8Array(M.buffer,m,m+=n):l?P[--l]||new Uint8Array(n):new Uint8Array(n),F=()=>{t?m>24576&&(m=0)||(m-=n):l<12&&!P[l]&&(P[l++]=s)}
for(let i=n;i--;)s[i]=d.charCodeAt(i)
if(s[0]){F();return E[0]}
for(let i=16;i--;)if(s[i+1]^U[i]){F();return E[0]}
const[x,p,z]=A(s),k=await B(x,p)||await B('sjc.o00o.ooo',443);if(!k){F();return E[1]}
const{0:c,1:ws}=new WebSocketPair,w=k.writable.getWriter(),f=[1,0],D=()=>{try{ws.close(f[1])}catch{};try{k.close()}catch{};W.delete(ws);W.size>999&&W.clear()},L=()=>f[0]&&(f[0]=0,w.releaseLock(),D())
ws.accept();ws.send(H);W.set(ws,f);n>z&&w.write(s.subarray(z)).catch(()=>f[0]=0);F()
ws.addEventListener('message',e=>f[0]&&w.write(e.data).catch(()=>f[0]=0))
ws.addEventListener('close',()=>{f[1]=1e3;L()})
ws.addEventListener('error',()=>{f[1]=1006;L()})
k.readable.pipeTo(new WritableStream({write(d){f[0]&&ws.send(d)},close(){f[1]=1e3;L()},abort(){f[1]=1006;L()}})).catch(()=>{})
return new Response(null,{status:101,webSocket:c})
}}
