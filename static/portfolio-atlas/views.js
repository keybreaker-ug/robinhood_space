import {cash, empty, escape as e, fixed, ink, nameOf, num, pct, quantity, shortName, svg, ticker, when} from './format.js';
import {grouped, parseDate, percent, sum, treemap} from './model.js';
import {seriesChange, vooSipName} from './chart.js';

const arrow = svg('ArrowUpRight',14);
export const ranges = ['1M','3M','6M','1Y','3Y','5Y'];
const heatModes = {move:'Session move', week:'1-week move', month:'1-month move', value:'Current value', totalReturn:'Total return', xirr:'XIRR', weight:'Weight'};
const mark = (s,k) => s === k ? 'true' : 'false';
const action = (id,label,icon='ArrowRight',cls='quiet') => '<button class="'+cls+'" data-action="'+id+'">'+e(label)+svg(icon,15)+'</button>';
export const tabs = (type,options,selected) => '<div class="seg" role="group" aria-label="'+e(type.replaceAll('-',' '))+'">'+options.map(([key,label]) =>
  '<button data-action="'+type+'" data-value="'+e(key)+'" aria-pressed="'+mark(selected,key)+'">'+e(label)+'</button>').join('')+'</div>';
export const stat = (label,value,note='',cls='',icon='') => '<div class="stat"><span'+(icon?' class="stat-label"':'')+'>'+
  e(label)+(icon?svg(icon,16):'')+'</span><strong class="'+cls+'">'+value+'</strong>'+(note?'<small>'+note+'</small>':'')+'</div>';
export const trendIcon = value => value>0?'TrendUp':value<0?'TrendDown':'TrendFlat';
export const brand = () => '<div class="brand"><span class="brand-logo"><svg aria-hidden="true" width="28" height="28" viewBox="0 0 32 32">'+
  '<path d="M25 5C12 4 5 10 7 19c2 8 13 8 16 0 2-5 0-8 2-14Z" fill="currentColor"/>'+
  '<path class="brand-vein" d="M8 26 22 11M12 22l-1-7m6 2 5 1" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg></span>'+
  '<div><strong>Ravenhood</strong><span>Investments made clearer</span></div></div>';
const head = (title,detail='',controls='') => '<header class="card-head"><div><h2>'+e(title)+'</h2>'+(detail?'<p>'+detail+'</p>':'')+'</div>'+controls+'</header>';
const openButton = (row,content,classes='') => '<button class="'+classes+'" data-security="'+e(row.isin)+'" aria-label="Research '+e(nameOf(row))+'">'+content+'</button>';
const valueText = (state,value,extra={}) => cash(value,{privateMode:state.privateMode,...extra});
export const assetTone = row => row.assetType==='crypto'||row.asset==='Crypto' ? 'crypto' :
  row.assetType==='stock'||row.asset==='Equity' ? 'stock' : 'fund';
export const symbolMark = (row, full=false) => {
  const text = row.symbol || ticker(row);
  return '<span '+(full?'':'aria-hidden="true" ')+'class="symbol-mark '+assetTone(row)+'-mark">'+e(full?text:text.slice(0,3))+'</span>';
};

const PAGE = {
  overview:['Overview','Portfolio Overview'],
  history:['History','Portfolio History'],
  holdings:['Holdings','Holdings Explorer'],
  heatmaps:['Heatmaps','Portfolio Heatmaps'],
  allocation:['Allocation','Allocation & Risk'],
  valuation:['Valuation','Equity Valuation'],
  performance:['Performance','Portfolio Performance'],
  insights:['Portfolio insights','Portfolio Insights'],
  activity:['Activity','Activity & Tax Records'],
  watchlist:['Watchlist','Research Watchlist'],
  sources:['Data & methods','Data & Methodology'],
};
export const title = page => PAGE[page][1];

export function nav(state, model) {
  const icons = {overview:'LayoutDashboard',history:'ChartLine',holdings:'Layers',heatmaps:'Grid2X2',allocation:'ChartPie',insights:'TrendingUp',
    performance:'ChartNoAxesCombined',valuation:'Landmark',activity:'Activity',watchlist:'Bookmark',sources:'Database'};
  const item = key => '<button class="nav-item" data-action="page" data-value="'+key+'" '+(state.page===key?'aria-current="page"':'')+'>'+svg(icons[key])+e(PAGE[key][0])+(key==='watchlist'&&state.watch.size?'<span class="nav-count">'+state.watch.size+'</span>':'')+'</button>';
  return brand()+
    '<nav aria-label="Workspace"><div class="nav-heading">Workspace</div>'+['overview','history','holdings','heatmaps','allocation','valuation','performance','insights'].map(item).join('')+
    '<div class="nav-heading lower">Records & research</div>'+['activity','watchlist','sources'].map(item).join('')+'</nav>'+
    '<div class="sidebar-foot"><span class="status-dot"></span><div><b>Local workspace</b><span>'+model.selected.length+' '+(model.selected.length===1?'portfolio':'portfolios')+' in view</span></div>'+svg('ShieldCheck',17)+'</div>';
}

export function topbar(state, model) {
  return '<div class="breadcrumb"><button class="icon mobile-menu" data-action="menu" aria-label="Toggle menu" aria-controls="sidebar" aria-expanded="'+state.menu+'">'+svg('Menu')+'</button><span>Workspace</span><i></i><b>'+e(PAGE[state.page][0])+'</b></div>'+
    '<div class="global-tools"><span class="snapshot">'+svg('Clock',14)+'<span>'+when(model.date)+'</span></span>'+
    '<button class="global-search" aria-label="Search securities" data-action="search">'+svg('Search',16)+'<span>Search securities</span><kbd>⌘ K</kbd></button>'+
    '<button class="icon" data-action="refresh" aria-label="Refresh portfolio" title="Refresh portfolio">'+svg('PortfolioRefresh')+'</button>'+
    '<button class="icon" data-action="privacy" aria-label="'+(state.privateMode?'Show balances':'Hide balances')+'" title="'+(state.privateMode?'Show balances':'Hide balances')+'">'+svg(state.privateMode?'EyeOff':'Eye')+'</button>'+
    '<button class="icon" data-action="theme" aria-label="Toggle color theme" title="Toggle color theme">'+svg(state.theme==='dark'?'PortfolioSun':'PortfolioMoon')+'</button></div>';
}

