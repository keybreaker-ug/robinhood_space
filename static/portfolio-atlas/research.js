import {cash, empty, escape as e, fixed, ink, nameOf, num, pct, quantity, svg, ticker, when} from './format.js';
import {cagrPeriods, parseDate, percent, sum} from './model.js';
import {financials} from './financial.js';
import {adjustedCloseField, seriesChange} from './chart.js';
import {assetTone, ranges, stat, symbolMark, tabs, trendIcon} from './views.js';

const safe = url => typeof url === 'string' && /^https:\/\//.test(url) ? e(url) : '#';
const label = row => row.navType;
const privateCash = (state,value,options={}) => cash(value,{privateMode:state.privateMode,...options});
const marketLink = row => 'https://finance.yahoo.com/quote/'+encodeURIComponent(
  row.assetType==='crypto'&&!row.symbol.endsWith('-USD')?row.symbol+'-USD':row.symbol.replaceAll('.','-'))+'/';
const quoteKind = () => 'Price';
const cashOpts = {compact:false};

function panel(state,row,active,body) {
  const identity = [row.symbol ? label(row)+' · '+ticker(row) : row.navType,row.isin,row.asset==='Equity'&&row.sector].filter(Boolean).join(' / ');
  const title = nameOf(row);
  const nav = row.asset==='Equity' ? [['chart','Chart'],['financials','Ratios & financials'],['news','News & filings'],['position','Position & lots']]
    : [['chart','Price history'],['position','Position']];
  const marked = state.watch.has(row.isin);
  const covered = row.costCount === row.positions.length;
  const investedNote = !row.costCount ? 'Cost basis unavailable' : covered ? 'Recorded cost of open units' : row.costCount+' of '+row.positions.length+' account positions covered';
  const xirrCoverage = percent(row.xirrValue,row.value);
  const xirrNote = row.xirr==null ? 'Complete transaction history required'
    : row.asset!=='Equity' ? 'Annualized cash-flow return'
    : row.transferLots ? 'Lot estimate · includes transfers' : 'Annualized cash-flow return';
  const detailLink = '<button class="metric-link" data-action="research-tab" data-value="position" aria-label="View XIRR calculation">'+
    e(xirrNote)+(xirrCoverage<99.99&&row.xirr!=null?' · '+pct(xirrCoverage,0)+' covered':'')+' '+svg('ChevronRight',11)+'</button>';
  const strip = '<div class="research-metrics position-strip">'+
    stat('Invested',privateCash(state,row.cost,{compact:false}),investedNote,'','Coins')+
    stat('Current position value',privateCash(state,row.value,{compact:false}),'At the portfolio snapshot','position-value','Wallet')+
    stat('Unrealized P&L',privateCash(state,row.gain,{signed:true,compact:false}),pct(row.gainPct,1,true)+(covered?'':' · known cost only'),ink(row.gain),trendIcon(state.privateMode?null:row.gain))+
    stat('XIRR',pct(row.xirr,2,true),detailLink,ink(row.xirr),'Percent')+
    stat('Quantity',state.privateMode?'••••':quantity(row.qty),'','','Layers')+
    stat('Total return',pct(row.totalReturn,2,true),'From recorded purchases, sales and cash dividends',ink(row.totalReturn),trendIcon(row.totalReturn))+'</div>';
  return '<div class="research-frame" data-asset-tone="'+assetTone(row)+'">'+
    '<div class="research-top"><span>'+svg('BookOpen',16)+' Security research</span><div><button class="secondary" data-action="save-security" aria-pressed="'+marked+'">'+svg(marked?'Check':'Bookmark',15)+(marked?'Saved':'Watch')+'</button>'+
    '<button class="secondary" data-action="close-research">'+svg('ArrowLeft',16)+' Back</button></div></div>'+
    '<header class="research-title"><div>'+symbolMark(row)+'<div><h1>'+e(title)+'</h1><p>'+e(identity)+(row.weight!=null?' · '+pct(row.weight,2)+' of portfolio':'')+'</p></div></div>'+
    '<div class="research-price"><strong>'+cash(row.cmp,cashOpts)+'</strong><span>'+quoteKind(row)+' snapshot '+(row.quoteDate?'· '+when(row.quoteDate):'')+'</span>'+
    (row.quoteNote?'<span>'+e(row.quoteNote)+'</span>':'')+'</div></header>'+
    strip+'<div class="research-nav">'+tabs('research-tab',nav,active)+'<a class="quiet" href="'+safe(marketLink(row))+'" target="_blank" rel="noopener noreferrer">Source '+svg('ExternalLink',14)+'</a></div>'+
    '<div class="research-body" id="research-body">'+body+'</div></div>';
}

