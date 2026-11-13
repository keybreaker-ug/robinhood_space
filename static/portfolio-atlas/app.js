import {buildModel, sectorAllocation} from './model.js';
import {adjustedCloseField, renderChart} from './chart.js';
import {cash, empty, escape as e, nameOf, pct, shortName, svg, ticker} from './format.js';
import {activity, allocation, brand, filtered, heatmaps, holdings, holdingRows, nav, overview, performance, portfolioInsights, sources, symbolMark, topbar, valuation} from './views.js';
import {drawResearch} from './research.js';
import {buildHoldingIndex, lookup} from './holding-index.js';
import {closingRows, historyPage, renderHistoryChart} from './history.js';

const $ = selector => document.querySelector(selector);
const main = $('#main');
const loadingScreen = main.firstElementChild.cloneNode(true);
const searchDialog = $('#search-dialog');
const pages = {overview,history:historyPage,holdings:(s,m)=>holdings(s,m),heatmaps,allocation,valuation,performance,insights:portfolioInsights,activity,watchlist:(s,m)=>holdings(s,m,true),sources};
const embedded = document.querySelector('#atlas-data');
const fallbackPage = Object.hasOwn(pages,embedded?.dataset.start) ? embedded.dataset.start : 'overview';
const stored = (key,fallback) => {try{return JSON.parse(localStorage.getItem('atlas-full-history:'+key)) ?? fallback;}catch{return fallback;}};
const persist = (key,value) => {try{localStorage.setItem('atlas-full-history:'+key,JSON.stringify(value));}catch{}};
const initialPage = location.hash.slice(1);
const state = {
  page:Object.hasOwn(pages,initialPage)?initialPage:fallbackPage,scope:'all',
  theme:stored('theme','dark'),privateMode:stored('private',false),watch:new Set(stored('watch',[])),
  benchmark:'S&P 500',marketRange:'1Y',vooRange:'1Y',movers:'up',query:'',asset:'all',sector:'all',peBand:'all',dataFilter:'all',
  sort:{key:'value',dir:-1},heatAsset:'stocks',heatStockMode:'move',heatFundMode:'move',
  historyRange:'all',historyCalendar:'sessions',historyDate:null,historyActivity:'all',
  heatSector:'all',activity:'trades',tradeSide:'all',scenarioSector:'all',scenarioShock:-10,menu:false,
};
document.documentElement.dataset.theme=state.theme;
let models, markets={}, historyData, session, savedData, savedResearch, comparison, expiryTimer;
let sp500History, sp500Request;
let chartCleanup=()=>{}, researchCleanup=()=>{};
let searchReturn, toastTimer;
const memory=new Map();
const researchRequests=new Map();
const fundSnapshots=new Map();
const showsSectorExposure=page=>page==='overview'||page==='allocation';

async function loadAllocationSectors(model) {
  if(embedded) return;
  const symbols=model.funds.filter(row=>row.value>0).map(({symbol,assetType})=>({symbol,assetType}));
  for(let start=0;start<symbols.length;start+=12){
    try {
      const response=await fetch('/api/research',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'funds',symbols:symbols.slice(start,start+12)})});
      if(response.status===401) throw Object.assign(new Error('Robinhood session expired'),{status:401});
      if(!response.ok) continue;
      const {data}=await response.json();
      for(const row of data) fundSnapshots.set(row.symbol,row);
    } catch(error) {
      if(error.status===401) throw error;
      // The allocation view reports the portion covered by available data.
    }
  }
}

async function get(url) {
  if(embedded) {
    savedData ??= JSON.parse(embedded.textContent);
    if(url in savedData) return savedData[url];
    savedResearch ??= readSavedResearch();
    return (await savedResearch)[url] ?? {error:'This research is available from the local server.'};
  }
  const response=await fetch(url,{credentials:'same-origin',mode:'same-origin',redirect:'error'});
  if(!response.ok) {
    if(response.status===401 && models) location.reload();
    throw Object.assign(new Error('Local API returned '+response.status),{status:response.status});
  }
  return response.json();
}