export const pageHeader = (state,detail='') => '<header class="page-head"><div><h1>'+title(state.page)+'</h1>'+(detail?'<p>'+e(detail)+'</p>':'')+'</div></header>';
const period = (actionId,selected,choices=ranges) => tabs(actionId,choices.map(r=>[r,r]),selected);

function sectorCoverage(state,model) {
  if (!(model.fundValue>0)) return '';
  const coverage=percent(model.lookThrough?.covered,model.fundValue);
  return '<p class="small-note">Yahoo Finance sector data covers '+pct(coverage,1)+' of ETF market value.</p>';
}

function overviewSectors(state,model) {
  const rows=model.lookThrough?.rows || [];
  const bars=rows.map((row,i)=>{
    const weight=percent(row.value,model.total), color='c'+(i%6);
    return '<div class="group-row"><span class="group-key '+color+'"></span><span class="group-name">'+
      e(row.name)+'</span><b>'+pct(weight,2)+'</b><span class="bar-track" aria-hidden="true"><span class="'+color+
      '" data-atlas-style="width:'+Math.min(100,weight??0)+'%"></span></span></div>';
  }).join('');
  return '<article class="card">'+head('Sector exposure','Direct stocks and reported ETF exposures · share of invested value',
    action('allocation','All sectors','ArrowUpRight'))+
    (bars?'<div class="group-list">'+bars+'</div>':empty('Sector exposure unavailable'))+
    sectorCoverage(state,model)+'</article>';
}

function allocationCard(state, model) {
  const equity = percent(model.equityValue,model.total), funds = percent(model.fundValue,model.total);
  const crypto = percent(sum(model.crypto,'value'),model.total);
  return '<article class="card allocation-card'+(state.page==='allocation'?' allocation-card-large':'')+'">'+
    head('Asset allocation','By market value',state.page==='allocation'?'':action('allocation','Explore','ArrowUpRight'))+
    '<div class="allocation-body"><div class="donut" role="img" aria-label="Stocks '+pct(equity,1)+', ETFs '+pct(funds,1)+', crypto '+pct(crypto,1)+'" data-atlas-style="--equity:'+(equity??0)+'%;--fund-edge:'+((equity??0)+(funds??0))+'%"><div><span>Holdings</span><strong>'+model.rows.length+'</strong></div></div>'+
    '<div class="allocation-legend"><button data-action="asset" data-value="Equity"><i class="stocks-dot"></i><span>Stocks<small>'+model.equity.length+' securities</small></span><strong>'+pct(equity,1)+'</strong></button>'+
    '<button data-action="asset" data-value="MF/ETF"><i class="funds-dot"></i><span>ETFs<small>'+model.funds.length+' funds</small></span><strong>'+pct(funds,1)+'</strong></button>'+
    (model.crypto.length?'<button data-action="asset" data-value="Crypto"><i class="crypto-dot"></i><span>Crypto<small>'+model.crypto.length+' assets</small></span><strong>'+pct(crypto,1)+'</strong></button>':'')+'</div></div>'+
    '<div class="allocation-foot"><span>Top 10 positions</span><b>'+pct(model.top10,1)+'</b><div><span data-atlas-style="width:'+model.top10+'%"></span></div></div></article>';
}

function benchmark(state, model, markets) {
  const index = model.indices.find(row => row.name === state.benchmark);
  const data = markets[state.benchmark]?.points ?? [];
  const stats = seriesChange(data,state.marketRange);
  return '<article class="card benchmark-card">'+head('Market pulse','Benchmark history',period('market-range',state.marketRange,['1M','3M','6M','1Y','5Y']))+
    '<div class="market-tabs">'+model.indices.map(item => '<button data-action="benchmark" data-value="'+e(item.name)+'" aria-pressed="'+mark(state.benchmark,item.name)+'"><span>'+e(item.name)+'</span><b class="'+ink(item.chg_pct)+'">'+pct(item.chg_pct,2,true)+'</b></button>').join('')+'</div>'+
    '<div class="chart-headline"><b title="'+(state.benchmark==='Bitcoin'?'Latest Bitcoin price':'Latest index level')+'">'+num(index?.level)+'</b><span class="'+ink(stats.change)+'">'+pct(stats.change,2,true)+' <small>'+state.marketRange+'</small></span></div>'+
    '<div id="market-chart" class="chart market-chart">'+(!data.length?empty('Benchmark history unavailable'):'')+'</div>'+
    '<footer class="card-foot"><span>Yahoo Finance</span><span>'+ (stats.last ? 'Series through '+when(stats.last[0],{day:'numeric',month:'short'}) : 'Snapshot values')+'</span></footer></article>';
}

function comparePortfolios(state,allModels) {
  const records=Object.values(allModels).filter(model=>model.scope!=='all');
  if(records.length<2) return '';
  return '<article class="card compare-card">'+head('Portfolio comparison','Same snapshot metrics, by account')+
    '<div class="table-scroll" tabindex="0" aria-label="Portfolio comparison"><table><thead><tr><th>Portfolio</th><th>Market value</th><th>Holdings</th><th>Funds & ETFs</th><th>Session change</th><th>Top 10 weight</th></tr></thead><tbody>'+
    records.map(m=>'<tr><th scope="row"><button class="plain-link" data-action="scope" data-value="'+m.scope+'">'+m.selected[0].label+' '+arrow+'</button></th><td><b>'+
      valueText(state,m.total)+'</b></td><td>'+m.rows.length+'</td><td>'+pct(percent(m.fundValue,m.total),1)+'</td><td class="'+ink(m.sessionPct)+'">'+
      pct(m.sessionPct,2,true)+'</td><td>'+pct(m.top10,1)+'</td></tr>').join('')+'</tbody></table></div></article>';
}

function movers(state,model) {
  const winners=state.movers==='up';
  const rows=model.equity.filter(row=>winners?row.session>0:row.session<0)
    .sort((a,b)=>winners?b.session-a.session:a.session-b.session);
  return '<article class="card movers-card">'+head('Session contributors','Ranked by impact on portfolio value',tabs('movers',[['up','Leaders'],['down','Laggards']],state.movers))+
    '<div class="compact-rows">'+rows.map(row=>openButton(row,symbolMark(row)+'<span><b>'+e(shortName(row))+'</b><small>'+e(ticker(row))+'</small></span>'+
      '<span class="'+ink(row.session)+'"><b>'+valueText(state,row.session,{signed:true})+'</b><small>'+pct(row.move,2,true)+'</small></span>'+arrow,'compact-row')).join('')+'</div></article>';
}

