import {cash, empty, escape as e, fixed, ink, pct, when} from './format.js';
import {parseDate, percent} from './model.js';
import {tabs} from './views.js';

const money = value => cash(value,{compact:false});
const multiple = value => Number.isFinite(value) ? fixed(value,2)+'×' : '—';
const yearly = value => when(value,{year:'numeric',month:'short'});
const ratio = (top,bottom) => Number.isFinite(top) && bottom>0 ? top/bottom : null;
const percentage = (top,bottom) => Number.isFinite(top) && bottom>0 ? percent(top,bottom) : null;
const change = (now,before) => Number.isFinite(now) && before>0 ? (now/before-1)*100 : null;
const dates = metrics => [...new Set(Object.values(metrics).flatMap(Object.keys))].sort().slice(-5).reverse();

const statementRows = [
  ['Income statement',['Revenue','Gross profit','Operating income','EBITDA','Interest expense','Net income','Diluted EPS']],
  ['Balance sheet',['Total assets','Current assets','Current liabilities','Cash & short-term investments','Total debt','Book equity']],
  ['Cash flow',['Operating cash flow','Capital expenditure','Free cash flow']],
];

function header(title,detail) {
  return '<header class="card-head"><div><h2>'+e(title)+'</h2><p>'+e(detail)+'</p></div></header>';
}
function ratioCard(title, detail, rows) {
  return '<section class="card ratio-card">'+header(title,detail)+'<dl>'+rows.map(([name,value,note,style=''])=>
    '<div><dt>'+e(name)+'<small>'+e(note)+'</small></dt><dd class="'+style+'">'+e(value)+'</dd></div>').join('')+'</dl></section>';
}

function ratios(row, metrics, latest, prior) {
  const get = key => metrics[key]?.[latest];
  const previous = key => metrics[key]?.[prior];
  const growth = key => change(get(key),previous(key));
  const avg = key => get(key)>0 && previous(key)>0 ? (get(key)+previous(key))/2 : null;
  const income=get('Net income'), revenue=get('Revenue'), eps=get('Diluted EPS'), cashFlow=get('Operating cash flow');
  const fcf=get('Free cash flow'), debt=get('Total debt'), book=get('Book equity'), liquidity=get('Cash & short-term investments');
  const fcfYield=percentage(fcf,row.mcap);
  const netDebt=Number.isFinite(debt)&&Number.isFinite(liquidity)?debt-liquidity:null;
  const trailingDate = row.fundamentalsDate ? 'Saved '+when(row.fundamentalsDate) : 'Saved fundamentals';
  const fiscal = latest?'FY ended '+when(latest):'Annual filing data';
  return '<div class="two-grid ratio-grid">'+
    ratioCard('Valuation','Saved price or market cap against the stated earnings or fiscal measure',[
      ['Trailing P/E',multiple(row.pe>0?row.pe:null),trailingDate+' · trailing earnings'],
      ['Price / annual EPS',multiple(row.cmp>0?ratio(row.cmp,eps):null),'Snapshot price ÷ last full-year diluted EPS'],
      ['Price / book',multiple(row.mcap>0?ratio(row.mcap,book):null),'Saved market cap ÷ year-end book equity'],
      ['Price / sales',multiple(row.mcap>0?ratio(row.mcap,revenue):null),'Saved market cap ÷ annual revenue'],
      ['Free cash flow yield',pct(fcfYield,2,true),'Annual FCF ÷ saved market cap',ink(fcfYield)],
      ['Diluted EPS',money(eps),fiscal],
    ])+
    ratioCard('Profitability',fiscal,[
      ['Gross margin',pct(percentage(get('Gross profit'),revenue),2),'Gross profit ÷ revenue'],
      ['Operating margin',pct(percentage(get('Operating income'),revenue),2),'Operating income ÷ revenue'],
      ['Net margin',pct(percentage(income,revenue),2),'Net income ÷ revenue'],
      ['Return on equity',pct(percentage(income,avg('Book equity')),2),'Net income ÷ average opening and closing equity'],
      ['Return on assets',pct(percentage(income,avg('Total assets')),2),'Net income ÷ average opening and closing assets'],
    ])+
    ratioCard('Financial strength',fiscal,[
      ['Debt / equity',multiple(ratio(debt,book)),'Year-end debt ÷ book equity'],
      ['Net debt / EBITDA',multiple(ratio(netDebt,get('EBITDA'))),'Debt less cash and short-term investments ÷ annual EBITDA'],
      ['Current ratio',multiple(ratio(get('Current assets'),get('Current liabilities'))),'Current assets ÷ current liabilities'],
      ['Interest coverage',multiple(ratio(get('Operating income'),get('Interest expense'))),'Operating income ÷ interest expense'],
      ['Operating cash / debt',pct(percentage(cashFlow,debt),2),'Annual operating cash flow ÷ year-end debt'],
    ])+
    ratioCard('Growth & cash generation',prior?yearly(prior)+' → '+yearly(latest):fiscal,[
      ['Revenue growth',pct(growth('Revenue'),2,true),'Year over year',ink(growth('Revenue'))],
      ['Net income growth',pct(growth('Net income'),2,true),'Year over year',ink(growth('Net income'))],
      ['Diluted EPS growth',pct(growth('Diluted EPS'),2,true),'Year over year',ink(growth('Diluted EPS'))],
      ['Cash conversion',pct(percentage(cashFlow,income),2),'Operating cash flow ÷ net income'],
      ['Free cash flow margin',pct(percentage(fcf,revenue),2,true),'Free cash flow ÷ revenue'],
    ])+'</div>'+
    '<p class="small-note">A dash marks missing inputs or an unusable denominator. Fiscal dates and valuation snapshot dates can differ.</p>';
}