async function readSavedResearch() {
  const data=$('#atlas-research')?.textContent;
  if(!data) return {};
  const bytes=Uint8Array.from(atob(data), c=>c.charCodeAt(0));
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

function chartPoints(label) {
  return markets[label]?.points||[];
}

function applyChartStyles(container) {
  for(const element of container.querySelectorAll('[data-atlas-style]')){
    for(const rule of element.dataset.atlasStyle.split(';')){
      const [property,value]=rule.split(':');
      if (['width','height','top','left','--equity','--fund-edge'].includes(property) && /^-?(?:\d*\.)?\d+(?:e[+-]?\d+)?%$/i.test(value)){
        element.style.setProperty(property,value);
      }
    }
  }
}

function fitRowWindows() {
  const windows='.table-scroll,.compact-rows,.group-list,.line-list,.rank-bars,.valuation-bars,'+
    '.search-rows,.history-day-list,.history-records,.history-checkpoints,.concentration-bars,.news-rows';
  for(const container of document.querySelectorAll(windows)){
    if(!container.getClientRects().length) continue;
    const rows=container.matches('.table-scroll')?container.querySelector('table')?.tBodies[0]?.rows:container.children;
    const eighth=rows?.[7];
    const scrolls=rows?.length>8;
    if(scrolls){
      const bottom=eighth.getBoundingClientRect().bottom-container.getBoundingClientRect().top+container.scrollTop;
      const scrollbar=container.offsetHeight-container.clientHeight;
      container.style.maxHeight=Math.ceil(bottom+scrollbar)+'px';
      if(!container.hasAttribute('tabindex')) container.tabIndex=0;
    } else {
      container.style.removeProperty('max-height');
    }
  }
}

function render() {
  chartCleanup();
  const model=models[state.scope];
  const active=document.activeElement?.closest('button[data-action]');
  const focus=active ? [active.dataset.action,active.dataset.value] : null;
  const activityScroll=$('.history-day-list')?.scrollTop ?? 0;
  $('#sidebar').innerHTML=nav(state,model);
  $('#sidebar').classList.toggle('mobile-open',state.menu);
  $('#topbar').innerHTML=topbar(state,model);
  if(session){renderResearch();return;}
  if(showsSectorExposure(state.page)){
    model.lookThrough=sectorAllocation(model,fundSnapshots);
  }
  const shownMarkets={...markets,[state.benchmark]:{points:chartPoints(state.benchmark)}};
  main.innerHTML=state.page==='history' ? historyPage(state,model,historyData) :
    state.page==='overview' ? overview(state,model,shownMarkets,models,comparison) : pages[state.page](state,model,shownMarkets,models);
  applyChartStyles(main);
  fitRowWindows();
  if(state.page==='overview' && $('#market-chart')) chartCleanup=renderChart($('#market-chart'),{
    points:chartPoints(state.benchmark),range:state.marketRange,name:state.benchmark,
  });
  if(state.page==='overview' && $('#voo-chart') && !state.privateMode) {
    const rows=comparison?.points||[];
    const drawVoo=renderChart($('#voo-chart'),{
      points:rows.map(row=>[row.date,row.portfolio]), comparison:rows.map(row=>[row.date,row.sp500]),
      sipComparison:rows.map(row=>[row.date,row.vooSip]),
      range:state.vooRange, mode:'comparison', currency:'$', name:'Portfolio', peerName:'VOO', peerColor:'#b99df5',
    });
    const drawMarket=chartCleanup;
    chartCleanup=()=>{drawMarket();drawVoo();};
  }
  if(state.page==='history' && $('#portfolio-chart')) chartCleanup=renderHistoryChart($('#portfolio-chart'),state,historyData,model.scope,(date,showDetails)=>{
    state.historyDate=date;
    render();
    if(showDetails) focusHistoryDetails();
    else $('#portfolio-chart canvas')?.focus({preventScroll:true});
  });
  if($('.history-day-list')) $('.history-day-list').scrollTop=activityScroll;
  if(focus) [...document.querySelectorAll('button[data-action]')].find(el=>el.dataset.action===focus[0]&&el.dataset.value===focus[1])?.focus({preventScroll:true});
}

function focusHistoryDetails() {
  const detail=$('#history-detail');
  detail?.focus({preventScroll:true});
  detail?.scrollIntoView({block:'start'});
}

function navigate(page) {
  if (!Object.hasOwn(pages,page)) return;
  if (state.page!==page || session) {
    if(embedded) location.hash=page;
    else history.pushState(null,'','#'+page);
  }
  if(session) closeResearch();
  state.page=page;
  state.menu=false;
  render();
  window.scrollTo({top:0,behavior:'instant'});
  main.focus({preventScroll:true});
}
function filters() {
  Object.assign(state,{query:'',asset:'all',sector:'all',peBand:'all',dataFilter:'all',sort:{key:'value',dir:-1}});
}
function notify(text) {
  const toast=$('#toast');
  toast.textContent=text;toast.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2200);
}

