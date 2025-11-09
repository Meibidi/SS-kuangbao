import{connect as C}from'cloudflare:sockets'
const U=new Uint8Array([207,164,66,231,10,98,92,23,153,27,78,44,147,137,198,95]),M=new Uint8Array(32768),P=Array(12),TD=new TextDecoder,
A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]===1,n=s[b];return[y?`${s[b]}.${s[b+1]}.${s[b+2]}.${s[b+3]}`:TD.decode(s.subarray(b+1,b+1+n)),p,y?b+4:b+1+n,s[0]]},
B=(h,p)=>{try{const s=C({hostname:h,port:p});return s.opened.then(()=>s).catch(()=>null)}catch{return null}};
let m=0,l=0
export default{async fetch(r){
if(r.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('Upgrade Required',{status:426,headers:{Connection:'Upgrade',Upgrade:'websocket'}})
const h=r.headers.get('sec-websocket-protocol');if(!h)return new Response(null,{status:400})
let d;try{d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/'))}catch{return new Response(null,{status:400})}
const n=d.length;if(n<18)return new Response(null,{status:400})
let t=m+n<=32768;t||(m=0,t=m+n<=32768);let s;t?(s=M.subarray(m,m+n),m+=n):s=l>0?P[--l]||new Uint8Array(n):new Uint8Array(n)
const F=()=>{!t&&l<12&&s.buffer.byteLength===s.length&&(P[l++]=s)}
for(let i=n;i--;)s[i]=d.charCodeAt(i)
for(let i=16;i--;)if(s[i+1]^U[i]){F();return new Response(null,{status:400})}
const[x,p,z,v]=A(s),k=await B(x,p)||await B('proxy.xxxxxxxx.tk',50001);if(!k){F();return new Response(null,{status:502})}
const{0:c,1:S}=new WebSocketPair,w=k.writable.getWriter();S.accept()
let a=1;const T=()=>{if(!a)return;a=0;try{w.releaseLock()}catch{}try{k.close()}catch{}try{S.close(1006)}catch{}}
if(n>z)w.write(s.subarray(z)).catch(T)
F()
S.addEventListener('message',e=>a&&w.write(e.data).catch(T))
S.addEventListener('close',T);S.addEventListener('error',T)
let f=1;k.readable.pipeTo(new WritableStream({write(d){if(!a)return;if(f){f=0;const h=new Uint8Array(d.length+2);h[0]=v,h.set(d,2),S.send(h)}else S.send(d)},close:T,abort:T})).catch(T)
return new Response(null,{status:101,webSocket:c})
}}
