'use strict';

/* ============================================================
   ZEITERFASSUNG PWA
   Datenhaltung: localStorage (JSON). CSV/Excel als Backup.
   ============================================================ */

const STORE_KEY = 'zeit_data_v1';
const APP_VERSION = '1.10.0';
const APP_BUILD = '2026-07-22';
const WP_TYPES = { I:'Office duty', A:'On field', D:'On-site service', O:'Field service o. Aufwand', T:'Homeoffice', U:'Abroad' };
const DAY_SOLL = 8;            // Stunden pro Werktag Mo-Fr
const PAUSE_MIN = 30;          // Minuten Pause
const PAUSE_THRESHOLD = 6;     // Pause erst ab > 6h
const VAC_PER_YEAR = 25;       // Urlaubstage pro Jahr

/* ---------- State ---------- */
let DB = load();
let view = 'overview';         // overview | calendar | capture | admin
let calMode = 'month';         // week | month | year
let cursor = new Date();       // navigierbares Datum
let timer = loadTimer();       // {start: ms, dateISO} — persistiert, überlebt App-Neustart
let modal = null;

/* ---------- Persistence ---------- */
const TIMER_KEY='zeit_timer_v1';
function loadTimer(){
  try{ const raw=localStorage.getItem(TIMER_KEY); if(raw) return JSON.parse(raw); }catch(e){}
  return null;
}
function saveTimer(){
  try{
    if(timer) localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(TIMER_KEY);
  }catch(e){}
}
function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {
    entries: {},        // "YYYY-MM-DD": [ {id, from, to, wp, info, order} ]
    dayType: {},        // "YYYY-MM-DD": {type:'vac|za|sick', half:bool}
    settings: {
      startYear: 2025,
      startVacBalance: null,   // manuell einzugeben
      hireDate: '2025-10-20'
    }
  };
}
function save(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }catch(e){ toast('Speichern fehlgeschlagen'); }
}

/* ---------- Date helpers ---------- */
function pad(n){ return String(n).padStart(2,'0'); }
function iso(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function parseISO(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function todayISO(){ return iso(new Date()); }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function isWeekend(d){ const w=d.getDay(); return w===0||w===6; }
function mondayOf(d){ const x=new Date(d); const w=(x.getDay()+6)%7; x.setDate(x.getDate()-w); x.setHours(0,0,0,0); return x; }
const DOW_DE = ['Mo','Di','Mi','Do','Fr','Sa','So'];
const MON_DE = ['Jänner','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const MON_SHORT = ['Jän','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

/* ---------- Feiertage (AT), inkl. bewegliche über Osterformel ---------- */
const _holCache = {};
function easter(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),
        h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
        l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
        mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  return new Date(y,mo-1,da);
}
function holidays(year){
  if(_holCache[year]) return _holCache[year];
  const set = {};
  const fixed = [[1,1,'Neujahr'],[1,6,'Hl. Drei Könige'],[5,1,'Staatsfeiertag'],
    [8,15,'Mariä Himmelfahrt'],[10,26,'Nationalfeiertag'],[11,1,'Allerheiligen'],
    [12,8,'Mariä Empfängnis'],[12,25,'Christtag'],[12,26,'Stefanitag']];
  fixed.forEach(([m,d,n])=> set[iso(new Date(year,m-1,d))]=n);
  const e = easter(year);
  set[iso(addDays(e,1))]='Ostermontag';
  set[iso(addDays(e,39))]='Christi Himmelfahrt';
  set[iso(addDays(e,50))]='Pfingstmontag';
  set[iso(addDays(e,60))]='Fronleichnam';
  _holCache[year]=set;
  return set;
}
function holidayName(dISO){
  const y = Number(dISO.slice(0,4));
  return holidays(y)[dISO] || null;
}

/* ---------- Zeit-Berechnung ---------- */
function hmToMin(hm){ if(!hm) return null; const [h,m]=hm.split(':').map(Number); return h*60+(m||0); }
function minToH(min){ return min/60; }
function fmtH(h){
  if(h==null) return '–';
  const neg = h<0; h=Math.abs(h);
  const hh=Math.floor(h+1e-9); const mm=Math.round((h-hh)*60);
  let out = mm===0 ? hh+':00' : hh+':'+pad(mm);
  return (neg?'-':'')+out;
}
function fmtHDec(h){ return (h<0?'-':'')+Math.abs(h).toFixed(1).replace('.',','); }

// Netto-Minuten eines einzelnen Eintrags (mit Pausenregel)
function entryNetMin(e){
  const f=hmToMin(e.from), t=hmToMin(e.to);
  if(f==null||t==null) return 0;
  let d=t-f; if(d<0) d+=24*60;
  return d;
}
// Summe eines Tages brutto (Minuten), dann Pause abziehen wenn >6h
function dayGrossMin(dISO){
  const list = DB.entries[dISO]||[];
  return list.reduce((s,e)=> s+entryNetMin(e), 0);
}
function dayWorkedMin(dISO){
  let gross = dayGrossMin(dISO);
  if(gross > PAUSE_THRESHOLD*60) gross -= PAUSE_MIN;
  return gross;
}
function dayWorkedH(dISO){ return minToH(dayWorkedMin(dISO)); }

// Tagessoll: Mo-Fr 8h, außer Feiertag (dann 0), Wochenende 0
function daySollH(dISO){
  const d = parseISO(dISO);
  if(isWeekend(d)) return 0;
  if(holidayName(dISO)) return 0;
  return DAY_SOLL;
}

// Tagestyp erfüllt Soll? (Urlaub/ZA/Krank gelten als erfüllt)
function dayIsFilled(dISO){
  const dt = DB.dayType[dISO];
  return dt && (dt.type==='vac'||dt.type==='za'||dt.type==='sick');
}

// Plusstunden-Beitrag eines Tages
function dayBalanceH(dISO){
  const soll = daySollH(dISO);
  if(soll===0) return dayWorkedH(dISO); // WE/Feiertag: alles was gearbeitet wird ist plus
  const dt = DB.dayType[dISO];
  if(dt){
    if(dt.type==='vac'||dt.type==='sick'){
      // Soll gilt als erfüllt, keine Ist-Stunden nötig; halbe Tage: halbes Soll erfüllt + evtl. gearbeitet
      if(dt.half){
        return dayWorkedH(dISO) - soll/2; // halber Tag frei, andere Hälfte muss gearbeitet werden
      }
      return 0;
    }
    if(dt.type==='za'){
      // ZA baut Plusstunden ab: voller Tag = -soll, halber = -soll/2, plus evtl. gearbeitet
      const za = dt.half ? soll/2 : soll;
      return dayWorkedH(dISO) - za;
    }
  }
  return dayWorkedH(dISO) - soll;
}

/* ---------- Salden über Zeitraum ---------- */
function allDatesWithData(){
  const s = new Set([...Object.keys(DB.entries), ...Object.keys(DB.dayType)]);
  return [...s].sort();
}
function plusBalanceUntil(cutoffISO){
  // Summe aller Tage-Beiträge vom Diensteintritt bis zu einem Stichtag
  let sum=0;
  const start = DB.settings.hireDate || '2025-10-20';
  allDatesWithData().forEach(dISO=>{
    if(dISO < start) return;
    if(dISO > cutoffISO) return;
    sum += dayBalanceH(dISO);
  });
  return sum;
}
function plusBalanceTotal(){ return plusBalanceUntil(todayISO()); }
function lastMonthEndISO(){
  const t=new Date();
  const last=new Date(t.getFullYear(), t.getMonth(), 0); // Tag 0 = letzter Tag des Vormonats
  return iso(last);
}
function plusBalanceAtLastMonthEnd(){ return plusBalanceUntil(lastMonthEndISO()); }

// Urlaubssaldo: Startbestand + Gutschrift pro 1.1. seit Eintritt - genommen(inkl. geplant)
function vacTakenCount(){
  let taken=0;
  Object.entries(DB.dayType).forEach(([dISO,dt])=>{
    if(dt.type==='vac') taken += dt.half?0.5:1;
  });
  return taken;
}
function vacAccrued(){
  const start = DB.settings.startVacBalance;
  if(start==null) return null;
  const startYear = DB.settings.startYear || 2025;
  const curYear = new Date().getFullYear();
  let bal = start;
  for(let y=startYear+1; y<=curYear; y++) bal += VAC_PER_YEAR;
  return bal;
}
function vacRemaining(){
  const acc = vacAccrued();
  if(acc==null) return null;
  return acc - vacTakenCount();
}

/* ---------- Woche/Monat Aggregation ---------- */
function weekDates(anyDate){
  const mon = mondayOf(anyDate);
  return Array.from({length:7},(_,i)=> addDays(mon,i));
}
function weekWorkedH(anyDate){
  return weekDates(anyDate).reduce((s,d)=> s+dayWorkedH(iso(d)), 0);
}
function weekSollH(anyDate){
  return weekDates(anyDate).reduce((s,d)=> s+daySollH(iso(d)), 0);
}

/* ---------- ID ---------- */
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

/* ---------- Toast ---------- */
let toastT=null;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),2200);
}