function showSearch() {
  searchReturn=document.activeElement;
  $('#search-content').innerHTML='<header>'+svg('Search',20)+'<input id="global-query" type="search" aria-label="Find a security" placeholder="Company, ticker or ISIN"><button class="icon" data-action="close-search" aria-label="Close search">'+svg('X',17)+'</button></header><div id="global-results"></div>';
  searchDialog.showModal();
  searchResults('');
  $('#global-query').focus();
}
function searchResults(value) {
  const model=models[state.scope];
  const q=value.trim();
  const rows=q?lookup(model.holdingIndex,q):model.rows;
  $('#global-results').innerHTML=rows.length?'<div class="search-caption">'+(q?'Matches':'Largest holdings')+'</div><div class="search-rows">'+rows.map(r=>
    '<button data-security="'+e(r.isin)+'" class="search-result">'+symbolMark(r)+'<span><b>'+e(shortName(r))+'</b><small>'+e(r.asset==='Equity'?ticker(r)+' · '+(r.sector||'Unclassified'):r.navType)+'</small></span>'+svg('ArrowUpRight',16)+'</button>').join('')+'</div>':empty('No matching holdings in this scope');
  fitRowWindows();
}
searchDialog.addEventListener('close',()=>{
  $('#search-content').replaceChildren();
  if(searchReturn?.isConnected) searchReturn.focus();
});

function openHoldingPage(isin, push=false) {
  const model=models[state.scope], row=model.rows.find(item=>item.isin===isin);
  if(!row) return false;
  if(searchDialog.open){searchReturn=null;searchDialog.close();}
  if(session?.row.isin===isin){main.focus({preventScroll:true});return true;}
  if(push) {
    if(!location.hash) history.replaceState(null,'','#'+state.page);
    history.pushState({holdingNavigation:true},'','#holding/'+encodeURIComponent(isin));
  }
  state.menu=false;
  session={row,model,tab:'chart',range:'1Y',priceMode:'price',financialView:'ratios',newsFilter:'all',data:{}};
  render();
  window.scrollTo({top:0,behavior:'instant'});
  main.focus({preventScroll:true});
  loadResearch('chart');
  return true;
}

function closeResearch() {
  researchCleanup();
  researchCleanup=()=>{};
  session=null;
}