function vooComparison(state,data) {
  const value=data?.portfolio, voo=data?.voo;
  const {portfolioXirr,vooXirr}=data?.returns?.[state.vooRange] || {};
  // Subtract the displayed rates so the two cards reconcile to the displayed portfolio XIRR.
  const displayRate=rate=>Math.sign(rate)*Number((Math.abs(rate)*100).toFixed(2));
  const difference=Number.isFinite(portfolioXirr)&&Number.isFinite(vooXirr)
    ? Number((displayRate(portfolioXirr)-displayRate(vooXirr)).toFixed(2)):null;
  const gap=Number.isFinite(difference)?(difference>0?'+':'')+fixed(difference)+' pp':'—';
  const metrics=stat('Portfolio value',valueText(state,value),'','','Wallet')+stat('VOO value',valueText(state,voo?.currentValue),'','benchmark-value','ChartLine')+
    stat('VOO XIRR',state.privateMode?'••••':pct(Number.isFinite(vooXirr)?vooXirr*100:null,2,true),'Annualized · '+state.vooRange,state.privateMode?'':ink(vooXirr),'Percent')+
    stat('Portfolio vs VOO',state.privateMode?'••••':gap,'Portfolio XIRR − VOO XIRR',state.privateMode?'':ink(difference),trendIcon(state.privateMode?null:difference));
  const hasSip=data?.points?.some(row=>Number.isFinite(row.vooSip));
  const hasPoints=data?.points?.filter(row=>[row.portfolio,row.sp500,row.vooSip].some(Number.isFinite)).length>=2;
  return '<article class="card voo-card">'+head('Performance vs VOO (S&P 500)',
    'Matches dated purchases, sales and cash payouts, including purchases funded by reinvested dividends.',
    period('voo-range',state.vooRange,['1M','3M','1Y','All']))+
    '<div class="summary-grid voo-stats">'+metrics+'</div>'+
    (state.privateMode?empty('Comparison hidden'):('<div class="compare-legend voo-key"><span>Portfolio</span><span>VOO</span>'+
      (hasSip?'<span class="voo-sip-key" title="Net purchases through yesterday, split evenly across 14-day installments from the first purchase.">'+vooSipName+'</span>':'')+'</div>'+
      '<div id="voo-chart" class="chart voo-chart">'+(!hasPoints?empty('Comparison history unavailable'):'')+'</div>'))+'</article>';
}

export function overview(state,model,markets,allModels,comparison) {
  const {balance,interestEarned,apy,dividends={}}=model.summary || {};
  const money=value=>valueText(state,value,{compact:false});
  const interestTitle=Number.isFinite(apy)?'Interest earned · '+Number(apy.toFixed(2))+'% APY':'Interest earned';
  return pageHeader(state,'Robinhood at a glance.')+
    '<section class="kpis" aria-label="Portfolio metrics">'+
      '<div class="hero-stat"><div><span class="hero-label">'+svg('Wallet',16)+' Market value</span><strong>'+valueText(state,model.total)+'</strong><small>'+model.rows.length+' distinct securities · USD</small></div><button class="history-overview-link" data-action="page" data-value="history">Value history '+svg('ArrowUpRight',13)+'</button><div class="hero-orbit" aria-hidden="true"></div></div>'+
      '<div class="kpi-secondary">'+stat('Session P&L',valueText(state,model.session,{signed:true}),state.privateMode?'':pct(model.sessionPct,2,true)+' on quoted stocks',ink(state.privateMode?null:model.session),trendIcon(state.privateMode?null:model.session))+
      stat('Unrealized P&L',valueText(state,model.gain,{signed:true}),'',ink(model.gain),trendIcon(state.privateMode?null:model.gain))+
      stat('XIRR',state.privateMode?'••••':pct(model.xirr,2,true),'',state.privateMode?'':ink(model.xirr),'Percent')+'</div></section>'+
    '<section class="summary-grid overview-balances" aria-label="Cash and investment metrics">'+
    stat('Cost basis',money(model.cost),'','','Coins')+stat('Cash',money(balance),'','','Cash')+
    stat(interestTitle,money(interestEarned),'','','Interest')+
    stat('Dividends reinvested',money(dividends.reinvested),'','','Reinvest')+stat('Dividends paid out',money(dividends.paid),'','','Payout')+'</section>'+
    '<section class="overview-grid">'+benchmark(state,model,markets)+allocationCard(state,model)+'</section>'+
    vooComparison(state,comparison)+
    '<section class="overview-grid lower-grid">'+movers(state,model)+overviewSectors(state,model)+'</section>'+
    (model.scope==='all'?comparePortfolios(state,allModels):'');
}

export function filtered(state, model, watch=false) {
  const q=state.query.trim().toLowerCase();
  const records = model.rows.filter(row => (!watch||state.watch.has(row.isin)) &&
    (state.asset==='all'||row.asset===state.asset) && (state.sector==='all'||row.sector===state.sector) &&
    (state.peBand==='all'||(row.asset==='Equity'&&valuationBand(row)===state.peBand)) &&
    (state.dataFilter==='all'||(state.dataFilter==='stale'&&!row.stamped)||(state.dataFilter==='no-cost'&&row.costCount<row.positions.length)||(state.dataFilter==='low-price'&&row.asset==='Equity'&&row.cmp>0&&row.cmp<10)) &&
    (!q||[nameOf(row),row.name,ticker(row),row.isin,row.sector].some(x=>String(x).toLowerCase().includes(q))));
  const {key,dir}=state.sort;
  return records.sort((a,b) => {
    if(a[key]==null) return b[key]==null?0:1;
    if(b[key]==null) return -1;
    return dir*(typeof a[key]==='string'?a[key].localeCompare(b[key]):a[key]-b[key]);
  });
}
const select = (actionId, items, active, label) => '<label class="select-label"><span class="sr-only">'+e(label)+'</span><select data-action="'+actionId+'">'+items.map(([k,v])=>'<option value="'+e(k)+'" '+(active===k?'selected':'')+'>'+e(v)+'</option>').join('')+'</select></label>';
const tableHead = (cols,state) => '<thead><tr>'+cols.map(([key,label,cls])=>'<th scope="col" class="'+(cls||'')+'" '+(state.sort.key===key?'aria-sort="'+(state.sort.dir===1?'ascending':'descending')+'"':'')+'><button data-action="sort" data-value="'+key+'">'+label+(state.sort.key===key?'<span>'+ (state.sort.dir===1?'↑':'↓')+'</span>':'')+'</button></th>').join('')+'</tr></thead>';
const columns = [['label','Security','security-col'],['qty','Quantity'],['avgBuyPrice','Avg buy price'],['cmp','Current price'],
  ['cost','Cost basis'],['value','Current value'],['gain','P&L'],['totalReturn','Total return'],['xirr','XIRR'],
  ['timeHeldDays','Time held'],['move','Session'],['weight','Weight'],['pe','P/E']];

