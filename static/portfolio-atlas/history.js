import {cash, empty, escape as e, ink, pct, svg, when} from './format.js';
import {pageHeader, tabs} from './views.js';
import {activityGroups, activityKinds, activityNavigator, activityPreview, coverageLabel, dayDetails, moneyExact, totals} from './history-activity.js';

const ranges = [['30D','30D'],['3M','3M'],['6M','6M'],['1Y','1Y'],['5Y','5Y'],['all','All time']];
const shortDate = day => when(day,{day:'numeric',month:'short'});
const months = {'3M':3,'6M':6,'1Y':12,'5Y':60};
const millis = day => Date.parse(day+'T00:00:00Z');

function fromDate(asof, range) {
  if (range === 'all') return '0000-01-01';
  const d = new Date(millis(asof));
  if (range === '30D') d.setUTCDate(d.getUTCDate()-29);
  else {
    const day=d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth()-months[range]);
    const maxDay=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,maxDay));
  }
  return d.toISOString().slice(0,10);
}

export function closingRows(data, scope, calendar) {
  const points = data?.scopes[scope]?.points ?? [];
  if (calendar === 'days' && points.length) return points.filter(p=>p.date>=fromDate(data.asof,'30D'));
  return points.slice(-30);
}

function money(state, amount, options) {
  return cash(amount,{privateMode:state.privateMode,...options});
}

function historyWindow(state, data) {
  return state.historyRange==='ledger' ? (data.tradeCoverage ?? ['0000-01-01',data.asof]) : [fromDate(data.asof,state.historyRange),data.asof];
}