function renderResearch() {
  if(!session) return;
  researchCleanup();
  const active=main.contains(document.activeElement)?document.activeElement.closest('button[data-action]'):null;
  const focus=active?[active.dataset.action,active.dataset.value]:null;
  main.innerHTML=drawResearch(state,session.row,session,sp500History);
  applyChartStyles(main);
  fitRowWindows();
  if(focus) [...main.querySelectorAll('button[data-action]')].find(el=>el.dataset.action===focus[0]&&el.dataset.value===focus[1])?.focus({preventScroll:true});
  const plot=$('#security-chart'), data=session.data.chart;
  if(plot&&data?.points?.length) researchCleanup=renderChart(plot,{
    points:data.points,range:session.range,field:adjustedCloseField,
    mode:session.priceMode==='compare'?'return':'level',
    comparison:session.priceMode==='compare'?sp500History.points:[],
    currency:'$',name:nameOf(session.row),volume:session.row.asset==='Equity',
    measure:{element:$('#security-measure'),period:session.measurement,onChange:period=>{session.measurement=period;}},
  });
}

async function loadSp500History() {
  if(sp500Request || sp500History?.points) return;
  sp500History=undefined;
  renderResearch();
  sp500Request=get('/api/atlas/benchmarks/sp500');
  try {
    const data=await sp500Request;
    sp500History=data.points?.length>=2 ? data : {error:data.error||'The provider returned too little history.'};
  } catch {
    sp500History={error:'Yahoo Finance history could not be loaded.'};
  } finally {
    sp500Request=undefined;
  }
  if(session?.tab==='chart' && session.priceMode==='compare') renderResearch();
}

async function loadResearch(kind,force=false) {
  if(kind==='position'||!session) return;
  const current=session;
  const id=current.row.isin+':'+kind;
  if(force){memory.delete(id);delete current.data[kind];}
  const cached=memory.get(id);
  if(cached) {
    current.data[kind]=cached;
    renderResearch();
    return;
  }
  if(current.data[kind]) return;
  if(force) renderResearch();
  try {
    if(!researchRequests.has(id)){
      const {assetType,symbol}=current.row;
      const request=get('/api/atlas/security/'+assetType+'/'+encodeURIComponent(symbol)+'/'+kind).finally(()=>researchRequests.delete(id));
      researchRequests.set(id,request);
    }
    const data=await researchRequests.get(id);
    current.data[kind]=data;
    if(!data.error && !(kind==='news' && current.row.assetType==='stock' && !data.analyst)) memory.set(id,data);
  } catch {
    current.data[kind]={error:'The local research endpoint did not respond.'};
  }
  if(session===current && current.tab===kind) renderResearch();
}

function exportCSV(file,headers,rows) {
  const cell=value=>{
    const text=String(value??'');
    const escaped=typeof value==='string'&&/^[=+\-@\t\r]/.test(text)?"'"+text:text;
    return '"'+escaped.replaceAll('"','""')+'"';
  };
  const csv='\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=file;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  notify('CSV exported');
}

const holdingsExport=(model)=>{
  const fields=[
    ['isin','ISIN'],['label','Security'],['symbol','Ticker'],['asset','Asset'],['sector','Sector'],['qty','Units'],
    ['cmp','Price or NAV'],['quoteDate','Price date'],['value','Market value USD'],['weight','Weight %'],
    ['avgBuyPrice','Avg buy price USD'],['cost','Recorded cost USD'],['gain','Unrealized USD'],['totalReturn','Total return %'],['xirr','Cash-flow XIRR %'],['timeHeld','Time held'],
    ['move','Covered session move %'],['navMove','NAV change %'],['pe','Trailing P/E'],['costCount','Positions with cost'],
    ['fundamentalsDate','Fundamentals date'],
  ];
  exportCSV('portfolio-atlas-'+state.scope+'-'+model.date+'.csv',fields.map(f=>f[1]),
    filtered(state,model,state.page==='watchlist').map(r=>fields.map(f=>r[f[0]])));
};
const recordsExport=model=>{
  const group={trades:'trades',tax:'realized',actions:'openLots',recon:'reconciliation'}[state.activity];
  const rows=model.selected.flatMap(a=>a.archive[group].map(r=>({Portfolio:a.label,...r})));
  const shown=state.activity==='actions'?rows.filter(r=>r.corp_action&&!['T','OpeningStk','Offmarket'].includes(r.corp_action)):
    state.activity==='trades'&&state.tradeSide!=='all'?rows.filter(r=>r.bs===state.tradeSide):rows;
  if(!shown.length){notify('No records to export');return;}
  const fields=Object.keys(shown[0]);
  exportCSV('atlas-'+group+'-'+state.scope+'.csv',fields,shown.map(r=>fields.map(f=>r[f])));
};

