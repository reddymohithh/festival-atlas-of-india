let STATES = [];
let byName = new Map();
const BAND = {
  hindu:     {label:"Hindu & temple",       color:"var(--saffron)", raw:"#C4531F"},
  muslim:    {label:"Islamic",              color:"var(--indigo)",  raw:"#2B3A67"},
  christian: {label:"Christian",            color:"var(--green)",   raw:"#3F6141"},
  harvest:   {label:"Harvest & seasonal",   color:"var(--turmeric)",raw:"#A0791A"},
  community: {label:"Community & cultural", color:"var(--red)",     raw:"#8A2B2B"}
};
// a hue per state: warm, saturated, neighbours distinct, never a single flat grey map
const STATE_HUES = ["#E8B04B","#E0784C","#C9544B","#7C9A6D","#5E8B9B","#9B7BA8","#D98FA0",
                    "#6F7FB5","#C3A05B","#86A98E","#D2A25C","#B9694F"];
// assigned once the real topology is known (see computeStateColors), so that
// two states sharing a border never land on the same hue; a hash-of-the-name
// fallback covers any state somehow missing from that map
let stateColorMap = new Map();
const stateFill = name => {
  if (stateColorMap.has(name)) return stateColorMap.get(name);
  let hsum = 0; for (let i = 0; i < name.length; i++) hsum = (hsum*31 + name.charCodeAt(i)) % 9973;
  return STATE_HUES[hsum % STATE_HUES.length];
};
// classic greedy graph colouring over the map's real adjacency (who actually
// shares a border with whom), highest-degree state first, so every state
// gets the lowest-index hue not already used by a neighbour
function computeStateColors(topo){
  const geoms = topo.objects.states.geometries;
  const neighborIdx = topojson.neighbors(geoms);
  const order = geoms.map((g,i) => i).sort((a,b) => neighborIdx[b].length - neighborIdx[a].length);
  const color = new Array(geoms.length).fill(-1);
  // always taking the lowest free hue collapses the whole map to about as
  // few colours as the densest little cluster needs (four or so); picking
  // whichever free hue has been used least so far instead spreads the map
  // across the full palette while still keeping every border two-toned
  const usage = new Array(STATE_HUES.length).fill(0);
  order.forEach(i => {
    const used = new Set(neighborIdx[i].map(j => color[j]).filter(c => c >= 0));
    let best = -1;
    for (let c = 0; c < STATE_HUES.length; c++){
      if (used.has(c)) continue;
      if (best === -1 || usage[c] < usage[best]) best = c;
    }
    if (best === -1) best = 0;
    color[i] = best;
    usage[best]++;
  });
  const map = new Map();
  geoms.forEach((g,i) => map.set(g.properties.st_nm, STATE_HUES[color[i]]));
  return map;
}
const escAttr = s => String(s).replace(/"/g, "&quot;");
// the same two letters used on that state or union territory's vehicle number plates
const VEHICLE_CODE = {
  "Andaman and Nicobar Islands":"AN", "Andhra Pradesh":"AP", "Arunachal Pradesh":"AR",
  "Assam":"AS", "Bihar":"BR", "Chandigarh":"CH", "Chhattisgarh":"CG",
  "Dadra and Nagar Haveli and Daman and Diu":"DD", "Delhi":"DL", "Goa":"GA", "Gujarat":"GJ",
  "Haryana":"HR", "Himachal Pradesh":"HP", "Jammu and Kashmir":"JK", "Jharkhand":"JH",
  "Karnataka":"KA", "Kerala":"KL", "Ladakh":"LA", "Lakshadweep":"LD", "Madhya Pradesh":"MP",
  "Maharashtra":"MH", "Manipur":"MN", "Meghalaya":"ML", "Mizoram":"MZ", "Nagaland":"NL",
  "Odisha":"OD", "Puducherry":"PY", "Punjab":"PB", "Rajasthan":"RJ", "Sikkim":"SK",
  "Tamil Nadu":"TN", "Telangana":"TS", "Tripura":"TR", "Uttar Pradesh":"UP",
  "Uttarakhand":"UK", "West Bengal":"WB"
};

let selected = null, current = null, angle = 0, paused = false, tagExpanded = false;

// five clicks on the word "Atlas" in the title, each within 800ms of the
// last, opens the admin panel; anyone just reading the title never notices
let atlasClicks = 0, atlasClickTimer = null;
function handleAtlasClick(e){
  e.stopPropagation();
  atlasClicks++;
  clearTimeout(atlasClickTimer);
  atlasClickTimer = setTimeout(() => { atlasClicks = 0; }, 800);
  if (atlasClicks >= 5){
    atlasClicks = 0;
    window.location.href = "admin.html";
  }
}
let projection, pathGen, features = [], centroids = new Map();
const drift = {x:0, y:0, tx:0, ty:0};
window.addEventListener("pointermove", e => {
  const {w,h} = stageSize();
  drift.tx = ((e.clientX - w/2) / (w/2)) * (isMobile() ? 8 : 26);
  drift.ty = ((e.clientY - h/2) / (h/2)) * (isMobile() ? 6 : 18);
});
window.addEventListener("pointerleave", () => { drift.tx = 0; drift.ty = 0; });
const mapEl = document.getElementById("map");
const uni = document.getElementById("universe");
const detail = document.getElementById("detail");

const isMobile = () => window.innerWidth <= 820;
const stageSize = () => ({w: window.innerWidth, h: window.innerHeight});

/* ---------------- map ---------------- */
let topology = null;
Promise.all([
  d3.json("https://cdn.jsdelivr.net/gh/udit-001/india-maps-data@main/topojson/india.json"),
  fetch("js/data.json").then(r => r.json())
])
  .then(([topo, states]) => {
    topology = topo;
    features = topojson.feature(topo, topo.objects.states).features;
    stateColorMap = computeStateColors(topo);
    STATES = states;
    byName = new Map(STATES.map(s => [s.st_nm, s]));
    ensureMap();
    if (window.ResizeObserver) new ResizeObserver(() => drawMap()).observe(document.getElementById("stage"));
    window.addEventListener("resize", drawMap);
  })
  .catch(e => {
    mapEl.innerHTML = '<div style="position:absolute;inset:0;display:grid;place-items:center;'
      + 'font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;'
      + 'color:var(--ink-2)">Map geometry could not load</div>';
    console.error(e);
  });

// Andaman & Nicobar and Lakshadweep sit far out to sea; fitting them in with the
// mainland shrinks the mainland and pushes it off centre, so the projection is
// framed on the mainland only. Both island groups still render, just wherever
// that same projection happens to place them.
const FAR_ISLANDS = ["Andaman and Nicobar Islands","Lakshadweep"];

// nudges overlapping labels apart, a few dozen cheap passes over a handful of
// candidates at a time, tethered to their real centroid so a label never
// drifts far from the place it names
function declutterLabels(labels, iterations = 160){
  for (let iter = 0; iter < iterations; iter++){
    let moved = false;
    for (let i = 0; i < labels.length; i++){
      for (let j = i+1; j < labels.length; j++){
        const a = labels[i], b = labels[j];
        const ox = Math.min(a.x+a.w/2, b.x+b.w/2) - Math.max(a.x-a.w/2, b.x-b.w/2);
        const oy = Math.min(a.y, b.y) - Math.max(a.y-a.h, b.y-b.h);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (oy <= ox){
          const dir = (a.y - b.y) >= 0 ? 1 : -1;
          const s = (oy/2 + 0.5) * dir;
          a.y += s; b.y -= s;
        } else {
          const dir = (a.x - b.x) >= 0 ? 1 : -1;
          const s = (ox/2 + 0.5) * dir;
          a.x += s; b.x -= s;
        }
      }
    }
    labels.forEach(l => {
      const dx = l.x - l.ox, dy = l.y - l.oy, dist = Math.hypot(dx,dy), maxDist = 36;
      if (dist > maxDist){ const k = maxDist/dist; l.x = l.ox + dx*k; l.y = l.oy + dy*k; }
    });
    if (!moved) break;
  }
}

function drawMap(){
  const {w,h} = stageSize();
  if (w < 1 || h < 1 || !features.length) return false;
  const mob = isMobile();
  const mainland = features.filter(f => !FAR_ISLANDS.includes(f.properties.st_nm));
  const fc = {type:"FeatureCollection", features: mainland};
  const box = mob
    ? [[w*0.06, h*0.05],[w*0.94, h*0.62]]
    : [[w*0.14, h*0.03],[w*0.86, h*0.99]];
  projection = d3.geoMercator().fitExtent(box, fc);
  pathGen = d3.geoPath(projection);

  const svg = d3.select(mapEl).selectAll("svg").data([0]).join("svg")
    .attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio","none");
  svg.selectAll("*").remove();
  const defs = svg.append("defs");
  const sea = defs.append("radialGradient").attr("id","seawash")
    .attr("cx","50%").attr("cy","46%").attr("r","62%");
  sea.append("stop").attr("offset","0%").attr("stop-color","#EAF0EC");
  sea.append("stop").attr("offset","62%").attr("stop-color","#F1EDE3");
  sea.append("stop").attr("offset","100%").attr("stop-color","#F3EDE2");
  svg.append("rect").attr("id","sea").attr("width",w).attr("height",h).attr("fill","url(#seawash)");
  const g = svg.append("g").attr("id","mapparallax").append("g").attr("id","mapgroup");

  g.selectAll("path.state").data(features).join("path")
    .attr("class", d => "state" + (byName.has(d.properties.st_nm) ? " live" : ""))
    .attr("fill", d => stateFill(d.properties.st_nm))
    .attr("d", pathGen)
    .attr("data-name", d => d.properties.st_nm)
    .on("click", (ev,d) => { if (byName.has(d.properties.st_nm)) openState(d.properties.st_nm); })
    .on("mouseenter", (ev,d) => { if (byName.has(d.properties.st_nm)) showHoverOutline(d.properties.st_nm); })
    .on("mouseleave", hideHoverOutline);

  g.append("path").attr("id","mapoutline")
    .attr("d", pathGen(topojson.merge(topology, topology.objects.states.geometries)));

  // a shared border belongs to two neighbouring paths at once, and whichever
  // is drawn second clips the other's own stroke there. Rather than reorder
  // the coloured fill paths (which briefly steals the pointer's hit-test
  // target mid-hover and made the effect flicker), the highlighted border is
  // a completely separate outline traced fresh on top for whichever state is
  // hovered or selected, so it is always whole on every side. A single path
  // can be several disjoint pieces (Puducherry's four enclaves, Daman and
  // Diu's coastal pair): tracing the real geometry outlines every piece at
  // once, which is correct, that territory really does sit in several places
  const hoverOutlineEl = g.append("path").attr("id","hoverOutline").node();
  g.append("path").attr("id","selOutline");
  function outlineDFor(name){
    const f = features.find(x => x.properties.st_nm === name);
    return f ? pathGen(f) : null;
  }
  function showHoverOutline(name){
    if (document.body.classList.contains("state-open")) return;
    const d = outlineDFor(name);
    if (!d) return;
    hoverOutlineEl.setAttribute("d", d);
    hoverOutlineEl.classList.add("active");
  }
  function hideHoverOutline(){ hoverOutlineEl.classList.remove("active"); }

  features.forEach(f => {
    centroids.set(f.properties.st_nm, projection(d3.geoCentroid(f)));
  });

  // the title lives inside the map itself (not a floating HTML overlay) so it
  // pans and blurs together with everything else, parked in the empty
  // Tibet/Nepal gap above the northeast states on desktop. It is anchored as
  // a fraction of the mainland's own rendered bounding box, not the raw
  // viewport: fitExtent can end up width bound or height bound depending on
  // the window's aspect ratio, so a point tied to the viewport, or even to
  // one fixed geographic coordinate, can land right on top of the map once
  // it shrinks on a wide window. A fraction of the map's own box tracks
  // correctly either way, since it shrinks by exactly the same amount the
  // map does; mobile's tighter crop has no such gap, so it keeps a fixed corner
  const mainlandBox = pathGen.bounds(fc);
  const boxW = mainlandBox[1][0] - mainlandBox[0][0];
  // the headline's left edge and its right edge are two independent marks in
  // the gap, not one point: line1X is where "Festival" starts, line2X is
  // where "India" ends, both as fractions of the mainland's own box so they
  // track correctly at any window size the same way the single point used to
  const line1X = mainlandBox[0][0] + boxW*0.49;
  const line2X = mainlandBox[0][0] + boxW*0.89;
  const titleWY0 = mainlandBox[0][1] + (mainlandBox[1][1]-mainlandBox[0][1])*0.20;
  const titleX = mob ? 20 : line1X, titleY = mob ? 34 : titleWY0;
  // "Atlas" is a quiet five-click door to the admin panel, so it gets its
  // own tspan to click against, re-enabling pointer events just there
  const titleEl = g.append("text").attr("class","svgtitle").attr("x",titleX).attr("y",titleY)
    .html('Festival <tspan id="atlasWord">Atlas</tspan> of India').node();
  d3.select("#atlasWord").on("click", handleAtlasClick);

  // stretch the headline to exactly fill line1 to line2 by scaling its font
  // size (never a non-uniform transform, which would squash the letterforms)
  let subGap = mob ? 24 : 30;
  if (!mob){
    const naturalWidth = titleEl.getComputedTextLength();
    const scale = (line2X - line1X) / naturalWidth;
    titleEl.style.fontSize = (26 * scale).toFixed(1) + "px";
    subGap = 30 * scale;
  }

  g.append("text").attr("class","svgtitle-sub").attr("x",titleX).attr("y",titleY + subGap)
    .text("A Cultural Cartography");

  // every state and union territory is live: a dot, a generous invisible hit
  // target (so tiny union territories stay easy to tap), and a name label
  const labels = [];
  features.forEach(f => {
    const n = f.properties.st_nm, c = centroids.get(n);
    if (!c || !byName.has(n)) return;
    g.append("circle").attr("class","dotring").attr("cx",c[0]).attr("cy",c[1]).attr("r",8.5);
    g.append("circle").attr("class","dot").attr("cx",c[0]).attr("cy",c[1]).attr("r",4);
    // the hit circle sits on top of the path at its centroid so tiny union
    // territories stay clickable, which also means it eats the path's own
    // :hover there; forward hover in by hand so the border and lift still show
    g.append("circle").attr("class","hit").attr("data-name",n).attr("cx",c[0]).attr("cy",c[1]).attr("r",17)
      .on("click", () => openState(n))
      .on("mouseenter", () => showHoverOutline(n))
      .on("mouseleave", hideHoverOutline);
    const t = g.append("text").attr("class","maplabel").attr("text-anchor","middle").text(VEHICLE_CODE[n] || n.toUpperCase());
    const b = t.node().getBBox();
    labels.push({el:t, x:c[0], y:c[1]-11, ox:c[0], oy:c[1]-11, w:b.width+8, h:b.height+6});
  });
  declutterLabels(labels);
  labels.forEach(l => l.el.attr("x", l.x).attr("y", l.y));

  // motif marks: small geometric accents so the sea is not dead space
  const mg = g.append("g").attr("class","motif").attr("opacity",".55");
  const spots = [[.14,.16],[.20,.40],[.11,.62],[.17,.83],[.86,.20],[.90,.44],[.83,.66],[.88,.86],
                 [.35,.05],[.62,.04],[.46,.96],[.70,.93]];
  spots.forEach(([px,py],i) => {
    const c = STATE_HUES[(i*5) % STATE_HUES.length];
    const x = px*w, y = py*h, r = 3.4 + (i % 3);
    if (i % 3 === 0) mg.append("circle").attr("cx",x).attr("cy",y).attr("r",r).attr("fill",c).attr("opacity",.5);
    else if (i % 3 === 1) mg.append("rect").attr("x",x-r).attr("y",y-r).attr("width",2*r).attr("height",2*r)
      .attr("transform","rotate(45 "+x+" "+y+")").attr("fill",c).attr("opacity",.42);
    else mg.append("circle").attr("cx",x).attr("cy",y).attr("r",r+1.5).attr("fill","none")
      .attr("stroke",c).attr("stroke-width",1.4).attr("opacity",.5);
  });

  if (selected) { applyTransform(); layout(); }
  else d3.select("#mapgroup").attr("transform",null);

  return true;
}

function ensureMap(){
  if (drawMap()) return;
  const t = setInterval(() => { if (drawMap()) clearInterval(t); }, 100);
  window.addEventListener("load", drawMap);
  document.addEventListener("visibilitychange", drawMap);
}

function universeCenter(){
  const {w,h} = stageSize();
  return isMobile() ? [w*0.5, h*0.62] : [w*0.5, h*0.52];
}
function universeRadius(){
  const {w,h} = stageSize();
  return isMobile() ? Math.min(w*0.44, h*0.30) : Math.min(w,h)*0.325;
}

function applyTransform(){
  const c = centroids.get(selected.st_nm);
  if (!c) return;
  const [ux,uy] = universeCenter();
  const s = isMobile() ? 1.15 : 1.28;
  d3.select("#mapgroup").attr("transform", `translate(${ux - s*c[0]},${uy - s*c[1]}) scale(${s})`);
}

/* ---------------- state open / close ---------------- */
function openState(name){
  closeDetail();
  selected = byName.get(name);
  document.body.classList.add("state-open");
  document.querySelectorAll("path.state").forEach(p =>
    p.classList.toggle("sel", p.getAttribute("data-name") === name));
  const f = features.find(x => x.properties.st_nm === name);
  const selOutline = document.getElementById("selOutline");
  if (f && pathGen && selOutline) selOutline.setAttribute("d", pathGen(f));
  const hoverOutline = document.getElementById("hoverOutline");
  if (hoverOutline) hoverOutline.classList.remove("active");
  applyTransform();
  buildUniverse();
}
function closeState(){
  closeDetail();
  selected = null;
  document.body.classList.remove("state-open");
  document.querySelectorAll("path.state.sel").forEach(p => p.classList.remove("sel"));
  d3.select("#mapgroup").attr("transform",null);
  setTimeout(() => { if(!selected) uni.innerHTML = ""; }, 600);
}

document.addEventListener("click", e => {
  if (document.body.classList.contains("detail-open")) {
    if (e.target.closest("#detail")) return;
    closeDetail();
    return;
  }
  if (!selected) return;
  if (e.target.closest(".node")) return;
  if (e.target.closest("#core")) { setTagExpanded(!tagExpanded); return; }
  if (e.target.closest("#veil")) { if (tagExpanded) setTagExpanded(false); return; }
  closeState();
}, true);

function setTagExpanded(v){
  tagExpanded = v;
  layout();
}

/* ---------------- universe ---------------- */
function buildUniverse(){
  uni.innerHTML = "";
  tagExpanded = false;

  const ring = document.createElement("div"); ring.id = "ring";
  const ring2 = document.createElement("div"); ring2.id = "ring2";
  const veil = document.createElement("div"); veil.id = "veil";
  uni.appendChild(veil); uni.appendChild(ring); uni.appendChild(ring2);

  const core = document.createElement("div"); core.id = "core";
  core.innerHTML = `<div class="cbrief">
      <div class="cname">${selected.name}</div>
      <div class="cmeta">${selected.capital}<br>${selected.languages}</div>
    </div>
    <div class="ctag">${selected.tagline}</div>`;
  uni.appendChild(core);

  selected.festivals.forEach((f,i) => {
    const n = document.createElement("div");
    n.className = "node"; n.dataset.i = i;
    const c = BAND[f.band].raw;
    n.style.background = `color-mix(in oklab, ${c} 9%, var(--paper))`;
    n.style.border = `1px solid color-mix(in oklab, ${c} 42%, transparent)`;
    n.innerHTML = `<div class="nname">${f.name}</div>
      <div class="nmeta">${f.month}</div>`;
    n.addEventListener("mouseenter", () => { uni.classList.add("hovering"); paused = true; });
    n.addEventListener("mouseleave", () => { uni.classList.remove("hovering"); paused = false; });
    n.addEventListener("click", () => openDetail(i));
    uni.appendChild(n);
  });
  layout();
}


const CV = document.createElement("canvas").getContext("2d");
function longestWordPx(name, ft){
  CV.font = ft + "px Newsreader, Georgia, serif";
  return Math.max(...name.split(/\s+/).map(w => CV.measureText(w).width));
}
// every node's name is set in the same base size regardless of the circle's
// scale; only a name too long for even the biggest circle shrinks from here
function baseFont(){
  return isMobile() ? 10.5 : 12;
}
// A node's content box is the square inscribed in its circle (0.72d), so the diameter
// is derived from the longest word in the name: labels can never fragment mid-word.
function measureNode(f, dMin, dMax){
  let ft = baseFont();
  // 1.15 covers the gap between canvas metrics and the rendered webfont
  const w = longestWordPx(f.name, ft) * 1.15;
  const d = Math.max(46, Math.min(Math.max(dMin, w/0.72), dMax));
  if (0.72*d < w) ft = Math.max(8.5, ft * 0.72 * d / w);
  return {d, ft};
}
function applyNode(el, d, ft){
  if (!el) return;
  el.style.width = el.style.height = Math.round(d)+"px";
  el.style.padding = (d*0.14).toFixed(1)+"px";
  const name = el.querySelector(".nname"), meta = el.querySelector(".nmeta");
  if (meta) meta.style.fontSize = Math.max(6.8, Math.min(9, d*0.1)).toFixed(1)+"px";
  if (!name) return;
  // correct against the real rendered box: a word wider than the content box
  // shows up as scrollWidth overflow, so shrink until it genuinely fits
  let f = Math.max(8.5, ft);
  name.style.fontSize = f.toFixed(1)+"px";
  for (let p = 0; p < 5 && name.scrollWidth > name.clientWidth; p++){
    f = Math.max(8, f * (name.clientWidth / name.scrollWidth) * 0.98);
    name.style.fontSize = f.toFixed(1)+"px";
  }
  for (let p = 0; p < 4 && el.scrollHeight > el.clientHeight; p++){
    f = Math.max(8, f * 0.92);
    name.style.fontSize = f.toFixed(1)+"px";
  }
}

let ORB = null;

function layout(){
  if (!selected) return;
  const {w,h} = stageSize();
  const [cx,cy] = universeCenter();
  const fs = selected.festivals, mob = isMobile();
  const core = document.getElementById("core");
  const ring = document.getElementById("ring"), ring2 = document.getElementById("ring2");
  const veil = document.getElementById("veil");
  const items = fs.map((f,i) => ({f,i}));
  const put = (el,x,y,ww,hh,rad) => { if (el) Object.assign(el.style,
    {left:x+"px", top:y+"px", width:ww+"px", height:hh+"px", borderRadius:rad}); };
  // reset every node so no inline value survives a state change
  uni.querySelectorAll(".node").forEach(el => {
    ["width","height","padding","borderRadius","left","top"].forEach(p => el.style[p] = "");
    const nm = el.querySelector(".nname"); if (nm) nm.style.fontSize = "";
  });

  // the disc is sized from the card's RENDERED text box, then the ring from the disc
  const availR = mob ? Math.min(w*0.46, h*0.32) : Math.min(w*0.46, h*0.46);
  const geom = s2 => availR * (mob ? 0.40 : 0.34) * (s2 === 3 ? 1 : s2 === 2 ? 0.86 : 0.74);
  const m = items.map(o => Object.assign({}, o, measureNode(o.f, geom(o.f.scale), 132)));
  const n = m.length;
  const stag = s2 => s2 === 3 ? 0.97 : s2 === 2 ? 1.0 : 1.03;

  core.classList.add("disc");
  // the description only shows once the visitor asks for it by clicking the
  // disc; until then it stays compact, same as when it genuinely doesn't fit
  core.classList.toggle("compact", !tagExpanded);
  core.style.transform = "none";
  core.style.textAlign = "center";
  core.style.left = "0px"; core.style.top = "0px";
  core.style.padding = "0";
  core.style.width = core.style.height = "auto";
  core.style.maxWidth = (mob ? 140 : 184)+"px";
  const fitCore = () => {
    const cw = core.offsetWidth, ch = core.offsetHeight;
    return Math.hypot(cw, ch)/2 + 10;
  };
  let coreR = fitCore();
  if (coreR > availR*0.46){            // tagline is the first thing to go
    core.classList.add("compact");
    coreR = fitCore();
  }
  if (coreR > availR*0.50){
    core.style.maxWidth = (mob ? 118 : 150)+"px";
    coreR = fitCore();
  }
  coreR = Math.max(coreR, mob ? 44 : 54);

  let rBase = 0, maxD = 0;
  for (let pass = 0; pass < 3; pass++){
    m.forEach(x => { x.el = uni.querySelector('.node[data-i="'+x.i+'"]');
      if (x.el) x.el.style.borderRadius = "50%";
      applyNode(x.el, x.d, x.ft); });
    m.forEach(x => { x.real = x.el ? x.el.offsetWidth : x.d; });
    maxD = Math.max(...m.map(x => x.real));
    rBase = Math.max(coreR + maxD/2 + 16,
                     n > 1 ? (maxD + 26)/(2*Math.sin(Math.PI/n)) : coreR + maxD/2 + 16);
    const over = (rBase*1.03 + maxD/2) / availR;
    if (over <= 1.001) break;
    const shrink = Math.max(0.6, 1/over);
    m.forEach(x => { x.d = x.real * shrink; x.ft *= shrink; });
  }
  m.forEach(x => { x.r = rBase * stag(x.f.scale); });

  core.classList.add("disc");
  core.style.maxWidth = "none";
  core.style.padding = "0 " + (coreR*0.15).toFixed(0) + "px";
  put(core, cx - coreR, cy - coreR, 2*coreR, 2*coreR, "50%");
  core.style.transform = "none";
  put(ring, cx - rBase, cy - rBase, 2*rBase, 2*rBase, "50%");
  put(ring2, cx - coreR, cy - coreR, 2*coreR, 2*coreR, "50%");
  const vr = rBase*1.03 + maxD/2 + 10;
  put(veil, cx - vr, cy - vr, 2*vr, 2*vr, "50%");
  ORB = {cx, cy, nodes: m.map(x => ({i:x.i, r:x.r}))};
  placeRing(ORB.nodes, cx, cy);
}

function placeRing(list, cx, cy){
  const n = list.length; if (!n) return;
  list.forEach((o,k) => {
    const a2 = (-90 + angle + k*(360/n)) * Math.PI/180;
    const el = uni.querySelector('.node[data-i="'+o.i+'"]');
    if (!el) return;
    el.style.left = (cx + o.r*Math.cos(a2) - el.offsetWidth/2)+"px";
    el.style.top = (cy + o.r*Math.sin(a2) - el.offsetHeight/2)+"px";
  });
}


function tick(){
  const px = document.getElementById("mapparallax");
  if (px){
    const tx = selected ? 0 : drift.tx, ty = selected ? 0 : drift.ty;
    drift.x += (tx - drift.x) * 0.07;
    drift.y += (ty - drift.y) * 0.07;
    if (Math.abs(drift.x) > 0.01 || Math.abs(drift.y) > 0.01 || tx || ty)
      px.setAttribute("transform", "translate(" + drift.x.toFixed(2) + "," + drift.y.toFixed(2) + ")");
  }
  if (ORB && selected && !paused
      && !document.body.classList.contains("detail-open")){
    angle += 0.022;
    placeRing(ORB.nodes, ORB.cx, ORB.cy);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------------- detail ---------------- */
const SECTIONS = [
  ["what","What is it?"],["who","Who celebrates it?"],["when","When is it celebrated?"],
  ["origin","Where did it begin?"],["signifies","What does it signify?"],
  ["beliefs","What do people believe?"],["celebrate","How is it celebrated?"]
];

function openDetail(i){
  current = i;
  const f = selected.festivals[i], fs = selected.festivals;
  document.getElementById("detail-body").innerHTML = `
    <div class="dtop">
      <button class="dback" id="dback">← Back to ${selected.name}</button>
      <button class="dclose" id="dclose" aria-label="Close">✕</button>
    </div>
    <div class="dcat">${f.categories.map(c=>`<span>${c}</span>`).join("")}
      <span>Scale ${f.scale===3?"major":f.scale===2?"widespread":"local"}</span></div>
    <h2>${f.name}</h2>
    <div class="dsub">${selected.name} · ${f.month}</div>
    <div class="dalias">Also known as ${f.aliases}</div>
    <div class="hero">${f.imageUrl
      ? `<img src="${escAttr(f.imageUrl)}" alt="${escAttr(f.name)}" loading="lazy">`
      : `<em>Photograph to place here: ${f.image}</em>`}</div>
    ${f.imageUrl ? `<div class="herocap">${f.image}</div>` : ""}
    <div class="reach">${f.reach.replace(/\.+$/, "")}.</div>
    ${SECTIONS.map(([k,t]) => `<div class="sect"><h3>${t}</h3><p>${f[k]}</p></div>`).join("")}
    <div class="local"><h3>A local detail</h3><p>${f.local}</p></div>
    <div class="dnav">
      <button id="dprev" ${i===0?"disabled":""}>← ${i===0?"":fs[i-1].name}</button>
      <button id="dnext" ${i===fs.length-1?"disabled":""} style="text-align:right">${i===fs.length-1?"":fs[i+1].name} →</button>
    </div>`;
  detail.setAttribute("aria-hidden","false");
  document.body.classList.add("detail-open");
  detail.scrollTop = 0;
  document.getElementById("dback").onclick = closeDetail;
  document.getElementById("dclose").onclick = closeDetail;
  const p = document.getElementById("dprev"), nx = document.getElementById("dnext");
  if (!p.disabled) p.onclick = () => openDetail(i-1);
  if (!nx.disabled) nx.onclick = () => openDetail(i+1);
}
function closeDetail(){
  document.body.classList.remove("detail-open");
  detail.setAttribute("aria-hidden","true");
  current = null;
}

window.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.body.classList.contains("detail-open")) closeDetail();
  else if (selected) closeState();
});
window.addEventListener("resize", () => { if (selected) layout(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (selected) layout(); });