export function historyPage(state,model,data) {
  const heading=pageHeader(state,'Daily closing values, statement checkpoints and recorded activity.');
  const scope=data?.scopes[model.scope];
  if (!scope) return heading+empty('History is unavailable','Open the latest saved copy of Portfolio Atlas or reload the local dashboard.');
  const {points,statements,events}=scope;
  const holdings=new Set(model.rows?.map(row=>row.isin));
  const [from,through]=historyWindow(state,data);
  const windowPoints=points.filter(p=>p.date>=from&&p.date<=through);
  if(!windowPoints.length) {
    const groups=activityGroups(events,from,through,state.historyActivity);
    const day=state.historyDate ?? groups.at(-1)?.[0] ?? data.asof;
    return heading+'<div class="history-layout"><section class="card">'+empty('Closing values unavailable','The recorded positions and market prices are incomplete for this range.')+
      '<div class="history-head">'+tabs('history-range',ranges,state.historyRange)+'</div></section>'+
      '<aside class="card history-inspector">'+activityNavigator(state,groups)+'</aside></div>'+
      dayDetails(state,day,events.filter(event=>event.date===day),data,holdings);
  }
  const latest=points.at(-1);
  const end=windowPoints.at(-1);
  const first=windowPoints[0];
  const change=end.value-first.value;
  const groups=activityGroups(events,from,through,state.historyActivity);
  const selectedDay=state.historyDate ?? end.date;
  const transactions=events.filter(event=>event.date===selectedDay);
  const quote=points.find(p=>p.date===selectedDay);
  const statement=statements.find(p=>p.date===selectedDay);
  const coverage=quote && !state.privateMode ? ' · '+pct(quote.coverage,2)+' price coverage' : '';
  const dateSpan=when(first.date)+' – '+when(end.date);
  const lowCoverage=first.coverage<90;
  const closeRows=closingRows(data,model.scope,state.historyCalendar);
  const previousByDate = new Map(points.slice(1).map((p,i)=>[p.date,points[i]]));
  return heading+
    '<div class="history-layout"><section class="card history-card"><header class="history-head"><div><h2>Closing value</h2><p>Positions reconstructed from dated Robinhood activity</p></div>'+
      tabs('history-range',ranges,state.historyRange)+'</header>'+
      '<div class="history-hero"><div><span>Latest close · '+when(latest.date)+'</span><strong>'+money(state,latest.value)+'</strong></div><div class="history-change">'+
        (lowCoverage?'<span>Available history</span><b>'+dateSpan+'</b><span>'+pct(first.coverage,1)+' price coverage at start</span>':
        '<span>Change in basket value</span><b class="'+ink(change)+'">'+(state.privateMode?'••••':money(state,change,{signed:true})+' <small>'+pct(100*change/first.value,2,true)+'</small>')+'</b><span>'+dateSpan+'</span>')+'</div></div>'+
      (state.privateMode?'<div class="history-hidden">'+svg('EyeOff',19)+'<span>Closing-value chart hidden</span></div>':'<div id="portfolio-chart" class="history-chart"></div>')+
      '<div class="history-key"><span><i class="history-line"></i>Reconstructed positions</span><span><i class="history-line is-backcast"></i>Earlier records</span><span><i class="history-checkpoint"></i>Statement value</span><span>Bars above the lane show net buys or deposits. Select a mark for details.</span></div>'+
      '<p class="history-caption">The chart values positions using dated executions and market closes. The latest point uses the Robinhood snapshot. Brokerage cash is excluded.</p></section>'+
    '<aside class="card history-inspector" tabindex="-1" aria-label="Selected date details"><header class="history-head"><div><h2>Day in detail</h2><p>Pick a point or a dated record</p></div>'+svg('Clock',18)+'</header>'+
      '<div class="history-readout"><div id="history-hover-date">'+when(selectedDay)+'</div><strong id="history-hover-value">'+(quote?moneyExact(state,quote.value):'—')+'</strong>'+
      '<div id="history-hover-meta">'+(quote?'Closing estimate'+coverage:'No market close recorded')+'</div>'+
      (statement?'<div class="history-inspected-statement">Statement value <b>'+moneyExact(state,statement.value)+'</b></div>':'')+'</div>'+
      activityPreview(state,transactions,data,selectedDay)+activityNavigator(state,groups)+'</aside></div>'+
    dayDetails(state,selectedDay,transactions,data,holdings)+
    '<section class="card history-close"><header class="history-head"><div><h2>Daily closing ledger</h2><p>'+closeRows.length+' trading closes · '+when(closeRows[0].date)+' – '+when(latest.date)+' · Eastern time</p></div><div class="history-close-controls">'+
      tabs('history-calendar',[['sessions','30 sessions'],['days','30 calendar days']],state.historyCalendar)+
      '<button class="quiet" data-action="history-export" '+(state.privateMode?'disabled':'')+'>'+svg('Download',15)+' CSV</button></div></header>'+
      '<div class="table-scroll" tabindex="0" aria-label="Daily closing values"><table><thead><tr><th scope="col">Date</th><th scope="col">Estimated close</th><th scope="col">Day change</th><th scope="col">Equity</th><th scope="col">ETFs</th><th scope="col">Crypto</th><th scope="col">Price coverage</th></tr></thead><tbody>'+
      [...closeRows].reverse().map(row=>{
        const prev=previousByDate.get(row.date);
        const diff=prev ? row.value-prev.value : null;
        return '<tr><th scope="row"><button class="plain-link history-date-button" data-action="history-inspect" data-value="'+row.date+'">'+when(row.date)+'</button>'+(row.latest?'<span class="history-latest">Latest</span>':'')+'</th>'+
          '<td><b>'+moneyExact(state,row.value)+'</b></td><td class="'+ink(diff)+'">'+money(state,diff,{signed:true,compact:false})+'</td>'+
          '<td>'+moneyExact(state,row.equity)+'</td><td>'+moneyExact(state,row.funds)+'</td><td>'+moneyExact(state,row.crypto)+'</td><td>'+pct(row.coverage,2)+'</td></tr>';
      }).join('')+'</tbody></table></div></section>'+
    '<section class="card history-notes"><header class="history-head"><div><h2>Statement checkpoints</h2><p>Dated account values from the source statements</p></div></header>'+
      '<div class="history-checkpoints">'+statements.map(s=>'<div><i class="history-checkpoint"></i><span><b>'+e(s.label)+'</b><small>'+when(s.date)+'</small></span><strong>'+moneyExact(state,s.value)+'</strong></div>').join('')+'</div>'+
      '<details><summary>How the closing estimates are calculated</summary><div><p>Historical values use Yahoo Finance closing prices and positions reconstructed from Robinhood executions. A recent close may carry forward between trading sessions.</p><p>The broker trade report covers '+coverageLabel(data.tradeCoverage)+'. The cash ledger covers '+coverageLabel(data.cashCoverage)+'. The chart values securities, excluding brokerage cash. Incomplete portfolio valuations are unavailable.</p></div></details></section>';
}