const handlers={
  refresh:()=>{
    const url=new URL(location.href);
    url.searchParams.set('refresh','1');
    location.replace(url);
  },
  page:navigate,allocation:()=>navigate('allocation'),valuation:()=>navigate('valuation'),search:showSearch,
  'close-search':()=>searchDialog.close(),
  'close-research':()=>{if(history.state?.holdingNavigation)history.back();else navigate(state.page);},menu:()=>{
    state.menu=!state.menu;$('#sidebar').classList.toggle('mobile-open',state.menu);
    $('[data-action=menu]').setAttribute('aria-expanded',String(state.menu));
  },
  theme:()=>{state.theme=state.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=state.theme;persist('theme',state.theme);render();},
  privacy:()=>{state.privateMode=!state.privateMode;persist('private',state.privateMode);render();notify(state.privateMode?'Balances hidden':'Balances visible');},
  scope:value=>{state.scope=value;state.sector='all';state.heatSector='all';state.scenarioSector='all';render();},
  benchmark:value=>{state.benchmark=value;render();},
  'market-range':value=>{state.marketRange=value;render();},
  'voo-range':value=>{state.vooRange=value;render();},
  'history-range':value=>{
    state.historyRange=value;
    state.historyDate=value==='ledger'?historyData?.scopes[state.scope]?.events.findLast(row=>row.kind==='buy'||row.kind==='sell')?.date:null;
    render();
  },
  'history-calendar':value=>{state.historyCalendar=value;render();},
  'history-activity':value=>{state.historyActivity=value;render();},
  'history-detail':focusHistoryDetails,
  'history-inspect':value=>{
    const fromLedger=document.activeElement?.closest('.history-close');
    state.historyDate=value;render();
    if(fromLedger) {
      $('.history-inspector')?.focus({preventScroll:true});
      $('.history-inspector')?.scrollIntoView({block:'nearest'});
    }
  },
  'history-export':()=>{
    if(state.privateMode) return;
    const points=historyData.scopes[state.scope].points;
    const previous=new Map(points.slice(1).map((p,i)=>[p.date,points[i].value]));
    const rows=closingRows(historyData,state.scope,state.historyCalendar).map(p=>[
      p.date,p.value,previous.has(p.date)?Number((p.value-previous.get(p.date)).toFixed(2)):'',p.equity,p.funds,p.crypto,p.coverage,
    ]);
    exportCSV('portfolio-atlas-closes-'+state.scope+'-'+historyData.asof+'.csv',
      ['Date (ET)','Estimated close (USD)','Change from previous close (USD)','Equity (USD)','ETFs (USD)',
        'Crypto (USD)','Price coverage (%)'],rows);
  },
  movers:value=>{state.movers=value;render();},
  asset:value=>{filters();state.asset=value;navigate('holdings');},
  'asset-filter':value=>{state.asset=value;state.sector='all';if(value==='MF/ETF')state.peBand='all';render();},
  'pe-band':value=>{filters();state.asset='Equity';state.peBand=value;navigate('holdings');},
  'clear-pe-band':()=>{state.peBand='all';render();},
  'sector-filter':value=>{state.sector=value;render();},
  'data-filter':value=>{state.dataFilter=value;render();},
  sort:value=>{state.sort={key:value,dir:state.sort.key===value?-state.sort.dir:value==='label'?1:-1};render();},
  'heat-asset':value=>{state.heatAsset=value;render();},
  'heat-mode':value=>{if(state.heatAsset==='stocks')state.heatStockMode=value;else state.heatFundMode=value;render();},
  'heat-sector':value=>{state.heatSector=value;render();},
  activity:value=>{state.activity=value;render();},
  'trade-side':value=>{state.tradeSide=value;render();},
  'scenario-sector':value=>{state.scenarioSector=value;render();},
  export:()=>{if(!state.privateMode)holdingsExport(models[state.scope]);},
  'export-records':()=>{if(!state.privateMode)recordsExport(models[state.scope]);},
  'research-tab':value=>{session.tab=value;renderResearch();loadResearch(value);},
  'research-range':value=>{session.range=value;renderResearch();},
  'price-mode':value=>{
    session.priceMode=value;
    if(value==='compare' && !sp500History && !sp500Request) loadSp500History();
    else renderResearch();
  },
  'financial-view':value=>{session.financialView=value;renderResearch();},
  'news-filter':value=>{session.newsFilter=value;renderResearch();},
  retry:()=>loadResearch(session.tab,true),
  'retry-sp500':loadSp500History,
  'save-security':()=>{
    const isin=session.row.isin;
    if(state.watch.has(isin)){state.watch.delete(isin);notify('Removed from watchlist');}
    else{state.watch.add(isin);notify('Added to watchlist');}
    persist('watch',[...state.watch]);render();
  },
};

