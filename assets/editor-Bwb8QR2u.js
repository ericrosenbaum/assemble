import{c as e,d as t,l as n,o as r,s as i,u as a}from"./index-qDvHk6mT.js";var o={"wedge → 8-ring":()=>t({nRing:8}),"wedge → 6-ring":()=>t({nRing:6}),"square → 2×2 block":()=>i({n:4,k:1}),"square → sheet":()=>a({n:4}),"hexagon → trimer":()=>i({n:6,k:1}),"hexagon → 6-ring":()=>i({n:6,k:2}),"hexagon → fibre":()=>i({n:6,k:3}),"hexagon → honeycomb":()=>a({n:6}),"triangle → 6-rosette":()=>i({n:3,k:1}),"pentagon → 10-ring":()=>i({n:5,k:2}),"triangle hub (+ all faces)":()=>e({n:3}),"rod arm (− one end)":()=>n({}),"blank square":()=>new r({name:`square`,verts:[[-4,-4],[4,-4],[4,4],[-4,4]],charges:[]})};function s(e,{onUse:t}){e.innerHTML=`
    <style>
      .dz-wrap { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
      .dz-wrap canvas { background: #10161d; border-radius: 8px; touch-action: none; width: 100%; }
      .dz-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .dz-row button, .dz-row select { flex: initial; padding: 5px 9px; font-size: 12.5px; }
      .dz-row button.active { background: #e8b04b; color: #14202e; border-color: #e8b04b; }
      .dz-hint { color: #8b98a8; font-size: 11.5px; line-height: 1.4; }
      .dz-json { width: 100%; height: 54px; background: #0d1117; color: #dbe4ee; border: 1px solid #2a3542; border-radius: 6px; font-size: 10.5px; font-family: ui-monospace, monospace; }
    </style>
    <div class="dz-wrap">
      <div class="dz-row">
        start from
        <select class="dz-starter">${Object.keys(o).map(e=>`<option>${e}</option>`).join(``)}</select>
      </div>
      <canvas class="dz-canvas" width="272" height="272"></canvas>
      <div class="dz-row">
        <button data-mode="move" class="active">move</button>
        <button data-mode="plus">+ charge</button>
        <button data-mode="minus">− charge</button>
        <button data-mode="erase">erase</button>
        <button data-mode="vertex">add corner</button>
      </div>
      <div class="dz-hint">move: drag corners · charge modes: tap an edge to place a site · erase: tap a charge or corner · add corner: tap an edge</div>
      <div class="dz-row">
        copies <input class="dz-count" type="number" min="2" max="120" value="24" style="width:64px" />
        <button class="dz-use">▶ simulate</button>
      </div>
      <textarea class="dz-json" spellcheck="false"></textarea>
      <div class="dz-row"><button class="dz-load">load JSON</button><button class="dz-copy">copy JSON</button></div>
    </div>`;let n=e.querySelector(`.dz-canvas`),i=n.getContext(`2d`),a=e.querySelector(`.dz-json`),s=o[`wedge → 8-ring`](),c=s.verts.map(e=>[...e]),l=s.charges.map(e=>({...e})),u=`move`,d=-1,f=()=>n.width/2,p=()=>n.height/2,m=([e,t])=>[f()+e*13,p()-t*13],h=(e,t)=>[(e-f())/13,(p()-t)/13];function g(e){let[t,n]=c[e.edge%c.length],[r,i]=c[(e.edge+1)%c.length];return[t+e.t*(r-t),n+e.t*(i-n)]}function _(){i.fillStyle=`#10161d`,i.fillRect(0,0,n.width,n.height),i.beginPath(),c.forEach((e,t)=>{let[n,r]=m(e);t?i.lineTo(n,r):i.moveTo(n,r)}),i.closePath(),i.fillStyle=`#e8b04bcc`,i.fill(),i.strokeStyle=`#00000088`,i.lineWidth=2,i.stroke();for(let e of c){let[t,n]=m(e);i.beginPath(),i.arc(t,n,5,0,Math.PI*2),i.fillStyle=`#dbe4ee`,i.fill()}for(let e of l){let[t,n]=m(g(e));i.beginPath(),i.arc(t,n,6,0,Math.PI*2),i.fillStyle=e.q>0?`#ff5c5c`:`#5ca8ff`,i.fill(),i.strokeStyle=`#000000aa`,i.lineWidth=1.5,i.beginPath(),i.moveTo(t-3,n),i.lineTo(t+3,n),e.q>0&&(i.moveTo(t,n-3),i.lineTo(t,n+3)),i.stroke()}v()}function v(){a.value=JSON.stringify({name:`custom`,verts:c,charges:l})}function y(e,t,n=14){let r=-1,i=n*n;return c.forEach((n,a)=>{let[o,s]=m(n),c=(o-e)**2+(s-t)**2;c<i&&(i=c,r=a)}),r}function b(e,t){let[n,r]=h(e,t),i={edge:-1,t:0,d:1.2};for(let e=0;e<c.length;e++){let[t,a]=c[e],[o,s]=c[(e+1)%c.length],l=o-t,u=s-a,d=l*l+u*u,f=((n-t)*l+(r-a)*u)/d;f=Math.max(.05,Math.min(.95,f));let p=t+f*l-n,m=a+f*u-r,h=Math.hypot(p,m);h<i.d&&(i={edge:e,t:f,d:h})}return i.edge>=0?i:null}function x(e,t,n=12){let r=-1,i=n*n;return l.forEach((n,a)=>{let[o,s]=m(g(n)),c=(o-e)**2+(s-t)**2;c<i&&(i=c,r=a)}),r}n.addEventListener(`pointerdown`,e=>{let t=n.getBoundingClientRect(),r=(e.clientX-t.left)*n.width/t.width,i=(e.clientY-t.top)*n.height/t.height;if(u===`move`)d=y(r,i),n.setPointerCapture(e.pointerId);else if(u===`plus`||u===`minus`){let e=b(r,i);e&&l.push({edge:e.edge,t:e.t,q:u===`plus`?1:-1})}else if(u===`erase`){let e=x(r,i);if(e>=0)l.splice(e,1);else{let e=y(r,i);e>=0&&c.length>3&&(l=l.filter(t=>t.edge!==e&&t.edge!==(e-1+c.length)%c.length),l.forEach(t=>{t.edge>e&&t.edge--}),c.splice(e,1))}}else if(u===`vertex`){let e=b(r,i);if(e){let[t,n]=c[e.edge],[r,i]=c[(e.edge+1)%c.length];c.splice(e.edge+1,0,[t+e.t*(r-t),n+e.t*(i-n)]),l.forEach(t=>{t.edge>e.edge&&t.edge++})}}_()}),n.addEventListener(`pointermove`,e=>{if(u!==`move`||d<0)return;let t=n.getBoundingClientRect(),r=(e.clientX-t.left)*n.width/t.width,i=(e.clientY-t.top)*n.height/t.height;c[d]=h(r,i),_()}),n.addEventListener(`pointerup`,()=>d=-1);for(let t of e.querySelectorAll(`[data-mode]`))t.addEventListener(`click`,()=>{u=t.dataset.mode,e.querySelectorAll(`[data-mode]`).forEach(e=>e.classList.toggle(`active`,e===t))});e.querySelector(`.dz-starter`).addEventListener(`change`,e=>{let t=o[e.target.value]();c=t.verts.map(e=>[...e]),l=t.charges.map(e=>({...e})),_()}),e.querySelector(`.dz-use`).addEventListener(`click`,()=>{try{t(new r({name:`custom`,verts:c,charges:l}),Number(e.querySelector(`.dz-count`).value)||24)}catch(e){alert(`invalid shape: `+e.message)}}),e.querySelector(`.dz-load`).addEventListener(`click`,()=>{try{let e=JSON.parse(a.value);c=e.verts.map(e=>[...e]),l=(e.charges??[]).map(e=>({...e})),_()}catch(e){alert(`bad JSON: `+e.message)}}),e.querySelector(`.dz-copy`).addEventListener(`click`,()=>{navigator.clipboard?.writeText(a.value)}),_()}export{s as mountDesigner};