/* app-render.js enthält die Render-Funktionen */

/* ============================================================
   RENDER
   ============================================================ */
function render(){
  renderAppbar();
  renderTabbar();
  const c=document.getElementById('content');
  if(view==='overview') c.innerHTML=viewOverview();
  else if(view==='calendar') c.innerHTML=viewCalendar();
  else if(view==='capture') c.innerHTML=viewCapture();
  else if(view==='admin') c.innerHTML=viewAdmin();
  bindContent();
  fitCalendar();
}

/* Kalender ohne Scrollen: Zellgröße an verfügbare Höhe anpassen */
function fitCalendar(){
  if(view!=='calendar' || calMode!=='month') return;
  requestAnimationFrame(()=>{
    const content=document.getElementById('content');
    const grid=document.querySelector('.cgrid');
    const dow=document.querySelector('.dow');
    const leg=document.querySelector('.legend');
    if(!content||!grid) return;
    const avail = content.clientHeight - 96; // Platz für schwebende Tabbar
    const legH = leg?leg.offsetHeight+10:0;
    const dowH = dow?dow.offsetHeight+8:0;
    const rows = Math.ceil(grid.children.length/7);
    const gap = 6;
    const cellW = Math.floor((grid.clientWidth - 6*gap)/7);
    let cellH = Math.floor((avail - legH - dowH - (rows-1)*gap - 12)/rows);
    // Bei sehr kleinen Displays Legende ausblenden, damit nichts scrollt
    if(leg && cellH < 38){
      leg.style.display='none';
      cellH = Math.floor((avail - dowH - (rows-1)*gap - 12)/rows);
    } else if(leg){
      leg.style.display='';
    }
    cellH = Math.min(cellH, cellW);
    cellH = Math.max(cellH, 32);
    grid.querySelectorAll('.cell').forEach(c=>{
      c.style.aspectRatio='auto';
      c.style.height=cellH+'px';
    });
    // Schrift skalieren
    const nSize = Math.max(11, Math.min(17, Math.round(cellH*0.36)));
    const hSize = Math.max(8, Math.min(11, Math.round(cellH*0.22)));
    grid.querySelectorAll('.dnum').forEach(e=>e.style.fontSize=nSize+'px');
    grid.querySelectorAll('.dhrs').forEach(e=>e.style.fontSize=hSize+'px');
  });
}

function renderAppbar(){
  const bar=document.getElementById('appbar');
  if(view==='overview'){
    bar.innerHTML=`<div class="appbar-row" style="justify-content:center;"><div style="text-align:center;">
      <div class="sub">Servus Robert</div><h1>Übersicht</h1></div></div>`;
  } else if(view==='calendar'){
    let title;
    if(calMode==='week'){ const wd=weekDates(cursor); title=`${pad(wd[0].getDate())}.–${pad(wd[6].getDate())}. ${MON_SHORT[wd[6].getMonth()]}`; }
    else if(calMode==='month') title=`${MON_DE[cursor.getMonth()]} ${cursor.getFullYear()}`;
    else title=`${cursor.getFullYear()}`;
    bar.innerHTML=`<div class="navchev">
        <button class="chevbtn" data-nav="prev"><i class="ti ti-chevron-left"></i></button>
        <span class="title">${title}</span>
        <button class="chevbtn" data-nav="next"><i class="ti ti-chevron-right"></i></button>
      </div>
      <div class="seg">
        <button data-cal="week" class="${calMode==='week'?'active':''}">Woche</button>
        <button data-cal="month" class="${calMode==='month'?'active':''}">Monat</button>
        <button data-cal="year" class="${calMode==='year'?'active':''}">Jahr</button>
      </div>`;
  } else if(view==='capture'){
    bar.innerHTML=`<div class="navchev">
        <button class="chevbtn" data-nav="prev"><i class="ti ti-chevron-left"></i></button>
        <span class="title">${captureTitle()}</span>
        <button class="chevbtn" data-nav="next"><i class="ti ti-chevron-right"></i></button>
      </div>`;
  } else {
    bar.innerHTML=`<div class="appbar-row" style="justify-content:center;"><h1>Verwaltung</h1></div>`;
  }
}