document.addEventListener('click',event=>{
  if(!models) return;
  if(event.target===searchDialog){searchDialog.close();return;}
  const button=event.target.closest('button[data-action]');
  if(button){handlers[button.dataset.action]?.(button.dataset.value);return;}
  const security=event.target.closest('[data-security],[data-row]');
  if(security) openHoldingPage(security.dataset.security||security.dataset.row,true);
});
document.addEventListener('change',event=>{
  const field=event.target.closest('select[data-action]');
  if(field)handlers[field.dataset.action]?.(field.value);
});
document.addEventListener('input',event=>{
  const field=event.target;
  if(field.id==='holding-query'){
    state.query=field.value;
    $('#holding-rows').innerHTML=holdingRows(state,models[state.scope],state.page==='watchlist');
    fitRowWindows();
  }
  if(field.id==='global-query')searchResults(field.value);
  if(field.id==='shock'){
    state.scenarioShock=Number(field.value);
    const model=models[state.scope];
    const basis=model.sector.find(g=>g.name===state.scenarioSector)?.value??model.equityValue;
    const impact=basis*state.scenarioShock/100;
    $('#scenario-shock').textContent=pct(state.scenarioShock,0,true);
    $('#scenario-impact').textContent=cash(impact,{signed:true,privateMode:state.privateMode});
    $('#scenario-impact').className=impact<0?'negative':impact>0?'positive':'';
    $('#scenario-value').textContent=cash(model.total+impact,{privateMode:state.privateMode});
  }
});
document.addEventListener('keydown',event=>{
  if(!models)return;
  if(event.key==='Escape'&&state.menu){handlers.menu();$('[data-action=menu]').focus();}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){
    event.preventDefault();if(!searchDialog.open)showSearch();
  }
  if(searchDialog.open&&event.target.id==='global-query'){
    if(event.key==='Enter'){event.preventDefault();$('#global-results [data-security]')?.click();}
    if(event.key==='ArrowDown'){event.preventDefault();$('#global-results [data-security]')?.focus();}
  }
  if(searchDialog.open && event.target.classList.contains('search-result')){
    if(event.key==='ArrowDown'){event.preventDefault();event.target.nextElementSibling?.focus();}
    if(event.key==='ArrowUp'){event.preventDefault();const previous=event.target.previousElementSibling;if(previous?.matches('button'))previous.focus();else $('#global-query').focus();}
  }
});
function showLocation(){
  if(!models) return;
  const page=location.hash.slice(1);
  if(page.startsWith('holding/')){
    let isin;
    try {isin=decodeURIComponent(page.slice(8));} catch {return;}
    if(session?.row.isin===isin)return;
    if(openHoldingPage(isin))return;
  }
  const next=Object.hasOwn(pages,page)?page:fallbackPage;
  if(next!==state.page || session){
    if(session)closeResearch();
    state.page=next;render();window.scrollTo(0,0);main.focus({preventScroll:true});
  }
}
window.addEventListener('popstate',showLocation);
window.addEventListener('hashchange',showLocation);
window.addEventListener('resize',fitRowWindows);
document.addEventListener('toggle',event=>{if(event.target.matches('details, dialog'))fitRowWindows();},true);
document.fonts.ready.then(fitRowWindows);
matchMedia('(max-width: 680px)').addEventListener('change',()=>{if(state.page==='heatmaps')render();});

