import {escape as e, ink, svg, when} from './format.js';
import {tabs} from './views.js';

export const kinds = {
  buy:'Buy',sell:'Sell',deposit:'Deposit',withdrawal:'Withdrawal',lot:'Open purchase lot',
  transfer:'Off-market transfer',opening:'Opening stock',action:'Corporate action',dividend:'Dividend',grant:'Stock reward',
};
const tradeKinds = new Set(['buy','sell']);
const bankKinds = new Set(['deposit','withdrawal']);
const number = new Intl.NumberFormat('en-US',{maximumFractionDigits:4});
const currency = new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

export function moneyExact(state, amount) {
  if (amount == null) return '—';
  return state.privateMode ? '$••••' : (amount<0?'−':'')+'$'+currency.format(Math.abs(amount));
}

export function totals(events) {
  const values={buy:0,sell:0,deposit:0,withdrawal:0,lot:0};
  for (const event of events) {
    if (event.amount != null && Object.hasOwn(values,event.kind)) values[event.kind]+=Math.round(event.amount*100);
  }
  const {buy,sell,deposit,withdrawal,lot}=values;
  return {buy:buy/100,sell:sell/100,deposit:deposit/100,withdrawal:withdrawal/100,lot:lot/100,
    tradeNet:(buy-sell)/100,bankNet:(deposit-withdrawal)/100};
}

export function activityGroups(events, from, through, filter) {
  const visible=events.filter(event=>event.date>=from && event.date<=through &&
    (filter==='all' || filter==='trades' && tradeKinds.has(event.kind) ||
     filter==='cash' && bankKinds.has(event.kind) || filter==='lots' && !tradeKinds.has(event.kind) && !bankKinds.has(event.kind)));
  return [...Map.groupBy(visible,event=>event.date)].sort(([a],[b])=>a.localeCompare(b));
}

export function activityKinds(events) {
  return {
    trade:events.some(event=>tradeKinds.has(event.kind)),
    cash:events.some(event=>bankKinds.has(event.kind)),
    records:events.some(event=>!tradeKinds.has(event.kind)&&!bankKinds.has(event.kind)),
  };
}

function activityTag(key,label) {
  return '<span class="history-event history-'+key+'">'+e(label??kinds[key])+'</span>';
}

function coverageIncludes(coverage,day) {
  return Boolean(coverage && day>=coverage[0] && day<=coverage[1]);
}

export function coverageLabel(coverage) {
  return coverage ? when(coverage[0])+' – '+when(coverage[1]) : 'No source ledger loaded';
}

function summaryRows(state, items, data, day) {
  const amounts=totals(items);
  const categories=activityKinds(items);
  const canTrade=coverageIncludes(data.tradeCoverage,day);
  const canBank=coverageIncludes(data.cashCoverage,day);
  const tradeLabel=amounts.tradeNet>0?'Net buy':amounts.tradeNet<0?'Net sell':'Net trade';
  const cashLabel=amounts.bankNet>0?'Net deposit':amounts.bankNet<0?'Net withdrawal':'Net cash flow';
  const line=(title, value, cls='')=>'<div><dt>'+title+'</dt><dd class="'+cls+'">'+moneyExact(state,value)+'</dd></div>';
  const group=(heading, content, note)=>'<section class="history-flow"><h3>'+heading+'</h3>'+
    (content?'<dl>'+content+'</dl>':'<p>'+note+'</p>')+'</section>';
  return group('Broker trades',canTrade||categories.trade
    ? line('Buys',amounts.buy)+line('Sells',amounts.sell)+line(tradeLabel,Math.abs(amounts.tradeNet),ink(-amounts.tradeNet)):'',
    'Trade totals unavailable for this date.')+
    group('Bank transfers',canBank||categories.cash
      ? line('Deposited',amounts.deposit)+line('Withdrawn',amounts.withdrawal)+line(cashLabel,Math.abs(amounts.bankNet),ink(amounts.bankNet)):'',
      'Deposit and withdrawal records unavailable for this date.');
}

function activityLabel(state,events) {
  const flags=activityKinds(events), amount=totals(events);
  const tradeText=amount.tradeNet>0?'Net buy':amount.tradeNet<0?'Net sell':'Net trade';
  const cashText=amount.bankNet>0?'Net deposit':amount.bankNet<0?'Net withdrawal':'Net cash';
  return [
    flags.trade && activityTag(amount.tradeNet<0?'sell':'buy',tradeText+' '+moneyExact(state,Math.abs(amount.tradeNet))),
    flags.cash && activityTag(amount.bankNet<0?'withdrawal':'deposit',cashText+' '+moneyExact(state,Math.abs(amount.bankNet))),
    flags.records && activityTag('action',events.filter(r=>!tradeKinds.has(r.kind)&&!bankKinds.has(r.kind)).length+' other records'),
  ].filter(Boolean).join('');
}

export function activityNavigator(state, groups) {
  return '<div class="history-activity"><h3>Activity dates <span>'+groups.length+'</span></h3>'+
    tabs('history-activity',[['all','All'],['trades','Trades'],['cash','Bank'],['lots','Lots & actions']],state.historyActivity)+
    '<button class="quiet history-ledger-window" data-action="history-range" data-value="'+(state.historyRange==='ledger'?'all':'ledger')+'">'+
    (state.historyRange==='ledger'?'Show all years':'Zoom to the trade and cash records')+' '+svg('ArrowUpRight',13)+'</button>'+
    (groups.length?'<div class="history-day-list" aria-label="Dates with activity">'+groups.slice().reverse().map(([day,items])=>
      '<button data-action="history-inspect" data-value="'+day+'" aria-pressed="'+(day===state.historyDate)+'"><time datetime="'+day+'">'+when(day)+'</time>'+
      '<span>'+activityLabel(state,items)+'</span>'+svg('ChevronRight',14)+'</button>').join('')+'</div>':
      '<div class="history-no-records">No matching records in this range.</div>')+'</div>';
}

