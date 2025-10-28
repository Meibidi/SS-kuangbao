import{connect as C}from'cloudflare:sockets'
const W=new Map,U='', //UUID
M=new Uint8Array(32768),Q=[],E=[new Response(null,{status:400}),new Response(null,{status:502})],
A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]&1;return[y?s[b]+'.'+s[b+1]+'.'+s[b+2]+'.'+s[b+3]:new TextDecoder().decode(s.subarray(b+1,b+1+s[b])),p,y?b+4:b+1+s[b]]},
B=(h,p)=>{try{const c=C({hostname:h,port:p});return c.opened.then(()=>c,()=>0)}catch{return Promise.resolve(0)}},
V=(s,u)=>{for(let i=0,j=0;i<16;i++,j+=2+(j==6||j==11||j==16||j==21?1:0))if(s[i+1]!==parseInt(u.substr(j,2),16))return 1}
let m=0,n=0
export default{async fetch(r){
if(r.headers.get('upgrade')!=='websocket')return E[1]
const h=r.headers.get('sec-websocket-protocol');if(!h)return E[0]
const d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/')),z=d.length;if(z<18)return E[0]
const t=m+z<32768,s=t?new Uint8Array(M.buffer,m,m+=z):n?Q[--n]||new Uint8Array(z):new Uint8Array(z),R=()=>{t?m>24576&&(m=0)||(m-=z):n<12&&!Q[n]&&(Q[n++]=s)}
for(let i=z;i--;)s[i]=d.charCodeAt(i)
if(s[0]||V(s,U)){R();return E[0]}
const[x,p,e]=A(s),k=await B(x,p)||await B('proxy.xxxxxxxx.tk',50001);if(!k){R();return E[1]} //Proxyip
const{0:c,1:w}=new WebSocketPair,g=k.writable.getWriter(),f=[1,0],D=()=>{try{w.close(f[1])}catch{};try{k.close()}catch{};W.delete(w);W.size>999&&W.clear()},L=()=>f[0]&&(f[0]=0,g.releaseLock(),D())
w.accept();W.set(w,f);z>e&&g.write(s.subarray(e)).catch(()=>f[0]=0);R()
w.addEventListener('message',v=>f[0]&&g.write(v.data).catch(()=>f[0]=0))
w.addEventListener('close',()=>{f[1]=1e3;L()})
w.addEventListener('error',()=>{f[1]=1006;L()})
k.readable.pipeTo(new WritableStream({write(a){f[0]&&w.send(a)},close(){f[1]=1e3;L()},abort(){f[1]=1006;L()}})).catch(()=>{})
return new Response(null,{status:101,webSocket:c})
}}
