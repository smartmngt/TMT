/* =============================================================================
   상가 관리 모듈  sangga.js   v0817.8
   -----------------------------------------------------------------------------
   index.html은 딱 한 줄만 추가 (estate.js 다음 줄):
        <script src="sangga.js"></script>
   - 데이터 + 첨부파일 모두 TMT 설정의 "내보내기/폰 백업/가져오기"에 한 번에 포함
     (설정 백업 함수를 감싸서 IndexedDB 첨부까지 JSON에 넣고, 가져올 때 복원)
   - v0817.5: 전화번호 하이픈 자동 · 공실 월별 관리비(합계+세부) · 백업 일원화
   - v0817.6: 상세주소 수기칸 · 증여/취득세 각각 가액 입력 · 취득세 별도창(영수증 구조)
   - v0817.7: 통장 금액 강조 · 구간 터치→보기화면 · 수선비/자본적지출 구분
   - v0817.8: 섹션 접기(▾/▸) · 취득/증여 보기화면 · 증여세도 한줄+계산팝업
   ============================================================================= */
(function(){
"use strict";
const $q = s=>document.querySelector(s);

/* ---------- 상태 ---------- */
function S(){
  if(!db.sangga) db.sangga={ info:{nickname:'',address:''}, acq:{}, segments:[], ledger:{opening:0,txns:[]} };
  if(!db.sangga.info) db.sangga.info={nickname:'',address:''};
  if(!db.sangga.acq) db.sangga.acq={};
  if(!db.sangga.segments) db.sangga.segments=[];
  if(!db.sangga.ledger) db.sangga.ledger={opening:0,txns:[]};
  return db.sangga;
}
function ledgerBalance(){ const s=S(); let b=+s.ledger.opening||0; s.ledger.txns.forEach(t=>b+=+t.amount||0); return b; }
function ledgerTotals(){ const s=S(); let inc=0,exp=0; s.ledger.txns.forEach(t=>{const a=+t.amount||0; if(a>=0)inc+=a; else exp+=-a;}); return {inc,exp}; }
function daysTo(d){ if(!d) return null; const e=new Date(d+'T00:00:00'),n=new Date(); n.setHours(0,0,0,0); return Math.round((e-n)/86400000); }
function activeLease(){ const s=S(), t=todayISO(); return s.segments.find(x=>x.type==='lease'&&x.start&&x.start<=t&&(!x.end||x.end>=t)); }
function currentStatus(){ const s=S(), t=todayISO();
  const seg=s.segments.find(x=>x.start&&x.start<=t&&(!x.end||x.end>=t));
  if(seg) return seg.type;
  const sorted=[...s.segments].sort((a,b)=>(a.start||'').localeCompare(b.start||''));
  return sorted.length?sorted[sorted.length-1].type:null; }

function segDocs(seg){
  if(!seg.docs){
    seg.docs = seg.contractKey ? [{id:'d0', label:'계약서', fileKey:seg.contractKey, fileName:seg.contractName||'계약서'}] : [];
    if(seg.contractKey) save();
  }
  return seg.docs;
}

/* ---------- 입력 포맷 ---------- */
function commaFmt(v){ const d=String(v==null?'':v).replace(/[^\d]/g,''); return d?(+d).toLocaleString('ko-KR'):''; }
function numOf(v){ return parseInt(String(v==null?'':v).replace(/[^\d]/g,''),10)||0; }
function wireComma(el){ if(!el) return; el.addEventListener('input',()=>{ const d=el.value.replace(/[^\d]/g,''); el.value=d?(+d).toLocaleString('ko-KR'):''; }); }

/* 전화번호 하이픈 자동 (010-7578-7878 / 02-123-4567 등) */
function phoneFmt(v){
  let d=String(v||'').replace(/[^\d]/g,'');
  if(d.startsWith('02')){ d=d.slice(0,10);
    if(d.length<3) return d;
    if(d.length<6) return d.replace(/(\d{2})(\d+)/,'$1-$2');
    if(d.length<10) return d.replace(/(\d{2})(\d{3,4})(\d+)/,'$1-$2-$3');
    return d.replace(/(\d{2})(\d{4})(\d{4})/,'$1-$2-$3');
  }
  d=d.slice(0,11);
  if(d.length<4) return d;
  if(d.length<8) return d.replace(/(\d{3})(\d+)/,'$1-$2');
  if(d.length<11) return d.replace(/(\d{3})(\d{3})(\d+)/,'$1-$2-$3');
  return d.replace(/(\d{3})(\d{4})(\d{4})/,'$1-$2-$3');
}
function wirePhone(el){ if(!el) return; el.addEventListener('input',()=>{ el.value=phoneFmt(el.value); }); }

function nextMgmtDate(){
  const s=S();
  const ms=s.ledger.txns.filter(t=>t.kind==='관리비'&&t.date).map(t=>t.date).sort();
  if(ms.length){ const d=new Date(ms[ms.length-1]+'T00:00:00'); d.setMonth(d.getMonth()+1); return d.toISOString().slice(0,10); }
  const l=activeLease(); const y=(l&&l.start)?l.start.slice(0,4):todayISO().slice(0,4);
  return y+'-04-01';
}

/* 섹션 접기 상태 */
function getCollapse(){ try{ return JSON.parse(localStorage.getItem('tmt.sangga.ui')||'{}')||{}; }catch(e){ return {}; } }
function toggleCollapse(k){ const c=getCollapse(); c[k]=!c[k]; try{ localStorage.setItem('tmt.sangga.ui', JSON.stringify(c)); }catch(e){} window.render(); }

/* ---------- 증여세·취득세 (2026 현행) ---------- */
function giftTaxGross(base){
  if(base<=0) return 0;
  const br=[[1e8,0.10,0],[5e8,0.20,1e7],[1e9,0.30,6e7],[3e9,0.40,1.6e8],[Infinity,0.50,4.6e8]];
  for(const b of br){ if(base<=b[0]) return Math.max(0, base*b[1]-b[2]); }
  return 0;
}
function calcGift(land, bldg, ded){
  const val=land+bldg;
  const base=Math.max(0, val-ded);
  const gross=giftTaxGross(base);
  const reportCr=Math.floor(gross*0.03);
  const tax=Math.max(0, gross-reportCr);
  return {val, base, gross, reportCr, tax};
}
function calcAcqTax(land, bldg){
  const base=land+bldg;
  const f=v=>Math.floor(v/10)*10;            // 10원 절사(지방세)
  const main=f(base*0.035), edu=f(base*0.003), rural=f(base*0.002);
  return {base, main, edu, rural, tax:main+edu+rural};
}
function giftBreakdownHTML(land,bldg,ded){
  if(land+bldg<=0) return '<span style="color:var(--muted);font-weight:600">토지·건물가액을 넣으면 증여세가 자동 계산돼요.</span>';
  const c=calcGift(land,bldg,ded), w=n=>fmtKRW(n), g=s=>`<b style="color:var(--green)">${s}</b>`;
  const bd='1px solid rgba(23,164,92,.22)';
  return `<div style="font-weight:800;font-size:13px;margin-bottom:6px">증여재산가액 = 토지 ${w(land)} + 건물 ${w(bldg)} = ${g(w(c.val))}</div>
   <div style="border-top:${bd};padding-top:8px;margin-top:4px"><div style="font-size:11.5px;line-height:1.75">
     과세표준 = ${w(c.val)} − 공제 ${w(ded)} = <b>${w(c.base)}</b><br>
     산출세액(누진) = <b>${w(c.gross)}</b> · 신고세액공제 −3% (${w(c.reportCr)})<br>→ 납부 증여세 ${g(w(c.tax))}</div></div>
   <div style="font-size:10.5px;color:var(--muted);font-weight:600;margin-top:8px;line-height:1.5">※ 2026 현행 · 시가인정액·10년내 기납부 증여 등에 따라 실제와 다름. 세무사 확인.</div>`;
}
function acqTaxBreakdownHTML(land,bldg,reg,bond,misc,scr){
  const c=calcAcqTax(land,bldg), w=n=>fmtKRW(n);
  const sub=c.tax+reg+bond+misc, grand=sub+scr;
  const row=(label,val,strong)=>`<div style="display:flex;justify-content:space-between;padding:5px 0;${strong?'font-weight:800;':''}"><span>${label}</span><span class="num">${w(val)}</span></div>`;
  const line='<div style="border-top:1px solid rgba(23,164,92,.28);margin:5px 0"></div>';
  return `<div style="font-weight:800;font-size:13px;margin-bottom:4px">과세표준 = 토지 ${w(land)} + 건물 ${w(bldg)} = <b style="color:var(--green)">${w(c.base)}</b></div>${line}
    ${row('취득세 (3.5%)',c.main)}${row('지방교육세 (0.3%)',c.edu)}${row('농어촌특별세 (0.2%)',c.rural)}
    ${row('등기신청수수료',reg)}${row('국민주택채권 할인금',bond)}${row('제증명·기타',misc)}${line}
    ${row('소계',sub,true)}${row('법무사 보수',scr)}${line}${row('합계',grand,true)}
    <div style="font-size:10.5px;color:var(--muted);font-weight:600;margin-top:8px;line-height:1.5">※ 취득세=시가표준액×4.0%(3.5+0.3+0.2), 10원 절사. 추가비용은 영수증대로 수기 입력.</div>`;
}

/* ---------- 카카오(다음) 주소검색 ---------- */
const DAUM_SDK='https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
let daumLoading=null;
function loadDaum(){
  if(window.daum && window.daum.Postcode) return Promise.resolve();
  if(daumLoading) return daumLoading;
  daumLoading=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=DAUM_SDK; s.async=true;
    s.onload=()=>res(); s.onerror=()=>rej(new Error('주소 서비스 로드 실패 (네트워크 확인)')); document.head.appendChild(s); });
  return daumLoading;
}
function openAddr(){
  window.sheet(`<h2>주소 검색</h2><div class="hint">도로명·지번·건물명으로 검색하세요.</div>
    <div id="sg-daum" style="width:100%;height:58vh;min-height:360px;border:1.5px solid var(--line);border-radius:12px;overflow:hidden;background:#fff"></div>
    <div class="hint" id="sg-daumsts" style="margin-top:8px">주소 검색창 불러오는 중…</div>
    <div class="sheet-actions"><button class="btn ghost" id="sg-addrback" style="flex:1">취소</button></div>`);
  const back=$q('#sg-addrback'); if(back) back.onclick=()=>openInfo();
  loadDaum().then(()=>{ const box=$q('#sg-daum'); if(!box) return; const sts=$q('#sg-daumsts'); if(sts) sts.textContent='';
    new window.daum.Postcode({ oncomplete:onDaumPick, onresize:sz=>{ box.style.height=Math.max(360,sz.height)+'px'; }, width:'100%', height:'100%' }).embed(box,{autoClose:false});
  }).catch(err=>{ const sts=$q('#sg-daumsts'); if(sts) sts.innerHTML='<b style="color:var(--red)">'+esc(err.message)+'</b><br>주소를 직접 입력하세요.'; });
}
function onDaumPick(d){
  const s=S();
  s.info.address = d.roadAddress || d.address || d.jibunAddress || '';
  if(d.buildingName && !s.info.nickname) s.info.nickname=d.buildingName;
  save(); openInfo();
}