export function activityPreview(state, items, data, day) {
  return '<div class="history-flow-preview">'+summaryRows(state,items,data,day)+'</div>'+
    (items.length?'<button class="quiet history-detail-link" data-action="history-detail">See '+items.length+
      (items.length===1?' record':' records')+' for this date '+svg('ArrowDownRight',14)+'</button>':'');
}

function securityTrades(state, trades, holdings) {
  const normalized=name=>name.trim().replace(/[.\s]+$/,'').replace(/\s+/g,' ').toUpperCase();
  const securities=[...Map.groupBy(trades,row=>normalized(row.label)).values()];
  const quantity=(rows)=>rows.some(row=>row.quantity==null)?null:rows.reduce((sum,row)=>sum+row.quantity,0);
  return '<div class="table-scroll" tabindex="0" aria-label="Trades by security"><table class="history-trades"><thead><tr><th scope="col">Security</th><th scope="col">Bought</th><th scope="col">Sold</th><th scope="col">Net shares</th><th scope="col">Net trade</th></tr></thead><tbody>'+
    securities.map(rows=>{
      const buys=rows.filter(row=>row.kind==='buy'), sells=rows.filter(row=>row.kind==='sell');
      const bought=quantity(buys),sold=quantity(sells),net=bought==null||sold==null?null:bought-sold;
      const values=totals(rows);
      const units=value=>state.privateMode?'••••':value==null?'—':number.format(value);
      const qty=(net>0&&!state.privateMode?'+':'')+units(net);
      const side=values.tradeNet>0?'Net buy':values.tradeNet<0?'Net sell':'Net trade';
      const accountCount=new Set(rows.map(row=>row.account)).size;
      const {isin,label}=rows[0];
      const ticker=e(label.toUpperCase());
      const open=holdings.has(isin)?'<button class="plain-link" data-security="'+e(isin)+'" aria-label="Open '+ticker+' holding">'+ticker+'</button>':ticker;
      return '<tr><th scope="row">'+open+'<details><summary>'+
        '<small>'+rows.length+(rows.length===1?' trade':' trades')+' · '+accountCount+(accountCount===1?' account':' accounts')+'</small></summary>'+
        '<ul>'+rows.map(row=>'<li>'+activityTag(row.kind)+' <span>Portfolio '+row.account+' · '+e(row.venue??'Exchange')+' · '+
          units(row.quantity)+' units at '+moneyExact(state,row.rate)+'</span> <b>'+moneyExact(state,row.amount)+'</b></li>').join('')+
        '</ul></details></th>'+
        '<td data-label="Bought"><b>'+units(bought)+'</b><small>'+moneyExact(state,values.buy)+'</small></td>'+
        '<td data-label="Sold"><b>'+units(sold)+'</b><small>'+moneyExact(state,values.sell)+'</small></td>'+
        '<td data-label="Net shares"><b>'+qty+'</b></td><td data-label="Net trade"><b>'+moneyExact(state,Math.abs(values.tradeNet))+'</b><small>'+side+'</small></td></tr>';
    }).join('')+'</tbody></table></div>';
}

function supportingRecords(state, rows) {
  return '<ul class="history-records">'+rows.map(row=>{
    const detail=[row.source,row.detail,'Portfolio '+row.account].filter(Boolean).join(' · ');
    const label = row.isin ? row.label.toUpperCase() : row.label;
    return '<li>'+activityTag(row.kind)+'<div><b>'+e(label)+'</b><small>'+e(detail)+'</small></div>'+
      (row.quantity!=null?'<span>'+(state.privateMode?'••••':number.format(row.quantity))+' units</span>':'')+
      (row.amount!=null?'<strong>'+moneyExact(state,row.amount)+'</strong>':'')+'</li>';
  }).join('')+'</ul>';
}

export function dayDetails(state, day, items, data, holdings=new Set()) {
  const trades=items.filter(row=>tradeKinds.has(row.kind));
  const transfers=items.filter(row=>bankKinds.has(row.kind));
  const lots=items.filter(row=>row.kind==='lot');
  const others=items.filter(row=>row.kind!=='lot'&&!tradeKinds.has(row.kind)&&!bankKinds.has(row.kind));
  const section=(title, description, content)=>'<section class="history-detail-section"><h3>'+title+'</h3>'+
    (description?'<p>'+description+'</p>':'')+content+'</section>';
  const records=[
    trades.length?section('Trades by security','Expand the trade count for quantities, execution rates and net amounts.',securityTrades(state,trades,holdings)):'',
    transfers.length?section('Bank transfers','Dated deposits and withdrawals from the broker cash ledger.',supportingRecords(state,transfers)):'',
    lots.length?section('Open purchase lots','These quantities remained open in the broker’s open positions report. The '+moneyExact(state,totals(lots).lot)+' shown is recorded lot cost.',supportingRecords(state,lots)):'',
    others.length?section('Other position records','Other activity recorded by Robinhood.',supportingRecords(state,others)):'',
  ].join('');
  return '<section class="card history-detail" id="history-detail" tabindex="-1" aria-label="Transaction details"><header class="history-head"><div><h2>Transactions on '+when(day)+'</h2>'+
    '<p>'+items.length+' dated '+(items.length===1?'record':'records')+'</p></div></header>'+
    '<div class="history-flow-summary">'+summaryRows(state,items,data,day)+'</div>'+
    (records||'<p class="history-detail-empty">No dated activity for the selected account and date.</p>')+'</section>';
}