function trends(metrics, years) {
  const keys=['Revenue','Net income','Diluted EPS','Free cash flow'];
  return '<div class="two-grid financial-trends">'+keys.map(key=>{
    const points=years.slice().reverse().flatMap(year=>{
      const value=metrics[key]?.[year];
      return Number.isFinite(value)?[{year,value}]:[];
    });
    const max=Math.max(1,...points.map(point=>Math.abs(point.value)));
    const last=points.at(-1);
    const format=key==='Diluted EPS'?money:cash;
    const growth=last && points.at(-2) ? change(last.value,points.at(-2).value) : null;
    return '<section class="card">'+header(key,last?yearly(last.year)+' · '+format(last.value):'Annual history')+
      (points.length?'<div class="fiscal-bars">'+points.map(({year,value})=>'<div><span>'+e(yearly(year))+'</span><i aria-hidden="true"><i class="'+(value<0?'negative':'')+'" data-atlas-style="width:'+Math.abs(value)/max*100+'%"></i></i><b>'+format(value)+'</b></div>').join('')+'</div>'+
        (growth!=null?'<p class="small-note '+ink(growth)+'">'+pct(growth,2,true)+' versus previous reported period</p>':''):empty('History unavailable'))+'</section>';
  }).join('')+'</div>';
}

function statements(metrics,years) {
  return statementRows.map(([label,keys])=>{
    const rows=keys.filter(key=>metrics[key]);
    return '<section class="card financial-card">'+header(label,'Fiscal period end · Yahoo Finance · reporting currency')+
      (rows.length?'<div class="table-scroll" tabindex="0" aria-label="'+label+' table"><table class="record-table"><thead><tr><th scope="col">Metric</th>'+
        years.map(date=>'<th scope="col">'+e(when(date))+'</th>').join('')+'</tr></thead><tbody>'+
        rows.map(key=>'<tr><th scope="row">'+e(key)+'</th>'+years.map(year=>'<td>'+cash(metrics[key][year],key==='Diluted EPS'?{compact:false}:{})+'</td>').join('')+'</tr>').join('')+
        '</tbody></table></div>':empty('No reported values for this statement'))+'</section>';
  }).join('');
}

export function financials(row,data,view,requestState) {
  const metrics=data?.metrics || {};
  const years=dates(metrics);
  const latest=years[0];
  const prior=years.find(date=>{
    const days=(parseDate(latest)-parseDate(date))/86400000;
    return days>=350 && days<=380;
  });
  return '<section class="card financial-controls"><header class="card-head"><div><h2>Ratios &amp; financials</h2><p>'+
    (latest?'Latest annual period ended '+e(when(latest))+' · Yahoo Finance'+(data?.cached?' · cached':''):'Annual financial statements · Yahoo Finance')+
    '</p></div>'+tabs('financial-view',[['ratios','Ratios'],['trends','Annual trends'],['statements','Statements']],view)+'</header></section>'+
    ((!years.length&&(requestState(data,'Financial history')||empty('No annual series returned by the provider')))||'')+
    (view==='ratios'?ratios(row,metrics,latest,prior):!years.length?'':view==='trends'?trends(metrics,years):statements(metrics,years));
}