export function holdingRows(state,model,watch) {
  const records=filtered(state,model,watch);
  const body = '<div class="table-scroll" tabindex="0" aria-label="Holdings table"><table class="holdings-table">'+tableHead(columns,state)+'<tbody>'+records.map(row=>
    '<tr data-row="'+e(row.isin)+'"><th scope="row">'+openButton(row,symbolMark(row,true)+'<span class="security-name" title="'+e(row.name||nameOf(row))+'">'+e(row.name||nameOf(row))+'</span>'+
      (!row.stamped?'<span class="old-quote" title="Fallback valuation" aria-label="Fallback valuation">'+svg('Info',13)+'</span>':''),'security-cell')+'</th>'+
    '<td>'+(state.privateMode?'••••':quantity(row.qty))+'</td><td>'+valueText(state,row.avgBuyPrice,{compact:false})+'</td>'+
    '<td>'+cash(row.cmp,{compact:false})+'</td><td>'+valueText(state,row.cost,{compact:false})+'</td><td><b>'+valueText(state,row.value,{compact:false})+'</b></td>'+
    '<td class="'+ink(row.gain)+'"><b>'+valueText(state,row.gain,{compact:false,signed:true})+'</b></td>'+
    '<td class="'+ink(row.totalReturn)+'"><b>'+pct(row.totalReturn,2,true)+'</b></td>'+
    '<td class="'+ink(row.xirr)+'"><b>'+pct(row.xirr,2,true)+'</b></td><td class="holding-time">'+
    (row.timeHeld && row.timeHeld!=='Unavailable'?row.timeHeld.split(', ').map(part=>'<span>'+e(part)+'</span>').join(''):'—')+
    '</td><td class="'+ink(row.move)+'">'+pct(row.move,2,true)+'</td><td>'+pct(row.weight,2)+'</td>'+
    '<td>'+(row.pe>0?fixed(row.pe,1)+'×':'—')+'</td></tr>').join('')+'</tbody></table></div>';
  return (records.length?body:empty(watch?'No watched holdings in this view':'No matching securities',watch?'Save a security from its research panel.':'Change the search or filters to see more holdings.'))+
    '<footer class="table-foot"><span>'+records.length+' holdings</span></footer>';
}

export function holdings(state,model,watch=false) {
  return pageHeader(state,watch?'Saved securities across your portfolios.':'Search holdings by company, ticker, ISIN or sector.')+
    '<article class="card table-card"><div class="filter-bar"><label class="field-search">'+svg('Search',17)+'<input id="holding-query" type="search" aria-label="Filter holdings" placeholder="Search name, ticker or ISIN" value="'+e(state.query)+'"></label>'+
    tabs('asset-filter',[['all','All assets'],['Equity','Stocks'],['MF/ETF','ETFs'],['Crypto','Crypto']],state.asset)+
    select('sector-filter',[['all','All sectors'],...model.sector.map(g=>[g.name,g.name])],state.sector,'Sector')+
    (state.peBand!=='all'?'<button class="secondary" data-action="clear-pe-band" aria-label="Clear valuation filter">'+e(bandLabels[state.peBand])+svg('X',13)+'</button>':'')+
    select('data-filter',[['all','All coverage'],['stale','Fallback prices'],['no-cost','Missing cost basis'],['low-price','Stocks below $10']],state.dataFilter,'Holding filter')+
    '<button class="secondary export" data-action="export" '+(state.privateMode?'disabled':'')+'>'+svg('Download',16)+' CSV</button></div>'+
    '<div id="holding-rows">'+holdingRows(state,model,watch)+'</div></article>';
}

const heatThresholds = {move:[.25,1,3],week:[.5,3,8],month:[1,5,15],xirr:[3,12,25]};
const weightedHeat = mode => ['weight','value','totalReturn'].includes(mode);
function heatColor(value,mode,maxWeight) {
  if(!Number.isFinite(value)) return 'heat-unavailable';
  if(weightedHeat(mode)) return 'heat-weight-'+(value>=maxWeight*.5?3:value>=maxWeight*.15?2:1);
  if(Math.abs(value)<heatThresholds[mode][0]) return 'heat-flat';
  const [,middle,strong]=heatThresholds[mode];
  const band=Math.abs(value)>=strong?3:Math.abs(value)>=middle?2:1;
  return (value<0?'heat-loss-':'heat-gain-')+band;
}

function heatLegend(mode) {
  const chip=(style,text)=>'<span><i class="'+style+'"></i>'+text+'</span>';
  if(weightedHeat(mode)) return chip('heat-weight-1','Smaller position')+
    chip('heat-weight-2','Mid-sized position')+chip('heat-weight-3','Larger position');
  const [small,middle,strong]=heatThresholds[mode];
  return chip('heat-loss-3','≤ −'+strong+'%')+
    chip('heat-loss-2','−'+middle+'%')+chip('heat-loss-1','−'+small+'%')+chip('heat-flat','Near 0%')+
    chip('heat-gain-1','+'+small+'%')+chip('heat-gain-2','+'+middle+'%')+chip('heat-gain-3','≥ +'+strong+'%');
}