function renderTabbar(){
  const tabs=[['overview','ti-layout-dashboard','Übersicht'],
    ['calendar','ti-calendar','Kalender'],
    ['capture','ti-clock','Erfassung'],
    ['admin','ti-settings','Verwaltung']];
  document.getElementById('tabbar').innerHTML = tabs.map(([id,ic,lbl])=>
    `<button data-tab="${id}" class="${view===id?'active':''}" style="position:relative;">
       <i class="ti ${ic}"></i>${lbl}${id==='capture'&&timer?'<span style="position:absolute; top:6px; right:22%; width:9px; height:9px; border-radius:50%; background:var(--gold); box-shadow:0 0 0 2px rgba(255,255,255,0.8);"></span>':''}</button>`).join('');
}

/* ---------- OVERVIEW ---------- */
function viewOverview(){
  const plus = plusBalanceAtLastMonthEnd();
  const monthEndTxt = (()=>{ const d=parseISO(lastMonthEndISO()); return `${MON_DE[d.getMonth()]} ${d.getFullYear()}`; })();
  const vac = vacRemaining();
  const wd = weekDates(new Date());
  const tIso = todayISO();

  const weekDiff = wd.reduce((s,d)=>{ const di=iso(d); return di<=tIso ? s+dayBalanceH(di) : s; },0);

  const rows = wd.filter(d=>!isWeekend(d)).map(d=>{
    const di=iso(d);
    const worked=dayWorkedH(di);
    const dt=DB.dayType[di];
    const hol=holidayName(di);
    const isToday = di===tIso;
    const isFuture = di>tIso;
    let pill='';
    if(dt&&dt.type==='vac') pill=`<span class="pill vac">Urlaub${dt.half?' ½':''}</span>`;
    else if(dt&&dt.type==='za') pill=`<span class="pill za">ZA${dt.half?' ½':''}</span>`;
    else if(dt&&dt.type==='sick') pill=`<span class="pill sick">Krank${dt.half?' ½':''}</span>`;
    else if(hol) pill=`<span class="pill hol">${hol}</span>`;
    const diff = isFuture ? null : dayBalanceH(di);
    const diffTxt = diff==null ? '–' : `${diff>=0?'+':''}${fmtHDec(diff)}`;
    const diffColor = diff==null ? 'var(--text3)' : (diff>=0?'var(--ok-text)':'var(--low-text)');
    const workedTxt = worked>0 ? fmtH(worked) : (isFuture?'–':'0:00');
    return `<div class="wrow"${isToday?' style="background:rgba(201,162,75,0.10); border-radius:14px; padding-left:10px; padding-right:10px;"':''}>
      <div class="d ${isWeekend(d)?'we':''}">${DOW_DE[(d.getDay()+6)%7]} ${pad(d.getDate())}.${pill}</div>
      <div style="text-align:right;">
        <div class="h ${worked>0?'':'dim'}">${workedTxt}</div>
        <div style="font-size:12px; font-weight:700; color:${diffColor}; margin-top:1px;">${diffTxt}</div>
      </div>
    </div>`;
  }).join('');

  // nächster Feiertag
  let nh=null; let scan=new Date();
  for(let i=0;i<400 && !nh;i++){ const di=iso(scan); const n=holidayName(di); if(n && di>=tIso) nh={di,n}; scan=addDays(scan,1); }
  const nhTxt = nh ? `${pad(parseISO(nh.di).getDate())}. ${MON_SHORT[parseISO(nh.di).getMonth()]} · ${nh.n}` : '–';

  const vacCard = vac==null
    ? `<button class="stat light" id="vac-quick" style="text-align:left; width:100%;"><div class="lbl">Resturlaub</div>
         <div class="val" style="font-size:19px; display:flex; align-items:center; gap:6px;">Einrichten <i class="ti ti-chevron-right" style="font-size:16px;"></i></div>
         <div class="hint">Startbestand eingeben</div></button>`
    : `<div class="stat light"><div class="lbl">Resturlaub</div>
         <div class="val">${fmtHDec(vac)}</div><div class="hint">von 25 Tagen/Jahr</div></div>`;

  return `
  <div class="stat-grid">
    <div class="stat dark"><div class="lbl">Plusstunden</div>
      <div class="val">${plus>=0?'+':''}${fmtHDec(plus)}</div><div class="hint">Stand Ende ${monthEndTxt}</div></div>
    ${vacCard}
  </div>
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <span style="font-size:15px; font-weight:700; color:var(--text);">Diese Woche</span>
      <span style="font-size:14px; font-weight:700; color:${weekDiff>=0?'var(--ok-text)':'var(--low-text)'};">${weekDiff>=0?'+':''}${fmtHDec(weekDiff)} h</span>
    </div>
    ${rows}
  </div>
  <div class="card" style="background:rgba(201,162,75,0.14); border:1px solid rgba(201,162,75,0.22); display:flex; align-items:center; gap:10px;">
    <i class="ti ti-calendar-star" style="color:var(--gold-text); font-size:19px;"></i>
    <span style="font-size:13px; color:var(--gold-text); font-weight:600;">Nächster Feiertag: ${nhTxt}</span>
  </div>`;
}