function showLogin(message='') {
  main.innerHTML='<section class="card atlas-signin"><header class="card-head">'+brand()+'</header>'+
    '<form id="atlas-login"><label>Email <input name="username" type="email" autocomplete="username" required></label>'+
    '<label>Password <input name="password" type="password" autocomplete="current-password" required></label>'+
    '<p role="status" class="small-note">'+e(message)+'</p><button class="secondary" type="submit">Sign in</button></form></section>';
  $('#atlas-login').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const fields=new FormData(form);
    const button=form.querySelector('button');
    const status=form.querySelector('[role=status]');
    button.disabled=true;
    status.textContent='Approve the sign-in in Robinhood if prompted.';
    try {
      const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
        credentials:'same-origin',mode:'same-origin',redirect:'error',
        body:JSON.stringify({username:fields.get('username'),password:fields.get('password')})});
      const result=await response.json();
      if(!response.ok) throw new Error(result.message||'Sign-in failed.');
      form.reset();
      await loadPortfolio({logged_in:true,session_info:result.session_info});
    } catch(error) {
      status.textContent=error.message;
      button.disabled=false;
      form.elements.password.value='';
    }
  });
}

async function loadPortfolio(broker){
  main.replaceChildren(loadingScreen.cloneNode(true));
  try{
    broker ??= await get('/api/check-session');
    if(!broker.logged_in){showLogin();return;}
    clearTimeout(expiryTimer);
    if(broker.session_info?.expires_at) expiryTimer=setTimeout(()=>location.reload(),Math.max(0,Date.parse(broker.session_info.expires_at)-Date.now()));
    const url=new URL(location.href);
    const refresh=url.searchParams.get('refresh')==='1';
    const suffix=refresh?'?refresh=1':'';
    if(refresh){url.searchParams.delete('refresh');history.replaceState(history.state,'',url);}
    const pendingMarkets=get('/api/atlas/benchmarks').catch(error=>{
      if(error.status===401) throw error;
      return {};
    });
    const pendingSnapshot=get('/api/atlas/snapshot'+(embedded?'':suffix)).then(async source=>{
      const next=buildModel(source);
      await loadAllocationSectors(next[state.scope]);
      return {source,next};
    });
    const [{source,next},marketData]=await Promise.all([pendingSnapshot,pendingMarkets]);
    markets=marketData;
    models=next;
    for(const model of Object.values(models)) model.holdingIndex=buildHoldingIndex(model);
    historyData=source.history;
    comparison=source.comparison;
    applyBenchmarks();
    showLocation();
    if(!session) render();
  }catch(error){
    console.error(error);
    if(error.status===401) showLogin();
    else main.innerHTML=empty('Portfolio snapshot could not load','Reload the page to retry the Robinhood connection.');
  }
}

function applyBenchmarks() {
  const indices=Object.entries(markets).map(([name,series])=>{
    const last=series.points.at(-1), previous=series.points.at(-2);
    return {name,level:last?.[1],chg_pct:previous?.[1]>0?(last[1]/previous[1]-1)*100:null};
  });
  for(const model of Object.values(models)) model.indices=indices;
}

loadPortfolio();