function rectangleStyle(rect,w,h) {
  return 'left:'+rect.x/w*100+'%;top:'+rect.y/h*100+'%;width:'+rect.w/w*100+'%;height:'+rect.h/h*100+'%';
}
function tiles(state,rows,mode,maxWeight) {
  const small=matchMedia('(max-width: 680px)').matches;
  const w=small?420:1000,h=small?560:510;
  const tilesFor=(set,width,height)=>treemap(set,width,height).map(tile=>{
    const caption=tile.asset==='Equity'?ticker(tile):shortName(tile);
    const val=tile[mode];
    const valueLabel=mode==='value'?valueText(state,val,{compact:false}):pct(val,2,mode!=='weight');
    const tooltip=nameOf(tile)+' · '+heatModes[mode]+' '+(Number.isFinite(val)?valueLabel:'unavailable')+' · weight '+pct(tile.weight,2);
    const readable=tile.w>=45 && tile.h>=25;
    const colorValue=mode==='totalReturn'&&Number.isFinite(val)?tile.value:val;
    return '<button class="heat-tile '+heatColor(colorValue,mode,maxWeight)+' '+(tile.w<100||tile.h<47?'tiny':tile.w>=135&&tile.h>=85?'large':'')+'" data-security="'+e(tile.isin)+'" data-atlas-style="'+rectangleStyle(tile,width,height)+'" title="'+e(tooltip)+'" aria-label="'+e(tooltip)+'">'+
      (readable?'<b>'+e(caption)+'</b>':'')+(readable&&tile.h>=43?'<small>'+valueLabel+'</small>':'')+'</button>';
  }).join('');
  const stocks=rows[0]?.asset==='Equity';
  if(!stocks) return tilesFor(rows,w,h);
  return treemap(grouped(rows,'sector'),w,h).map(group=>{
    const label=group.w>75&&group.h>42;
    return '<div class="heat-group" data-atlas-style="'+rectangleStyle(group,w,h)+'">'+(label?'<button class="heat-label" data-action="heat-sector" data-value="'+e(group.name)+'" title="Filter to '+e(group.name)+'">'+e(group.name)+svg('ChevronRight',12)+'</button>':'')+
      '<div class="heat-inner">'+tilesFor(group.holdings,Math.max(1,group.w-4),Math.max(1,group.h-(label?22:4)))+'</div></div>';
  }).join('');
}

export function heatmaps(state,model) {
  const stocks=state.heatAsset==='stocks';
  const original=stocks?model.equity:state.heatAsset==='crypto'?model.crypto:model.funds;
  const rows=original.filter(row=>state.heatSector==='all'||!stocks||(row.sector||'Unclassified')===state.heatSector);
  const modes=Object.keys(heatModes);
  const selectedMode=stocks?state.heatStockMode:state.heatFundMode;
  const mode=modes.includes(selectedMode)?selectedMode:'move';
  const max=Math.max(...rows.map(r=>(mode==='weight'?r.weight:r.value)||0),Number.EPSILON);
  const drawable=rows.filter(row=>row.value>0).length;
  return pageHeader(state,'Tile size represents the market value of each position.')+
    '<article class="card heat-card"><div class="heat-toolbar">'+tabs('heat-asset',[['stocks','Stocks'],['funds','ETFs'],['crypto','Crypto']],state.heatAsset)+
      tabs('heat-mode',modes.map(key=>[key,heatModes[key]]),mode)+
      (stocks?select('heat-sector',[['all','All sectors'],...model.sector.map(x=>[x.name,x.name])],state.heatSector,'Heatmap sector'):'')+'</div>'+
    '<div class="heat-heading"><div><h2>'+(stocks?'Stock heatmap':state.heatAsset==='crypto'?'Crypto heatmap':'ETF heatmap')+'</h2><p>'+drawable+' tiles'+(drawable<rows.length?' · '+(rows.length-drawable)+' without positive value':'')+' · '+(mode==='xirr'?rows.filter(row=>row.value>0&&row.xirr!=null).length+' with XIRR':e(heatModes[mode]))+(stocks?' · grouped by sector':'')+'</p></div>'+
      '<div class="heat-key" aria-label="Heatmap color legend">'+heatLegend(mode)+'</div></div>'+
    '<div class="treemap">'+tiles(state,rows,mode,max)+'</div>'+
    '<footer class="card-foot"><span>'+ (mode==='totalReturn'?'Lifetime return on recorded purchases. Color intensity follows position size.':mode==='xirr'?'Annualized returns from recorded cash flows.':'Click any tile to open security research.')+'</span><span>Area = market value</span></footer></article>'+
    (state.heatAsset==='funds'?'<article class="card table-card funds-table">'+head('Fund coverage','Price change is available for '+model.funds.filter(row=>row.navMove!=null).length+' of '+model.funds.length+' ETFs.')+
      '<div class="table-scroll"><table><thead><tr><th>Fund</th><th>Type</th><th>Price as of</th><th>Market value</th><th>Session move</th><th>Total return</th><th>XIRR</th></tr></thead><tbody>'+
      model.funds.map(row=>'<tr data-row="'+e(row.isin)+'"><th>'+openButton(row,e(shortName(row)),'plain-link')+'</th><td>'+e(row.navType)+'</td><td>'+when(row.quoteDate)+'</td><td>'+valueText(state,row.value)+'</td><td class="'+ink(row.move)+'">'+pct(row.move,2,true)+'</td><td class="'+ink(row.totalReturn)+'">'+pct(row.totalReturn,2,true)+'</td><td>'+pct(row.xirr,2,true)+'</td></tr>').join('')+'</tbody></table></div></article>':'');
}

function rankBars(state, rows, key, {percentage=false}={}) {
  const max=Math.max(1,...rows.map(r=>Math.abs(r[key])));
  if(!rows.length) return empty('No matching holdings');
  return '<div class="rank-bars">'+rows.map(row=>openButton(row,
    '<span><b>'+e(shortName(row))+'</b><b class="'+ink(row[key])+'">'+(percentage?pct(row[key],2,true):valueText(state,row[key],{signed:true}))+'</b></span>'+
    '<i><i class="'+ink(row[key])+'" data-atlas-style="width:'+Math.abs(row[key])/max*100+'%"></i></i>','rank-bar')).join('')+'</div>';
}

export function portfolioInsights(state,model) {
  const {largestStockSector,risk={}}=model.insights || {};
  const reference=risk.benchmark || {};
  const ranked=model.rows.filter(row=>Number.isFinite(row.totalReturn)).sort((a,b)=>b.totalReturn-a.totalReturn);
  const top=ranked[0], worst=ranked.at(-1);
  const performer=(name,row)=>stat(name,pct(row?.totalReturn,2,true),
    row?e(ticker(row))+' · '+e(nameOf(row)):'Return history unavailable',ink(row?.totalReturn),trendIcon(row?.totalReturn));
  const drawdown=Number.isFinite(risk.drawdown)?Math.abs(risk.drawdown):null;
  const vooDrawdown=Number.isFinite(reference.drawdown)?Math.abs(reference.drawdown):null;
  return pageHeader(state,risk.note || 'Portfolio risk and returns across stocks, ETFs, and crypto.')+
    '<section class="summary-grid" aria-label="Portfolio insights">'+
    performer('Top performer',top)+performer('Worst performer',worst)+
    stat('Largest direct stock sector',pct(largestStockSector?.weight),e(largestStockSector?.name || 'Sector data unavailable'),'','ChartPie')+
    stat('Diversification',fixed(model.effective,1),'Effective holdings · '+model.rows.length+' positions','','Coins')+
    stat('Alpha',Number.isFinite(risk.alpha)?fixed(risk.alpha)+' pp':'—','Annualized excess return after adjusting for VOO exposure',ink(risk.alpha),'Percent')+
    stat('Volatility',pct(risk.volatility),'Annualized · VOO '+pct(reference.volatility),'','Activity')+
    stat('Max drawdown',pct(drawdown),'Peak-to-trough decline · VOO '+pct(vooDrawdown),drawdown>0?'negative':'','TrendDown')+
    stat('Sharpe ratio',fixed(risk.sharpe),'Return per unit of volatility · VOO '+fixed(reference.sharpe),'','Interest')+
    stat('Beta vs S&P 500',fixed(risk.beta),'VOO sensitivity · 1.00 matches the benchmark','','Reinvest')+'</section>';
}