export function drawResearch(state,row,research,sp500History) {
  const active = research.tab;
  const data = research.data[active];
  let body;
  if(active==='chart') body=chartBody(row,research,data,sp500History);
  else if(active==='financials') body=financials(row,data,research.financialView,requestState);
  else if(active==='news') body=news(research,data,row);
  else body=position(state,row,research.model);
  return panel(state,row,active,body);
}

function requestState(data,label) {
  if (!data) return '<div class="research-loading" role="status"><i></i> Loading '+e(label)+'…</div>';
  if (data.error) return empty(label+' unavailable',data.error)+'<button class="secondary retry" data-action="retry">'+svg('RefreshCw',15)+' Retry</button>';
  return '';
}

function chartBody(row,research,data,sp500History) {
  const equity = row.asset==='Equity';
  const points = data?.points || [];
  const {range,priceMode} = research;
  const comparing = priceMode==='compare';
  const stats = seriesChange(points,range,adjustedCloseField,comparing ? sp500History?.points || [] : undefined);
  const quote = equity ? row.move : row.navMove;
  const volume = data?.points?.at(-1)?.[3];
  const rates = cagrPeriods(points);
  const cagrNote = '<p class="small-note cagr-note">CAGR uses adjusted closing prices. Lifetime starts at the first available price.</p>';
  const cagrCards = '<div class="research-metrics cagr-grid">'+['1Y','5Y','10Y','15Y','Lifetime'].map(label=>{
      const rate=rates.get(label);
      return stat(label+' CAGR',pct(rate,2,true),'',ink(rate),'Percent');
    }).join('')+'</div>';
  const cagr = '<section class="cagr-summary" aria-label="Compound annual growth rates">'+cagrCards+cagrNote+'</section>';
  const plot = '<div id="security-chart" class="chart research-chart"></div><div id="security-measure" class="chart-measure">'+svg('TrendingUp',16)+
    '<div class="measure-result" data-measure-result></div><span class="sr-only" role="status" data-measure-live></span><button class="quiet" aria-label="Clear chart measurement" hidden>Clear</button></div>';
  const compareStatus = !sp500History ? '<div class="research-loading" role="status"><i></i> Loading S&P 500 history…</div>' : sp500History.error
    ? empty('S&P 500 history unavailable',sp500History.error)+'<button class="secondary retry" data-action="retry-sp500">'+svg('RefreshCw',15)+' Retry</button>' : '';
  const chart = requestState(data,'Price history') || (comparing&&compareStatus) || (stats.first ? plot :
    empty(comparing ? 'Not enough shared dates in this period' : 'Insufficient chart history'));
  const changeNote = stats.first ? when(stats.first[0])+' to '+when(stats.last[0]) : '';
  return '<section class="card research-chart-card"><header class="card-head"><div><h2>Price history</h2><p>Adjusted daily closes · Yahoo Finance</p></div>'+
    tabs('research-range',[...ranges,'All'].map(r=>[r,r]),range)+'</header>'+
    '<div class="research-chart-tools">'+tabs('price-mode',[['price','Price'],['compare','vs S&P 500']],priceMode)+
      (comparing?'<span class="compare-legend"><i></i> S&P 500 price index · change from first shared date</span>':'')+'</div>'+
    cagr+
    chart+
    '<div class="card-foot"><span>'+(stats.last?'Series through '+when(stats.last[0]):'Provider coverage varies by security')+'</span><span>'+
    (data?.cached?'Cached provider response.':'Latest bar can include a partial session.')+'</span></div></section>'+
    '<div class="research-metrics">'+stat(range+' change',pct(stats.change,2,true),changeNote,ink(stats.change))+
    stat(range+' range',stats.low?cash(stats.low,cashOpts)+'–'+cash(stats.high,cashOpts):'—','Low to high')+
    stat(equity?'Snapshot session move':'Snapshot NAV move',pct(quote,2,true),row.quoteDate?when(row.quoteDate):'',ink(quote))+
    (equity?stat('Latest daily volume',num(volume),'Shares') : stat('Fund XIRR',pct(row.xirr,2,true),'Broker statement where available'))+'</div>'+
    (equity?'<div class="research-metrics">'+stat('Trailing P/E',row.pe>0?fixed(row.pe,2)+'×':'—',row.fundamentalsDate?when(row.fundamentalsDate):'Saved fundamentals')+
    stat('Market capitalization',cash(row.mcap),'Saved fundamentals')+stat('52-week high',cash(row.wk52_high,cashOpts),'Saved fundamentals')+
    stat('52-week low',cash(row.wk52_low,cashOpts),'Saved fundamentals')+'</div>':'');
}