/* ---------- CALENDAR ---------- */
function viewCalendar(){
  if(calMode==='week') return calWeek();
  if(calMode==='year') return calYear();
  return calMonth();
}
function cellClass(dISO, inMonth=true){
  const d=parseISO(dISO);
  const dt=DB.dayType[dISO];
  // Tagestyp hat Vorrang vor der Stunden-Ampel
  if(dt){ if(dt.type==='vac')return'vac'; if(dt.type==='za')return'za'; if(dt.type==='sick')return'sick'; }
  const worked=dayWorkedH(dISO);
  if(isWeekend(d)) return 'we-cell';           // Wochenende immer graugrün
  if((DB.entries[dISO]||[]).length){
    return worked >= DAY_SOLL ? 'work-ok' : 'work-low';
  }
  return inMonth?'empty':'other';
}
function calMonth(){
  const y=cursor.getFullYear(), m=cursor.getMonth();
  const first=new Date(y,m,1); const startOff=(first.getDay()+6)%7;
  const days=new Date(y,m+1,0).getDate();
  const tIso=todayISO();
  let cells='';
  // Vortagsfüller
  for(let i=0;i<startOff;i++){ const d=new Date(y,m,1-startOff+i); const di=iso(d);
    cells+=`<div class="cell ${cellClass(di,false)} other" data-day="${di}">${d.getDate()}</div>`; }
  for(let dd=1;dd<=days;dd++){
    const d=new Date(y,m,dd); const di=iso(d);
    const cls=cellClass(di); const hol=holidayName(di);
    const dt=DB.dayType[di]; const half=dt&&dt.half?'half':'';
    const today=di===tIso?'today':'';
    const worked=dayWorkedH(di);
    const hrs = worked>0 ? `<span class="dhrs">${fmtH(worked)}</span>` : '';
    cells+=`<div class="cell ${cls} ${today} ${half}" data-day="${di}"><span class="dnum">${dd}</span>${hrs}${hol?'<span class="hol-dot"></span>':''}</div>`;
  }
  return `
  <div class="dow"><span>M</span><span>D</span><span>M</span><span>D</span><span>F</span><span class="we">S</span><span class="we">S</span></div>
  <div class="cgrid">${cells}</div>
  ${legend()}`;
}
function calWeek(){
  const wd=weekDates(cursor); const tIso=todayISO();
  let rows='';
  wd.forEach(d=>{
    const di=iso(d); const dt=DB.dayType[di]; const hol=holidayName(di);
    const worked=dayWorkedH(di);
    let pill='';
    if(dt&&dt.type==='vac')pill=`<span class="pill vac">Urlaub${dt.half?' ½':''}</span>`;
    else if(dt&&dt.type==='za')pill=`<span class="pill za">ZA${dt.half?' ½':''}</span>`;
    else if(dt&&dt.type==='sick')pill=`<span class="pill sick">Krank${dt.half?' ½':''}</span>`;
    else if(hol)pill=`<span class="pill hol">${hol}</span>`;
    const hTxt = worked>0?fmtH(worked):(isWeekend(d)||hol||dt?'':'0:00');
    rows+=`<div class="wrow" data-day="${di}">
      <div class="d ${isWeekend(d)?'we':''}">${DOW_DE[(d.getDay()+6)%7]} ${pad(d.getDate())}.${pill}</div>
      <div class="h ${worked>0?'':'dim'}">${hTxt||'–'}</div></div>`;
  });
  const wSum=weekWorkedH(cursor), wSoll=weekSollH(cursor);
  const diff=wSum-wSoll;
  const head=`<div class="stat-grid">
    <div class="stat dark" style="padding:14px 16px;"><div class="lbl">Ist / Soll</div>
      <div class="val" style="font-size:24px;">${fmtHDec(wSum)} / ${wSoll}</div></div>
    <div class="stat light" style="padding:14px 16px;"><div class="lbl">Differenz</div>
      <div class="val" style="font-size:24px; color:${diff>=0?'var(--ok-text)':'var(--low-text)'};">${diff>=0?'+':''}${fmtHDec(diff)} h</div></div>
  </div>`;
  return `${head}<div class="card" style="padding:4px 14px;">${rows}</div>${legend()}`;
}
function calYear(){
  const y=cursor.getFullYear();
  const curM=new Date().getMonth(), curY=new Date().getFullYear();
  let out='<div class="ygrid">';
  for(let m=0;m<12;m++){
    const days=new Date(y,m+1,0).getDate();
    const off=(new Date(y,m,1).getDay()+6)%7; // Mo=0
    let cells='';
    for(let i=0;i<off;i++) cells+='<span class="mc" style="background:transparent;"></span>';
    for(let dd=1;dd<=days;dd++){
      const di=iso(new Date(y,m,dd));
      const cls=cellClass(di);
      const colorMap={'work-ok':'var(--ok-bg)','work-low':'var(--low-bg)',work:'var(--green)',vac:'var(--gold)',za:'var(--sage)',sick:'var(--clay)','we-cell':'var(--weekend)'};
      cells+=`<span class="mc" style="background:${colorMap[cls]||'rgba(20,52,43,0.06)'}"></span>`;
    }
    const isCur=(y===curY&&m===curM);
    out+=`<button class="mini" data-month="${m}" style="${isCur?'box-shadow:0 0 0 2px var(--gold);':''}"><div class="mname">${MON_SHORT[m]}</div><div class="mg">${cells}</div></button>`;
  }
  out+='</div>';
  // Summenzeile
  let vac=0,za=0,sick=0;
  Object.entries(DB.dayType).forEach(([di,dt])=>{ if(di.slice(0,4)!=String(y))return;
    const v=dt.half?0.5:1; if(dt.type==='vac')vac+=v; else if(dt.type==='za')za+=v; else if(dt.type==='sick')sick+=v; });
  out+=`<div class="card card-green" style="display:flex; justify-content:space-between; margin-top:14px;">
    <div><div style="font-size:10px;color:#9DB0A2;">Urlaub</div><div style="font-size:17px;font-weight:600;color:var(--gold);">${fmtHDec(vac)} T</div></div>
    <div><div style="font-size:10px;color:#9DB0A2;">Zeitausgleich</div><div style="font-size:17px;font-weight:600;">${fmtHDec(za)}</div></div>
    <div><div style="font-size:10px;color:#9DB0A2;">Krank</div><div style="font-size:17px;font-weight:600;">${fmtHDec(sick)}</div></div>
  </div>`;
  return out;
}
function legend(){
  return `<div class="legend">
    <span><span class="ldot" style="background:var(--ok-bg)"></span>ab 8 h</span>
    <span><span class="ldot" style="background:var(--low-bg)"></span>unter 8 h</span>
    <span><span class="ldot" style="background:var(--gold)"></span>Urlaub</span>
    <span><span class="ldot" style="background:var(--sage)"></span>ZA</span>
    <span><span class="ldot" style="background:var(--clay)"></span>Krank</span>
    <span><span class="ldot" style="background:var(--weekend)"></span>Wochenende</span>
  </div>`;
}