export function allocation(state,model) {
  const curve=[1,5,10,20,50,100].filter(n=>n<model.rows.length);
  const sector=model.sector.find(row=>row.name===state.scenarioSector);
  const shock=state.scenarioShock/100;
  const affected=sector?.value ?? model.equityValue;
  const impact=affected*shock;
  const caps=model.cap;
  const top = model.rows[0];
  return pageHeader(state,'Concentration, sector exposure and a simple stress test.')+
    '<div class="summary-grid">'+stat('Top 10 weight',pct(model.top10,1),model.rows.length+' distinct holdings')+
    stat('Largest position',pct(top?.weight,2),top?e(shortName(top)):'')+stat('Effective holdings',fixed(model.effective,1),'1 ÷ sum of squared weights')+
    stat('Covered equity P/E',fixed(model.pe,1)+'×',pct(model.peCoverage,0)+' of equity value covered')+'</div>'+
    '<div class="overview-grid allocation-grid">'+allocationCard(state,model)+
    '<article class="card">'+head('Sector exposure','Direct stocks and reported ETF exposures · share of invested value')+
    '<div class="line-list">'+(model.lookThrough?.rows || []).map(group=>'<div><span>'+e(group.name)+'</span><b>'+
      valueText(state,group.value)+'</b><small>'+pct(percent(group.value,model.total),2)+'</small></div>').join('')+'</div>'+
    (model.fundValue>0?sectorCoverage(state,model):'<p class="small-note">No ETF holdings.</p>')+'</article></div>'+
    '<div class="overview-grid allocation-grid"><article class="card">'+head('ETF holdings','Each ETF’s share of invested value')+
    (model.funds.length?'<div class="line-list">'+model.funds.map(row=>'<div><span>'+openButton(row,e(ticker(row))+' · '+e(nameOf(row)),'plain-link')+
      '</span><b>'+valueText(state,row.value)+'</b><small>'+pct(row.weight,2)+'</small></div>').join('')+'</div>':empty('No ETF positions'))+'</article>'+
    '<div class="stack"><article class="card">'+head('Market capitalization','Source classification · equities')+
      '<div class="line-list">'+caps.map((group,i)=>'<div><span><i class="group-key c'+i+'"></i>'+e(group.name)+'</span><b>'+valueText(state,group.value)+'</b><small>'+pct(group.weight,1)+'</small></div>').join('')+'</div></article>'+
    '<article class="card scenario">'+head('Stress test','Immediate price shock on selected equities')+
      '<div class="scenario-tools">'+select('scenario-sector',[['all','All equities'],...model.sector.map(x=>[x.name,x.name])],state.scenarioSector,'Sector to stress')+
      '<output id="scenario-shock" for="shock">'+pct(state.scenarioShock,0,true)+'</output></div>'+
      '<input id="shock" aria-label="Price shock in percent" type="range" min="-40" max="40" step="1" value="'+state.scenarioShock+'">'+
      '<div class="scenario-results"><div><small>Value impact</small><b id="scenario-impact" class="'+ink(impact)+'">'+valueText(state,impact,{signed:true})+'</b></div><div><small>Simulated value</small><b id="scenario-value">'+valueText(state,model.total+impact)+'</b></div></div>'+
      '<p class="small-note">Uses current weights and holds all other prices and quantities fixed.</p></article></div></div>'+
    '<article class="card">'+head('Cumulative concentration','Largest positions first · share of portfolio value',action('valuation','Equity valuation','ArrowUpRight'))+
    '<div class="concentration-bars">'+curve.map(n=>{const weight=sum(model.rows.slice(0,n),'weight');return '<div><span>Top '+n+'</span><i><i data-atlas-style="width:'+weight+'%"></i></i><b>'+pct(weight,1)+'</b></div>';}).join('')+'</div></article>';
}

const bandLabels = {under15:'Below 15×',between15:'15× to 30×',between30:'30× to 50×',above50:'50× and above',missing:'No positive P/E'};
function valuationBand(row) {
  if (!(row.pe>0)) return 'missing';
  if (row.pe<15) return 'under15';
  if (row.pe<30) return 'between15';
  if (row.pe<50) return 'between30';
  return 'above50';
}

function peRanks(rows) {
  const max=Math.max(1,...rows.map(row=>row.pe));
  return rows.length?'<div class="valuation-bars">'+rows.map(row=>openButton(row,
    '<span class="valuation-name" title="'+e(nameOf(row))+'">'+e(shortName(row))+'</span><span class="valuation-track"><i data-atlas-style="width:'+100*row.pe/max+'%"></i></span>'+
    '<b>'+fixed(row.pe,1)+'×</b>','valuation-row')).join('')+'</div>':empty('No positive P/E values in scope');
}