function table(headers, rows) {
  return '<div class="table-scroll" tabindex="0" aria-label="Research table"><table class="record-table"><thead><tr>'+headers.map(cell=>'<th scope="col">'+e(cell)+'</th>').join('')+
    '</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}

function analystSentiment(analyst,row) {
  const link = safe(marketLink(row)+'analysis/');
  const heading = '<section class="card analyst-card"><header class="card-head"><div><h2>Analyst sentiment</h2></div>'+
    '<a class="quiet" href="'+link+'" target="_blank" rel="noopener noreferrer">Yahoo Finance '+svg('ExternalLink',14)+'</a></header>';
  if(!analyst) return heading+empty('Analyst ratings and price targets unavailable')+
    '<button class="secondary retry" data-action="retry">'+svg('RefreshCw',15)+' Retry analyst data</button></section>';
  const {sentiment,ratings={},target={}} = analyst;
  const currency = /^[A-Z]{3}$/.test(analyst.currency) ? analyst.currency : 'USD';
  const formatter = new Intl.NumberFormat('en-US',{style:'currency',currency});
  const price = value => Number.isFinite(value)?e(formatter.format(value)):'—';
  const difference = currency==='USD' && row.cmp>0 && Number.isFinite(target.mean) ? (target.mean/row.cmp-1)*100 : null;
  const tone = /buy/i.test(sentiment) ? 'positive' : /sell/i.test(sentiment) ? 'negative' : '';
  const groups = [['Buy',(ratings.Buy||0)+(ratings['Strong buy']||0)],['Hold',ratings.Hold||0],['Sell',(ratings.Sell||0)+(ratings['Strong sell']||0)]];
  const total = sum(groups,group=>group[1]);
  let offset = 0;
  const bar = total ? '<svg class="analyst-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">'+groups.map(([label,count])=>{
    const width = 100*count/total;
    const segment = '<rect class="analyst-'+label.toLowerCase()+'" x="'+offset+'" width="'+width+'" height="10"/>';
    offset += width;
    return segment;
  }).join('')+'</svg><ul class="analyst-legend" aria-label="Analyst rating counts">'+groups.map(([label,count])=>
    '<li class="analyst-'+label.toLowerCase()+'">'+label+' <b>'+count+'</b></li>').join('')+'</ul>' : '';
  const range = Number.isFinite(target.low) && Number.isFinite(target.high) ? price(target.low)+' to '+price(target.high) : '—';
  const note = difference===null ? '' : '<b class="'+ink(difference)+'">'+pct(difference,2,true)+'</b> vs current price';
  return heading+'<div class="analyst-grid research-metrics"><div class="stat analyst-consensus"><span>Consensus</span><strong class="'+tone+'">'+e(sentiment||'—')+'</strong>'+
    (bar?'<div class="analyst-ratings">'+bar+'</div>':'')+'</div>'+stat('Average target price',price(target.mean),note)+stat('Target range',range)+'</div></section>';
}

function news(research,data,row) {
  if (!data || data.error) return requestState(data,'Company news');
  const stories = data.stories || [];
  const filings = data.filings || [];
  const tone = ['Positive','Negative','Mixed','Unclear'];
  const count = Object.fromEntries(tone.map(key=>[key,stories.filter(item=>item.tone===key).length]));
  const important = research.newsFilter==='important';
  const press = important?stories.filter(story=>story.important):stories;
  const official = important?filings.filter(filing=>filing.important):filings;
  const card = item=>'<a class="news-item" href="'+safe(item.url)+'" target="_blank" rel="noopener noreferrer"><div><small>'+e(item.source)+' · '+when(item.date.replace(' ','T').slice(0,10))+'</small><b>'+e(item.title)+'</b>'+
    (item.detail?'<p>'+e(item.detail)+'</p>':'')+'<span class="news-tags">'+(item.important?'<span class="tag important">Key event</span>':'')+
    (item.tone?'<span class="tag '+(item.tone==='Positive'?'positive':item.tone==='Negative'?'negative':'')+'">'+item.tone+'</span>':'')+'</span></div>'+svg('ExternalLink',15)+'</a>';
  return (row.asset==='Equity'?analystSentiment(data.analyst,row):'')+
    '<section class="card news-summary"><header class="card-head"><div><h2>Headline tone</h2><p>'+stories.length+' press headlines · latest 45 days</p></div>'+tabs('news-filter',[['all','All'],['important','Key events']],research.newsFilter)+'</header>'+
    '<div class="tone-grid">'+tone.map(key=>'<div><b class="'+(key==='Positive'?'positive':key==='Negative'?'negative':'')+'">'+count[key]+'</b><span>'+key+'</span></div>').join('')+'</div>'+
    '<p class="small-note">Keyword classification of headlines. Unclear is the default when direction is ambiguous.</p></section>'+
    '<div class="two-grid news-grid"><article class="card"><header class="card-head"><div><h2>Exchange filings</h2><p>'+(row.symbol?.endsWith('.NS')?'NSE disclosures':'Exchange source available above')+'</p></div></header>'+
    (official.length?'<div class="news-rows" aria-label="Filings">'+official.map(card).join('')+'</div>':empty(row.symbol?.endsWith('.NS')?'No matching filings returned':'Direct exchange lookup',row.symbol?.endsWith('.NS')?'The exchange feed can be incomplete.':'Use Source to review exchange records for this listing.'))+'</article>'+
    '<article class="card"><header class="card-head"><div><h2>In the press</h2><p>Publishers via Yahoo Finance</p></div></header>'+
    (press.length?'<div class="news-rows" aria-label="Press headlines">'+press.map(card).join('')+'</div>':empty(data.pressError?'Press feed temporarily unavailable':'No matching recent headlines'))+'</article></div>'+
    (data.cached?'<p class="small-note">Showing the last cached provider response.</p>':'');
}

function position(state,row,model) {
  const accounts = new Map(model.selected.map(account=>[account.number,account]));
  const positions = row.positions.map(p=>[
    'Portfolio '+p.account,state.privateMode?'••':num(p.qty),cash(p.cmp,cashOpts),privateCash(state,p.cur_value),privateCash(state,p.cost_value),
    privateCash(state,p.gain,{signed:true}),pct(p.xirr,2,true),p.quoteDate?when(p.quoteDate):'—']);
  const lots = row.positions.flatMap(p=>(accounts.get(p.account).lots[row.isin] || []).map(lot=>({...lot,account:p.account})))
    .sort((a,b)=>(parseDate(b.date)||0)-(parseDate(a.date)||0));
  const trades = row.positions.flatMap(p=>accounts.get(p.account).trades.filter(t=>t.isin===row.isin).map(t=>({...t,account:p.account})))
    .sort((a,b)=>(parseDate(b.date)||0)-(parseDate(a.date)||0));
  return '<section class="card"><header class="card-head"><div><h2>Current positions</h2><p>Robinhood quantities and snapshot prices</p></div></header>'+
    table(['Portfolio','Units','Price / NAV','Market value','Cost basis','Open P&L','XIRR','Price date'],positions)+'</section>'+returnBasis(state,row,model)+
    (row.fundStatement?'<section class="card"><header class="card-head"><div><h2>Fund statement</h2><p>Portfolio '+row.account+'</p></div></header>'+
      '<div class="research-metrics inner-metrics">'+stat('Invested',privateCash(state,row.fundStatement.invested))+
      stat('Statement value',privateCash(state,row.fundStatement.value))+stat('Reported XIRR',pct(row.fundStatement.xirr,2,true))+
      stat('Reported return',pct(row.fundStatement.absolute,1,true))+'</div></section>':'')+
    (row.asset==='Equity'?'<section class="card"><header class="card-head"><div><h2>Statement-era tax lots</h2><p>Brokerage records · '+lots.length+' lots</p></div></header>'+
    (lots.length?table(['Portfolio','Date','Units','Acquisition rate','Term','Event','Statement P&L'],lots.map(l=>[
      'Portfolio '+l.account,e(l.date),state.privateMode?'••':num(l.qty),privateCash(state,l.rate,cashOpts),e(l.term),e(l.corp),privateCash(state,l.gl,{signed:true})])):empty('No archived tax lots'))+'</section>'+
    '<section class="card"><header class="card-head"><div><h2>Recorded trades</h2><p>Broker trade ledger</p></div></header>'+
    (trades.length?table(['Portfolio','Date','Side','Units','Price','Amount'],trades.map(t=>['Portfolio '+t.account,e(t.date),
      t.bs==='B'?'Buy':'Sell',state.privateMode?'••':num(t.qty),cash(t.rate,cashOpts),privateCash(state,t.value)])):empty('No trades in the archived ledger'))+'</section>':'');
}


function returnBasis(state,row,model) {
  if (row.asset!=='Equity') return '';
  const details=row.positions.flatMap(p=>p.lotFlows.map(lot=>({...lot,account:p.account}))).sort((a,b)=>a.date-b.date);
  const covered = (value) => pct(percent(value,row.value),1)+' of position value';
  const metrics=stat('Lot-based XIRR',pct(row.xirr,2,true),row.xirr!=null?covered(row.xirrValue):'No eligible positive-cost lots',ink(row.xirr))+
    stat('Trade-backed XIRR',pct(row.tradeXirr,2,true),row.tradeXirr!=null?covered(row.tradeXirrValue):'No reconciled dated exchange trades',ink(row.tradeXirr))+
    stat('Dated lot cost',privateCash(state,details.length?sum(details,'amount'):null,cashOpts),details.length+' cost lots')+
    stat('Terminal position value',privateCash(state,details.length?row.xirrValue:null,cashOpts),when(model.date));
  return '<section class="card"><header class="card-head"><div><h2>How XIRR is calculated</h2><p>Annualized using recorded cost dates and the portfolio snapshot</p></div></header>'+
    '<div class="research-metrics inner-metrics">'+metrics+'</div>'+
    '<p class="small-note">'+(row.transferLots?'Off-market lots use their recorded transfer dates and cost. Those dates can differ from the original cash purchase. ':'')+
    (row.stamped?'':'Some terminal marks use carried custody prices. ')+'XIRR uses dated purchases, sales and cash dividends plus the current market value.</p>'+
    (details.length?'<details class="return-lots"><summary>View dated inputs</summary>'+
      table(['Portfolio','Date','Lot event','Recorded cost'],details.map(lot=>['Portfolio '+lot.account,when(new Date(lot.date).toISOString().slice(0,10)),
        e(lot.event==='T'?'Exchange trade':lot.event||'Statement lot'),privateCash(state,lot.amount,cashOpts)]))+'</details>':'')+'</section>';
}