/* ---------- CAPTURE ---------- */
function captureTitle(){
  const di=iso(cursor); const t=todayISO();
  if(di===t) return 'Heute';
  return `${DOW_DE[(cursor.getDay()+6)%7]}, ${pad(cursor.getDate())}. ${MON_SHORT[cursor.getMonth()]}`;
}
function viewCapture(){
  const di=iso(cursor);
  const running = timer!==null;
  const list=DB.entries[di]||[];
  const dt=DB.dayType[di];

  let timerBox='';
  if(timer && iso(cursor)!==todayISO()){
    const st=new Date(timer.start);
    timerBox=`<button class="type-banner za" id="goto-timer" style="width:100%;">
      <span><i class="ti ti-clock-play" style="vertical-align:-2px; margin-right:6px;"></i>Timer läuft seit ${pad(st.getHours())}:${pad(st.getMinutes())}</span>
      <span style="font-weight:700;">Anzeigen</span></button>`;
  }
  if(iso(cursor)===todayISO()){
    if(running){
      const st=new Date(timer.start);
      timerBox=`<div class="timer-box">
        <div class="timer-status">Gestartet um ${pad(st.getHours())}:${pad(st.getMinutes())} Uhr</div>
        <div class="timer-hint">Zeit läuft im Hintergrund mit, ohne Anzeige</div>
        <button class="timer-btn stop" id="timer-btn"><i class="ti ti-player-stop-filled"></i>Stop</button></div>`;
    } else {
      const now=new Date();
      timerBox=`<div class="timer-box">
        <div class="timer-status">Jetzt ${pad(now.getHours())}:${pad(now.getMinutes())} Uhr</div>
        <div class="timer-hint">Diese Zeit wird als Start verwendet</div>
        <button class="timer-btn start" id="timer-btn"><i class="ti ti-player-play-filled"></i>Start</button></div>`;
    }
  }

  let typeBanner='';
  const holName=holidayName(di);
  if(holName && !dt){
    typeBanner=`<div class="type-banner vac" style="background:rgba(201,162,75,0.16);">
      <span><i class="ti ti-calendar-star" style="vertical-align:-2px; margin-right:6px;"></i>${holName}</span>
      <span style="font-size:var(--t-cap); font-weight:600; opacity:.8;">Soll 0 h</span></div>`;
  }
  if(dt){
    const names={vac:'Urlaub',za:'Zeitausgleich',sick:'Krank'};
    typeBanner=`<div class="type-banner ${dt.type}">
      <span>${names[dt.type]}${dt.half?' · halber Tag':''}</span>
      <button data-cleartype="${di}">Entfernen</button></div>`;
  }

  let entriesHtml='';
  if(list.length){
    entriesHtml=list.map(e=>{
      const net=fmtH(minToH(entryNetMin(e)));
      return `<div class="entry" data-edit="${e.id}">
        <div class="entry-top"><span class="entry-time">${e.from} – ${e.to}</span>
          <span class="entry-dur">${net}</span></div>
        <div class="entry-meta">${e.order?shortOrder(e.order):'—'}
          ${e.wp?`<span class="wp-badge">${WP_TYPES[e.wp]||e.wp}</span>`:''}</div>
        ${e.info?`<div class="entry-info">${escapeHtml(e.info)}</div>`:''}
      </div>`;
    }).join('');
  } else if(!dt){
    entriesHtml=`<div class="empty-note">Noch keine Einträge.<br>Timer starten oder manuell hinzufügen.</div>`;
  }

  const dayH = dayWorkedH(di);
  const summary = (list.length)?`<div class="card" style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
    <span style="font-size:var(--t-sub); color:var(--text2); font-weight:600;">Tag netto${dayGrossMin(di)>PAUSE_THRESHOLD*60?' <span style="font-weight:500; color:var(--text3)">(−30 min Pause)</span>':''}</span>
    <span style="font-size:22px; font-weight:700; color:var(--gold-text);">${fmtH(dayH)}</span></div>`:'';

  return `
  ${timerBox}
  ${typeBanner}
  <div class="act-row">
    <button class="act-btn" id="add-manual"><i class="ti ti-plus"></i>Eintrag</button>
    <button class="act-btn" id="set-type"><i class="ti ti-calendar-event"></i>Tagestyp</button>
  </div>
  ${entriesHtml}
  ${summary}`;
}
function shortOrder(o){
  // "2026-SC-... - RISE Operations 1000 (Personalstunden)" -> "RISE Operations"
  const m=o.match(/-\s*([A-Za-zÄÖÜäöü ]+?)\s*\d*\s*\(/);
  if(m) return m[1].trim();
  const parts=o.split(' - '); return parts.length>1?parts[1].replace(/\d+.*/,'').trim():o.slice(0,20);
}
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ---------- ADMIN ---------- */
function viewAdmin(){
  const vac=vacRemaining();
  const vacTxt = vac==null?'einrichten':fmtHDec(vac)+' offen';
  return `
  <div class="sect-label">Daten</div>
  <div class="mlist">
    <button class="mitem" id="import-btn"><span class="ic"><i class="ti ti-file-spreadsheet"></i></span>Excel importieren<i class="ti ti-chevron-right chev"></i></button>
    <button class="mitem" id="export-btn"><span class="ic"><i class="ti ti-download"></i></span>CSV exportieren<i class="ti ti-chevron-right chev"></i></button>
  </div>
  <div class="sect-label">Urlaub &amp; Abwesenheit</div>
  <div class="mlist">
    <button class="mitem" id="vac-setup"><span class="ic"><i class="ti ti-beach"></i></span>Urlaubskonto<span class="rgt">${vacTxt}</span></button>
    <button class="mitem" id="holidays-btn"><span class="ic"><i class="ti ti-calendar-star"></i></span>Feiertage<i class="ti ti-chevron-right chev"></i></button>
  </div>
  <div class="sect-label">Einstellungen</div>
  <div class="mlist">
    <button class="mitem" id="rules-btn"><span class="ic"><i class="ti ti-adjustments"></i></span>Soll &amp; Pause<i class="ti ti-chevron-right chev"></i></button>
    <button class="mitem" id="about-btn"><span class="ic"><i class="ti ti-info-circle"></i></span>Über die App<i class="ti ti-chevron-right chev"></i></button>
  </div>
  <input type="file" id="file-input" accept=".xlsx,.xls" class="hidden">`;
}

/* ============================================================
   INTERAKTION
   ============================================================ */
function bindContent(){
  // Tabs
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{ view=b.dataset.tab; if(view!=='calendar'&&view!=='capture')cursor=new Date(); render(); });
  // Cal mode + nav
  document.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{ calMode=b.dataset.cal; render(); });
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
  // Calendar day tap -> capture that day
  document.querySelectorAll('[data-day]').forEach(el=>el.onclick=()=>{ cursor=parseISO(el.dataset.day); view='capture'; render(); });
  document.querySelectorAll('[data-month]').forEach(el=>el.onclick=()=>{ cursor=new Date(cursor.getFullYear(), Number(el.dataset.month), 1); calMode='month'; render(); });

  if(view==='capture'){
    const tb=document.getElementById('timer-btn'); if(tb) tb.onclick=toggleTimer;
    const gt=document.getElementById('goto-timer'); if(gt) gt.onclick=()=>{ cursor=new Date(); render(); };
    const am=document.getElementById('add-manual'); if(am) am.onclick=()=>openEntryModal();
    const st=document.getElementById('set-type'); if(st) st.onclick=openTypeModal;
    document.querySelectorAll('[data-edit]').forEach(el=>el.onclick=()=>openEntryModal(el.dataset.edit));
    document.querySelectorAll('[data-cleartype]').forEach(el=>el.onclick=(ev)=>{ ev.stopPropagation();
      delete DB.dayType[el.dataset.cleartype]; save(); render(); });
  }
  if(view==='admin') bindAdmin();
  const vq=document.getElementById('vac-quick'); if(vq) vq.onclick=openVacModal;
}

