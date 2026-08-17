/* =============================================================================
   상가 관리 모듈  sangga.js   v0817.1
   -----------------------------------------------------------------------------
   index.html은 딱 한 줄만 추가 (estate.js 다음 줄):
        <script src="sangga.js"></script>
   나머지는 이 파일이 알아서 붙는다 (하단 탭 "상가" · 화면 · 스타일 자동 주입).

   - 데이터는 기존 db 안(db.sangga)에 저장 → TMT 백업(phoneBackup/내보내기)에 자동 포함
   - 계약서 파일만 용량 때문에 IndexedDB 별도 저장(백업 JSON엔 미포함)
   - 상가 1개 기준: ① 취득(증여) ② 보유 구간(임차/공실) ③ 통장(0원부터 관리)
   - db / uid / esc / tab / save / fmtK / fmtKRW / todayISO / toast / window.sheet /
     window.close / window.render 는 index.html의 것을 그대로 사용
   ============================================================================= */
(function(){
"use strict";
const $q = s=>document.querySelector(s);

/* ============================================================
   1. 상태 접근
   ============================================================ */
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

/* ============================================================
   2. 계약서 파일 (IndexedDB)
   ============================================================ */
function idbOpen(){return new Promise((res,rej)=>{const r=indexedDB.open('tmt_sangga_files',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('contracts'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});}
function idbPut(k,b){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readwrite');t.objectStore('contracts').put(b,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
function idbGet(k){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readonly');const q=t.objectStore('contracts').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);}));}
function idbDel(k){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction('contracts','readwrite');t.objectStore('contracts').delete(k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}

/* ============================================================
   3. 스타일 (기존 디자인 토큰 재사용)
   ============================================================ */
const CSS=`
.sg-seg{background:var(--card);border-radius:16px;padding:14px;box-shadow:var(--shadow);margin-bottom:10px}
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
.sg-led3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;margin-bottom:10px;text-align:center}
.sg-led3>div{background:var(--card);border-radius:13px;padding:11px 4px;box-shadow:var(--shadow)}
.sg-led3 .k{font-size:10.5px;color:var(--muted);font-weight:700}
.sg-led3 .v{font-size:15px;font-weight:800;margin-top:3px}
.sg-tx{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.sg-tx:last-child{border:none}
.sg-tx .l{flex:1;min-width:0}
.sg-tx .l .d{font-size:11px;color:var(--muted);font-weight:700}
.sg-tx .l .m{font-size:13px;font-weight:700;margin-top:1px}
.sg-tx .r{text-align:right;flex:none}
.sg-tx .amt{font-weight:800;font-size:14px}
.sg-tx .bal{font-size:10.5px;color:var(--muted);font-weight:600;margin-top:1px}
.sg-txedit{color:var(--muted);width:28px;height:28px;border-radius:8px;display:grid;place-items:center;flex:none}
.sg-txedit svg{width:15px;height:15px}
.sg-txedit:active{background:var(--bg);color:var(--blue)}
.sg-sec{display:flex;align-items:center;gap:6px}
.sg-sec .sbtn{margin-left:auto;padding:6px 11px;font-size:12px}
`;
function injectCSS(){ const s=document.createElement('style'); s.textContent=CSS; document.head.appendChild(s); }

/* ============================================================
   4. 화면
   ============================================================ */
function viewSangga(){
  const s=S();
  const st=currentStatus(), lease=activeLease(), dd=lease?daysTo(lease.end):null, bal=ledgerBalance();
  const stTxt = st==='lease'?'임차중':st==='vacant'?'공실':'미설정';
  const stCol = st==='lease'?'#3FE0A0':st==='vacant'?'#E6A020':'#9AA6B6';
  const a=s.acq||{};

  /* 요약 (다크 카드) */
  let html=`<div class="sumcard"><div class="glow"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="stitle" style="margin:0">${esc(s.info.nickname||'상가')}</div>
      <span style="font-size:12.5px;font-weight:800;color:${stCol}">${stTxt}${lease&&dd!=null?` · 만기 ${dd<0?'만료':'D-'+dd}`:''}</span>
    </div>
    <div style="font-size:12px;color:#9AA6B6;font-weight:600;margin-bottom:14px">${esc(s.info.address||'주소 미입력')}</div>
    <div class="sumcols">
      <div class="sumcol"><div class="sk">💳 통장 잔액</div><div class="sv num">${fmtK(bal)}</div></div>
      <div class="sumcol r"><div class="sk">🏢 취득가(증여신고)</div><div class="sv num">${a.declared?fmtK(+a.declared):'—'}</div></div>
    </div>
  </div>`;

  /* ① 취득·증여 */
  const totalCost=(+a.giftTax||0)+(+a.acqTax||0)+(+a.fee||0);
  const acqRows=[
    ['취득일', a.acqDate||'-'],
    ['증여 신고가액', a.declared?fmtKRW(+a.declared):'-'],
    ['증여세', a.giftTax?fmtKRW(+a.giftTax):'-'],
    ['취득세', a.acqTax?fmtKRW(+a.acqTax):'-'],
    ['수수료·부대', a.fee?fmtKRW(+a.fee):'-'],
  ];
  html+=`<div class="sec sg-sec">① 취득 · 증여<button class="sbtn" data-sgeditinfo="1">수정</button></div>
    <div class="setcard">`+acqRows.map(r=>`<div class="settings-row"><div class="sk">${r[0]}</div><div class="num" style="font-weight:800">${r[1]}</div></div>`).join('')+
    (totalCost>0?`<div class="settings-row"><div class="sk" style="color:var(--muted)">취득 총부담(세금+수수료)</div><div class="num" style="font-weight:800;color:var(--muted)">${fmtKRW(totalCost)}</div></div>`:'')+
    (a.memo?`<div class="settings-row"><div class="sd" style="margin:0">${esc(a.memo)}</div></div>`:'')+`</div>`;

  /* ② 보유 구간 */
  html+=`<div class="sec sg-sec">② 보유 구간<span class="cnt">${s.segments.length}</span><button class="sbtn" data-sgaddseg="1">+ 구간</button></div>`;
  if(!s.segments.length){
    html+=`<div class="empty" style="padding:26px 20px"><div class="em">🏢</div><h3>구간이 없어요</h3><p>임차·공실 기간을 추가하세요.</p></div>`;
  } else {
    const sorted=[...s.segments].sort((x,y)=>(y.start||'').localeCompare(x.start||''));
    html+=sorted.map(segCard).join('');
  }

  /* ③ 통장 */
  html+=`<div class="sec sg-sec">③ 통장 내역<button class="sbtn" data-sgaddtx="1">+ 내역</button></div>`;
  const {inc,exp}=ledgerTotals();
  html+=`<div class="sg-led3">
      <div><div class="k">누적 수입</div><div class="v" style="color:var(--green)">${fmtK(inc)}</div></div>
      <div><div class="k">누적 지출</div><div class="v" style="color:var(--red)">${fmtK(exp)}</div></div>
      <div><div class="k">잔액</div><div class="v">${fmtK(bal)}</div></div>
    </div>
    <button class="btn ghost" data-sgquickrent="1" style="width:100%;padding:12px;margin-bottom:10px;color:var(--green);border-color:var(--green)">＋ 이번달 임차료 입금</button>`;
  html+=txListHTML();

  html+=`<div style="text-align:center;color:var(--muted);font-size:11px;font-weight:600;margin:18px 0">상가 관리 · v0817.1</div>`;
  return html;
}

function segCard(seg){
  const lease=seg.type==='lease';
  const period=`${seg.start||'?'} ~ ${seg.end||'진행중'}`;
  let body='';
  if(lease){
    const rent=+seg.rent||0, vat=seg.vatSeparate!==false?Math.round(rent*0.1):0;
    body=`<div class="sg-kv">
      <div><span class="k">임차인</span><b>${esc(seg.tenant||'-')}</b></div>
      <div><span class="k">월세${vat?` (+VAT ${fmtK(vat)})`:''}</span><b>${fmtK(rent)}</b></div>
      <div><span class="k">보증금</span><b>${fmtK(+seg.deposit||0)}</b></div>
      <div><span class="k">관리비</span><b>${seg.mgmt?fmtK(+seg.mgmt):'-'}</b></div>
    </div>`;
    if(seg.contractKey) body+=`<div class="sg-attach">📎 ${esc(seg.contractName||'계약서')}<button class="sbtn" style="padding:4px 10px;font-size:11px" data-sgcontract="${seg.id}">보기</button></div>`;
  } else {
    body=`<div class="sg-kv"><div><span class="k">공실 월부담</span><b>${seg.ownerCost?fmtK(+seg.ownerCost):'-'}</b></div></div>`;
  }
  if(seg.memo) body+=`<div class="sg-memo">${esc(seg.memo)}</div>`;
  return `<div class="sg-seg">
    <div class="sg-seg-h"><span class="sg-tag ${lease?'lease':'vacant'}">${lease?'임차':'공실'}</span>
      <span class="sg-period">${period}</span>
      <button class="sbtn" style="margin-left:auto;padding:4px 10px;font-size:11px" data-sgeditseg="${seg.id}">수정</button></div>
    ${body}</div>`;
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

/* ============================================================
   5. 이벤트 바인딩
   ============================================================ */
function bindSangga(){
  const app=$q('#app'); if(!app) return;
  const on=(sel,fn)=>app.querySelectorAll(sel).forEach(el=>el.onclick=fn(el));
  on('[data-sgeditinfo]',()=>()=>openInfo());
  on('[data-sgaddseg]',()=>()=>openSeg(null));
  on('[data-sgeditseg]',el=>()=>openSeg(el.dataset.sgeditseg));
  on('[data-sgcontract]',el=>()=>viewContract(el.dataset.sgcontract));
  on('[data-sgaddtx]',()=>()=>openTx(null));
  on('[data-sgedittx]',el=>()=>openTx(el.dataset.sgedittx));
  on('[data-sgquickrent]',()=>()=>quickRent());
}

/* ============================================================
   6. 시트 (기존 window.sheet / window.close 사용)
   ============================================================ */
function openInfo(){
  const s=S(), a=s.acq||{}, info=s.info||{};
  window.sheet(`<h2>상가 정보 · 취득(증여)</h2>
    <div class="field"><label>별칭</label><input id="sg-nick" value="${esc(info.nickname||'')}"></div>
    <div class="field"><label>주소</label><input id="sg-addr" value="${esc(info.address||'')}"></div>
    <div class="row2"><div class="field"><label>취득일</label><input id="sg-acqd" type="date" value="${a.acqDate||''}"></div>
      <div class="field"><label>증여 신고가액(원)</label><input id="sg-decl" type="number" inputmode="numeric" value="${a.declared||''}"></div></div>
    <div class="row2"><div class="field"><label>증여세(원)</label><input id="sg-gift" type="number" inputmode="numeric" value="${a.giftTax||''}"></div>
      <div class="field"><label>취득세(원)</label><input id="sg-atax" type="number" inputmode="numeric" value="${a.acqTax||''}"></div></div>
    <div class="field"><label>기타 수수료·부대(원)</label><input id="sg-fee" type="number" inputmode="numeric" value="${a.fee||''}"></div>
    <div class="field"><label>메모</label><input id="sg-memo" value="${esc(a.memo||'')}"></div>
    <div class="sheet-actions"><button class="btn ghost" id="sg-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-save">저장</button></div>`);
  $q('#sg-cancel').onclick=window.close;
  $q('#sg-save').onclick=()=>{
    s.info.nickname=$q('#sg-nick').value.trim(); s.info.address=$q('#sg-addr').value.trim();
    s.acq={ acqDate:$q('#sg-acqd').value, declared:$q('#sg-decl').value, giftTax:$q('#sg-gift').value,
      acqTax:$q('#sg-atax').value, fee:$q('#sg-fee').value, memo:$q('#sg-memo').value.trim() };
    save(); window.close(); window.render(); toast('저장됨');
  };
}

function openSeg(id){
  const s=S();
  const seg = id ? s.segments.find(x=>x.id===id) : null;
  let type = seg? seg.type : 'lease';
  let vat = seg? (seg.vatSeparate!==false) : true;
  let pendingFile=null;
  window.sheet(`<h2>${seg?'보유 구간 수정':'보유 구간 추가'}</h2>
    <div class="seg-in" id="sg-type"><button data-t="lease" class="${type==='lease'?'on':''}">임차</button><button data-t="vacant" class="${type==='vacant'?'on':''}">공실(비임차)</button></div>
    <div class="row2" style="margin-top:12px"><div class="field"><label>시작일</label><input id="sg-s" type="date" value="${seg?seg.start||'':''}"></div>
      <div class="field"><label>종료일(진행중이면 비움)</label><input id="sg-e" type="date" value="${seg?seg.end||'':''}"></div></div>
    <div id="sg-lease" style="display:${type==='lease'?'block':'none'}">
      <div class="field"><label>임차인(상호/이름)</label><input id="sg-tenant" value="${seg?esc(seg.tenant||''):''}"></div>
      <div class="row2"><div class="field"><label>보증금(원)</label><input id="sg-dep" type="number" inputmode="numeric" value="${seg?seg.deposit||'':''}"></div>
        <div class="field"><label>월 임차료(공급가,원)</label><input id="sg-rent" type="number" inputmode="numeric" value="${seg?seg.rent||'':''}"></div></div>
      <div class="settings-row" style="padding:12px 0"><div><div class="sk">부가세 별도</div><div class="sd">월세 10% 추가 수취</div></div><div class="switch ${vat?'on':''}" id="sg-vat"><i></i></div></div>
      <div class="field"><label>월 관리비(임차인 부담)</label><input id="sg-mgmt" type="number" inputmode="numeric" value="${seg?seg.mgmt||'':''}"></div>
      <div class="field"><label>계약서 첨부(사진/PDF)</label><input id="sg-file" type="file" accept="image/*,application/pdf"><div class="fx-note" id="sg-fileh" style="margin-top:6px">${seg&&seg.contractName?('첨부됨: '+esc(seg.contractName)):''}</div></div>
    </div>
    <div id="sg-vacant" style="display:${type==='vacant'?'block':'none'}">
      <div class="field"><label>공실 시 월 소유주 부담(관리비 등, 원)</label><input id="sg-owner" type="number" inputmode="numeric" value="${seg?seg.ownerCost||'':''}"></div>
    </div>
    <div class="field"><label>메모</label><input id="sg-segmemo" value="${seg?esc(seg.memo||''):''}"></div>
    <div class="sheet-actions">${seg?'<button class="btn ghost" id="sg-del" style="color:var(--red);flex:0 0 auto">삭제</button>':''}<button class="btn ghost" id="sg-cancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-save">저장</button></div>`);

  $q('#sg-type').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    type=b.dataset.t;
    $q('#sg-type').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.t===type));
    $q('#sg-lease').style.display=type==='lease'?'block':'none';
    $q('#sg-vacant').style.display=type==='vacant'?'block':'none';
  });
  const vatEl=$q('#sg-vat'); if(vatEl) vatEl.onclick=()=>{ vat=!vat; vatEl.classList.toggle('on',vat); };
  const fileEl=$q('#sg-file'); if(fileEl) fileEl.onchange=e=>{ pendingFile=e.target.files[0]||null; $q('#sg-fileh').textContent=pendingFile?('선택됨: '+pendingFile.name):''; };
  $q('#sg-cancel').onclick=window.close;
  $q('#sg-save').onclick=async()=>{
    const data={ type, start:$q('#sg-s').value, end:$q('#sg-e').value, memo:$q('#sg-segmemo').value.trim() };
    if(type==='lease'){ Object.assign(data,{ tenant:$q('#sg-tenant').value.trim(), deposit:$q('#sg-dep').value,
      rent:$q('#sg-rent').value, vatSeparate:vat, mgmt:$q('#sg-mgmt').value }); }
    else { data.ownerCost=$q('#sg-owner').value; }
    let target;
    if(seg){ Object.assign(seg,data); target=seg; }
    else { data.id='sg'+Date.now().toString(36); s.segments.push(data); target=data; }
    if(pendingFile){ try{ const key='sgcontract_'+target.id; await idbPut(key,pendingFile); target.contractKey=key; target.contractName=pendingFile.name; }
      catch(err){ toast('계약서 저장 실패(이 환경 미지원일 수 있음)'); } }
    save(); window.close(); window.render(); toast('저장됨');
  };
  const delEl=$q('#sg-del'); if(delEl) delEl.onclick=async()=>{ if(!confirm('이 구간을 삭제할까요?')) return;
    if(seg.contractKey){ try{ await idbDel(seg.contractKey); }catch(e){} }
    s.segments=s.segments.filter(x=>x.id!==seg.id); save(); window.close(); window.render(); toast('삭제됨'); };
}

function openTx(id){
  const s=S();
  const t = id ? s.ledger.txns.find(x=>x.id===id) : null;
  const amt = t? Math.abs(+t.amount||0) : '';
  const dir = t? ((+t.amount||0)>=0?'in':'out') : 'in';
  const kinds=['임차료','부가세','관리비','세금','수수료','보증금','기타'];
  window.sheet(`<h2>${t?'통장 내역 수정':'통장 내역 추가'}</h2>
    <div class="row2"><div class="field"><label>날짜</label><input id="sg-tdate" type="date" value="${t?(t.date||todayISO()):todayISO()}"></div>
      <div class="field"><label>유형</label><select id="sg-tdir"><option value="in"${dir==='in'?' selected':''}>입금(+)</option><option value="out"${dir==='out'?' selected':''}>출금(−)</option></select></div></div>
    <div class="field"><label>항목</label><select id="sg-tkind">${kinds.map(k=>`<option${t&&t.kind===k?' selected':''}>${k}</option>`).join('')}</select></div>
    <div class="field"><label>금액(원)</label><input id="sg-tamt" type="number" inputmode="numeric" value="${amt}"></div>
    <div class="field"><label>메모</label><input id="sg-tmemo" value="${t?esc(t.memo||''):''}"></div>
    <div class="sheet-actions">${t?'<button class="btn ghost" id="sg-tdel" style="color:var(--red);flex:0 0 auto">삭제</button>':''}<button class="btn ghost" id="sg-tcancel" style="flex:0 0 auto">취소</button><button class="btn" id="sg-tsave">저장</button></div>`);
  $q('#sg-tcancel').onclick=window.close;
  $q('#sg-tsave').onclick=()=>{
    const v=Math.abs(parseFloat($q('#sg-tamt').value)||0); if(!v) return toast('금액을 입력하세요');
    const signed=$q('#sg-tdir').value==='in'?v:-v;
    const data={ date:$q('#sg-tdate').value||todayISO(), kind:$q('#sg-tkind').value, amount:signed, memo:$q('#sg-tmemo').value.trim() };
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

function viewContract(id){
  const s=S(); const seg=s.segments.find(x=>x.id===id); if(!seg||!seg.contractKey) return;
  idbGet(seg.contractKey).then(blob=>{
    if(!blob){ toast('파일을 찾을 수 없어요'); return; }
    const url=URL.createObjectURL(blob); window.open(url,'_blank'); setTimeout(()=>URL.revokeObjectURL(url),60000);
  }).catch(()=>toast('열기 실패'));
}

/* ============================================================
   7. 앱에 부착 (index.html 수정 없이 · estate.js와 동일 방식)
   ============================================================ */
function attach(){
  injectCSS();

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

window.SanggaMgr={S,ledgerBalance,activeLease,currentStatus};
})();
