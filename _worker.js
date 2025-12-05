import{connect as C}from'cloudflare:sockets'
const U=new Uint8Array([207,164,66,231,10,98,92,23,153,27,78,44,147,137,198,95]),M=new Uint8Array(32768),P=[],D=new TextDecoder,
A=s=>{const o=19+s[17],p=s[o]<<8|s[o+1],b=o+3,y=s[o+2]===1,n=s[b],i=b+1;return[y?s[b]+'.'+s[i]+'.'+s[i+1]+'.'+s[i+2]:D.decode(s.subarray(i,i+n)),p,y?b+4:i+n,s[0]]},
B=async(h,p)=>{try{const s=C({hostname:h,port:p,keepAlive:true});await s.opened;return s}catch{return null}};
let m=0
export default{async fetch(r){
const u=r.headers.get('upgrade');if(!u||u.toLowerCase()!=='websocket')return new Response('Upgrade Required',{status:426,headers:{Connection:'Upgrade',Upgrade:'websocket'}})
const h=r.headers.get('sec-websocket-protocol');if(!h)return new Response(null,{status:400})
let d;try{d=atob(h.replace(/[-_]/g,x=>x<'.'?'+':'/'))}catch{return new Response(null,{status:400})}
const n=d.length;if(n<18)return new Response(null,{status:400})
const t=m+n<=32768;let s;if(t)s=M.subarray(m,m+n),m+=n;else{m=0;s=P.pop()||new Uint8Array(n)}
const F=()=>{if(t||P.length>=12||s.buffer.byteLength!==s.length||s.buffer.byteLength>4096)return;P.push(s)}
for(let i=0;i<n;i++)s[i]=d.charCodeAt(i)
for(let i=1;i<17;i++)if(s[i]!==U[i-1]){F();return new Response(null,{status:400})}
const[x,p,z,v]=A(s),k=await B(x,p)||await B('proxy.xxxxxxxx.tk',50001);if(!k){F();return new Response(null,{status:502})}
const{0:c,1:S}=new WebSocketPair,w=k.writable.getWriter();S.accept()
let a=true;const T=()=>{if(!a)return;a=false;try{w.releaseLock()}catch{}try{k.close()}catch{}try{S.close(1006)}catch{}}
if(n>z)w.write(s.subarray(z)).catch(T)
F()
const E=e=>{if(a)w.write(e.data).catch(T)};S.addEventListener('message',E);S.addEventListener('close',T);S.addEventListener('error',T)
let f=true;k.readable.pipeTo(new WritableStream({write(b){if(!a)return;const u=new Uint8Array(b);if(f){f=false;const o=new Uint8Array(u.length+2);o[0]=v;o.set(u,2);S.send(o)}else S.send(u)},close:T,abort:T})).catch(T)
return new Response(null,{status:101,webSocket:c})
}}