function navigate(dir){
  const s=dir==='prev'?-1:1;
  if(view==='capture'){ cursor=addDays(cursor,s); }
  else if(calMode==='week'){ cursor=addDays(cursor,7*s); }
  else if(calMode==='month'){ cursor=new Date(cursor.getFullYear(),cursor.getMonth()+s,1); }
  else { cursor=new Date(cursor.getFullYear()+s,cursor.getMonth(),1); }
  render();
}

/* ---------- Timer ---------- */
function toggleTimer(){
  if(timer){
    // Stop -> Eintrag am Starttag des Timers anlegen (nicht am angezeigten Tag)
    const start=new Date(timer.start), end=new Date();
    const from=pad(start.getHours())+':'+pad(start.getMinutes());
    const to=pad(end.getHours())+':'+pad(end.getMinutes());
    const timerDate=timer.dateISO || iso(start);
    timer=null; saveTimer();
    cursor=parseISO(timerDate);
    render();
    openEntryModal(null, {from,to});
  } else {
    timer={start:Date.now(), dateISO:todayISO()}; saveTimer(); render();
  }
}

/* ---------- Modal Framework ---------- */
function openModal(html){
  document.getElementById('modal-root').innerHTML=`<div class="modal-back" id="mback"><div class="modal"><div class="grabber"></div>${html}</div></div>`;
  document.getElementById('mback').onclick=(e)=>{ if(e.target.id==='mback') closeModal(); };
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=closeModal);
}
function closeModal(){ document.getElementById('modal-root').innerHTML=''; }

/* ---------- Entry Modal (manuell / bearbeiten / aus Timer) ---------- */
function openEntryModal(editId=null, preset=null){
  const di=iso(cursor);
  let e = editId ? (DB.entries[di]||[]).find(x=>x.id===editId) : null;
  const from = e?e.from : (preset?preset.from:'09:00');
  const to = e?e.to : (preset?preset.to:'17:30');
  const wp = e?e.wp:'I';
  const info = e?e.info:'';
  const order = e?e.order:'RISE Operations';
  const wpOpts = Object.entries(WP_TYPES).map(([k,v])=>`<option value="${k}" ${wp===k?'selected':''}>${k} · ${v}</option>`).join('');
  openModal(`
    <h2><span>${editId?'Eintrag':'Neuer Eintrag'} <span style="font-weight:500; color:var(--text2); font-size:var(--t-sub);">· ${DOW_DE[(cursor.getDay()+6)%7]} ${pad(cursor.getDate())}.${pad(cursor.getMonth()+1)}.</span></span><button class="x" data-close>&times;</button></h2>
    <div class="field-row">
      <div class="field"><label>Von</label><input type="time" id="f-from" value="${from}"></div>
      <div class="field"><label>Bis</label><input type="time" id="f-to" value="${to}"></div>
    </div>
    <div class="field"><label>Projekt / Order</label><input type="text" id="f-order" value="${escapeHtml(order)}" placeholder="RISE Operations"></div>
    <div class="field"><label>Arbeitsort</label><select id="f-wp">${wpOpts}</select></div>
    <div class="field"><label>Was gemacht</label><textarea id="f-info" placeholder="kurze Notiz">${escapeHtml(info)}</textarea></div>
    <button class="primary" id="f-save">Speichern</button>
    ${editId?'<button class="ghost" id="f-del">Eintrag löschen</button>':''}
  `);
  document.getElementById('f-save').onclick=()=>{
    const obj={ id: editId||uid(),
      from:document.getElementById('f-from').value,
      to:document.getElementById('f-to').value,
      order:document.getElementById('f-order').value.trim(),
      wp:document.getElementById('f-wp').value,
      info:document.getElementById('f-info').value.trim() };
    if(!obj.from||!obj.to){ toast('Von und Bis angeben'); return; }
    if(!DB.entries[di]) DB.entries[di]=[];
    if(editId){ const i=DB.entries[di].findIndex(x=>x.id===editId); DB.entries[di][i]=obj; }
    else DB.entries[di].push(obj);
    DB.entries[di].sort((a,b)=>a.from.localeCompare(b.from));
    save(); closeModal(); render();
  };
  const del=document.getElementById('f-del');
  if(del) del.onclick=()=>{ DB.entries[di]=(DB.entries[di]||[]).filter(x=>x.id!==editId);
    if(!DB.entries[di].length) delete DB.entries[di]; save(); closeModal(); render(); };
}