export function renderHistoryChart(container,state,data,scope,onSelect) {
  const source=data.scopes[scope];
  const [from,through]=historyWindow(state,data);
  const points=source.points.filter(p=>p.date>=from&&p.date<=through);
  const statements=source.statements.filter(r=>r.date>=from&&r.date<=through);
  const groups=activityGroups(source.events,from,through,state.historyActivity);
  const canvas=document.createElement('canvas');
  canvas.tabIndex=0;
  canvas.setAttribute('aria-label','Portfolio closing value and activity. Use the arrow keys to inspect dates, Page Up or Page Down to jump between activity dates, and Enter to select.');
  const tip=document.createElement('div');
  tip.className='chart-tooltip history-tooltip';
  tip.hidden=true;
  container.append(canvas,tip);
  const ctx=canvas.getContext('2d');
  const dates=[...new Set([...points.map(p=>p.date),...statements.map(p=>p.date),...groups.map(g=>g[0])])].sort();
  const byDate=new Map(points.map(p=>[p.date,p]));
  const statementByDate=new Map(statements.map(p=>[p.date,p]));
  const eventByDate=new Map(groups);
  const dated=dates.map(day=>[day,millis(day)]);
  const timestamps=new Map(dated);
  const activity=groups.map(([day,items])=>({day,...activityKinds(items),...totals(items)}));
  const maxTrade=Math.max(1,...activity.map(row=>Math.abs(row.tradeNet)));
  const maxBank=Math.max(1,...activity.map(row=>Math.abs(row.bankNet)));
  const lanes=[['trade','Trades',30],['cash','Bank',57],['records','Lots',81]];
  const initial=dates.includes(state.historyDate)?state.historyDate:dates.at(-1);
  let active=null, layout;
  const start=millis(dates[0]), span=millis(dates.at(-1))-start || 1;
  const extrema=points.map(p=>p.value).concat(statements.map(p=>p.value));
  const min=Math.min(...extrema),max=Math.max(...extrema);
  const spanValue=max-min||max*.05||1;
  const rough=spanValue/4, power=10**Math.floor(Math.log10(rough));
  const step=([1,2,2.5,5,10].find(x=>x>=rough/power)||10)*power;
  const low=Math.floor((min-spanValue*.06)/step)*step;
  const high=Math.ceil((max+spanValue*.08)/step)*step;
  const theme=()=>getComputedStyle(container);
  function plot() {
    const w=container.clientWidth,h=container.clientHeight,ratio=window.devicePixelRatio||1;
    if (!w || !h) return;
    canvas.width=w*ratio; canvas.height=h*ratio;
    ctx.scale(ratio,ratio);
    const narrow=w<520, left=narrow?60:77, right=w-15, top=16, base=h-118;
    const x=day=>left+(timestamps.get(day)-start)/span*(right-left);
    const y=value=>top+(high-value)/(high-low)*(base-top);
    layout={x,y,left,right,base,top};
    const css=theme();
    const color=key=>css.getPropertyValue('--'+key).trim();
    ctx.font='11px "DM Sans", sans-serif';
    ctx.lineWidth=1;
    ctx.textAlign='right';ctx.textBaseline='middle';
    for(let v=low;v<=high+.001;v+=step){
      ctx.strokeStyle=color('line');ctx.beginPath();ctx.moveTo(left,y(v));ctx.lineTo(right,y(v));ctx.stroke();
      ctx.fillStyle=color('muted');ctx.fillText(cash(v),left-8,y(v));
    }
    const ticks=narrow?3:6;
    for(let i=0;i<ticks;i++){
      const target=start+i/(ticks-1)*span;
      const [day]=dated.reduce((a,b)=>Math.abs(a[1]-target)<Math.abs(b[1]-target)?a:b);
      ctx.textAlign=i===0?'left':i===ticks-1?'right':'center';
      ctx.fillStyle=color('muted');
      ctx.fillText(['5Y','all'].includes(state.historyRange)?when(day,{month:'short',year:'numeric'}):shortDate(day),x(day),h-10);
    }
    const custodyIndex=points.findIndex(row=>row.date>=data.custody);
    function drawSeries(series, dashed) {
      if (series.length<2) return;
      ctx.beginPath();
      series.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](x(p.date),y(p.value)));
      ctx.lineWidth=dashed?1.65:2.35;
      ctx.strokeStyle=color(dashed?'muted':'accent');
      ctx.setLineDash(dashed?[5,4]:[]);
      ctx.lineJoin='round';ctx.stroke();ctx.setLineDash([]);
    }
    if(custodyIndex===-1) drawSeries(points,true);
    else {
      if(custodyIndex>0) drawSeries(points.slice(0,custodyIndex+1),true);
      drawSeries(points.slice(custodyIndex),false);
    }
    ctx.fillStyle=color('blue');
    for(const p of statements){
      ctx.save();ctx.translate(x(p.date),y(p.value));ctx.rotate(Math.PI/4);ctx.fillRect(-4,-4,8,8);ctx.restore();
    }
    for(const [,label,offset] of lanes){
      ctx.textAlign='right';ctx.fillStyle=color('muted');ctx.fillText(label,left-8,base+offset);
      ctx.beginPath();ctx.moveTo(left,base+offset);ctx.lineTo(right,base+offset);
      ctx.strokeStyle=color('line');ctx.lineWidth=1;ctx.stroke();
    }
    function bar(px,py,net,max,incoming,outgoing){
      const height=Math.min(11,2+9*Math.sqrt(Math.abs(net)/max));
      ctx.fillStyle=color(net===0?'muted':net>0?incoming:outgoing);
      ctx.fillRect(px-1.7,net>0?py-height:py,3.4,height);
    }
    for(const row of activity){
      const px=x(row.day);
      if(row.trade)bar(px,base+30,row.tradeNet,maxTrade,'gain','loss');
      if(row.cash)bar(px,base+57,row.bankNet,maxBank,'blue','loss');
      if(row.records){ctx.fillStyle=color('quiet');ctx.fillRect(px-1.25,base+79,2.5,4);}
    }
    const cursor=active || (state.historyDate?initial:null);
    if(cursor){
      ctx.strokeStyle=color('quiet');ctx.beginPath();ctx.moveTo(x(cursor),top);ctx.lineTo(x(cursor),base+89);ctx.stroke();
      const p=byDate.get(cursor);
      if(p){ctx.beginPath();ctx.arc(x(cursor),y(p.value),4.2,0,Math.PI*2);ctx.fillStyle=color('accent');ctx.fill();}
    }
  }
  function closest(event) {
    const bounds=canvas.getBoundingClientRect();
    const x=event.clientX-bounds.left,y=event.clientY-bounds.top;
    const lane=lanes.find(([, ,offset])=>Math.abs(y-layout.base-offset)<=12);
    const nearby=lane?activity.filter(row=>row[lane[0]] && Math.abs(layout.x(row.day)-x)<18).map(row=>row.day):[];
    const options=nearby.length?nearby:dates;
    return options.reduce((best,day)=>Math.abs(layout.x(day)-x)<Math.abs(layout.x(best)-x)?day:best,options[0]);
  }
  function inspect(day) {
    if (day===active && !tip.hidden) return;
    active=day;
    const p=byDate.get(day), statement=statementByDate.get(day), events=eventByDate.get(day)??[];
    const flags=activityKinds(events), net=totals(events);
    tip.innerHTML='<b>'+when(day)+'</b>'+(p?'<span>'+moneyExact(state,p.value)+' · Closing estimate</span>':'')+
      (statement?'<span>'+moneyExact(state,statement.value)+' · Statement</span>':'')+
      (flags.trade?'<span>Trades · '+(net.tradeNet>=0?'Net buy ':'Net sell ')+moneyExact(state,Math.abs(net.tradeNet))+'</span>':'')+
      (flags.cash?'<span>Bank · '+(net.bankNet>=0?'Net deposit ':'Net withdrawal ')+moneyExact(state,Math.abs(net.bankNet))+'</span>':'')+
      (flags.records?'<span>Open lots or position records</span>':'');
    tip.hidden=false;
    tip.style.left=Math.min(Math.max(5,layout.x(day)+10),container.clientWidth-tip.offsetWidth-5)+'px';
    tip.style.top='8px';
    plot();
  }
  canvas.addEventListener('pointermove',event=>{if(layout && event.pointerType!=='touch')inspect(closest(event));});
  canvas.addEventListener('pointerleave',()=>{tip.hidden=true;active=null;plot();});
  canvas.addEventListener('click',event=>{
    if(layout) {
      const day=closest(event);
      onSelect(day,eventByDate.has(day) && matchMedia('(max-width: 920px)').matches);
    }
  });
  canvas.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();onSelect(active||initial);return;}
    if(!['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)||!layout)return;
    event.preventDefault();
    const currentDay=active||initial;
    if(event.key==='PageUp'||event.key==='PageDown'){
      const activityDay=event.key==='PageUp'?groups.findLast(([day])=>day<currentDay):groups.find(([day])=>day>currentDay);
      if(activityDay) {inspect(activityDay[0]);canvas.setAttribute('aria-label',tip.textContent+'. Press Enter to select.');}
      return;
    }
    const current=dates.indexOf(currentDay);
    const next=event.key==='Home'?0:event.key==='End'?dates.length-1:
      Math.max(0,Math.min(dates.length-1,current+(event.key==='ArrowLeft'?-1:1)));
    inspect(dates[next]);
    canvas.setAttribute('aria-label',tip.textContent+'. Press Enter to select.');
  });
  canvas.addEventListener('blur',()=>{tip.hidden=true;active=null;plot();});
  const resize=new ResizeObserver(plot);
  resize.observe(container);
  return ()=>resize.disconnect();
}
