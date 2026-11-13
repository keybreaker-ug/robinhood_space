import {inRange} from './model.js';
import {pct, when} from './format.js';

export const vooSipName = 'VOO (2 week SIP)';
export const adjustedCloseField = 2;

function sharedPeriod(points, benchmark) {
  const first = points.findIndex(point => benchmark.has(point[0]));
  const last = points.findLastIndex(point => benchmark.has(point[0]));
  return last > first ? points.slice(first,last+1) : [];
}

export function renderChart(container, {points, range, field=1, comparison=[], sipComparison=[], mode='level', currency='', name='', volume=false, accent, measure, peerName='S&P 500', peerColor}) {
  const absoluteComparison = mode === 'comparison';
  const comparisonByDate = new Map(comparison);
  const sipByDate = new Map(sipComparison);
  const inPeriod = inRange(points,range).filter(p => absoluteComparison
    ? [p[field],comparisonByDate.get(p[0]),sipByDate.get(p[0])].some(Number.isFinite) : p[field] > 0);
  const indexed = mode === 'return';
  const compareByDay = new Map(comparison.filter(p => p[1] > 0).map(p => [p[0],p[1]]));
  const active = indexed ? sharedPeriod(inPeriod,compareByDay) : inPeriod;
  if (active.length < 2) return () => {};
  const base = active[0][field];
  const compareBase = compareByDay.get(active[0][0]);
  const plot = active.map(p => ({
    date:p[0], price:p[field], peerPrice:compareByDay.get(p[0]), y:indexed ? (p[field] / base - 1)*100 : p[field],
    peer:absoluteComparison ? comparisonByDate.get(p[0]) : indexed && compareBase && compareByDay.has(p[0]) ? (compareByDay.get(p[0])/compareBase-1)*100 : null,
    sip:sipByDate.get(p[0]),
    volume:p[3],
  }));
  const includeYear = range.endsWith('Y') || (range === 'All' && plot[0].date.slice(0,4) !== plot.at(-1).date.slice(0,4));
  const dateFormat = includeYear ? {month:'short',year:'2-digit'} : {month:'short',day:'numeric'};
  container.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  const hasSip=plot.some(p=>Number.isFinite(p.sip));
  canvas.setAttribute('aria-label', (absoluteComparison ? name+' vs '+peerName+(hasSip?' and '+vooSipName:'')+' value chart.' : name + ' chart. ' + range + ' change ' + pct((active.at(-1)[field]/base-1)*100,2,true) + '.') + ' Use left and right arrow keys to inspect dates.' + (measure ? ' Hold Shift while using the arrow keys to measure a period.' : ''));
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  container.append(canvas,tooltip);
  const ctx = canvas.getContext('2d');
  let selection = null;
  let plotBounds;
  const pointIndex = date => plot.findIndex(point => point.date === date);
  const saved = measure?.period?.map(pointIndex);
  let interval = saved?.every(i=>i>=0) ? saved : null;
  let anchor = null;
  let drag = null;
  const priceLabel = new Intl.NumberFormat('en-US',{maximumFractionDigits:currency ? 4 : 2});
  const priceText = value => currency + priceLabel.format(value);
  const label = value => indexed ? pct(value,1,true) : priceText(value);
  const result = measure?.element.querySelector('[data-measure-result]');
  const clear = measure?.element.querySelector('button');
  function showMeasure() {
    if (!result) return;
    if (!interval) {
      result.textContent = 'Drag between two dates to measure change.';
      clear.hidden = true;
      return;
    }
    const [first,last] = interval;
    const from = plot[first], to = plot[last];
    const change = (to.price/from.price - 1)*100;
    const delta = to.price-from.price;
    const benchmark = indexed && from.peerPrice > 0 && to.peerPrice > 0
      ? (to.peerPrice/from.peerPrice-1)*100 : null;
    result.replaceChildren();
    const strong = document.createElement('strong');
    strong.className = change < 0 ? 'negative' : change > 0 ? 'positive' : '';
    strong.textContent = pct(change,2,true);
    result.append(strong, ' ', when(from.date)+' → '+when(to.date));
    const details = document.createElement('small');
    details.textContent = priceText(from.price)+' → '+priceText(to.price)+' · '+(delta<0?'−':'+')+priceText(Math.abs(delta))+
      ' · '+(last-first)+' sessions'+(benchmark===null?'':' · '+peerName+' '+pct(benchmark,2,true)+
      ' · Relative '+(change-benchmark>=0?'+':'')+(change-benchmark).toFixed(2)+' pp');
    result.append(details);
    clear.hidden = false;
  }
  function commit() {
    showMeasure();
    if (measure) {
      measure.onChange(interval ? interval.map(i=>plot[i].date) : null);
      measure.element.querySelector('[data-measure-live]').textContent=result.textContent;
    }
  }
  function setInterval(start,end) {
    interval = start===end ? null : [Math.min(start,end),Math.max(start,end)];
    showMeasure();
  }
  function pointAt(event) {
    const [left,width] = plotBounds;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    return Math.round(Math.max(0,Math.min(1,(x-left)/width))*(plot.length-1));
  }
  canvas.addEventListener('pointermove',event => {
    if (!plotBounds || (drag && event.pointerId !== drag.id)) return;
    selection = pointAt(event);
    if (drag && (drag.moved || Math.abs(event.clientX-drag.x)>=4)) {
      drag.moved=true;
      setInterval(drag.start,selection);
    }
    draw();
  });
  if (measure) {
    canvas.classList.add('measure-chart');
    canvas.addEventListener('pointerdown',event => {
      if (!plotBounds || event.button!==0 || !event.isPrimary) return;
      drag={id:event.pointerId,x:event.clientX,start:pointAt(event),prior:interval,moved:false};
      anchor=null;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerup',event => {
      if (drag?.id!==event.pointerId) return;
      if (drag.moved) {
        setInterval(drag.start,pointAt(event));
        commit();
      }
      drag=null;
      draw();
    });
    canvas.addEventListener('pointercancel',event => {
      if (drag?.id!==event.pointerId) return;
      interval=drag.prior;
      drag=null;
      selection=null;
      showMeasure();
      draw();
    });
    clear.addEventListener('click',()=>{
      interval=null;
      anchor=null;
      canvas.focus({preventScroll:true});
      commit();
      draw();
    });
    showMeasure();
  }
  canvas.addEventListener('pointerleave',() => {if(!drag){selection=null;draw();}});
  canvas.addEventListener('blur',() => {selection=null;draw();});
  canvas.addEventListener('keydown',event => {
    if (event.key==='Escape' && interval) {
      event.preventDefault();
      interval=null;
      anchor=null;
      commit();
      draw();
      return;
    }
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const prior=selection ?? plot.length-1;
    if (event.key==='Home') selection=0;
    else if (event.key==='End') selection=plot.length-1;
    else selection=Math.max(0,Math.min(plot.length-1,prior+(event.key==='ArrowRight'?1:-1)));
    if(measure && event.shiftKey) {
      anchor ??= prior;
      setInterval(anchor,selection);
      commit();
    } else anchor=null;
    draw();
  });
  function draw() {
    if (!container.isConnected || !container.clientWidth) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = window.devicePixelRatio || 1;
    canvas.width = width*scale;
    canvas.height = height*scale;
    ctx.scale(scale,scale);
    const css = getComputedStyle(container);
    const line = accent ?? (css.getPropertyValue('--chart-accent').trim() || css.getPropertyValue('--accent').trim());
    const grid = css.getPropertyValue('--line').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const panel = css.getPropertyValue('--surface').trim();
    const peer = peerColor ?? css.getPropertyValue('--blue').trim();
    const font = '11px "DM Sans", sans-serif';
    ctx.font = font;
    const sipColor = css.getPropertyValue('--voo-sip').trim();
    const values = plot.flatMap(p => [p.y,p.peer,p.sip]).filter(Number.isFinite);
    const min = Math.min(...values), max = Math.max(...values);
    const margin = (max-min)*.08 || Math.max(Math.abs(max)*.02, .05);
    const rough = (max-min+margin*2)/4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = ([1,2,2.5,5,10].find(n => n >= rough/magnitude) ?? 10) * magnitude;
    const low = Math.max(indexed ? -100 : 0,min-margin);
    const high = Math.max(max+margin,low+.01);
    const firstTick = Math.floor(high/step)*step;
    const left = Math.ceil(ctx.measureText(label(high)).width) + 13;
    const right = width-10;
    const top = 14, bottom = height-27;
    const x = i => left+i/(plot.length-1)*(right-left);
    const y = value => top+(high-value)/(high-low)*(bottom-top);
    plotBounds = [left,right-left];
    ctx.textBaseline = 'middle';
    for (let level=firstTick; level>=low; level-=step) {
      const heightAtLevel = y(level);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left,heightAtLevel); ctx.lineTo(right,heightAtLevel); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.fillText(label(level),left-10,heightAtLevel);
    }
    const columns = width < 420 ? 3 : 6;
    for (let i=0;i<columns;i++) {
      const index = Math.round(i*(plot.length-1)/(columns-1));
      ctx.textAlign = i===0 ? 'left' : i===columns-1 ? 'right' : 'center';
      ctx.fillStyle = muted;
      ctx.fillText(when(plot[index].date,dateFormat),x(index),height-10);
    }
    if (volume) {
      const maxVolume = Math.max(...plot.map(p => p.volume || 0));
      if (maxVolume) {
        ctx.fillStyle = line;
        ctx.globalAlpha = .25;
        const barWidth = Math.max(1,(right-left)/plot.length*.6);
        plot.forEach((p,i) => {const size=(p.volume || 0)/maxVolume*(bottom-top)*.23;ctx.fillRect(x(i)-barWidth/2,bottom-size,barWidth,size);});
        ctx.globalAlpha = 1;
      }
    }
    if (!absoluteComparison) {
      ctx.beginPath();
      plot.forEach((p,i) => i === 0 ? ctx.moveTo(x(i),y(p.y)) : ctx.lineTo(x(i),y(p.y)));
      const gradient = ctx.createLinearGradient(0,top,0,bottom);
      gradient.addColorStop(0,line);
      gradient.addColorStop(1,panel);
      ctx.lineTo(right,bottom);ctx.lineTo(left,bottom);ctx.closePath();
      ctx.globalAlpha = .20;ctx.fillStyle = gradient;ctx.fill();ctx.globalAlpha=1;
    }
    const series = hasSip ? [['sip',sipColor],['peer',peer],['y',line]] : [['peer',peer],['y',line]];
    for (const [key,color] of series) {
      ctx.beginPath();
      let first=true;
      plot.forEach((p,i) => {
        if (!Number.isFinite(p[key])) {if (absoluteComparison) first=true;return;}
        if(first){ctx.moveTo(x(i),y(p[key]));first=false;}
        else ctx.lineTo(x(i),y(p[key]));
      });
      ctx.strokeStyle=color;ctx.lineWidth=key==='y'?2:1.3;
      if (key==='sip') ctx.setLineDash([5,3]);
      ctx.stroke();
      if (key==='sip') ctx.setLineDash([]);
    }
    if (interval) {
      const [first,last] = interval;
      ctx.fillStyle=line;
      ctx.globalAlpha=.15;
      ctx.fillRect(x(first),top,x(last)-x(first),bottom-top);
      ctx.globalAlpha=1;
      for (const index of interval) {
        const px=x(index);
        ctx.strokeStyle=line;
        ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.stroke();
        ctx.beginPath();ctx.arc(px,y(plot[index].y),4,0,2*Math.PI);ctx.fillStyle=line;ctx.fill();
      }
    }
    if (selection === null || drag?.moved || interval) {tooltip.hidden=true;return;}
    const point=plot[selection], px=x(selection), py=y(point.y ?? point.peer ?? point.sip);
    ctx.strokeStyle=muted;ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.arc(px,py,4.5,0,2*Math.PI);ctx.fillStyle=point.y!=null?line:point.peer!=null?peer:sipColor;ctx.fill();ctx.strokeStyle=panel;ctx.lineWidth=2;ctx.stroke();
    tooltip.hidden=false;
    tooltip.textContent=when(point.date)+(point.y==null?'':' · '+(absoluteComparison?name+' ':'')+label(point.y))+
      (point.peer==null?'':' · '+peerName+' '+(absoluteComparison?label(point.peer):pct(point.peer,1,true)))+
      (point.sip==null?'':' · '+vooSipName+' '+label(point.sip));
    tooltip.style.left=Math.max(3,Math.min(px+10,width-tooltip.offsetWidth-4))+'px';
    tooltip.style.top=Math.max(2,Math.min(py-34,height-55))+'px';
  }
  const observer = new ResizeObserver(draw);
  observer.observe(container);
  draw();
  return () => observer.disconnect();
}

export function seriesChange(points, range, field=1, comparison) {
  const inPeriod=inRange(points,range).filter(p => p[field]>0);
  const active=comparison ? sharedPeriod(inPeriod,new Set(comparison.filter(p=>p[1]>0).map(p=>p[0]))) : inPeriod;
  if(active.length<2) return {change:null,last:null};
  return {change:(active.at(-1)[field]/active[0][field]-1)*100,first:active[0],last:active.at(-1),high:Math.max(...active.map(p=>p[field])),low:Math.min(...active.map(p=>p[field]))};
}