/* ---------- Type Modal (Urlaub/ZA/Krank) ---------- */
function openTypeModal(){
  const di=iso(cursor);
  const cur=DB.dayType[di]||{type:null,half:false};
  let sel=cur.type, half=cur.half;
  openModal(`
    <h2>Tagestyp · ${pad(cursor.getDate())}.${pad(cursor.getMonth()+1)}.<button class="x" data-close>&times;</button></h2>
    <div class="type-choose" id="tc">
      <button data-t="work" class="${!sel?'on work':''}">Arbeitstag</button>
      <button data-t="vac" class="${sel==='vac'?'on vac':''}">Urlaub</button>
      <button data-t="za" class="${sel==='za'?'on za':''}">Zeitausgleich</button>
      <button data-t="sick" class="${sel==='sick'?'on sick':''}">Krank</button>
    </div>
    <label class="half-toggle" for="t-half">
      <span>Halber Tag</span>
      <span class="switch"><input type="checkbox" id="t-half" ${half?'checked':''}><span class="slider"></span></span>
    </label>
    <p style="font-size:12px; color:var(--text2); margin:4px 0 14px; line-height:1.5;">
      Urlaub zieht vom Urlaubskonto ab. ZA baut Plusstunden ab. Krank ist nur Dokumentation.
      Für 24.12. und 31.12. „Urlaub“ + „Halber Tag“ wählen.</p>
    <button class="primary" id="t-save">Speichern</button>
  `);
  document.querySelectorAll('#tc button').forEach(b=>b.onclick=()=>{
    sel=b.dataset.t==='work'?null:b.dataset.t;
    document.querySelectorAll('#tc button').forEach(x=>x.className='');
    const map={vac:'on vac',za:'on za',sick:'on sick'};
    b.className=sel?map[sel]:'on work';
  });
  document.getElementById('t-save').onclick=()=>{
    half=document.getElementById('t-half').checked;
    if(!sel) delete DB.dayType[di];
    else DB.dayType[di]={type:sel,half};
    save(); closeModal(); render();
  };
}

/* ---------- Urlaubskonto ---------- */
function openVacModal(){
  const s=DB.settings;
  openModal(`
    <h2>Urlaubskonto einrichten<button class="x" data-close>&times;</button></h2>
    <p style="font-size:13px; color:var(--text2); margin-bottom:14px; line-height:1.55;">
      Gib den Reststand zum Jahresende deines Eintrittsjahres ein. Ab dann rechnet die App
      jeden 1.1. +25 Tage dazu (kein Verfall) und zieht deine Urlaubstage ab.</p>
    <div class="field"><label>Eintrittsjahr</label><input type="text" inputmode="numeric" id="v-year" value="${s.startYear||2025}"></div>
    <div class="field"><label>Resturlaub Ende ${s.startYear||2025} (Tage)</label>
      <input type="text" inputmode="decimal" id="v-bal" value="${s.startVacBalance??''}" placeholder="z.B. 5"></div>
    <button class="primary" id="v-save">Speichern</button>
  `);
  document.getElementById('v-save').onclick=()=>{
    const y=parseInt(document.getElementById('v-year').value);
    const b=parseFloat(String(document.getElementById('v-bal').value).replace(',','.'));
    if(isNaN(b)){ toast('Bitte Reststand angeben'); return; }
    DB.settings.startYear=y||2025; DB.settings.startVacBalance=b;
    save(); closeModal(); render();
  };
}

/* ---------- Feiertage anzeigen ---------- */
function openHolidaysModal(){
  const y=cursor.getFullYear();
  const hs=Object.entries(holidays(y)).sort((a,b)=>a[0].localeCompare(b[0]));
  const rows=hs.map(([di,n])=>{const d=parseISO(di);
    return `<div class="wrow"><div class="d">${DOW_DE[(d.getDay()+6)%7]}, ${pad(d.getDate())}. ${MON_SHORT[d.getMonth()]}</div><div class="h" style="font-weight:400; font-size:13px; color:var(--text2)">${n}</div></div>`;}).join('');
  openModal(`<h2>Feiertage ${y}<button class="x" data-close>&times;</button></h2>
    <div class="card" style="padding:2px 12px;">${rows}</div>
    <p style="font-size:12px;color:var(--text2);margin-top:10px;">Gesetzliche Feiertage in Österreich. Fällt einer auf Mo–Fr, ist das Tagessoll 0.</p>`);
}

/* ---------- Regeln ---------- */
function openRulesModal(){
  openModal(`<h2>Soll &amp; Pause<button class="x" data-close>&times;</button></h2>
    <div class="card" style="line-height:1.7; font-size:14px;">
      <div>Wochensoll: <b>40 h</b> (Mo–Fr je 8 h)</div>
      <div>Pause: <b>30 min</b> Abzug, nur wenn Tag &gt; 6 h</div>
      <div>Feiertag Mo–Fr: Soll <b>0 h</b></div>
      <div>Urlaub: <b>25 Tage/Jahr</b>, Gutschrift am 1.1., kein Verfall</div>
      <div>ZA: baut Plusstunden ab</div>
      <div>Krank: nur Dokumentation</div>
    </div>
    <p style="font-size:12px;color:var(--text2);margin-top:10px;">Diese Regeln sind fix hinterlegt. Melde dich, wenn etwas angepasst werden soll.</p>`);
}
function openAboutModal(){
  openModal(`<h2>Über die App<button class="x" data-close>&times;</button></h2>
    <div class="card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <div>
        <div style="font-size:12px; color:var(--text3); font-weight:600; text-transform:uppercase; letter-spacing:0.4px;">Version</div>
        <div style="font-size:22px; font-weight:700; color:var(--gold-text); margin-top:2px;">${APP_VERSION}</div>
      </div>
      <div style="text-align:right; font-size:13px; color:var(--text3);">Stand<br><b style="color:var(--text2);">${APP_BUILD}</b></div>
    </div>
    <div class="card" style="line-height:1.7; font-size:14px;">
      Zeiterfassung PWA · lokale Speicherung am Gerät.<br>
      Deine Daten bleiben in diesem Browser. CSV-Export als Backup nutzen.<br>
      Zum Homescreen hinzufügen: Teilen-Symbol → „Zum Home-Bildschirm“.
    </div>`);
}

