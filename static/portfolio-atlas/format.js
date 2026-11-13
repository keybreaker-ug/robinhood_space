import icons from './icons.js';

const decimal = new Intl.NumberFormat('en-US', {maximumFractionDigits:2});
const whole = new Intl.NumberFormat('en-US', {maximumFractionDigits:0});
const two = new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const num = value => Number.isFinite(value) ? decimal.format(value) : '—';
export const quantity = value => Number.isFinite(value)
  ? value.toLocaleString('en-US',{maximumFractionDigits:Math.abs(value)<0.01?12:2}) : '—';
export const fixed = (value, digits=2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
export const sign = value => value < 0 ? '−' : value > 0 ? '+' : '';
export const pct = (value, digits=2, signed=false) => Number.isFinite(value)
  ? (value < 0 ? '−' : signed ? sign(value) : '') + Math.abs(value).toFixed(digits) + '%'
  : '—';
export const ink = value => value < 0 ? 'negative' : value > 0 ? 'positive' : '';
export const when = (value, options={day:'numeric',month:'short',year:'numeric'}) =>
  value ? new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York', ...options}).format(new Date(value.length === 10 ? value+'T12:00:00Z' : value)) : '—';
export const cash = (value, {compact=true, signed=false, privateMode=false}={}) => {
  if (!Number.isFinite(value)) return '—';
  if (privateMode) return '$••••';
  const prefix = (value < 0 ? '−' : signed ? sign(value) : '') + '$';
  const magnitude = Math.abs(value);
  if (compact && magnitude >= 1e9) return prefix + two.format(magnitude / 1e9) + 'B';
  if (compact && magnitude >= 1e6) return prefix + two.format(magnitude / 1e6) + 'M';
  return prefix + (compact ? whole : decimal).format(magnitude);
};
export const svg = (name, size=18) => '<svg aria-hidden="true" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+(icons[name] ?? '')+'</svg>';
export const titleCase = value => value && value === value.toUpperCase()
  ? value.toLowerCase().replace(/\b[a-z]/g, match => match.toUpperCase()).replace(/\b(Bse|Nse|Itc|Hdfc|Icici|Idfc|Ltim|Jsw|Jio|Sbi|Adf|Ntpc|Tcs|L&t|Etf|Elss|Idcw|TvS|CdsL)\b/gi, match => match.toUpperCase())
  : value;
export const ticker = row => row.symbol?.replace(/\.(NS|BO)$/,'') || (row.navType === 'ETF' ? 'ETF' : row.navType === 'Mutual fund' ? 'FUND' : row.isin.slice(-5));
export const nameOf = row => titleCase(row.label);
export function shortName(row) {
  const name = nameOf(row);
  return name?.replace(/\bMutual Fund\b/gi,'').replace(/\s+Limited\.?$/i,'').replace(/\bOpen Ended\b/gi,'').replace(/\s+/g,' ').trim();
}
export const empty = (title, detail='') => '<div class="empty"><span>'+svg('Info',19)+'</span><strong>'+escape(title)+'</strong>'+(detail?'<p>'+escape(detail)+'</p>':'')+'</div>';