/* ---------- 첨부 파일 (IndexedDB) ---------- */
function idbOpen(){return new Promise((res,rej)=>{const r=indexedDB.open('tmt_sangga_files',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('contracts'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});}
function idbPut(k,b){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readwrite');t.objectStore('contracts').put(b,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
function idbGet(k){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readonly');const q=t.objectStore('contracts').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);}));}
function idbDel(k){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readwrite');t.objectStore('contracts').delete(k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
function openDocBlob(fileKey){
  idbGet(fileKey).then(blob=>{ if(!blob){ toast('파일을 찾을 수 없어요'); return; }
    const url=URL.createObjectURL(blob); window.open(url,'_blank'); setTimeout(()=>URL.revokeObjectURL(url),60000);
  }).catch(()=>toast('열기 실패'));
}
function blobToDataURL(blob){ return new Promise((res,rej)=>{const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob);}); }
function dataURLToBlob(u){ return fetch(u).then(r=>r.blob()); }
async function collectFiles(){
  const s=S(); const out=[]; const seen=new Set();
  for(const seg of (s.segments||[])){ for(const d of segDocs(seg)){
    if(!d.fileKey||seen.has(d.fileKey)) continue; seen.add(d.fileKey);
    try{ const blob=await idbGet(d.fileKey); if(blob) out.push({fileKey:d.fileKey, fileName:d.fileName, data:await blobToDataURL(blob)}); }catch(e){}
  }}
  return out;
}

/* ---------- 스타일 ---------- */
const CSS=`
.sg-seg{background:var(--card);border-radius:16px;padding:14px;box-shadow:var(--shadow);margin-bottom:10px}
.sg-seg[data-segid]{cursor:pointer}
.sg-seg[data-segid]:active{background:var(--bg)}
.sg-coll{cursor:pointer;user-select:none}
.sg-tap{cursor:pointer}
.sg-tap:active{background:var(--bg)}
.sg-taxrow{width:100%;display:block;text-align:left;color:inherit}
.sg-vrow{cursor:pointer}
.sg-seg-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.sg-tag{font-size:11px;font-weight:800;padding:3px 10px;border-radius:99px;flex:none}
.sg-tag.lease{background:var(--green-t);color:var(--green)}
.sg-tag.vacant{background:#F3EEDF;color:var(--gold)}
[data-theme="dark"] .sg-tag.vacant{background:#2A2417}
.sg-period{font-size:12px;color:var(--muted);font-weight:700}
.sg-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}
.sg-kv .k{font-size:11px;color:var(--muted);font-weight:700;display:block}
.sg-kv b{font-size:14px;font-weight:800}
.sg-attach{margin-top:10px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink2);font-weight:700;flex-wrap:wrap}
.sg-memo{margin-top:8px;font-size:12px;color:var(--muted);font-weight:600;line-height:1.6}
.sg-vm{margin-top:8px}
.sg-vm summary{font-size:12.5px;color:var(--green);font-weight:800;cursor:pointer;list-style:none}
.sg-vm summary::-webkit-details-marker{display:none}
.sg-vm .vrow{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid var(--line)}
.sg-vm .vrow:last-child{border:none}
.sg-vm .vrow .vm-m{color:var(--muted);font-weight:700}
.sg-led3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;margin-bottom:10px;text-align:center}
.sg-led3>div{background:var(--card);border-radius:13px;padding:11px 4px;box-shadow:var(--shadow)}
.sg-led3 .k{font-size:10.5px;color:var(--muted);font-weight:700}
.sg-led3 .v{font-size:15px;font-weight:800;margin-top:3px}
.sg-tx{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.sg-tx:last-child{border:none}
.sg-tx .l{flex:1;min-width:0}
.sg-tx .l .d{font-size:11px;color:var(--muted);font-weight:700}
.sg-tx .l .m{font-size:12px;font-weight:600;margin-top:1px;color:var(--ink2)}
.sg-tx .r{text-align:right;flex:none}
.sg-tx .amt{font-weight:800;font-size:16.5px}
.sg-tx .bal{font-size:10.5px;color:var(--muted);font-weight:600;margin-top:1px}
.sg-txedit{color:var(--muted);width:28px;height:28px;border-radius:8px;display:grid;place-items:center;flex:none}
.sg-txedit svg{width:15px;height:15px}
.sg-txedit:active{background:var(--bg);color:var(--blue)}
.sg-sec{display:flex;align-items:center;gap:6px}
.sg-sec .sbtn{margin-left:auto;padding:6px 11px;font-size:12px}
.sg-qrow{display:flex;gap:8px;margin-bottom:10px}
.sg-qrow button{flex:1;padding:12px;font-size:13px}
.sg-acqbox{text-align:left;color:var(--ink2)!important}
.sg-doc{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px}
.sg-doc:last-child{border:none}
.sg-doc .dn{flex:1;min-width:0;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sg-doc .dn small{color:var(--muted);font-weight:600}
`;
function injectCSS(){ const s=document.createElement('style'); s.textContent=CSS; document.head.appendChild(s); }

/* ---------- 화면 ---------- */
function viewSangga(){
  const s=S();
  const st=currentStatus(), lease=activeLease(), dd=lease?daysTo(lease.end):null, bal=ledgerBalance();
  const stTxt = st==='lease'?'임차중':st==='vacant'?'공실':'미설정';
  const stCol = st==='lease'?'#3FE0A0':st==='vacant'?'#E6A020':'#9AA6B6';
  const a=s.acq||{};
  const col=getCollapse();
  const head=(key,title,extra)=>`<div class="sec sg-sec"><span class="sg-coll" data-sgcollapse="${key}">${col[key]?'▸':'▾'} ${title}</span>${extra||''}</div>`;

  let html=`<div class="sumcard"><div class="glow"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="stitle" style="margin:0">${esc(s.info.nickname||'상가')}</div>
      <span style="font-size:12.5px;font-weight:800;color:${stCol}">${stTxt}${lease&&dd!=null?` · 만기 ${dd<0?'만료':'D-'+dd}`:''}</span>
    </div>
    <div style="font-size:12px;color:#9AA6B6;font-weight:600;margin-bottom:14px">${esc(s.info.address||'주소 미입력')}${s.info.addressDetail?' '+esc(s.info.addressDetail):''}</div>
    <div class="sumcols">
      <div class="sumcol"><div class="sk">💳 통장 잔액</div><div class="sv num">${fmtK(bal)}</div></div>
      <div class="sumcol r"><div class="sk">🏢 취득가(증여신고)</div><div class="sv num">${a.declared?fmtK(+a.declared):'—'}</div></div>
    </div>
  </div>`;

  /* ① 취득·증여 */
  html+=head('acq','① 취득 · 증여','<button class="sbtn" data-sgeditinfo="1">수정</button>');
  if(!col.acq){
    const acqRows=[
      ['취득일', a.acqDate||'-'],
      ['증여 신고가액', a.declared?fmtKRW(+a.declared):'-'],
      ['증여세', a.giftTax?fmtKRW(+a.giftTax):'-'],
      ['취득세(공과금)', a.acqTax?fmtKRW(+a.acqTax):'-'],
    ];
    if(a.acqGrand) acqRows.push(['취득 총비용(법무사 포함)', fmtKRW(+a.acqGrand)]);
    const burden=(+a.giftTax||0)+(+a.acqGrand|| +a.acqTax||0);
    html+=`<div class="setcard sg-tap" data-sginfoview="1">`+acqRows.map(r=>`<div class="settings-row"><div class="sk">${r[0]}</div><div class="num" style="font-weight:800">${r[1]}</div></div>`).join('')+
      (burden>0?`<div class="settings-row"><div class="sk" style="color:var(--muted)">취득 총부담</div><div class="num" style="font-weight:800;color:var(--muted)">${fmtKRW(burden)}</div></div>`:'')+
      `<div style="text-align:right;font-size:11px;color:var(--muted);font-weight:700;padding:4px 2px 0">터치하여 상세 보기 ▸</div></div>`;
  }

  /* ② 보유 구간 */
  html+=head('seg','② 보유 구간',`<span class="cnt">${s.segments.length}</span><button class="sbtn" data-sgaddseg="1">+ 구간</button>`);
  if(!col.seg){
    if(!s.segments.length){ html+=`<div class="empty" style="padding:26px 20px"><div class="em">🏢</div><h3>구간이 없어요</h3><p>임차·공실 기간을 추가하세요.</p></div>`; }
    else { const sorted=[...s.segments].sort((x,y)=>(y.start||'').localeCompare(x.start||'')); html+=sorted.map(segCard).join(''); }
  }

  /* ③ 통장 */
  html+=head('led','③ 통장 내역','<button class="sbtn" data-sgaddtx="1">+ 내역</button>');
  if(!col.led){
    const {inc,exp}=ledgerTotals();
    html+=`<div class="sg-led3">
        <div><div class="k">누적 수입</div><div class="v" style="color:var(--green)">${fmtK(inc)}</div></div>
        <div><div class="k">누적 지출</div><div class="v" style="color:var(--red)">${fmtK(exp)}</div></div>
        <div><div class="k">잔액</div><div class="v">${fmtK(bal)}</div></div>
      </div>`;
    const capital=s.ledger.txns.filter(t=>t.capital&&(+t.amount||0)<0).reduce((x,t)=>x+(-t.amount),0);
    if(capital>0) html+=`<div class="hint" style="margin:-4px 2px 10px">🔧 자본적지출 누계 <b>${fmtKRW(capital)}</b> · 미래 양도세 취득원가 가산 후보</div>`;
    html+=`<div class="sg-qrow">
        <button class="btn ghost" data-sgquickrent="1" style="color:var(--green);border-color:var(--green)">＋ 이번달 임차료</button>
        <button class="btn ghost" data-sgquickmgmt="1" style="color:var(--gold);border-color:var(--gold)">＋ 관리비(월)</button>
      </div>`;
    html+=txListHTML();
  }

  html+=`<div class="hint" style="text-align:center;margin:14px 8px 0">데이터·계약서·영수증 모두 TMT <b>설정 → 백업/가져오기</b>에 한 번에 저장돼요.</div>`;
  html+=`<div style="text-align:center;color:var(--muted);font-size:11px;font-weight:600;margin:10px 0 18px">상가 관리 · v0817.8</div>`;
  return html;
}
function segCard(seg){
  const lease=seg.type==='lease';
  const period=`${seg.start||'?'} ~ ${seg.end||'진행중'}`;
  let body='';
  if(lease){
    const rent=+seg.rent||0, vat=seg.vatSeparate!==false?Math.round(rent*0.1):0;
    const mgmtTxt = seg.mgmtActual ? '실비(임차인)' : (seg.mgmt?fmtK(+seg.mgmt):'-');
    const phone = seg.phone ? `<a href="tel:${esc(phoneFmt(seg.phone))}" style="color:inherit">${esc(phoneFmt(seg.phone))}</a>` : '-';
    body=`<div class="sg-kv">
      <div><span class="k">임차인</span><b>${esc(seg.tenant||'-')}</b></div>
      <div><span class="k">연락처</span><b style="font-size:12.5px">${phone}</b></div>
      <div><span class="k">입금계좌</span><b style="font-size:12.5px">${esc(seg.account||'-')}</b></div>
      <div><span class="k">월세${vat?` (+VAT ${fmtK(vat)})`:''}</span><b>${fmtK(rent)}</b></div>
      <div><span class="k">보증금</span><b>${fmtK(+seg.deposit||0)}</b></div>
      <div><span class="k">관리비</span><b>${mgmtTxt}</b></div>
    </div>`;
    const docs=segDocs(seg);
    if(docs.length) body+=`<div class="sg-attach">`+docs.map(d=>`📎 ${esc(d.label||'문서')} <button class="sbtn" style="padding:3px 9px;font-size:11px" data-sgdoc="${seg.id}|${d.id}">보기</button>`).join(' ')+`</div>`;
  } else {
    const vm=seg.vacantMonths||[];
    if(vm.length){
      const total=vm.reduce((s,x)=>s+(+x.amount||0),0);
      const rows=[...vm].sort((a,b)=>(a.ym||'').localeCompare(b.ym||'')).map(x=>`<div class="vrow"><span class="vm-m">${x.ym||''}${x.memo?' · '+esc(x.memo):''}</span><b>${fmtKRW(+x.amount||0)}</b></div>`).join('');
      body=`<div class="sg-kv"><div><span class="k">공실 관리비 합계</span><b>${fmtK(total)} <small style="color:var(--muted);font-weight:700">(${vm.length}개월)</small></b></div></div>
        <details class="sg-vm"><summary>▸ 월별 세부 보기</summary><div style="margin-top:6px">${rows}</div></details>`;
    } else if(seg.ownerCost){
      body=`<div class="sg-kv"><div><span class="k">공실 월부담</span><b>${fmtK(+seg.ownerCost)}</b></div></div>`;
    } else {
      body=`<div class="sg-kv"><div><span class="k">공실 관리비</span><b>-</b></div></div>`;
    }
  }
  if(seg.memo) body+=`<div class="sg-memo">${esc(seg.memo)}</div>`;
  return `<div class="sg-seg" data-segid="${seg.id}">
    <div class="sg-seg-h"><span class="sg-tag ${lease?'lease':'vacant'}">${lease?'임차':'공실'}</span>
      <span class="sg-period">${period}</span>
      <button class="sbtn" style="margin-left:auto;padding:4px 10px;font-size:11px" data-sgeditseg="${seg.id}">수정</button></div>
    ${body}
    <div style="text-align:right;font-size:11px;color:var(--muted);font-weight:700;margin-top:8px">터치하여 상세 보기 ▸</div></div>`;
}

function txListHTML(){
  const s=S();
  if(!s.ledger.txns.length) return `<div class="empty" style="padding:22px 20px"><p>내역이 없어요. 잔액 0원부터 시작합니다.</p></div>`;
  const asc=[...s.ledger.txns].map((t,i)=>({...t,_i:i})).sort((a,b)=>(a.date||'').localeCompare(b.date||'')||a._i-b._i);
  let run=+s.ledger.opening||0; const runMap={};
  asc.forEach(t=>{ run+=+t.amount||0; runMap[t.id]=run; });
  const txns=[...s.ledger.txns].map((t,i)=>({...t,_i:i})).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b._i-a._i);
  return `<div class="setcard" style="padding:2px 16px">`+txns.map(t=>{
    const a=+t.amount||0, isIn=a>=0;
    return `<div class="sg-tx">
      <div class="l"><div class="d">${t.date||''}</div><div class="m">${esc(t.kind||'기타')}${t.memo?' · '+esc(t.memo):''}</div></div>
      <div class="r"><div class="amt num" style="color:${isIn?'var(--green)':'var(--red)'}">${isIn?'+':'−'}${fmtKRW(Math.abs(a))}</div>
        <div class="bal num">잔액 ${fmtKRW(runMap[t.id]||0)}</div></div>
      <button class="sg-txedit" data-sgedittx="${t.id}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
    </div>`;
  }).join('')+`</div>`;
}

/* ---------- 바인딩 ---------- */
function bindSangga(){
  const app=$q('#app'); if(!app) return;
  const on=(sel,fn)=>app.querySelectorAll(sel).forEach(el=>el.onclick=fn(el));
  on('[data-sgcollapse]',el=>()=>toggleCollapse(el.dataset.sgcollapse));
  on('[data-sginfoview]',()=>()=>openInfoView());
  on('[data-sgeditinfo]',()=>()=>openInfo());
  on('[data-sgaddseg]',()=>()=>openSeg(null));
  on('[data-sgeditseg]',el=>()=>openSeg(el.dataset.sgeditseg));
  on('[data-sgdoc]',el=>()=>{ const [sid,did]=el.dataset.sgdoc.split('|'); const seg=S().segments.find(x=>x.id===sid); if(seg){ const d=segDocs(seg).find(x=>x.id===did); if(d) openDocBlob(d.fileKey); } });
  on('[data-sgaddtx]',()=>()=>openTx(null));
  on('[data-sgedittx]',el=>()=>openTx(el.dataset.sgedittx));
  on('[data-sgquickrent]',()=>()=>quickRent());
  on('[data-sgquickmgmt]',()=>()=>quickMgmt());
  app.querySelectorAll('.sg-seg[data-segid]').forEach(el=>el.addEventListener('click',e=>{
    if(e.target.closest('button,a,summary,details')) return;
    openSegView(el.dataset.segid);
  }));
}

/* ---------- 취득(증여) 시트 ---------- */
function writeInfoBasic(){
  const s=S(), a=s.acq||{};
  s.info.nickname=$q('#sg-nick').value.trim();
  s.info.address=$q('#sg-addr').value.trim();
  s.info.addressDetail=$q('#sg-addrd').value.trim();
  s.acq=Object.assign({}, a, { acqDate:$q('#sg-acqd').value, memo:$q('#sg-memo').value.trim() });
}
function taxRowHTML(id,title,sub,val){
  return `<button class="setcard sg-taxrow" id="${id}">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 2px">
      <div><div class="sk">${title}</div><div class="sd">${sub}</div></div>
      <div style="text-align:right"><div class="num" style="font-weight:800;font-size:16px">${val}</div><div style="color:var(--green);font-size:11px;font-weight:800">상세 ▸</div></div>
    </div></button>`;
}
function openInfo(){
  const s=S(), a=s.acq||{}, info=s.info||{};
  window.sheet(`<h2>상가 정보 · 취득(증여)</h2>
    <div class="field"><label>별칭</label><input id="sg-nick" value="${esc(info.nickname||'')}"></div>
    <div class="field"><label>주소</label><div style="display:flex;gap:8px"><input id="sg-addr" style="flex:1" value="${esc(info.address||'')}"><button class="sbtn" id="sg-findaddr" style="flex:none;padding:0 14px">주소찾기</button></div></div>
    <div class="field"><label>상세주소 (동/호 등 수기)</label><input id="sg-addrd" value="${esc(info.addressDetail||'')}" placeholder="예: 3동 502호"></div>
    <div class="field"><label>취득일</label><input id="sg-acqd" type="date" value="${a.acqDate||''}"></div>
    <div class="sec" style="margin:12px 2px 8px">세금 (터치 → 계산)</div>
    ${taxRowHTML('sg-giftbtn','증여세','토지·건물가·공제 입력 → 자동', a.giftTax?fmtKRW(+a.giftTax):'입력')}
    <div style="height:8px"></div>
    ${taxRowHTML('sg-acqtaxbtn','취득세 공과금 · 취득비용','토지·건물가 입력 → 자동', a.acqTax?fmtKRW(+a.acqTax):'입력')}
    <div class="field" style="margin-top:14px"><label>메모</label><input id="sg-memo" value="${esc(a.memo||'')}"></div>
    <div class="sheet-actions"><button class="btn ghost" id="sg-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-save">저장</button></div>`);
  $q('#sg-findaddr').onclick=()=>{ writeInfoBasic(); save(); openAddr(); };
  $q('#sg-giftbtn').onclick=()=>{ writeInfoBasic(); save(); openGiftTax(openInfo); };
  $q('#sg-acqtaxbtn').onclick=()=>{ writeInfoBasic(); save(); openAcqTax(openInfo); };
  $q('#sg-cancel').onclick=window.close;
  $q('#sg-save').onclick=()=>{ writeInfoBasic(); save(); window.close(); window.render(); toast('저장됨'); };
}
function openInfoView(){
  const s=S(), a=s.acq||{}, info=s.info||{};
  const kv=(k,v)=>`<div class="settings-row"><div class="sk">${k}</div><div class="num" style="font-weight:800">${v}</div></div>`;
  const addr=esc(info.address||'-')+(info.addressDetail?' '+esc(info.addressDetail):'');
  const burden=(+a.giftTax||0)+(+a.acqGrand|| +a.acqTax||0);
  window.sheet(`<h2>상가 정보 · 취득(증여)</h2>
    <div class="setcard">
      ${kv('별칭', esc(info.nickname||'-'))}
      ${kv('주소', addr)}
      ${kv('취득일', a.acqDate||'-')}
    </div>
    <div class="sec" style="margin:12px 2px 8px">세금 (터치 → 계산흐름)</div>
    <div class="setcard">
      <div class="settings-row sg-vrow" data-vgift="1"><div class="sk">증여세 <span style="color:var(--green);font-size:11px;font-weight:800">계산흐름 ▸</span></div><div class="num" style="font-weight:800">${a.giftTax?fmtKRW(+a.giftTax):'-'}</div></div>
      <div class="settings-row sg-vrow" data-vacq="1"><div class="sk">취득세 공과금 <span style="color:var(--green);font-size:11px;font-weight:800">계산흐름 ▸</span></div><div class="num" style="font-weight:800">${a.acqTax?fmtKRW(+a.acqTax):'-'}</div></div>
      ${a.acqGrand?kv('취득 총비용(법무사 포함)', fmtKRW(+a.acqGrand)):''}
      ${burden>0?kv('취득 총부담(증여세+취득비용)', fmtKRW(burden)):''}
    </div>
    ${a.memo?`<div class="setcard" style="margin-top:10px"><div class="sd" style="margin:0">${esc(a.memo)}</div></div>`:''}
    <div class="sheet-actions"><button class="btn ghost" id="iv-close" style="flex:0 0 auto">닫기</button><button class="btn" id="iv-edit">수정</button></div>`);
  $q('#iv-close').onclick=window.close;
  $q('#iv-edit').onclick=()=>openInfo();
  const g=$q('[data-vgift]'); if(g) g.onclick=()=>openGiftTax(openInfoView);
  const ac=$q('[data-vacq]'); if(ac) ac.onclick=()=>openAcqTax(openInfoView);
}
function writeGiftTax(){
  const s=S(), a=s.acq||{};
  const gl=numOf($q('#gt-land').value), gb=numOf($q('#gt-bldg').value), ded=numOf($q('#gt-ded').value);
  const g=calcGift(gl,gb,ded);
  s.acq=Object.assign({}, a, { giftLand:gl, giftBldg:gb, giftDeduction:ded, declared:g.val, giftTax:g.tax });
}
function openGiftTax(back){
  back = back||openInfo;
  const s=S(), a=s.acq||{};
  const gl=a.giftLand!=null?a.giftLand:(a.landValue||'');
  const gb=a.giftBldg!=null?a.giftBldg:(a.buildingValue||'');
  const ded0=a.giftDeduction!=null?a.giftDeduction:50000000;
  window.sheet(`<h2>증여세 계산</h2><div class="hint">증여재산가액(시가인정액/감정가) 기준. 토지·건물가를 넣으면 자동 계산돼요.</div>
    <div class="row2"><div class="field"><label>토지가액(증여용, 원)</label><input id="gt-land" type="text" inputmode="numeric" value="${commaFmt(gl)}"></div>
      <div class="field"><label>건물가액(증여용, 원)</label><input id="gt-bldg" type="text" inputmode="numeric" value="${commaFmt(gb)}"></div></div>
    <div class="field"><label>증여재산공제(원)</label><input id="gt-ded" type="text" inputmode="numeric" value="${commaFmt(ded0)}"><div class="hint">직계 성년 5천만 · 배우자 6억 · 미성년 2천만 (10년 합산)</div></div>
    <div class="calc-preview on sg-acqbox" id="gt-calc">${giftBreakdownHTML(numOf(gl),numOf(gb),ded0)}</div>
    <div class="sheet-actions"><button class="btn ghost" id="gt-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="gt-save">저장</button></div>`);
  ['gt-land','gt-bldg','gt-ded'].forEach(id=>wireComma($q('#'+id)));
  const recalc=()=>{ $q('#gt-calc').innerHTML=giftBreakdownHTML(numOf($q('#gt-land').value),numOf($q('#gt-bldg').value),numOf($q('#gt-ded').value)); };
  ['gt-land','gt-bldg','gt-ded'].forEach(id=>$q('#'+id).addEventListener('input',recalc));
  $q('#gt-cancel').onclick=()=>back();
  $q('#gt-save').onclick=()=>{ writeGiftTax(); save(); back(); toast('증여세 저장됨'); };
}
function writeAcqTax(){
  const s=S(); const a=s.acq||{};
  const al=numOf($q('#at-land').value), ab=numOf($q('#at-bldg').value);
  const c=calcAcqTax(al,ab);
  const reg=numOf($q('#at-reg').value), bond=numOf($q('#at-bond').value), misc=numOf($q('#at-misc').value), scr=numOf($q('#at-scr').value);
  const subtotal=c.tax+reg+bond+misc, grand=subtotal+scr;
  s.acq=Object.assign({}, a, { acqLand:al, acqBldg:ab, acqTaxMain:c.main, acqEdu:c.edu, acqRural:c.rural, acqTax:c.tax,
    regFee:reg, bondDiscount:bond, misc:misc, scrivenerFee:scr, acqSubtotal:subtotal, acqGrand:grand });
}
function openAcqTax(back){
  back = back||openInfo;
  const s=S(), a=s.acq||{};
  const al = a.acqLand!=null?a.acqLand:(a.landValue||'');
  const ab = a.acqBldg!=null?a.acqBldg:(a.buildingValue||'');
  window.sheet(`<h2>취득세 · 취득비용 계산</h2><div class="hint">취득세는 시가표준액 기준(증여세 가액과 달라도 됨). 토지·건물가를 넣으면 자동 계산돼요.</div>
    <div class="row2"><div class="field"><label>토지가액(취득세용, 원)</label><input id="at-land" type="text" inputmode="numeric" value="${commaFmt(al)}"></div>
      <div class="field"><label>건물가액(취득세용, 원)</label><input id="at-bldg" type="text" inputmode="numeric" value="${commaFmt(ab)}"></div></div>
    <div class="sec" style="margin:6px 2px 8px">추가 비용 (법무사 영수증 참고 · 수기)</div>
    <div class="row2"><div class="field"><label>등기신청수수료</label><input id="at-reg" type="text" inputmode="numeric" value="${commaFmt(a.regFee)}"></div>
      <div class="field"><label>국민주택채권 할인금</label><input id="at-bond" type="text" inputmode="numeric" value="${commaFmt(a.bondDiscount)}"></div></div>
    <div class="row2"><div class="field"><label>제증명·기타</label><input id="at-misc" type="text" inputmode="numeric" value="${commaFmt(a.misc)}"></div>
      <div class="field"><label>법무사 보수</label><input id="at-scr" type="text" inputmode="numeric" value="${commaFmt(a.scrivenerFee)}"></div></div>
    <div class="calc-preview on sg-acqbox" id="at-calc">${acqTaxBreakdownHTML(numOf(al),numOf(ab),numOf(a.regFee),numOf(a.bondDiscount),numOf(a.misc),numOf(a.scrivenerFee))}</div>
    <div class="sheet-actions"><button class="btn ghost" id="at-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="at-save">저장</button></div>`);
  ['at-land','at-bldg','at-reg','at-bond','at-misc','at-scr'].forEach(id=>wireComma($q('#'+id)));
  const recalc=()=>{ $q('#at-calc').innerHTML=acqTaxBreakdownHTML(numOf($q('#at-land').value),numOf($q('#at-bldg').value),numOf($q('#at-reg').value),numOf($q('#at-bond').value),numOf($q('#at-misc').value),numOf($q('#at-scr').value)); };
  ['at-land','at-bldg','at-reg','at-bond','at-misc','at-scr'].forEach(id=>$q('#'+id).addEventListener('input',recalc));
  $q('#at-cancel').onclick=()=>back();
  $q('#at-save').onclick=()=>{ writeAcqTax(); save(); back(); toast('취득세 저장됨'); };
}

/* ---------- 구간 보기(읽기전용) 시트 ---------- */
function openSegView(id){
  const s=S(); const seg=s.segments.find(x=>x.id===id); if(!seg) return;
  const lease=seg.type==='lease';
  const period=`${seg.start||'?'} ~ ${seg.end||'진행중'}`;
  const kv=(k,v)=>`<div class="settings-row"><div class="sk">${k}</div><div class="num" style="font-weight:800">${v}</div></div>`;
  let rows='';
  if(lease){
    const rent=+seg.rent||0, vat=seg.vatSeparate!==false?Math.round(rent*0.1):0;
    rows=kv('임차인',esc(seg.tenant||'-'))
      +kv('연락처', seg.phone?`<a href="tel:${esc(phoneFmt(seg.phone))}" style="color:var(--green)">${esc(phoneFmt(seg.phone))}</a>`:'-')
      +kv('입금계좌',esc(seg.account||'-'))
      +kv('보증금',fmtKRW(+seg.deposit||0))
      +kv('월 임차료',fmtKRW(rent)+(vat?` <small style="color:var(--muted)">(+VAT ${fmtKRW(vat)})</small>`:''))
      +kv('관리비', seg.mgmtActual?'실비(임차인 부담)':(seg.mgmt?fmtKRW(+seg.mgmt):'-'));
  } else {
    const vm=seg.vacantMonths||[]; const total=vm.reduce((a,x)=>a+(+x.amount||0),0);
    rows=kv('공실 관리비 합계', `${fmtKRW(total)} <small style="color:var(--muted)">(${vm.length}개월)</small>`);
    rows+=[...vm].sort((a,b)=>(a.ym||'').localeCompare(b.ym||'')).map(x=>kv('· '+(x.ym||''), fmtKRW(+x.amount||0))).join('');
  }
  const docs=segDocs(seg);
  const docHtml = docs.length ? `<div class="sec" style="margin:12px 2px 8px">첨부</div><div class="setcard">`+docs.map(d=>`<div class="settings-row"><div class="sk">📎 ${esc(d.label||'문서')} <small style="color:var(--muted)">${esc(d.fileName||'')}</small></div><button class="sbtn" data-vdoc="${d.id}" style="padding:6px 12px">보기</button></div>`).join('')+`</div>` : '';
  window.sheet(`<h2><span class="sg-tag ${lease?'lease':'vacant'}" style="vertical-align:middle;margin-right:4px">${lease?'임차':'공실'}</span>구간 상세</h2>
    <div class="hint" style="margin:-4px 0 10px">${period}</div>
    <div class="setcard">${rows}</div>
    ${seg.memo?`<div class="setcard" style="margin-top:10px"><div class="sd" style="margin:0">${esc(seg.memo)}</div></div>`:''}
    ${docHtml}
    <div class="sheet-actions"><button class="btn ghost" id="sv-close" style="flex:0 0 auto">닫기</button><button class="btn" id="sv-edit">수정</button></div>`);
  $q('#sv-close').onclick=window.close;
  $q('#sv-edit').onclick=()=>openSeg(id);
  document.querySelectorAll('[data-vdoc]').forEach(b=>b.onclick=()=>{ const d=segDocs(seg).find(x=>x.id===b.dataset.vdoc); if(d) openDocBlob(d.fileKey); });
}

/* ---------- 보유 구간 시트 ---------- */
function openSeg(id){
  const s=S();
  let seg = id ? s.segments.find(x=>x.id===id) : null;
  let type = seg? seg.type : 'lease';
  let vat = seg? (seg.vatSeparate!==false) : true;
  let mgmtActual = seg? !!seg.mgmtActual : false;
  let vm = seg && seg.vacantMonths ? seg.vacantMonths.map(x=>({...x})) : [];
  let pendingDocFile=null;

  window.sheet(`<h2>${seg?'보유 구간 수정':'보유 구간 추가'}</h2>
    <div class="seg-in" id="sg-type"><button data-t="lease" class="${type==='lease'?'on':''}">임차</button><button data-t="vacant" class="${type==='vacant'?'on':''}">공실(비임차)</button></div>
    <div class="row2" style="margin-top:12px"><div class="field"><label>시작일</label><input id="sg-s" type="date" value="${seg?seg.start||'':''}"></div>
      <div class="field"><label>종료일(진행중이면 비움)</label><input id="sg-e" type="date" value="${seg?seg.end||'':''}"></div></div>
    <div id="sg-lease" style="display:${type==='lease'?'block':'none'}">
      <div class="field"><label>임차인(상호/이름)</label><input id="sg-tenant" value="${seg?esc(seg.tenant||''):''}"></div>
      <div class="field"><label>연락처(전화)</label><input id="sg-phone" type="tel" inputmode="tel" value="${seg?esc(phoneFmt(seg.phone||'')):''}" placeholder="예: 010-1234-5678"></div>
      <div class="field"><label>입금 계좌번호</label><input id="sg-account" value="${seg?esc(seg.account||''):''}" placeholder="예: 국민 123-45-6789"></div>
      <div class="row2"><div class="field"><label>보증금(원)</label><input id="sg-dep" type="text" inputmode="numeric" value="${commaFmt(seg?seg.deposit:'')}"></div>
        <div class="field"><label>월 임차료(공급가,원)</label><input id="sg-rent" type="text" inputmode="numeric" value="${commaFmt(seg?seg.rent:'')}"></div></div>
      <div class="settings-row" style="padding:12px 0"><div><div class="sk">부가세 별도</div><div class="sd">월세 10% 추가 수취</div></div><div class="switch ${vat?'on':''}" id="sg-vat"><i></i></div></div>
      <div class="field"><label>월 관리비(임차인 부담)</label><input id="sg-mgmt" type="text" inputmode="numeric" value="${commaFmt(seg?seg.mgmt:'')}"></div>
      <div class="settings-row" style="padding:12px 0"><div><div class="sk">관리비 실비 정산</div><div class="sd">정액 아님 · 실비로 임차인 부담</div></div><div class="switch ${mgmtActual?'on':''}" id="sg-mgmtreal"><i></i></div></div>
    </div>
    <div id="sg-vacant" style="display:${type==='vacant'?'block':'none'}">
      <div class="field"><label>공실 월별 관리비 (소유주 부담)</label>
        <div id="sg-vmlist" style="margin-bottom:6px"></div>
        <div class="row2"><div class="field" style="margin:0"><label>월</label><input id="sg-vmym" type="month"></div>
          <div class="field" style="margin:0"><label>금액(원)</label><input id="sg-vmamt" type="text" inputmode="numeric"></div></div>
        <button class="sbtn" id="sg-vmadd" style="width:100%;margin-top:8px">+ 이 달 관리비 추가</button>
      </div>
    </div>
    <div class="field"><label>첨부 문서 (계약서·영수증 등 · 필요할 때마다 추가)</label>
      <div id="sg-docs" style="margin-bottom:6px"></div>
      <input id="sg-doclabel" placeholder="종류 (예: 계약서, 납부영수증)" style="margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center"><input id="sg-docfile" type="file" accept="image/*,application/pdf" style="flex:1"><button class="sbtn" id="sg-docadd" style="flex:none;padding:0 16px">추가</button></div>
    </div>
    <div class="field"><label>메모</label><input id="sg-segmemo" value="${seg?esc(seg.memo||''):''}"></div>
    <div class="sheet-actions">${seg?'<button class="btn ghost" id="sg-del" style="color:var(--red);flex:0 0 auto">삭제</button>':''}<button class="btn ghost" id="sg-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-save">저장</button></div>`);

  ['sg-dep','sg-rent','sg-mgmt','sg-vmamt'].forEach(id=>wireComma($q('#'+id)));
  wirePhone($q('#sg-phone'));
  $q('#sg-type').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    type=b.dataset.t;
    $q('#sg-type').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.t===type));
    $q('#sg-lease').style.display=type==='lease'?'block':'none';
    $q('#sg-vacant').style.display=type==='vacant'?'block':'none';
  });
  const vatEl=$q('#sg-vat'); if(vatEl) vatEl.onclick=()=>{ vat=!vat; vatEl.classList.toggle('on',vat); };
  const mgmtInput=$q('#sg-mgmt'), realEl=$q('#sg-mgmtreal');
  function applyReal(){ if(mgmtInput){ mgmtInput.disabled=mgmtActual; mgmtInput.style.opacity=mgmtActual?0.45:1; mgmtInput.placeholder=mgmtActual?'실비(정액 아님)':''; } }
  if(realEl) realEl.onclick=()=>{ mgmtActual=!mgmtActual; realEl.classList.toggle('on',mgmtActual); applyReal(); };
  applyReal();

  /* 공실 월별 관리비 */
  function renderVM(){
    const box=$q('#sg-vmlist'); if(!box) return;
    if(!vm.length){ box.innerHTML='<div class="hint" style="margin:0">없음</div>'; return; }
    const total=vm.reduce((s,x)=>s+(+x.amount||0),0);
    box.innerHTML=[...vm].sort((a,b)=>(a.ym||'').localeCompare(b.ym||'')).map(x=>`<div class="sg-doc"><div class="dn">${x.ym||''} <small>${fmtKRW(+x.amount||0)}</small></div><button class="sbtn" style="padding:4px 9px;font-size:11px;color:var(--red)" data-vmdel="${x.id}">삭제</button></div>`).join('')
      +`<div style="text-align:right;font-weight:800;font-size:12.5px;margin-top:6px">합계 ${fmtKRW(total)}</div>`;
    box.querySelectorAll('[data-vmdel]').forEach(b=>b.onclick=()=>{ vm=vm.filter(x=>x.id!==b.dataset.vmdel); renderVM(); });
  }
  renderVM();
  $q('#sg-vmadd').onclick=()=>{ const ym=$q('#sg-vmym').value, amt=numOf($q('#sg-vmamt').value);
    if(!ym) return toast('월을 선택하세요'); if(!amt) return toast('금액을 입력하세요');
    if(vm.some(x=>x.ym===ym) && !confirm(ym+' 이미 있어요. 그래도 추가?')) return;
    vm.push({id:'vm'+Date.now().toString(36)+Math.floor(Math.random()*100), ym, amount:amt});
    $q('#sg-vmamt').value=''; renderVM(); };

  /* 첨부 문서 */
  function readSegForm(){
    const data={ type, start:$q('#sg-s').value, end:$q('#sg-e').value, memo:$q('#sg-segmemo').value.trim() };
    if(type==='lease'){ Object.assign(data,{ tenant:$q('#sg-tenant').value.trim(), phone:phoneFmt($q('#sg-phone').value),
      account:$q('#sg-account').value.trim(), deposit:numOf($q('#sg-dep').value), rent:numOf($q('#sg-rent').value),
      vatSeparate:vat, mgmtActual:mgmtActual, mgmt: mgmtActual?0:numOf($q('#sg-mgmt').value) }); }
    else { data.vacantMonths=vm; }
    return data;
  }
  function ensurePersisted(){
    if(seg) return seg;
    const data=readSegForm(); data.id='sg'+Date.now().toString(36); data.docs=[];
    s.segments.push(data); seg=data; save(); return seg;
  }
  function renderDocs(){
    const box=$q('#sg-docs'); if(!box) return;
    const docs = seg ? segDocs(seg) : [];
    if(!docs.length){ box.innerHTML='<div class="hint" style="margin:0">첨부 없음</div>'; return; }
    box.innerHTML=docs.map(d=>`<div class="sg-doc"><div class="dn">📎 ${esc(d.label||'문서')} <small>${esc(d.fileName||'')}</small></div>
      <button class="sbtn" style="padding:4px 9px;font-size:11px" data-dview="${d.id}">보기</button>
      <button class="sbtn" style="padding:4px 9px;font-size:11px;color:var(--red)" data-ddel="${d.id}">삭제</button></div>`).join('');
    box.querySelectorAll('[data-dview]').forEach(b=>b.onclick=()=>{ const d=segDocs(seg).find(x=>x.id===b.dataset.dview); if(d) openDocBlob(d.fileKey); });
    box.querySelectorAll('[data-ddel]').forEach(b=>b.onclick=async()=>{ if(!confirm('이 첨부를 삭제할까요?')) return;
      const d=segDocs(seg).find(x=>x.id===b.dataset.ddel); if(d){ try{await idbDel(d.fileKey);}catch(e){} seg.docs=segDocs(seg).filter(x=>x.id!==d.id); save(); renderDocs(); } });
  }
  renderDocs();
  $q('#sg-docfile').onchange=e=>{ pendingDocFile=e.target.files[0]||null; };
  $q('#sg-docadd').onclick=async()=>{
    const f=pendingDocFile; if(!f){ toast('파일을 선택하세요'); return; }
    const target=ensurePersisted();
    const docId='doc'+Date.now().toString(36), key='sgdoc_'+docId;
    try{ await idbPut(key,f); }catch(err){ toast('첨부 저장 실패(이 환경 미지원일 수 있음)'); return; }
    const label=$q('#sg-doclabel').value.trim()||f.name;
    segDocs(target).push({id:docId, label, fileKey:key, fileName:f.name});
    save(); pendingDocFile=null; $q('#sg-docfile').value=''; $q('#sg-doclabel').value=''; renderDocs(); toast('첨부 추가됨');
  };

  $q('#sg-cancel').onclick=window.close;
  $q('#sg-save').onclick=()=>{
    const data=readSegForm();
    if(seg){ Object.assign(seg,data); } else { data.id='sg'+Date.now().toString(36); data.docs=[]; s.segments.push(data); }
    save(); window.close(); window.render(); toast('저장됨');
  };
  const delEl=$q('#sg-del'); if(delEl) delEl.onclick=async()=>{ if(!confirm('이 구간을 삭제할까요?')) return;
    for(const d of segDocs(seg)){ try{ await idbDel(d.fileKey); }catch(e){} }
    s.segments=s.segments.filter(x=>x.id!==seg.id); save(); window.close(); window.render(); toast('삭제됨'); };
}