function bindAdmin(){
  document.getElementById('import-btn').onclick=()=>document.getElementById('file-input').click();
  document.getElementById('file-input').onchange=handleImport;
  document.getElementById('export-btn').onclick=exportCSV;
  document.getElementById('vac-setup').onclick=openVacModal;
  document.getElementById('holidays-btn').onclick=openHolidaysModal;
  document.getElementById('rules-btn').onclick=openRulesModal;
  document.getElementById('about-btn').onclick=openAboutModal;
}

/* ============================================================
   EXCEL IMPORT
   Erkennt zwei Formate pro Blatt automatisch:
   1) GROB Zeitexport: Spalten [A,F,D,T], Order, Status, From, To,
      Total, Work place, Info, Info Backoffice (Datum = Index 2)
   2) Eigenes Tagestyp-Format: Spalten Datum | Typ | Halbtag
      (Typ: Urlaub / ZA / Krank, Halbtag: Ja/Nein)
   ============================================================ */
function handleImport(ev){
  const file=ev.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=(e)=>{
    try{
      const data=new Uint8Array(e.target.result);
      const wb=XLSX.read(data,{type:'array'});
      let added=0, skipped=0;
      wb.SheetNames.forEach(sn=>{
        const ws=wb.Sheets[sn];
        const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''});
        const result = isDayTypeSheet(rows) ? importDayTypeRows(rows) : importTimeRows(rows);
        added+=result.added; skipped+=result.skipped;
      });
      save(); render();
      toast(`Import: ${added} neu, ${skipped} übersprungen`);
    }catch(err){ console.error(err); toast('Import fehlgeschlagen'); }
    ev.target.value='';
  };
  reader.readAsArrayBuffer(file);
}
function isDayTypeSheet(rows){
  if(!rows.length) return false;
  const header=rows[0].map(c=>String(c||'').trim().toLowerCase());
  return header.includes('datum') && header.includes('typ');
}
function importDayTypeRows(rows){
  let added=0, skipped=0;
  const header=rows[0].map(c=>String(c||'').trim().toLowerCase());
  const iDate=header.indexOf('datum'), iTyp=header.indexOf('typ'), iHalb=header.indexOf('halbtag');
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    const dateCell=r[iDate];
    if(!dateCell || !/^\d{2}\.\d{2}\.\d{4}$/.test(String(dateCell).trim())){ continue; }
    const [dd,mm,yy]=String(dateCell).trim().split('.');
    const di=`${yy}-${mm}-${dd}`;
    const typRaw=String(r[iTyp]||'').trim().toLowerCase();
    let type=null;
    if(typRaw.startsWith('urlaub')) type='vac';
    else if(typRaw.startsWith('za')||typRaw.startsWith('zeitausgleich')||typRaw.startsWith('gleitzeit')) type='za';
    else if(typRaw.startsWith('krank')) type='sick';
    if(!type){ skipped++; continue; }
    const halbRaw=String(r[iHalb]||'').trim().toLowerCase();
    const half = halbRaw==='ja'||halbRaw==='true'||halbRaw==='1'||halbRaw==='x';
    // Schutz: bestehender Tagestyp (manuell oder aus früherem Import) bleibt unangetastet
    if(DB.dayType[di]){ skipped++; continue; }
    DB.dayType[di]={type,half};
    added++;
  }
  return {added,skipped};
}
function importTimeRows(rows){
  let added=0, skipped=0;
  rows.forEach(r=>{
    const dateCell=r[2];
    if(!dateCell || !/^\d{2}\.\d{2}\.\d{4}$/.test(String(dateCell).trim())) return;
    const [dd,mm,yy]=String(dateCell).trim().split('.');
    const di=`${yy}-${mm}-${dd}`;
    const order=String(r[4]||'').trim();
    const from=normTime(r[6]); const to=normTime(r[7]);
    const wpRaw=String(r[9]||'').trim().toUpperCase();
    const wp=WP_TYPES[wpRaw]?wpRaw:(wpRaw||'');
    const info=String(r[10]||'').trim().replace(/\\n/g,' ').trim();
    if(!from||!to) return;
    if(!DB.entries[di]) DB.entries[di]=[];
    const dup=DB.entries[di].some(x=>x.from===from&&x.to===to&&x.order===order);
    if(dup){ skipped++; return; }
    DB.entries[di].push({id:uid(),from,to,order,wp,info});
    DB.entries[di].sort((a,b)=>a.from.localeCompare(b.from));
    added++;
  });
  return {added,skipped};
}
function normTime(v){
  if(v==null) return '';
  let s=String(v).trim();
  if(!s) return '';
  // "09:00" oder "9:00" oder Excel-Bruch
  const m=s.match(/^(\d{1,2}):(\d{2})/);
  if(m) return pad(+m[1])+':'+m[2];
  // Excel-Zeit als Dezimal (0.375 = 09:00)
  const f=parseFloat(s.replace(',','.'));
  if(!isNaN(f)&&f>0&&f<1){ const mins=Math.round(f*24*60); return pad(Math.floor(mins/60))+':'+pad(mins%60); }
  return '';
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function exportCSV(){
  const rows=[['Datum','Wochentag','Von','Bis','Netto (h)','Arbeitsort','Projekt','Info','Tagestyp']];
  const dates=allDatesWithData().sort();
  dates.forEach(di=>{
    const d=parseISO(di); const dow=DOW_DE[(d.getDay()+6)%7];
    const dt=DB.dayType[di];
    const typeName=dt?({vac:'Urlaub',za:'Zeitausgleich',sick:'Krank'}[dt.type]+(dt.half?' ½':'')):'';
    const list=DB.entries[di]||[];
    if(list.length){
      list.forEach(e=>{
        const net=minToH(entryNetMin(e)).toFixed(2).replace('.',',');
        rows.push([di,dow,e.from,e.to,net,WP_TYPES[e.wp]||e.wp||'',e.order||'',e.info||'',typeName]);
      });
    } else if(dt){
      rows.push([di,dow,'','','',' ','','',typeName]);
    }
  });
  const csv=rows.map(r=>r.map(c=>{
    const s=String(c==null?'':c);
    return /[";\n,]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
  }).join(';')).join('\r\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`zeiterfassung_${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('CSV exportiert');
}

/* ============================================================
   START
   ============================================================ */
render();

window.addEventListener('resize',()=>fitCalendar());
window.addEventListener('orientationchange',()=>setTimeout(fitCalendar,150));

/* Service Worker für Offline (optional, schlägt lokal ohne https fehl -> egal) */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}
