import {nameOf} from './format.js';

const normalize = text => String(text??'').normalize('NFKD').toLowerCase()
  .replace(/\p{M}/gu,'').replace(/[^a-z0-9]+/g,' ').trim();

export function buildHoldingIndex(model) {
  const aliases = new Map();
  for(const account of model.selected) {
    for(const [oldName,currentName] of account.recon.renamed ?? []) {
      const key=normalize(currentName);
      if(!aliases.has(key)) aliases.set(key,new Set());
      aliases.get(key).add(oldName);
    }
  }
  const rows = model.rows.slice().sort((a,b)=>nameOf(a).localeCompare(nameOf(b),'en-IN',{numeric:true}));
  const tokens = new Map();
  const identity = new Map();
  function indexToken(token, row, weight) {
    if(!tokens.has(token)) tokens.set(token,new Map());
    const postings=tokens.get(token);
    postings.set(row.isin,Math.max(weight,postings.get(row.isin)??0));
  }
  for(const row of rows) {
    const symbol=row.symbol?.replace(/\.(NS|BO)$/,'');
    const names=new Set([row.label,row.name,...(aliases.get(normalize(row.name))??[])]);
    identity.set(row.isin,new Set([symbol,row.symbol,row.isin].filter(Boolean).flatMap(value=>[
      normalize(value),normalize(value).replaceAll(' ',''),
    ])));
    const fields=[
      [symbol,32],[row.symbol,25],[row.isin,28],...[...names].map(name=>[name,18]),
      [row.sector,6],[row.industry,7],[row.navType,5],[row.fund?.house,8],[row.fund?.category,5],
    ];
    for(const [field,weight] of fields) {
      const words=normalize(field).split(' ').filter(Boolean);
      const terms=new Set(words);
      if(weight>=25 && words.length>1) terms.add(words.join(''));
      for(const token of terms) {
        indexToken(token,row,weight+8);
        for(let length=1;length<token.length;length++) indexToken(token.slice(0,length),row,weight);
      }
    }
  }
  return {rows,tokens,identity};
}

export function lookup(index,query) {
  const text=normalize(query);
  const words=[...new Set(text.split(' ').filter(Boolean))];
  const lists=words.map(word=>index.tokens.get(word)??new Map());
  const matches=index.rows.filter(row=>lists.every(postings=>postings.has(row.isin)));
  if(!words.length) return matches;
  const score=row=>(index.identity.get(row.isin).has(text)?100:0) +
    (normalize(nameOf(row)).startsWith(text)?12:0)+lists.reduce((sum,postings)=>sum+postings.get(row.isin),0);
  return matches.sort((a,b)=>score(b)-score(a));
}