/* ---------- 통장 시트 ---------- */
function openTx(id, prefill){
  const s=S();
  const t = id ? s.ledger.txns.find(x=>x.id===id) : null;
  prefill = prefill||{};
  const amt = t? commaFmt(Math.abs(+t.amount||0)) : '';
  const dir = t? ((+t.amount||0)>=0?'in':'out') : (prefill.dir||'in');
  const dateVal = t?(t.date||todayISO()):(prefill.date||todayISO());
  const kindVal = t?(t.kind||'기타'):(prefill.kind||'임차료');
  let capital = t? !!t.capital : !!prefill.capital;
  const kinds=['임차료','부가세','관리비','수선비','공사·시설','세금','수수료','보증금','기타'];
  window.sheet(`<h2>${t?'통장 내역 수정':'통장 내역 추가'}</h2>
    <div class="row2"><div class="field"><label>날짜</label><input id="sg-tdate" type="date" value="${dateVal}"></div>
      <div class="field"><label>유형</label><select id="sg-tdir"><option value="in"${dir==='in'?' selected':''}>입금(+)</option><option value="out"${dir==='out'?' selected':''}>출금(−)</option></select></div></div>
    <div class="field"><label>항목</label><select id="sg-tkind">${kinds.map(k=>`<option${kindVal===k?' selected':''}>${k}</option>`).join('')}</select></div>
    <div class="field"><label>금액(원)</label><input id="sg-tamt" type="text" inputmode="numeric" value="${amt}"></div>
    <div class="field"><label>메모</label><input id="sg-tmemo" value="${t?esc(t.memo||''):''}"></div>
    <div class="settings-row" style="padding:12px 0"><div><div class="sk">자본적지출</div><div class="sd">양도세 취득원가 가산(새시·확장 등) · 도배·장판은 해제</div></div><div class="switch ${capital?'on':''}" id="sg-tcap"><i></i></div></div>
    <div class="sheet-actions">${t?'<button class="btn ghost" id="sg-tdel" style="color:var(--red);flex:0 0 auto">삭제</button>':''}<button class="btn ghost" id="sg-tcancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-tsave">저장</button></div>`);
  wireComma($q('#sg-tamt'));
  const capEl=$q('#sg-tcap'); if(capEl) capEl.onclick=()=>{ capital=!capital; capEl.classList.toggle('on',capital); };
  $q('#sg-tcancel').onclick=window.close;
  $q('#sg-tsave').onclick=()=>{
    const v=numOf($q('#sg-tamt').value); if(!v) return toast('금액을 입력하세요');
    const signed=$q('#sg-tdir').value==='in'?v:-v;
    const data={ date:$q('#sg-tdate').value||todayISO(), kind:$q('#sg-tkind').value, amount:signed, memo:$q('#sg-tmemo').value.trim(), capital:capital };
    if(t){ Object.assign(t,data); } else { data.id='sgtx'+Date.now().toString(36)+Math.floor(Math.random()*1000); s.ledger.txns.push(data); }
    save(); window.close(); window.render(); toast('저장됨');
  };
  const del=$q('#sg-tdel'); if(del) del.onclick=()=>{ if(!confirm('이 내역을 삭제할까요?')) return;
    s.ledger.txns=s.ledger.txns.filter(x=>x.id!==t.id); save(); window.close(); window.render(); toast('삭제됨'); };
}

