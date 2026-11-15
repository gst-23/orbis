/** Calendar computations using floating local wall time (YYYY-MM-DDTHH:mm).
 * All dates are calendar dates, not UTC instants. Client and server agree on the
 * same Italian calendar day even across daylight-saving changes.
 */
const DAY_MS = 86400000;
const pad = value => String(value).padStart(2, '0');
export function dateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function localNowString(date = new Date()) {
  return `${dateString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function dayFromISO(isoDate) {
  const [y,m,d] = isoDate.slice(0,10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m-1, d) / DAY_MS);
}
export function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
export function shiftDay(isoDate, count) {
  return fromDayNumber(dayFromISO(isoDate) + count);
}
export function startOfWeek(isoDate) {
  const dow = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).getUTCDay();
  return shiftDay(isoDate, -(dow + 6) % 7);
}
export function monthLength(y,m) { return new Date(Date.UTC(y,m,0)).getUTCDate(); }
function monthShift(day, offset) {
  const [y,m,d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y,m-1+offset,1));
  const ty=first.getUTCFullYear(), tm=first.getUTCMonth()+1;
  return `${ty}-${pad(tm)}-${pad(Math.min(d,monthLength(ty,tm)))}`;
}
export function addMinutes(start, minutes) {
  const [date, time] = start.split('T');
  const [h,m]=time.split(':').map(Number);
  const total = dayFromISO(date) * 1440 + h * 60 + m + minutes;
  const day = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  return `${fromDayNumber(day)}T${pad(Math.floor(mins/60))}:${pad(mins%60)}`;
}
export function minuteNumber(value) {
  const [day,clock] = String(value).split('T');
  const [h,m] = clock.split(':').map(Number);
  return dayFromISO(day) * 1440 + h*60 + m;
}
export function originalAt(ev, index) {
  const base = ev.start_at;
  if (!ev.recurrence_unit || index===0) return base;
  const n=index*(Number(ev.recurrence_interval)||1);
  const [day,clock]=base.split('T');
  switch(ev.recurrence_unit) {
    case 'days': return `${shiftDay(day,n)}T${clock}`;
    case 'weeks': return `${shiftDay(day,n*7)}T${clock}`;
    case 'months': return `${monthShift(day,n)}T${clock}`;
    case 'years': return `${monthShift(day,n*12)}T${clock}`;
    default: return base;
  }
}
function indexNear(ev, fromDay) {
  const interval = Number(ev.recurrence_interval)||1;
  const dayDifference=dayFromISO(fromDay)-dayFromISO(ev.start_at.slice(0,10));
  if (dayDifference<=0) return 0;
  if(ev.recurrence_unit==='days') return Math.max(0,Math.floor(dayDifference/interval)-3);
  if(ev.recurrence_unit==='weeks') return Math.max(0,Math.floor(dayDifference/(7*interval))-3);
  const [fy,fm]=fromDay.split('-').map(Number);
  const [y,m]=ev.start_at.slice(0,10).split('-').map(Number);
  const months=(fy-y)*12+fm-m;
  if(ev.recurrence_unit==='months') return Math.max(0,Math.floor(months/interval)-3);
  if(ev.recurrence_unit==='years') return Math.max(0,Math.floor(months/(12*interval))-3);
  return 0;
}
/** Return occurrence instances intersecting [fromDay, toDay) as date-only strings. */
export function expandEvents(events, fromDay, toDay) {
  const results=[];
  const from=minuteNumber(`${fromDay}T00:00`);
  const to=minuteNumber(`${toDay}T00:00`);
  function append(ev,original,override) {
    if (override === null) return;
    const actual = override && typeof override==='object' ? override : ev;
    const start=override && typeof override==='object' ? override.start_at : original;
    const duration=Number(actual.duration_min);
    if (!start || !Number.isFinite(duration) || duration<1 || duration>1439) return;
    const startNum=minuteNumber(start);
    if(startNum>=to || startNum+duration<=from) return;
    results.push({
      id:ev.id, uid:`${ev.id}|${original}`,
      original, original_start:original,
      title:actual.title, notes:actual.notes||'',
      start_at:start,duration_min:duration,end_at:addMinutes(start,duration),
      recurrence_unit:ev.recurrence_unit || null,
      recurrence_interval:ev.recurrence_interval || null,
      creator:actual.creator || ev.creator || 'one',
      revised:Boolean(override),
      event:ev,
    });
  }
  for(const ev of events) {
    if(!ev || !ev.start_at || !ev.id) continue;
    const overrides=(ev.overrides && typeof ev.overrides==='object') ? ev.overrides : {};
    const recurring=Boolean(ev.recurrence_unit);
    const initial=recurring ? indexNear(ev,shiftDay(fromDay,-2)) : 0;
    for(let i=initial;i<initial+1000;i++) {
      if(!recurring && i>0) break;
      const original=originalAt(ev,i);
      if(ev.recurrence_until && original.slice(0,10)>ev.recurrence_until) break;
      if (original>=`${toDay}T00:00`) break;
      if(Object.prototype.hasOwnProperty.call(overrides,original)) continue;
      append(ev,original,undefined);
    }
    // Separately include moved occurrences whose original dates are outside range.
    for(const [original,override] of Object.entries(overrides)) {
      if(override !== null && override && typeof override==='object') append(ev,original,override);
    }
  }
  return results.sort((a,b)=>a.start_at.localeCompare(b.start_at) || a.title.localeCompare(b.title, 'it'));
}
export function eventsOnDay(events, day) { return expandEvents(events,day,shiftDay(day,1)); }
export function conflictMatches(candidate, events, ignoreUid='', ignoreEventId='') {
  const from=shiftDay(candidate.start_at.slice(0,10), -1);
  const to=shiftDay(candidate.start_at.slice(0,10), 3);
  const s=minuteNumber(candidate.start_at), e=s+candidate.duration_min;
  return expandEvents(events,from,to).filter(o=>
    o.uid!==ignoreUid && o.id!==ignoreEventId && minuteNumber(o.start_at)<e &&
    minuteNumber(o.start_at)+o.duration_min>s
  );
}
export function sameDate(a,b) { return String(a).slice(0,10)===String(b).slice(0,10); }
