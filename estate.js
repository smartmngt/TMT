/* =============================================================================
   부동산 보유세 모듈  estate.js   v0807.001
   -----------------------------------------------------------------------------
   index.html은 딱 한 줄만 추가:
        <script src="estate.js"></script>      ← 기존 </script> 다음, </body> 앞
   나머지는 이 파일이 알아서 붙는다 (탭 버튼·화면·스타일 자동 주입).

   - 데이터는 기존 db 안(db.estate)에 저장 → 백업 내보내기/불러오기에 자동 포함
   - 주소검색/공시가는 같은 서버의 /addr, /gongsiga 사용 (app.py v0806.001)
   - 세율·공제는 EST.cfg에 데이터로 분리 → 국회 확정 시 여기만 수정
   ============================================================================= */
(function(){
"use strict";

/* ---------- 기존 앱 함수 참조 ---------- */
const $q = s=>document.querySelector(s);
/* index.html의 db / uid / esc / tab 은 let·const 선언이라 window에 없다.
   같은 페이지의 다음 <script>에서는 '이름 그대로' 접근된다. */

/* ============================================================
   1. 세금 계산 엔진
   ============================================================ */
const 억=1e8, 만=1e4;
function prog(base,br){ if(base<=0) return 0; let t=0,p=0;
  for(const b of br){ const c=Math.min(base,b.upTo); if(c>p) t+=(c-p)*b.rate; p=c; if(base<=b.upTo) break; } return t; }

const EST = { cfg:{
  jaeStd:[{upTo:.6*억,rate:.001},{upTo:1.5*억,rate:.0015},{upTo:3*억,rate:.0025},{upTo:Infinity,rate:.004}],
  jaeSpc:[{upTo:.6*억,rate:.0005},{upTo:1.5*억,rate:.001},{upTo:3*억,rate:.002},{upTo:Infinity,rate:.0035}],
  도시분:.0014, 교육세:.20, 농특:.20,
  jong:{
    cur_1_2:[{upTo:3*억,rate:.005},{upTo:6*억,rate:.007},{upTo:12*억,rate:.010},{upTo:25*억,rate:.013},{upTo:50*억,rate:.015},{upTo:94*억,rate:.020},{upTo:Infinity,rate:.027}],
    cur_3  :[{upTo:3*억,rate:.005},{upTo:6*억,rate:.007},{upTo:12*억,rate:.010},{upTo:25*억,rate:.020},{upTo:50*억,rate:.030},{upTo:94*억,rate:.040},{upTo:Infinity,rate:.050}],
    y27_1_2:[{upTo:3*억,rate:.005},{upTo:6*억,rate:.007},{upTo:12*억,rate:.013},{upTo:25*억,rate:.015},{upTo:50*억,rate:.015},{upTo:94*억,rate:.020},{upTo:Infinity,rate:.027}],
    y27_3  :[{upTo:3*억,rate:.005},{upTo:6*억,rate:.007},{upTo:12*억,rate:.013},{upTo:25*억,rate:.020},{upTo:50*억,rate:.030},{upTo:94*억,rate:.040},{upTo:Infinity,rate:.050}],
    y28    :[{upTo:3*억,rate:.005},{upTo:6*억,rate:.007},{upTo:12*억,rate:.013},{upTo:25*억,rate:.020},{upTo:50*억,rate:.030},{upTo:94*억,rate:.040},{upTo:Infinity,rate:.050}]
  },
  ded:{ cur:{live:12*억,nonlive:12*억,multi:9*억}, re:{live:14*억,nonlive:9*억,multi:4*억} },
  fair:{2026:{live:.60,nonlive:.60,multi:.60},2027:{live:.70,nonlive:.70,multi:.70},2028:{live:.70,nonlive:.70,multi:.80}},
  fairJae:{one:.45, other:.60},
  ageCr:[[70,.40],[65,.30],[60,.20]], holdCr:[[15,.50],[10,.40],[5,.20]], cap:.80,
  burden:{cur:1.5, re:2.0}
}};
const fy = y=> y<=2026?2026:(y<=2027?2027:2028);
const era= y=> y<=2026?'cur':'re';

/* 재산세 (물건별) */
function jaesan(pub, is1){
  const C=EST.cfg, fair=is1?C.fairJae.one:C.fairJae.other, base=pub*fair;
  const bon=prog(base, (is1&&pub<=9*억)?C.jaeSpc:C.jaeStd);
  return { base, bon, total: bon + base*C.도시분 + bon*C.교육세 };
}
/* 종부세 (인별 합산) */
function jongbu(sumPub, pCount, hCount, isPrimary, year, o){
  const C=EST.cfg; o=o||{};
  const e=era(year), is1=(hCount===1);
  const type = is1 ? (isPrimary?'live':'nonlive') : 'multi';
  const ded=C.ded[e][type], fair=C.fair[fy(year)][type];
  const tb=Math.max(0, sumPub-ded)*fair;
  if(tb<=0) return {type,ded,fair,tb:0,gross:0,jaeCr:0,ageCr:0,ageRate:0,decided:0,nong:0,total:0};
  const k = pCount>=3 ? '_3' : '_1_2';
  const br = year<=2026 ? C.jong['cur'+k] : year<=2027 ? C.jong['y27'+k] : C.jong.y28;
  const gross=prog(tb,br), jaeCr=prog(tb*.60, C.jaeStd);
  let after=Math.max(0,gross-jaeCr), ageRate=0;
  if(is1 && type==='live'){
    let a=0,h=0;
    // 핵심: 현행은 보유기간, 2028년 개편 후는 거주기간 기준
    const span = year>=2028 ? (o.liveYears||0) : (o.holdYears||0);
    for(const[t,r] of C.ageCr) if((o.age||0)>=t){ a=r; break; }
    for(const[t,r] of C.holdCr) if(span>=t){ h=r; break; }
    ageRate=Math.min(C.cap, a+h);
  }
  const ageCr=after*ageRate;
  let decided=after-ageCr;
  if(o.prevTax>0){ const cap=C.burden[e]*o.prevTax, mx=Math.max(0,cap-(o.jaeThisYear||0)); if(decided>mx) decided=mx; }
  return {type,ded,fair,tb,gross,jaeCr,ageCr,ageRate,decided,nong:decided*C.농특,total:decided*(1+C.농특)};
}

/* ---------- 조정대상지역 자동 판정 ----------
   2023.01.05 ~ 2025.10.15 : 서울 강남·서초·송파·용산 4곳
   2025.10.16 ~            : 서울 25개 전 자치구 + 경기 12개
   (과세기준일 6.1 기준으로 그 해 지정 여부를 판단)                       */
const SEOUL25=['강남구','서초구','송파구','용산구','노원구','도봉구','강북구','성북구',
  '은평구','마포구','서대문구','종로구','중구','성동구','광진구','동대문구','중랑구',
  '강동구','양천구','강서구','구로구','금천구','영등포구','동작구','관악구'];
const GG12=['과천시','광명시','의왕시','하남시','성남시 분당구','성남시 수정구','성남시 중원구',
  '수원시 영통구','수원시 장안구','수원시 팔달구','안양시 동안구','용인시 수지구'];
const ADJ_OLD=['강남구','서초구','송파구','용산구'];

/* 주소 문자열에서 시군구 추출 */
function sigungu(addr){
  const a=(addr||'').replace(/\s+/g,' ').trim();
  if(!a) return '';
  // 경기 2단계(성남시 분당구 등) 우선 매칭
  for(const g of GG12){ const [si,gu]=g.split(' ');
    if(gu){ if(a.includes(si)&&a.includes(gu)) return g; }
    else if(a.includes(si)) return g; }
  const m=a.match(/([가-힣]+구)/);
  if(m && a.includes('서울')) return m[1];
  const m2=a.match(/([가-힣]+시)/);
  return m2?m2[1]:(m?m[1]:'');
}
/* 해당 연도(6.1 기준) 조정대상지역인가 */
function isAdj(addr, year){
  const sg=sigungu(addr); if(!sg) return null;   // 판정불가
  if(year>=2026) return SEOUL25.includes(sg)||GG12.includes(sg);
  return ADJ_OLD.includes(sg);
}

/* ---------- 만 나이 (과세기준일 6.1 기준) ---------- */
function ageAt(m, year){
  if(!m.birth) return m.age||0;
  const b=m.birth.split('-').map(Number);
  if(!b[0]) return m.age||0;
  let age=year-b[0];
  const bm=b[1]||1, bd=b[2]||1;
  if(bm>6 || (bm===6 && bd>1)) age--;   // 6월 1일 기준 생일 전이면 -1
  return Math.max(0,age);
}

/* ---------- 기간 계산 (과세기준일 6.1) ---------- */
const ym = s=>{ if(!s) return null; const a=s.split('-').map(Number); return a[0]*12+(a[1]||1); };
const heldY = (p,y)=>{ const a=ym(p.acquire); return a==null?0:Math.max(0,Math.floor((y*12+6-a)/12)); };
const livedY= (p,y)=>{ if(!p.primary) return 0; const s=ym(p.liveStart)||ym(p.acquire); return s==null?0:Math.max(0,Math.floor((y*12+6-s)/12)); };

/* ============================================================
   2. 상태
   ============================================================ */
const REC_YEARS=[2024,2025,2026];
let seg='hold', taxYear=2026, whatOn=false, growth=3;
let addrPid=null, addrPick=null, addrResults=[];

function E(){   // db.estate 보장 (db는 index.html의 전역 let)
  if(!db.estate || !db.estate.households || !db.estate.households.length){
    const m=uid();
    db.estate={ active:'h1', households:[{
      id:'h1', name:'본인 세대', members:[{id:m,name:'본인',age:50}],
      properties:[], records:{}
    }]};
  }
  return db.estate;
}
function HH(){ const e=E(); return e.households.find(h=>h.id===e.active)||e.households[0]; }
/* ============================================================
   3. 계산 (세대 단위)
   ============================================================ */
function priceAt(p,year){
  if(p.prices && p.prices[year]) return p.prices[year];
  const known=REC_YEARS.filter(y=>p.prices&&p.prices[y]>0);
  if(!known.length) return 0;
  const by=known[known.length-1], base=p.prices[by];
  return year>by ? base*Math.pow(1+growth/100, year-by) : base;
}
function compute(hh, year, override){
  const list = override || hh.properties;
  const hc=list.length, is1=(hc===1);
  let jaeTotal=0; const jaeBy={};
  list.forEach(p=>{ const j=jaesan(priceAt(p,year), is1); jaeBy[p.id]=j.total; jaeTotal+=j.total; });

  const P={}; hh.members.forEach(m=>P[m.id]={m,sum:0,c:0,pri:false,jae:0,hY:0,lY:0});
  list.forEach(p=>{
    const pub=priceAt(p,year), ow=p.owners||{}, hY=heldY(p,year), lY=livedY(p,year);
    Object.keys(ow).forEach(mid=>{
      const sh=ow[mid]||0; if(sh<=0) return;
      const o=P[mid]; if(!o) return;
      o.sum+=pub*(sh/100); o.c++; o.jae+=(jaeBy[p.id]||0)*(sh/100);
      if(p.primary){ o.pri=true; o.lY=Math.max(o.lY,lY); }
      o.hY=Math.max(o.hY,hY);
    });
  });
  let jongTotal=0; const per=[];
  Object.values(P).forEach(o=>{
    if(!o.c){ per.push({name:o.m.name,jae:0,jong:0,jb:null}); return; }
    const jb=jongbu(o.sum,o.c,hc,o.pri,year,{age:ageAt(o.m,year),holdYears:o.hY,liveYears:o.lY,jaeThisYear:o.jae});
    jongTotal+=jb.total;
    per.push({name:o.m.name,jae:o.jae,jong:jb.total,jb,sumPub:o.sum,count:o.c,hY:o.hY,lY:o.lY});
  });
  return {jaeTotal,jongTotal,total:jaeTotal+jongTotal,per,is1,hc};
}
/* 현행(2026) 규칙 고정 + 공시가만 성장 */
function frozen(hh,year){
  const list=hh.properties, hc=list.length, is1=(hc===1);
  let jae=0; const jaeBy={};
  list.forEach(p=>{ const j=jaesan(priceAt(p,year),is1); jaeBy[p.id]=j.total; jae+=j.total; });
  const P={}; hh.members.forEach(m=>P[m.id]={m,sum:0,c:0,pri:false,jae:0,hY:0,lY:0});
  list.forEach(p=>{
    const pub=priceAt(p,year), ow=p.owners||{}, hY=heldY(p,year), lY=livedY(p,year);
    Object.keys(ow).forEach(mid=>{ const sh=ow[mid]||0; if(sh<=0)return; const o=P[mid]; if(!o)return;
      o.sum+=pub*(sh/100); o.c++; o.jae+=(jaeBy[p.id]||0)*(sh/100);
      if(p.primary){o.pri=true;o.lY=Math.max(o.lY,lY);} o.hY=Math.max(o.hY,hY); });
  });
  let jong=0;
  Object.values(P).forEach(o=>{ if(!o.c) return;
    jong+=jongbu(o.sum,o.c,hc,o.pri,2026,{age:ageAt(o.m,2026),holdYears:o.hY,liveYears:o.lY,jaeThisYear:o.jae}).total; });
  return jae+jong;
}

/* ============================================================
   4. 스타일 (기존 디자인 토큰 재사용)
   ============================================================ */
const CSS=`
.es-seg{display:flex;gap:8px;margin:12px 0 14px}
.es-seg button{flex:1;padding:11px 4px;border-radius:12px;border:1.5px solid var(--line);background:var(--card);
  font-weight:800;color:var(--muted);font-size:13.5px}
.es-seg button.on{border-color:var(--green);background:var(--green-t);color:var(--green)}
.es-prop{background:var(--card);border-radius:18px;padding:16px;box-shadow:var(--shadow);margin-bottom:11px}
.es-prop .ph{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.es-prop .ph .nm{flex:1;min-width:0;font-weight:800;font-size:15.5px;border:none;background:none;
  color:var(--ink);border-bottom:1px dashed var(--line);padding:2px 0;outline:none}
.es-prop .ph .nm:focus{border-bottom-color:var(--green)}
.es-prop .del{color:var(--muted);font-size:12px;font-weight:700;flex:none}
.es-prop .del:active{color:var(--red)}
.es-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:9px}
.es-addr{flex:1;min-width:0;padding:9px 11px;border-radius:10px;border:1.5px solid var(--line);
  background:var(--bg);color:var(--ink);font-weight:700;font-size:13px;outline:none}
.es-name{width:100%;min-width:0;padding:9px 11px;border-radius:10px;border:1.5px solid var(--line);
  background:var(--bg);color:var(--ink);font-weight:800;font-size:14px;outline:none}
.es-name:focus,.es-addr:focus{border-color:var(--green)}
.es-mini{padding:9px 12px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);
  color:var(--ink2);font-weight:800;font-size:12.5px;flex:none}
.es-mini.on{border-color:var(--green);background:var(--green-t);color:var(--green)}
.es-chk{display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:700;color:var(--ink2)}
.es-chk input{accent-color:var(--green);width:16px;height:16px}
.es-num{width:56px;padding:6px 8px;border-radius:9px;border:1.5px solid var(--line);background:var(--bg);
  color:var(--ink);text-align:right;font-weight:800;font-size:12.5px;outline:none}
.es-num:focus{border-color:var(--green)}
.es-date{padding:7px 9px;border-radius:9px;border:1.5px solid var(--line);background:var(--bg);
  color:var(--ink);font-weight:700;font-size:12.5px;outline:none}
.es-k{font-size:11px;color:var(--muted);font-weight:700}
.es-note{font-size:11.5px;color:var(--muted);font-weight:600;line-height:1.6;margin-top:8px}
.es-pill{display:inline-block;font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:99px;margin-left:6px}
.es-pill.one{background:var(--green-t);color:var(--green)}
.es-pill.multi{background:var(--red-t);color:var(--red)}
.es-yr{display:flex;gap:7px;overflow-x:auto;padding:2px;margin-bottom:12px}
.es-yr::-webkit-scrollbar{display:none}
.es-yr button{flex:none;padding:8px 15px;border-radius:99px;background:var(--card);box-shadow:var(--shadow);
  font-size:13px;font-weight:700;color:var(--ink2)}
.es-yr button.on{background:var(--navy);color:#fff}
.es-tb{width:100%;border-collapse:collapse;font-size:13.5px}
.es-tb th,.es-tb td{padding:10px 6px;text-align:right;border-bottom:1px solid var(--line)}
.es-tb th:first-child,.es-tb td:first-child{text-align:left}
.es-tb th{font-size:11px;color:var(--muted);font-weight:700}
.es-tb tr.sum td{font-weight:800;border-bottom:none;border-top:1.5px solid var(--line)}
.es-chart{width:100%;height:auto;display:block;margin:4px 0}
.es-2{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-top:12px}
.es-w{background:var(--card);border-radius:16px;padding:15px;box-shadow:var(--shadow)}
.es-w.after{background:var(--red-t)}
.es-w .t{font-size:11.5px;color:var(--muted);font-weight:700}
.es-w .b{font-size:22px;font-weight:800;letter-spacing:-.02em;margin-top:5px}
.es-w .l{font-size:11.5px;color:var(--muted);font-weight:600;margin-top:4px}
.es-hint2{font-size:12px;color:var(--muted);font-weight:600;padding:10px 2px;line-height:1.7}
`;
function injectCSS(){ const s=document.createElement('style'); s.textContent=CSS; document.head.appendChild(s); }

/* ============================================================
   5. 화면
   ============================================================ */
const 만원=n=>'₩'+Math.round(n/만).toLocaleString('ko-KR')+'만';
const 억원=n=>Math.abs(n)>=억 ? (n/억).toLocaleString('ko',{maximumFractionDigits:2})+'억' : 만원(n);

function hhChips(){
  const e=E();
  return `<div class="acct-scroll">`+
    e.households.map(h=>`<button class="achip ${h.id===e.active?'on':''}" data-eshh="${h.id}">${esc(h.name)}</button>`).join('')+
    `<button class="achip" data-eshh="__add">+ 세대</button></div>`;
}
function viewEstate(){
  const hh=HH(), n=hh.properties.length;
  const head=`${hhChips()}
    <div style="display:flex;align-items:center;gap:6px;margin:10px 2px 0;font-size:12.5px;color:var(--muted);font-weight:700">
      주택 <b style="color:var(--ink)">${n}채</b> · 구성원 <b style="color:var(--ink)">${hh.members.length}명</b>
      <span class="es-pill ${n===1?'one':'multi'}">${n===1?'1세대1주택':n===0?'주택없음':'다주택'}</span>
      <button class="es-mini" style="margin-left:auto;padding:6px 10px" data-eshhedit="1">세대 설정</button>
    </div>
    <div class="es-seg">
      <button class="${seg==='hold'?'on':''}" data-esseg="hold">현황</button>
      <button class="${seg==='tax'?'on':''}" data-esseg="tax">세금</button>
      <button class="${seg==='sim'?'on':''}" data-esseg="sim">예측</button>
    </div>`;
  return head + (seg==='hold'?viewHold():seg==='tax'?viewTax():viewSim());
}

/* ---- 현황 ---- */
function viewHold(){
  const hh=HH();
  const mem=hh.members.map(m=>`
    <div class="settings-row" style="gap:10px">
      <div style="flex:1;min-width:0">
        <input class="es-name" value="${esc(m.name)}" data-esmn="${m.id}">
        <div class="es-line" style="margin:7px 0 0">
          <div style="flex:1;min-width:0">
            <div class="es-k">생년월일</div>
            <input class="es-date" style="width:100%" type="date" value="${m.birth||''}" data-esmb="${m.id}">
          </div>
          <div style="flex:none;text-align:right">
            <div class="es-k">만 나이(’26.6.1)</div>
            <div style="font-weight:800;font-size:15px;color:var(--green)">${ageAt(m,2026)}세</div>
          </div>
        </div>
        <div class="es-note" style="margin-top:5px">연령별 세액공제 60·65·70세↑ · 연도별 자동 반영</div>
      </div>
      ${hh.members.length>1?`<button class="del" data-esmd="${m.id}" style="color:var(--muted);font-size:12px;font-weight:700;align-self:flex-start">삭제</button>`:''}
    </div>`).join('');

  const props = hh.properties.length ? hh.properties.map(p=>{
    const own=hh.members.map(m=>{ const sh=(p.owners&&p.owners[m.id])||0;
      return `<label class="es-chk">${esc(m.name)}<input class="es-num" style="width:48px" type="number" placeholder="0"
        value="${sh||''}" data-esown="${p.id}|${m.id}">%</label>`;}).join('');
    return `<div class="es-prop">
      <div class="ph"><input class="nm" value="${esc(p.name)}" data-espn="${p.id}">
        <button class="del" data-espd="${p.id}">삭제</button></div>
      <div class="es-line">
        <input class="es-addr" placeholder="주소" value="${esc(p.address||'')}" data-espa="${p.id}">
        <button class="es-mini on" data-essearch="${p.id}">주소찾기</button>
      </div>
      ${p.pnu?`<div class="es-note" style="margin:-4px 0 8px">PNU ${p.pnu}${p.dong?` · ${esc(p.dong)}동`:''}${p.ho?` ${esc(p.ho)}호`:''}</div>`:''}
      <div class="es-line">${own}
        <label class="es-chk"><input type="checkbox" ${p.primary?'checked':''} data-espp="${p.id}">실거주</label>
      </div>
      <div class="es-line" style="margin-bottom:9px">
        <span class="es-k">조정대상지역</span>
        ${(()=>{const auto=isAdj(p.address,2026);
          if(p.adjOverride!=null) return `<b style="font-size:12.5px;color:${p.adjOverride?'var(--red)':'var(--muted)'}">${p.adjOverride?'해당':'미해당'}</b>
            <span class="es-k">(수동)</span><button class="es-mini" style="padding:4px 9px" data-esadjreset="${p.id}">자동으로</button>`;
          if(auto===null) return `<b style="font-size:12.5px;color:var(--muted)">주소 입력 시 자동 판정</b>
            <button class="es-mini" style="padding:4px 9px" data-esadj="${p.id}">직접 지정</button>`;
          return `<b style="font-size:12.5px;color:${auto?'var(--red)':'var(--muted)'}">${auto?'해당':'미해당'}</b>
            <span class="es-k">${esc(sigungu(p.address))} · 자동</span>
            <button class="es-mini" style="padding:4px 9px" data-esadj="${p.id}">변경</button>`;})()}
      </div>
      <div class="es-line">
        <div><div class="es-k">취득일</div><input class="es-date" type="month" value="${p.acquire||''}" data-espq="${p.id}"></div>
        <div><div class="es-k">거주 개시</div><input class="es-date" type="month" value="${p.liveStart||''}" data-espl="${p.id}"></div>
        <div style="align-self:flex-end;font-size:12px;font-weight:700;color:var(--ink2)">
          보유 <b style="color:var(--green)">${heldY(p,2026)}년</b> · 거주 <b style="color:var(--green)">${livedY(p,2026)}년</b></div>
      </div>
      <div class="es-line" style="margin-bottom:8px">
        <button class="es-mini on" style="flex:1;padding:11px" data-esrealty="1">🔍 공시가격 조회 (realtyprice.kr 열기)</button>
      </div>
      <div class="es-note" style="margin:-2px 0 9px">버튼 → 크롬에서 <b>공동주택 공시가격 열람</b> 선택 → 단지·동·호 조회 → 나온 금액을 아래 칸에 입력(억 단위)</div>
      <div class="es-line" style="margin-bottom:0">
        ${REC_YEARS.map(y=>`<div><div class="es-k">${y} 공시가</div>
          <input class="es-num" style="width:72px" type="number" step="0.1" placeholder="0"
            value="${((p.prices&&p.prices[y])||0)/억||''}" data-espr="${p.id}|${y}"> <span class="es-k">억</span></div>`).join('')}
      </div>
    </div>`;
  }).join('') : `<div class="empty" style="padding:30px 20px"><div class="em">🏠</div><h3>등록된 주택이 없어요</h3>
      <p>주소를 검색하면 공시가격을 자동으로 불러와요.</p></div>`;

  return `<div class="sec">세대 구성원</div><div class="setcard">${mem}
      <div class="settings-row"><div><div class="sk">구성원 추가</div><div class="sd">배우자 등 (인별 종부세 합산)</div></div>
        <button class="sbtn" data-esmadd="1" style="color:var(--green);border-color:var(--green)">+ 추가</button></div></div>
    <div class="sec">보유 주택<span class="cnt">${hh.properties.length}채</span></div>
    ${props}
    <button class="btn ghost" data-espadd="1" style="width:100%;padding:13px;margin-top:2px">+ 주택 추가</button>
    <div class="es-hint2">※ 2026.8.3 발표 개편안 기준(국회 통과 전) · 종부세 세액공제는 현행 <b>보유기간</b>,
      2028년 개편 후 <b>거주기간</b> 기준이라 취득일과 거주 개시일을 각각 넣어야 정확합니다.</div>`;
}

/* ---- 세금 ---- */
function viewTax(){
  const hh=HH();
  if(!hh.properties.length) return `<div class="empty" style="padding:36px 20px"><div class="em">📋</div>
    <h3>주택을 먼저 등록하세요</h3><p>현황 탭에서 주택과 공시가격을 입력하면<br>연도별 보유세가 계산돼요.</p></div>`;
  const r=compute(hh,taxYear), base=compute(hh,2026);
  const d=r.total-base.total;
  const upc=v=>v>=0?'var(--red)':'var(--green)';
  const years=[2024,2025,2026,2027,2028];

  const rec=hh.records[taxYear]||{}, paid=(rec.jaesan||0)+(rec.jongbu||0);
  const diff=r.total-paid, pc=paid>0?Math.abs(diff/paid*100):0;
  let verify;
  if(REC_YEARS.includes(taxYear)){
    const chip = paid===0 ? `<span class="chip gold">실납부 미입력</span>`
      : pc<=5 ? `<span class="chip green">오차 ${pc.toFixed(1)}% · 정확</span>`
      : pc<=15 ? `<span class="chip gold">오차 ${pc.toFixed(1)}%</span>`
      : `<span class="chip" style="background:var(--red-t);color:var(--red)">오차 ${pc.toFixed(1)}% · 확인필요</span>`;
    verify=`<div class="sec">실납부 검증 ${chip}</div>
      <div class="setcard">
        <div class="settings-row"><div><div class="sk">재산세 (실제 납부)</div><div class="sd">7월·9월 합산</div></div>
          <div style="white-space:nowrap"><input class="mini-in num" type="number" placeholder="0"
            value="${(rec.jaesan||0)/만||''}" data-esrec="${taxYear}|jaesan" style="width:78px"> 만</div></div>
        <div class="settings-row"><div><div class="sk">종부세 (실제 납부)</div><div class="sd">12월 고지</div></div>
          <div style="white-space:nowrap"><input class="mini-in num" type="number" placeholder="0"
            value="${(rec.jongbu||0)/만||''}" data-esrec="${taxYear}|jongbu" style="width:78px"> 만</div></div>
      </div>
      <div class="es-hint2">계산 ${만원(r.total)} vs 실납부 ${paid?만원(paid):'—'}${paid?` → 차이 ${diff>=0?'+':'−'}${만원(Math.abs(diff))}`:''}<br>
        오차 원인: 재산세 세부담상한(105~130%)·감면, 공시가 입력값, 분납. <b>5% 이내면 엔진 정상</b>입니다.</div>`;
  } else {
    verify=`<div class="es-hint2">${taxYear}년은 개편안을 적용한 <b>예측</b>이라 검증 대상이 아닙니다.</div>`;
  }

  const t=r.per.find(x=>x.jb&&x.jb.tb>0);
  const detail = t ? `<div class="sec">계산 근거</div><div class="setcard" style="padding:14px 16px">
      <div class="es-hint2" style="margin:0">
        <b>${esc(t.name)}</b> · 합산 공시가 ${억원(t.sumPub)}<br>
        기본공제 ${억원(t.jb.ded)} · 공정시장가액비율 ${(t.jb.fair*100).toFixed(0)}% → 과세표준 ${억원(t.jb.tb)}<br>
        산출 ${만원(t.jb.gross)} − 재산세공제 ${만원(t.jb.jaeCr)} − 세액공제 ${(t.jb.ageRate*100).toFixed(0)}% (${만원(t.jb.ageCr)})<br>
        = 결정세액 ${만원(t.jb.decided)} + 농특세 ${만원(t.jb.nong)}<br>
        <b style="color:var(--green)">기간공제 기준: ${taxYear>=2028?`거주 ${t.lY}년 (개편)`:`보유 ${t.hY}년 (현행)`}</b>
      </div></div>` : '';

  return `<div class="es-yr">${years.map(y=>`<button class="${y===taxYear?'on':''}" data-esyr="${y}">${y}${y>=2027?' 개편':''}</button>`).join('')}</div>
    <div class="sumcard"><div class="glow"></div>
      <div class="stitle">${taxYear}년 보유세 ${taxYear>=2027?'(개편안 적용)':''}</div>
      <div class="sumcols">
        <div class="sumcol"><div class="sk">🏠 재산세</div><div class="sv num">${만원(r.jaeTotal)}</div></div>
        <div class="sumcol r"><div class="sk">📋 종합부동산세</div><div class="sv num">${만원(r.jongTotal)}</div></div>
      </div>
      <div style="margin-top:16px;padding-top:13px;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:baseline">
        <span class="sk">연간 합계</span>
        <span class="num" style="font-size:24px;font-weight:800;color:#fff">${만원(r.total)}</span>
      </div>
      ${taxYear!==2026?`<div style="margin-top:8px;text-align:right;font-size:12.5px;font-weight:700;color:${d>=0?'#FF8B8B':'#3FE0A0'}">
        2026년 대비 ${d>=0?'+':'−'}${만원(Math.abs(d))} (${base.total?((d/base.total)*100).toFixed(0):0}%)</div>`:''}
    </div>
    <div class="sec">구성원별 내역</div>
    <div class="setcard" style="padding:6px 16px 12px">
      <table class="es-tb"><thead><tr><th>구성원</th><th>재산세</th><th>종부세</th><th>합계</th></tr></thead><tbody>
      ${r.per.map(p=>`<tr><td>${esc(p.name)}${p.jb?` <span class="es-k">${p.count}채</span>`:''}</td>
        <td class="num">${p.jae?만원(p.jae):'—'}</td><td class="num">${p.jong?만원(p.jong):'—'}</td>
        <td class="num">${만원(p.jae+p.jong)}</td></tr>`).join('')}
      <tr class="sum"><td>합계</td><td class="num">${만원(r.jaeTotal)}</td><td class="num">${만원(r.jongTotal)}</td>
        <td class="num">${만원(r.total)}</td></tr></tbody></table>
    </div>
    ${verify}${detail}`;
}

/* ---- 예측 ---- */
function viewSim(){
  const hh=HH();
  if(!hh.properties.length) return `<div class="empty" style="padding:36px 20px"><div class="em">📈</div>
    <h3>주택을 먼저 등록하세요</h3><p>공시가 상승률에 따른 보유세 추이를 보여줘요.</p></div>`;
  const years=[2026,2027,2028,2029,2030];
  const data=years.map(y=>({y,cur:frozen(hh,y),re:compute(hh,y).total}));
  const W=680,H=210,pad=46;
  const xs=data.map((d,i)=>pad+i*(W-pad*2)/(data.length-1));
  const mx=Math.max(...data.map(d=>Math.max(d.cur,d.re)),1);
  const Y=v=>H-pad-(v/mx)*(H-pad*2);
  const line=(k,c,dash)=>`<polyline points="${data.map((d,i)=>xs[i]+','+Y(d[k])).join(' ')}"
      fill="none" stroke="${c}" stroke-width="2.5" ${dash?'stroke-dasharray="5 4"':''}/>`+
    data.map((d,i)=>`<circle cx="${xs[i]}" cy="${Y(d[k])}" r="3.6" fill="${c}"/>`).join('');
  const grid=[0,.5,1].map(f=>{ const y=H-pad-f*(H-pad*2);
    return `<line x1="${pad}" y1="${y}" x2="${W-pad}" y2="${y}" stroke="var(--line)"/>
      <text x="${pad-7}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--muted)" font-weight="700">${Math.round(mx*f/만).toLocaleString()}만</text>`;}).join('');

  const before=compute(hh,2028);
  let after=before, wHtml='';
  if(whatOn){
    const wp=(E().wPub||15)*억, wo=E().wOwner||hh.members[0].id;
    after=compute(hh,2028, hh.properties.map(p=>({...p})).concat([{
      id:'__virt', name:'추가주택', owners:{[wo]:100}, primary:false, adjusted:true,
      acquire:(new Date().getFullYear()+1)+'-01', liveStart:'', prices:{2026:wp} }]));
  }
  const dd=after.total-before.total;
  wHtml=`<div class="setcard" style="padding:14px 16px">
      <div class="settings-row" style="border:none;padding:4px 0">
        <div><div class="sk">주택을 하나 더 산다면?</div><div class="sd">1세대1주택 특례 소멸 효과 확인</div></div>
        <div class="switch ${whatOn?'on':''}" data-eswtog="1"><i></i></div>
      </div>
      ${whatOn?`<div class="es-line" style="margin-top:10px">
        <div style="flex:1"><div class="es-k">취득자</div>
          <select class="es-addr" data-eswowner="1">${hh.members.map(m=>`<option value="${m.id}" ${(E().wOwner||hh.members[0].id)===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div><div class="es-k">공시가</div><input class="es-num" style="width:74px" type="number" step="0.5"
          value="${E().wPub||15}" data-eswpub="1"> <span class="es-k">억</span></div>
      </div>`:''}
      <div class="es-2">
        <div class="es-w"><div class="t">현재 ${before.hc}주택</div>
          <div class="b num" style="color:var(--ink)">${만원(before.total)}</div>
          <div class="l">${before.is1?'1세대1주택 특례 적용':'다주택'}</div></div>
        <div class="es-w ${whatOn?'after':''}"><div class="t">${whatOn?`취득 후 ${after.hc}주택`:'취득 시'}</div>
          <div class="b num" style="color:${whatOn?'var(--red)':'var(--muted)'}">${whatOn?만원(after.total):'—'}</div>
          <div class="l">${whatOn?(after.is1?'1세대1주택':'특례 소멸'):'스위치를 켜세요'}</div></div>
      </div>
      ${whatOn?`<div style="text-align:center;margin-top:12px;font-weight:800;font-size:14px;color:var(--red)">
        연간 ${dd>=0?'+':'−'}${만원(Math.abs(dd))} (${before.total?((dd/before.total)*100).toFixed(0):'∞'}% ${dd>=0?'증가':'감소'})</div>`:''}
      <div class="es-hint2">2주택이 되면 ① 1세대1주택 특례(공제 14억·세액공제) 소멸 ② 재산세 특례 상실(공정시장가액비율 45%→60%)
        ③ 종부세 인별 합산과세. 개편 최종(2028~) 기준.</div>
    </div>`;

  return `<div class="setcard" style="padding:4px 16px">
      <div class="settings-row"><div><div class="sk">공시가 연 상승률</div><div class="sd">2026년 공시가 기준 복리</div></div>
        <div style="white-space:nowrap"><input class="mini-in num" type="number" step="0.5" value="${growth}" data-esgrow="1" style="width:70px"> %</div></div>
    </div>
    <div class="sec">보유세 추이</div>
    <div class="setcard" style="padding:14px 12px">
      <div style="display:flex;gap:16px;font-size:12px;font-weight:700;color:var(--muted);margin:0 4px 6px">
        <span>┅ 현행 유지</span><span style="color:var(--green)">━ 개편 적용</span></div>
      <svg class="es-chart" viewBox="0 0 ${W} ${H}">${grid}
        ${data.map((d,i)=>`<text x="${xs[i]}" y="${H-pad+18}" text-anchor="middle" font-size="11" fill="var(--muted)" font-weight="700">${d.y}</text>`).join('')}
        ${line('cur','#8B93A0',true)}${line('re','#17A45C',false)}</svg>
      <table class="es-tb" style="margin-top:6px"><thead><tr><th>연도</th><th>현행유지</th><th>개편적용</th><th>차이</th></tr></thead><tbody>
      ${data.map(d=>{const df=d.re-d.cur;
        return `<tr><td>${d.y}</td><td class="num">${만원(d.cur)}</td><td class="num">${만원(d.re)}</td>
          <td class="num" style="color:${df>=0?'var(--red)':'var(--green)'}">${df>=0?'+':'−'}${만원(Math.abs(df))}</td></tr>`;}).join('')}
      </tbody></table>
    </div>
    <div class="sec">주택 추가 취득 시나리오</div>${wHtml}`;
}

/* ============================================================
   6. 이벤트 바인딩
   ============================================================ */
function bindEstate(){
  const app=$q('#app'); if(!app) return;
  const on=(sel,ev,fn)=>app.querySelectorAll(sel).forEach(el=>el[ev]=fn(el));
  const hh=HH(), e=E();

  on('[data-eshh]','onclick',el=>()=>{ const v=el.dataset.eshh;
    if(v==='__add'){ const n=prompt('세대 이름','부모님 세대'); if(!n) return;
      const m=uid(); const id=uid();
      e.households.push({id,name:n,members:[{id:m,name:'본인',age:60}],properties:[],records:{}});
      e.active=id; } else e.active=v;
    save(); window.render(); });

  on('[data-eshhedit]','onclick',()=>()=>openHHedit());
  on('[data-esseg]','onclick',el=>()=>{ seg=el.dataset.esseg; window.render(); });
  on('[data-esyr]','onclick',el=>()=>{ taxYear=+el.dataset.esyr; window.render(); });

  /* 구성원 */
  on('[data-esmn]','onchange',el=>()=>{ const m=hh.members.find(x=>x.id===el.dataset.esmn); if(m){m.name=el.value;save();window.render();} });
  on('[data-esma]','onchange',el=>()=>{ const m=hh.members.find(x=>x.id===el.dataset.esma); if(m){m.age=+el.value||0;save();window.render();} });
  on('[data-esmb]','onchange',el=>()=>{ const m=hh.members.find(x=>x.id===el.dataset.esmb);
    if(m){ m.birth=el.value; m.age=ageAt(m,2026); save(); window.render(); } });
  on('[data-esmd]','onclick',el=>()=>{ const id=el.dataset.esmd;
    if(!confirm('이 구성원을 삭제할까요?')) return;
    hh.members=hh.members.filter(x=>x.id!==id);
    hh.properties.forEach(p=>{ if(p.owners&&p.owners[id]){ delete p.owners[id];
      if(!Object.keys(p.owners).length) p.owners[hh.members[0].id]=100; }});
    save(); window.render(); });
  on('[data-esmadd]','onclick',()=>()=>{ hh.members.push({id:uid(),name:'배우자',age:50,birth:''}); save(); window.render(); });

  /* 주택 */
  on('[data-espadd]','onclick',()=>()=>{
    hh.properties.push({id:uid(),name:'새 주택',address:'',owners:{[hh.members[0].id]:100},
      primary:hh.properties.length===0,acquire:'',liveStart:'',prices:{}});
    save(); window.render(); });
  const P=id=>hh.properties.find(p=>p.id===id);
  on('[data-espn]','onchange',el=>()=>{ P(el.dataset.espn).name=el.value; save(); });
  on('[data-espa]','onchange',el=>()=>{ P(el.dataset.espa).address=el.value; save(); });
  on('[data-espd]','onclick',el=>()=>{ if(!confirm('이 주택을 삭제할까요?'))return;
    hh.properties=hh.properties.filter(p=>p.id!==el.dataset.espd); save(); window.render(); });
  on('[data-espp]','onchange',el=>()=>{ P(el.dataset.espp).primary=el.checked; save(); window.render(); });
  on('[data-esadj]','onclick',el=>()=>{ const p=P(el.dataset.esadj);
    const cur=(p.adjOverride!=null)?p.adjOverride:isAdj(p.address,2026);
    p.adjOverride=!cur; save(); window.render(); });
  on('[data-esadjreset]','onclick',el=>()=>{ const p=P(el.dataset.esadjreset);
    delete p.adjOverride; save(); window.render(); });
  on('[data-espq]','onchange',el=>()=>{ P(el.dataset.espq).acquire=el.value; save(); window.render(); });
  on('[data-espl]','onchange',el=>()=>{ P(el.dataset.espl).liveStart=el.value; save(); window.render(); });
  on('[data-esown]','onchange',el=>()=>{ const [pid,mid]=el.dataset.esown.split('|'); const p=P(pid);
    p.owners=p.owners||{}; const sh=parseFloat(el.value)||0;
    if(sh<=0) delete p.owners[mid]; else p.owners[mid]=sh; save(); window.render(); });
  on('[data-espr]','onchange',el=>()=>{ const [pid,y]=el.dataset.espr.split('|'); const p=P(pid);
    p.prices=p.prices||{}; p.prices[y]=(parseFloat(el.value)||0)*억; save(); window.render(); });
  on('[data-essearch]','onclick',el=>()=>openAddr(el.dataset.essearch));
  on('[data-esfetch]','onclick',el=>()=>fetchPrice(el.dataset.esfetch));
  on('[data-esrealty]','onclick',()=>()=>openRealty());

  /* 검증 · 예측 */
  on('[data-esrec]','onchange',el=>()=>{ const [y,k]=el.dataset.esrec.split('|');
    hh.records[y]=hh.records[y]||{}; hh.records[y][k]=(parseFloat(el.value)||0)*만; save(); window.render(); });
  on('[data-esgrow]','onchange',el=>()=>{ growth=parseFloat(el.value)||0; window.render(); });
  on('[data-eswtog]','onclick',()=>()=>{ whatOn=!whatOn; window.render(); });
  on('[data-eswpub]','onchange',el=>()=>{ e.wPub=parseFloat(el.value)||15; save(); window.render(); });
  on('[data-eswowner]','onchange',el=>()=>{ e.wOwner=el.value; save(); window.render(); });
}

/* 세대 설정 시트 */
function openHHedit(){
  const e=E(), hh=HH();
  window.sheet(`<h2>세대 설정</h2><div class="hint">세대 이름을 바꾸거나 삭제할 수 있어요.</div>
    <div class="field"><label>세대 이름</label><input id="es-hn" value="${esc(hh.name)}"></div>
    <div class="sheet-actions">
      ${e.households.length>1?'<button class="btn ghost" id="es-hd" style="color:var(--red)">삭제</button>':''}
      <button class="btn" id="es-hs">저장</button></div>`);
  $q('#es-hs').onclick=()=>{ const v=$q('#es-hn').value.trim(); if(!v) return toast('이름을 입력하세요');
    hh.name=v; save(); window.close(); window.render(); toast('저장됨'); };
  const del=$q('#es-hd');
  if(del) del.onclick=()=>{ if(!confirm(`'${hh.name}' 세대를 삭제할까요?\n주택·기록도 함께 삭제됩니다.`)) return;
    e.households=e.households.filter(h=>h.id!==hh.id); e.active=e.households[0].id;
    save(); window.close(); window.render(); toast('삭제됨'); };
}

/* ============================================================
   7. 주소검색 / 공시가 (같은 서버 /addr, /gongsiga)
   ============================================================ */
/* ============================================================
   주소 검색 — 카카오(다음) 우편번호 서비스
   · API 키 불필요, 클라이언트에서 바로 동작
   · bcode(법정동코드 10자리)를 주므로 PNU 조립이 정확함
   · apartment==='Y' 이면 공동주택 → 동/호 입력 유도
   ============================================================ */
const DAUM_SDK='https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
let daumLoading=null;
function loadDaum(){
  if(window.daum && window.daum.Postcode) return Promise.resolve();
  if(daumLoading) return daumLoading;
  daumLoading=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=DAUM_SDK; s.async=true;
    s.onload=()=>res();
    s.onerror=()=>rej(new Error('주소 서비스 로드 실패 (네트워크 확인)'));
    document.head.appendChild(s);
  });
  return daumLoading;
}

function openAddr(pid){
  addrPid=pid;
  window.sheet(`<h2>주소 검색</h2>
    <div class="hint">도로명·지번·건물명으로 검색하세요. 선택하면 공시가격을 자동으로 불러와요.</div>
    <div id="es-daum" style="width:100%;height:60vh;min-height:380px;border:1.5px solid var(--line);
      border-radius:12px;overflow:hidden;background:#fff"></div>
    <div class="es-hint2" id="es-daumsts">주소 검색창을 불러오는 중…</div>`);
  loadDaum().then(()=>{
    const box=$q('#es-daum'); if(!box) return;
    const sts=$q('#es-daumsts'); if(sts) sts.textContent='';
    new window.daum.Postcode({
      oncomplete: onDaumPick,
      onresize: sz=>{ box.style.height=Math.max(380,sz.height)+'px'; },
      width:'100%', height:'100%'
    }).embed(box, {autoClose:false});
  }).catch(err=>{
    const sts=$q('#es-daumsts');
    if(sts) sts.innerHTML=`<b style="color:var(--red)">${esc(err.message)}</b><br>주소를 직접 입력해 주세요.`;
  });
}

/* 카카오 우편번호 결과 처리 */
function onDaumPick(d){
  try{
    const p=HH().properties.find(x=>x.id===addrPid);
    if(!p){ toast('대상 주택을 찾지 못했어요'); return; }
    const road=d.roadAddress||d.address||'';
    const jibun=d.jibunAddress||d.autoJibunAddress||'';
    p.address = road || jibun;
    p.jibun   = jibun;
    if(d.buildingName && (p.name==='새 주택'||!p.name)) p.name=d.buildingName;
    p.pnu   = pnuFromDaum(d);
    p.isApt = (d.apartment==='Y');
    save(); window.close(); window.render();
    if(!p.pnu){ toast('주소 저장됨 · PNU 조립 실패로 공시가는 직접 입력하세요'); return; }
    if(p.isApt) askDongHo(p.id); else fetchPrice(p.id);
  }catch(err){ console.error('[estate] onDaumPick',err); toast('주소 처리 오류: '+err.message); }
}

/* 지번주소에서 산여부·본번·부번 추출  예) "서울 서초구 반포동 산 25-1" */
function parseJibun(jibun){
  const m=String(jibun||'').match(/(산)?\s*(\d+)(?:-(\d+))?\s*$/);
  if(!m) return null;
  return { san: m[1]?'1':'0', bon: m[2]||'0', bu: m[3]||'0' };
}
/* 카카오 결과 → PNU 19자리 (bcode = 법정동코드 10자리) */
function pnuFromDaum(d){
  const code=(d.bcode||'').padEnd(10,'0').slice(0,10);
  if(!/^\d{10}$/.test(code)) return '';
  const j=parseJibun(d.jibunAddress||d.autoJibunAddress||'');
  if(!j) return '';
  return code + (j.san==='1'?'2':'1')
       + String(j.bon).padStart(4,'0') + String(j.bu).padStart(4,'0');
}

/* 공동주택 동·호 입력 */
function askDongHo(pid){
  const p=HH().properties.find(x=>x.id===pid); if(!p) return;
  window.sheet(`<h2>동·호 입력</h2><div class="hint">${esc(p.address||'')}<br>
      아파트는 동·호까지 넣어야 그 집의 공시가격을 정확히 가져와요.</div>
    <div class="row2">
      <div class="field"><label>동</label><input id="es-adong" inputmode="numeric" placeholder="101" value="${esc(p.dong||'')}"></div>
      <div class="field"><label>호</label><input id="es-aho" inputmode="numeric" placeholder="1203" value="${esc(p.ho||'')}"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" id="es-skip">건너뛰기</button>
      <button class="btn" id="es-dhok">공시가 조회</button></div>`);
  const ok=$q('#es-dhok'), skip=$q('#es-skip');
  if(ok) ok.onclick=()=>{
    const dv=$q('#es-adong'), hv=$q('#es-aho');
    p.dong=dv?dv.value.trim():''; p.ho=hv?hv.value.trim():'';
    save(); window.close(); window.render(); fetchPrice(pid);
  };
  if(skip) skip.onclick=()=>{ window.close(); fetchPrice(pid); };
}

/* PNU 19자리 = 법정동코드10 + 산여부(대지1/산2) + 본번4 + 부번4 */
function makePNU(it){
  const c=it.admCd||''; if(c.length<10) return '';
  return c.slice(0,10) + ((it.mtYn==='1')?'2':'1')
    + String(it.lnbrMnnm||0).padStart(4,'0') + String(it.lnbrSlno||0).padStart(4,'0');
}
/* realtyprice.kr(부동산공시가격 알리미) 열기 — 크롬(외부 브라우저)에서 공동주택 공시가격 열람 */
function openRealty(){
  const url='https://www.realtyprice.kr';
  try{
    const a=document.createElement('a');
    a.href=url; a.target='_blank'; a.rel='noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ try{ window.open(url,'_blank','noopener'); }catch(e2){ location.href=url; } }
  try{ toast('realtyprice.kr 여는 중 · 공동주택 공시가격 열람 선택'); }catch(e){}
}
async function fetchPrice(pid){
  const p=HH().properties.find(x=>x.id===pid);
  if(!p||!p.pnu) return toast('먼저 주소를 검색해 선택하세요');
  toast('공시가격 조회 중…');
  const got=[], errs=[];
  for(const y of REC_YEARS){
    const q='/gongsiga?pnu='+p.pnu+'&year='+y
      +(p.dong?'&dong='+encodeURIComponent(p.dong):'')
      +(p.ho?'&ho='+encodeURIComponent(p.ho):'');
    try{
      const base=(typeof backendBase==='function')?backendBase():'';
      const r=await fetch(base+q);
      let b=null; try{ b=await r.json(); }catch(e){}
      if(!r.ok){ errs.push((b&&b.error)?b.error:('HTTP '+r.status)); continue; }
      if(b&&b.error){ errs.push(b.error); continue; }
      if(b&&b.price>0){ p.prices=p.prices||{}; p.prices[y]=b.price;
        got.push(y+'년 '+(b.price/억).toFixed(2)+'억'); }
      else errs.push(y+'년: '+((b&&b.note)||'매칭 결과 없음'));
    }catch(e){ errs.push(e.message||String(e)); }
  }
  save(); window.render();
  if(got.length){ toast('공시가 '+got.length+'개 조회됨 · '+got[got.length-1]); return; }
  showPriceHelp(p, errs);
}

/* 조회 실패 시 원인과 다음 단계를 그대로 보여준다 */
function showPriceHelp(p, errs){
  const uniq=[...new Set(errs)].slice(0,4);
  const keyMissing=uniq.some(e=>/VWORLD_KEY/.test(e));
  window.sheet(`<h2>공시가격 조회 실패</h2>
    <div class="hint">${esc(p.address||'')}${p.dong?` · ${esc(p.dong)}동 ${esc(p.ho||'')}호`:''}</div>
    <div class="setcard" style="padding:14px 16px;margin-bottom:14px">
      <div class="es-k" style="margin-bottom:6px">서버 응답</div>
      ${uniq.map(e=>`<div style="font-size:12.5px;font-weight:700;color:var(--red);margin-bottom:4px;word-break:break-all">${esc(e)}</div>`).join('')}
      <div class="es-k" style="margin-top:8px;word-break:break-all">PNU ${esc(p.pnu||'-')}</div>
    </div>
    ${keyMissing?`<div class="es-hint2" style="margin-bottom:14px">
      Cloud Run 환경변수 <b>VWORLD_KEY</b>가 없습니다. 공공데이터포털에서 발급 후 넣어주세요.</div>`
    :`<div class="es-hint2" style="margin-bottom:14px">
      호별(동·호) 공시가격은 공개 REST API로 제공되지 않는 경우가 많습니다.<br>
      아래 버튼으로 원본 응답을 확인하면 실제 어떤 값이 오는지 알 수 있어요.</div>`}
    <div class="field"><label>공시가격 직접 입력 (임시)</label>
      <div class="es-line">
        ${REC_YEARS.map(y=>`<div style="flex:1"><div class="es-k">${y}</div>
          <div class="es-unit"><input class="es-num" style="width:100%" type="number" step="0.1"
            placeholder="0" value="${((p.prices&&p.prices[y])||0)/억||''}" data-esph="${y}"></div></div>`).join('')}
      </div></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="es-raw">원본 응답 보기</button>
      <button class="btn" id="es-phsave">저장</button></div>`);
  const raw=$q('#es-raw');
  if(raw) raw.onclick=()=>{
    const base=(typeof backendBase==='function')?backendBase():'';
    window.open(base+'/gongsiga_raw?pnu='+p.pnu,'_blank');
  };
  const sv=$q('#es-phsave');
  if(sv) sv.onclick=()=>{
    REC_YEARS.forEach(y=>{
      const el=document.querySelector('[data-esph="'+y+'"]');
      if(el){ const v=parseFloat(el.value)||0; p.prices=p.prices||{}; if(v>0) p.prices[y]=v*억; }
    });
    save(); window.close(); window.render(); toast('공시가 저장됨');
  };
}

/* ============================================================
   8. 앱에 부착 (index.html 수정 없이)
   ============================================================ */
function attach(){
  injectCSS();

  /* 하단 탭 버튼 추가 (설정 앞에) */
  const nav=$q('#nav');
  const btn=document.createElement('button');
  btn.dataset.tab='estate';
  btn.innerHTML=`<svg viewBox="0 0 24 24" fill="none"><path d="M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M10 20v-5h4v5" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>부동산`;
  btn.onclick=()=>{ tab='estate'; window.render(); window.scrollTo(0,0); };
  const setBtn=nav.querySelector('[data-tab="settings"]');
  if(setBtn) nav.insertBefore(btn, setBtn); else nav.appendChild(btn);

  /* render() 감싸기 — 부동산 탭일 때만 가로채고 나머지는 원본 그대로 */
  const orig=window.render;
  window.render=function(){
    if(tab!=='estate'){
      try{ localStorage.setItem('tmt.ui.estate','0'); }catch(err){}
      return orig.apply(this, arguments);
    }
    try{
      $q('#app').innerHTML='<div class="topspace"></div><div class="wrap">'+viewEstate()+'</div>';
      document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('on', b.dataset.tab==='estate'));
      const fab=$q('#fab'); if(fab) fab.style.display='none';
      bindEstate();
      localStorage.setItem('tmt.ui.estate','1');
    }catch(err){
      /* 부동산 탭에서 문제가 나도 앱 전체가 멈추지 않도록 격리 */
      console.error('[estate]', err);
      $q('#app').innerHTML='<div class="topspace"></div><div class="wrap">'
        +'<div class="empty" style="padding:40px 20px"><div class="em">\u26a0\ufe0f</div>'
        +'<h3>부동산 탭 오류</h3><p style="word-break:break-all">'+String((err&&err.message)||err)+'</p>'
        +'<button class="btn ghost" id="es-home">홈으로</button></div></div>';
      const hb=$q('#es-home'); if(hb) hb.onclick=()=>{ tab='dash'; window.render(); };
      try{ localStorage.setItem('tmt.ui.estate','0'); }catch(e2){}
    }
  };

  /* 마지막에 부동산 탭이었으면 복원 */
  try{ if(localStorage.getItem('tmt.ui.estate')==='1'){ tab='estate'; window.render(); } }catch(err){}
}

function safeAttach(){ try{ attach(); }catch(err){ console.error('[estate] attach 실패',err); } }
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',safeAttach);
else safeAttach();

window.EstateTax={EST,jaesan,jongbu,compute,frozen,heldY,livedY,makePNU,isAdj,sigungu,ageAt,pnuFromDaum,parseJibun,onDaumPick};
})();