export function valuation(state,model) {
  const rated=model.equity.filter(row=>row.pe>0&&row.value>0);
  const missing=model.equity.filter(row=>!(row.pe>0));
  const bands=Object.entries(bandLabels).map(([key,label])=>{
    const rows=model.equity.filter(row=>valuationBand(row)===key);
    return {key,label,value:sum(rows,'value'),count:rows.length};
  }).sort((a,b)=>b.value-a.value);
  const max=Math.max(1,...bands.map(b=>b.value));
  return pageHeader(state,'Trailing price-to-earnings ratios across the selected portfolio.')+
    '<div class="summary-grid">'+stat('Covered equity P/E',fixed(model.pe,1)+'×','Aggregate market value ÷ implied earnings')+
      stat('P/E coverage',pct(model.peCoverage,1),'Share of equity market value')+
      stat('Positive P/E',rated.length,'Valued holdings with a positive ratio')+
      stat('Without positive P/E',missing.length,valueText(state,sum(missing,'value'))+' of equity value')+'</div>'+
    '<div class="two-grid valuation-grid"><article class="card">'+head('P/E bands','Market value by trailing P/E · select a band to filter holdings')+
      '<div class="valuation-bars">'+bands.map(band=>'<button class="valuation-row" data-action="pe-band" data-value="'+band.key+'"><span class="valuation-name">'+
        e(band.label)+'<small>'+band.count+' securities · '+pct(percent(band.value,model.equityValue),1)+'</small></span><span class="valuation-track"><i data-atlas-style="width:'+
        band.value/max*100+'%"></i></span><b>'+valueText(state,band.value)+'</b></button>').join('')+'</div></article>'+
      '<article class="card">'+head('Highest P/E holdings','Highest reported positive ratios')+peRanks(rated.slice().sort((a,b)=>b.pe-a.pe))+'</article>'+
      '<article class="card">'+head('Lowest positive P/E holdings','Lowest reported positive ratios')+peRanks(rated.slice().sort((a,b)=>a.pe-b.pe))+'</article>'+
      '<article class="card">'+head('Missing valuation data',missing.length+' equities without a positive trailing P/E',
        '<button class="quiet" data-action="pe-band" data-value="missing">View all '+arrow+'</button>')+
        (missing.length?'<div class="compact-rows">'+missing.map(row=>openButton(row,symbolMark(row)+'<span><b>'+e(shortName(row))+'</b><small>'+e(row.sector||'Unclassified')+
          '</small></span><span><b>'+valueText(state,row.value)+'</b><small>'+(row.pe!=null&&row.pe<=0?'Non-positive P/E':'P/E unavailable')+'</small></span>'+arrow,'compact-row')).join('')+'</div>':empty('All equities have a positive P/E'))+
      '</article></div>';
}

function sessionComparison(state,model) {
  const peers=[{name:'Covered stock positions',chg_pct:model.sessionPct},...model.indices];
  const sectors=model.sector.filter(g=>g.session!==0).sort((a,b)=>Math.abs(b.session)-Math.abs(a.session));
  return '<div class="two-grid"><article class="card">'+head('Session versus benchmarks','Snapshot move · prior close to saved marks')+
    '<div class="line-list">'+peers.map((item,index)=>'<div><span>'+e(item.name)+'</span><b class="'+ink(item.chg_pct)+'">'+pct(item.chg_pct,2,true)+'</b><small>'+
      (index?'Index':'Holdings')+'</small></div>').join('')+'</div><p class="small-note">Holdings return covers stock positions with a prior close. Benchmark moves are shown separately.</p></article>'+
    '<article class="card">'+head('Sector contribution','Largest drivers of covered session P&L')+
    '<div class="line-list">'+sectors.map(item=>'<div><span>'+e(item.name)+'</span><b class="'+ink(item.session)+'">'+valueText(state,item.session,{signed:true})+
      '</b><small>'+fixed(percent(item.session,model.previous),2)+' pp</small></div>').join('')+'</div></article></div>';
}

export function performance(state,model) {
  const positive=model.rows.filter(row=>row.gain>0).sort((a,b)=>b.gain-a.gain);
  const negative=model.rows.filter(row=>row.gain<0).sort((a,b)=>a.gain-b.gain);
  const ranges = model.equity.filter(row=>row.live && row.wk52_low>0 && row.wk52_high>row.wk52_low && row.cmp>0)
    .map(row=>({...row, off52:100*(row.cmp/row.wk52_high-1)}));
  const latest=model.total;
  const old=sum(model.selected,account=>account.totals.mar_total_mv);
  const matched=model.rows.filter(r=>r.costCount>0);
  const buckets=[['Below 0%',r=>r.xirr<0],['0% to 10%',r=>r.xirr>=0&&r.xirr<10],['10% to 20%',r=>r.xirr>=10&&r.xirr<20],
    ['20% to 35%',r=>r.xirr>=20&&r.xirr<35],['35% and above',r=>r.xirr>=35]];
  const eligible=model.rows.filter(r=>r.xirr!=null);
  return pageHeader(state,'Unrealized gains, cash-flow returns and range positioning.')+
    '<div class="summary-grid">'+stat('Unrealized P&L',valueText(state,model.gain,{signed:true}),pct(model.gainPct,2,true)+' on known basis',ink(model.gain))+
    stat('Known basis',pct(percent(model.knownValue,model.total),1),matched.length+' securities with some cost basis')+
    stat('Portfolio XIRR',pct(model.xirr,1,true),pct(model.xirrCoverage,1)+' of total market value covered',ink(model.xirr))+
    stat('Session change',pct(model.sessionPct,2,true),pct(percent(model.quoteValue,model.total),1)+' of total market value covered',ink(model.sessionPct))+'</div>'+sessionComparison(state,model)+
    '<div class="two-grid"><article class="card">'+head('Largest open gains','Covered cost only')+rankBars(state,positive,'gain')+'</article>'+
      '<article class="card">'+head('Largest open losses','Covered cost only')+rankBars(state,negative,'gain')+'</article></div>'+
    '<div class="two-grid"><article class="card">'+head('Reported portfolio values','Recorded valuation points')+
    '<div class="line-list"><div><span>Broker statement</span><b>'+valueText(state,old)+'</b></div><div><span>'+when(model.date)+' valuation</span><b>'+valueText(state,latest)+'</b></div></div>'+
    '<p class="small-note">Statement values appear when available in the source data.</p></article>'+
    '<article class="card">'+head('XIRR distribution','Annualized returns from recorded cash flows')+
    '<div class="line-list">'+buckets.map(([label,test])=>{const rows=eligible.filter(test);return '<div><span>'+label+'</span><b>'+valueText(state,sum(rows,'xirrValue'))+'</b><small>'+rows.length+'</small></div>';}).join('')+'</div>'+
    '<p class="small-note">Holding XIRR covers '+pct(model.xirrCoverage,1)+' of total market value.</p></article></div>'+
    '<div class="two-grid"><article class="card">'+head('Near the 52-week high','Gap versus the saved 52-week high')+
    rankBars(state,ranges.slice().sort((a,b)=>b.off52-a.off52),'off52',{percentage:true})+'</article>'+
    '<article class="card">'+head('Furthest below the 52-week high','Gap versus the saved 52-week high')+
    rankBars(state,ranges.slice().sort((a,b)=>a.off52-b.off52),'off52',{percentage:true})+'</article></div>';
}