function quickRent(){
  const l=activeLease(); if(!l) return toast('진행중인 임차 구간이 없어요 (② 보유 구간에 임차 기간 추가)');
  const rent=+l.rent||0, vat=l.vatSeparate!==false?Math.round(rent*0.1):0, amt=rent+vat;
  if(!amt) return toast('임차 구간에 월세가 없어요');
  const s=S(), m=todayISO().slice(0,7);
  const exists=s.ledger.txns.some(t=>t.kind==='임차료' && (t.date||'').slice(0,7)===m);
  if(exists && !confirm('이번 달 임차료가 이미 있어요. 그래도 추가할까요?')) return;
  s.ledger.txns.push({ id:'sgtx'+Date.now().toString(36), date:todayISO(), kind:'임차료', amount:amt, memo:(l.tenant||'')+(vat?' (월세+VAT)':'') });
  save(); window.render(); toast('임차료 입금 기록됨');
}
function quickMgmt(){ openTx(null, { date:nextMgmtDate(), kind:'관리비', dir:'in' }); }

/* ---------- 설정 백업/가져오기에 첨부파일 포함 (index.html 함수 감싸기) ---------- */
function hookBackup(){
  const bfn = (typeof backupFilename==='function') ? backupFilename : (()=> 'tmt-backup-'+todayISO()+'.json');
  const dl=(text,fname)=>{ const blob=new Blob([text],{type:'application/json'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=fname; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1200); };
  async function buildBackupText(){ const backup=JSON.parse(JSON.stringify(db)); backup.sangga=backup.sangga||{}; backup.sangga._files=await collectFiles(); return JSON.stringify(backup,null,2); }

  if(typeof window.exportData==='function'){
    window.exportData=async function(){ try{ dl(await buildBackupText(),'tmt-asset-backup-'+todayISO()+'.json'); db.lastAutoBackup=Date.now(); save(); toast('백업 저장됨 (첨부 포함)'); }catch(e){ toast('백업 실패: '+e.message); } };
  }
  if(typeof window.phoneBackup==='function'){
    window.phoneBackup=async function(){ try{ dl(await buildBackupText(), bfn('')); db.lastAutoBackup=Date.now(); save(); if(tab==='settings') window.render(); toast('📲 폰에 백업됨 (첨부 포함)'); }catch(e){ toast('백업 실패: '+e.message); } };
  }
  if(typeof window.importData==='function'){
    const AC=(typeof ACCT_COLORS!=='undefined')?ACCT_COLORS:['#17A45C'];
    window.importData=function(){
      const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
      inp.onchange=()=>{ const f=inp.files[0]; if(!f) return; const r=new FileReader();
        r.onload=async()=>{ try{ const d=JSON.parse(r.result); if(!d.accounts&&!d.stocks&&!d.sangga) throw 0;
          const files=(d.sangga&&d.sangga._files)||null; if(d.sangga) delete d.sangga._files;
          db=Object.assign({accounts:[],stocks:[],buys:[],sells:[],divs:[],taxUS:15,taxKR:15.4,theme:'light',apiBase:'',seeded:false,lastAutoBackup:0,autoBackupOn:true},d);
          if(!db.sells)db.sells=[]; if(!db.accounts.length)db.accounts.push({id:uid(),name:'토스증권 (배당)',broker:'토스증권',color:AC[0]});
          save();
          if(files){ for(const it of files){ try{ const blob=await dataURLToBlob(it.data); await idbPut(it.fileKey, blob); }catch(e){} } }
          if(typeof applyTheme==='function') applyTheme(); window.render(); toast('불러오기 완료 (첨부 포함)');
        }catch(e){ toast('파일 형식 오류'); } };
        r.readAsText(f); };
      inp.click();
    };
  }
}

/* ---------- 부착 ---------- */
function attach(){
  injectCSS();
  hookBackup();
  const nav=$q('#nav'); if(!nav) return;
  const btn=document.createElement('button');
  btn.dataset.tab='sangga';
  btn.innerHTML=`<svg viewBox="0 0 24 24" fill="none"><path d="M4 9h16l-1.2-4.2A1 1 0 0 0 17.8 4H6.2a1 1 0 0 0-1 .8L4 9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M5 9v10h14V9M10 19v-5h4v5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>상가`;
  btn.onclick=()=>{ tab='sangga'; window.render(); window.scrollTo(0,0); };
  const setBtn=nav.querySelector('[data-tab="settings"]');
  if(setBtn) nav.insertBefore(btn, setBtn); else nav.appendChild(btn);

  const orig=window.render;
  window.render=function(){
    if(tab!=='sangga'){
      try{ localStorage.setItem('tmt.ui.sangga','0'); }catch(e){}
      return orig.apply(this, arguments);
    }
    try{
      $q('#app').innerHTML='<div class="topspace"></div><div class="wrap">'+viewSangga()+'</div>';
      document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('on', b.dataset.tab==='sangga'));
      const fab=$q('#fab'); if(fab) fab.style.display='none';
      bindSangga();
      try{ localStorage.setItem('tmt.ui.sangga','1'); localStorage.setItem('tmt.ui.estate','0'); }catch(e){}
    }catch(err){
      console.error('[sangga]', err);
      $q('#app').innerHTML='<div class="topspace"></div><div class="wrap">'
        +'<div class="empty" style="padding:40px 20px"><div class="em">\u26a0\ufe0f</div>'
        +'<h3>상가 탭 오류</h3><p style="word-break:break-all">'+String((err&&err.message)||err)+'</p>'
        +'<button class="btn ghost" id="sg-home">홈으로</button></div></div>';
      const hb=$q('#sg-home'); if(hb) hb.onclick=()=>{ tab='dash'; window.render(); };
      try{ localStorage.setItem('tmt.ui.sangga','0'); }catch(e2){}
    }
  };

  try{ if(localStorage.getItem('tmt.ui.sangga')==='1'){ tab='sangga'; window.render(); } }catch(e){}
}
function safeAttach(){ try{ attach(); }catch(err){ console.error('[sangga] attach 실패',err); } }
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',safeAttach);
else safeAttach();

window.SanggaMgr={S,ledgerBalance,activeLease,currentStatus,calcGift,calcAcqTax,giftTaxGross,phoneFmt};
})();