function archiveTable(headers, rows) {
  return '<div class="table-scroll" tabindex="0" aria-label="Statement records"><table class="record-table"><thead><tr>'+headers.map(h=>'<th scope="col">'+e(h)+'</th>').join('')+
    '</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}

export function activity(state,model) {
  const data=model.selected;
  const kind=state.activity;
  let block='';
  if(kind==='trades'){
    const current=new Map(model.rows.map(row=>[row.isin,row]));
    const raw=data.flatMap(a=>a.trades.map(t=>({...t,account:a.label})));
    const rows=raw.filter(t=>state.tradeSide==='all'||t.bs===state.tradeSide).sort((a,b)=>(parseDate(b.date)||0)-(parseDate(a.date)||0));
    block='<div class="card-head"><div><h2>Broker trade ledger</h2><p>'+rows.length+' recorded trades</p></div>'+
      tabs('trade-side',[['all','All'],['B','Buys'],['S','Sells']],state.tradeSide)+'</div>'+
      archiveTable(['Security','Portfolio','Date','Side','Units','Price','Amount'],rows.map(r=>[
        current.has(r.isin)?openButton(current.get(r.isin),e(r.scrip),'plain-link'):e(r.scrip),e(r.account),e(r.date),r.bs==='B'?'Buy':'Sell',
        state.privateMode?'••':num(r.qty),cash(r.rate,{compact:false}),valueText(state,r.value,{compact:false})]));
  } else if(kind==='tax') {
    if (!data.every(account=>account.cg)) block=head('Reported realized gains','Broker statement')+empty('Tax statements unavailable','Robinhood transaction data does not include statement tax classifications.');
    else {
    const rows=data.flatMap(a=>['lt','st','spec'].map((k,i)=>{
      const [buy,sell,gain,taxable]=a.cg.realized[k];
      return [a.label,['Long-term','Short-term','Speculative'][i],valueText(state,buy),valueText(state,sell),valueText(state,gain,{signed:true}),valueText(state,taxable)];
    }));
    block=head('Reported realized gains','broker statement')+archiveTable(['Portfolio','Term','Acquisition value','Sale value','Realized','Taxable in statement'],rows)+
      head('Reported open gains','Broker statement values')+archiveTable(['Portfolio','Long-term','Short-term','Total'],data.map(a=>[a.label,...['LT','ST','GRAND'].map(k=>valueText(state,a.cg.open[k],{signed:true}))]));
    }
  } else if(kind==='actions') {
    const lookup=new Map(model.rows.map(row=>[row.isin,row]));
    const rows=data.flatMap(a=>Object.entries(a.lots).flatMap(([isin,lots])=>lots
      .filter(lot=>lot.corp&&!['T','OpeningStk','Offmarket'].includes(lot.corp)).map(lot=>({...lot,isin,account:a.label}))));
    block=head('Corporate actions in tax lots',rows.length+' source rows · statement era')+
      archiveTable(['Security','Portfolio','Date','Action','Units'],rows.map(r=>[lookup.has(r.isin)?openButton(lookup.get(r.isin),e(shortName(lookup.get(r.isin))),'plain-link'):e(r.isin),r.account,e(r.date),e(r.corp),state.privateMode?'••':num(r.qty)]));
  } else {
    const rows=data.flatMap(a=>a.archive.reconciliation.map(r=>({...r,account:a.label})));
    block=head('Holdings reconciliation','Brokerage statement versus custody records')+
      archiveTable(['Change','Security','Portfolio','Asset','Units','Statement value'],rows.map(r=>[e(r.change),e(r.name),r.account,e(r.asset),state.privateMode?'••':e(r.qty),valueText(state,r.value_inr===''?null:Number(r.value_inr))]));
  }
  return pageHeader(state,'Historical statements and lot records by portfolio.')+
    '<article class="card table-card activity-card"><div class="filter-bar">'+tabs('activity',[['trades','Trades'],['tax','Capital gains'],['actions','Corporate actions'],['recon','Reconciliation']],kind)+
    '<button class="secondary" data-action="export-records" '+(state.privateMode?'disabled':'')+'>'+svg('Download',16)+' Export CSV</button></div>'+block+'</article>';
}

export function sources(state,model) {
  const checks=[
    ['Holdings & quantity','Robinhood supplies positions, quantities, cost basis and current quotes.'],
    ['Prices & NAVs',[...new Set(model.selected.map(a=>a.meta.live.source))].join(' · ')+'. Yahoo Finance supplies benchmark prices and equity fundamentals.'],
    ['Session P&L','Sums stock contributions with a comparable prior close. Session return divides the change by the previous value of those same positions. NAV marks use their own publication schedule.'],
    ['Unrealized P&L','Market value less recorded cost for positions with both figures. Combined cost coverage can be partial when only one account has a usable basis.'],
    ['XIRR','XIRR uses dated purchases, sales and cash dividends, plus the current market value. Reinvested dividends enter as purchases.'],
    ['Valuation','Covered equity P/E divides covered market value by estimated earnings, using positive per-security P/E from the fundamentals snapshot. The eligible share is shown alongside it.'],
    ['Research','Chart and statement data come from public market providers. Company filings and press are separate. Headline tone uses keyword rules and can miss context.'],
    ['Local storage','Account data is served on this computer. Opening research queries public security identifiers. Theme, privacy mode and saved securities use this browser’s local storage.'],
  ];
  return pageHeader(state,'Snapshot provenance, coverage and calculation rules.')+
    '<div class="summary-grid">'+stat('Refreshed marks',model.priced+' / '+model.rows.length,'Securities with refreshed prices across their positions')+
      stat('Cost coverage',pct(percent(model.knownValue,model.total),1),'Share of total market value')+
      stat('Equity P/E coverage',pct(model.peCoverage,1),'Share of equity market value')+
      stat('XIRR coverage',pct(model.xirrCoverage,1),'Share of total market value')+'</div>'+
    '<article class="card">'+head('Account snapshots','Source timestamps in Eastern time')+
      '<div class="line-list">'+model.selected.map(a=>'<div><span>'+e(a.label)+'</span><b>'+e(a.meta.live.asof)+'</b><small>'+a.holdings.length+' positions</small></div>').join('')+'</div></article>'+
    '<article class="card methods-card">'+head('Methods & sources')+checks.map(([label,detail])=>'<details><summary>'+e(label)+svg('ChevronDown',16)+'</summary><p>'+e(detail)+'</p></details>').join('')+'</article>';
}
