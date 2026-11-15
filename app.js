import {CONFIG} from './config.js';
import {dateString, localNowString, shiftDay, startOfWeek, dayFromISO, fromDayNumber, addMinutes, minuteNumber, expandEvents, eventsOnDay, conflictMatches, monthLength} from './recurrence.js';

/* Orbis Lite — static PWA + Supabase Data API. Shared publicly, without accounts. */
const $ = id => document.getElementById(id);
const VIEW_KEY='orbis-lite-view-v1';
const DEMO_STORE='orbis-lite-local-v1';
const MONTHS=new Intl.DateTimeFormat('it-IT',{month:'long',year:'numeric',timeZone:'UTC'});
const FULL_DATE=new Intl.DateTimeFormat('it-IT',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'});
const WEEKDAYS=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const daysOfWeek=['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
const colors=['one','two','three'];
const state={
  selected:dateString(), view:'month', events:[], mode:'demo', client:null, version:0,
  occurrenceMap:new Map(), edit:null, toastTimer:null, syncBusy:false,
  drag:null, hover:null, swipe:null, timelineScroll:null,
};
function readStore(key){try{return localStorage.getItem(key);}catch{return null;}}
function writeStore(key,value){try{localStorage.setItem(key,value);}catch{}}
function pad(n){return String(n).padStart(2,'0');}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function prettyTime(s){return s.slice(11,16);}
function humanDate(s,opts={weekday:'long',day:'numeric',month:'long'}){return new Intl.DateTimeFormat('it-IT',{...opts,timeZone:'UTC'}).format(new Date(`${s.slice(0,10)}T12:00:00Z`));}
function capital(s){return s.charAt(0).toLocaleUpperCase('it-IT')+s.slice(1);}
function uuid(){return globalThis.crypto?.randomUUID?.()||`evt-${Date.now()}-${Math.random().toString(36).slice(2,11)}`;}
function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function sameDay(a,b){return a?.slice(0,10)===b?.slice(0,10);}
function durationLabel(min){const h=Math.floor(min/60),m=min%60;return (h?`${h} h `:'')+(m?`${m} min`:'');}
function toast(message){
  const el=$('toast');el.textContent=message;el.classList.remove('hidden');
  clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),3600);
}
function isConfigured(){
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(CONFIG.supabaseUrl||'')
    && (CONFIG.publishableKey||'').length>=20 && !CONFIG.publishableKey.includes('INCOLLA');
}
function sampleEvents(){
  const day=dateString();
  return [
    {id:uuid(),title:'Appuntamento di esempio',notes:'Tocca per modificare o trascina per spostare',start_at:`${day}T10:30`,duration_min:60,creator:'one',recurrence_unit:null,recurrence_interval:null,recurrence_until:null,overrides:{},revision:1},
    {id:uuid(),title:'Attività ricorrente',notes:'Ogni settimana, sullo stesso giorno',start_at:`${day}T17:00`,duration_min:45,creator:'two',recurrence_unit:'weeks',recurrence_interval:1,recurrence_until:null,overrides:{},revision:1}
  ];
}
function demoLoad(){
  try{const raw=localStorage.getItem(DEMO_STORE);if(raw){const val=JSON.parse(raw);if(Array.isArray(val))return val;}}catch{}
  const sample=sampleEvents();demoSave(sample);return sample;
}
function demoSave(events){try{localStorage.setItem(DEMO_STORE,JSON.stringify(events));}catch{}}
function setBanner(text='',error=false){
  const el=$('modeBanner');el.textContent=text;el.classList.toggle('hidden',!text);el.classList.toggle('error',error);
}
function notifyCloudError(err){
  const message=err?.message||String(err);
  if(!navigator.onLine)toast('Sei offline. Le modifiche richiedono la connessione a Internet.');
  else toast(`Supabase: ${message}`);
}
async function getCloudEvents(){
  if(!state.client)throw Error('Supabase non è configurato.');
  const all=[];let from=0;
  for(let page=0;page<50;page++){
    const {data,error}=await state.client.from('orbis_events').select('*').range(from,from+999).order('created_at',{ascending:true});
    if(error)throw error;
    all.push(...(data||[]));
    if(!data || data.length<1000)break;
    from+=1000;
  }
  return all;
}
async function cloudRefresh({silent=false}={}){
  if(state.mode!=='cloud'||state.syncBusy)return;
  state.syncBusy=true;
  try{
    state.events=await getCloudEvents();
    if(!$('eventDialog').open&&!state.drag?.active)render();
    if(!silent)toast('Calendario aggiornato.');
  }catch(err){if(!silent)notifyCloudError(err);}finally{state.syncBusy=false;}
}
const DATA_FIELDS=['id','title','start_at','duration_min','notes','creator','recurrence_unit','recurrence_interval','recurrence_until','overrides','revision'];
function toRecord(ev){return Object.fromEntries(DATA_FIELDS.filter(k=>Object.hasOwn(ev,k)).map(k=>[k,ev[k]]));}
async function saveOne(next,isNew=false){
  if(state.mode==='error')throw Error('Non è possibile salvare: collegamento Supabase non riuscito.');
  let result={...next};
  if(state.mode==='cloud'){
    let request;
    if(isNew){
      result.revision=1;
      request=state.client.from('orbis_events').insert(toRecord(result)).select('*').single();
    }else{
      const prior=state.events.find(e=>e.id===next.id);
      if(!prior)throw Error('Appuntamento non trovato. Aggiorna la pagina.');
      result.revision=Number(prior.revision||1)+1;
      request=state.client.from('orbis_events').update(toRecord(result)).eq('id',next.id).eq('revision',Number(prior.revision||1)).select('*').maybeSingle();
    }
    const {data,error}=await request;
    if(error)throw error;
    if(!data){await cloudRefresh({silent:true});throw Error('Questo appuntamento è stato modificato da un altro telefono. Aggiorna e riprova.');}
    result=data;
  }else{
    result.revision=isNew?1:Number(next.revision||1)+1;
  }
  const idx=state.events.findIndex(e=>e.id===result.id);
  if(idx>=0)state.events[idx]=result;else state.events.push(result);
  if(state.mode==='demo')demoSave(state.events);
  render();
}
async function removeOne(event){
  if(state.mode==='error')throw Error('Collegamento Supabase non riuscito.');
  if(state.mode==='cloud'){
    const {data,error}=await state.client.from('orbis_events').delete().eq('id',event.id).eq('revision',Number(event.revision||1)).select('id').maybeSingle();
    if(error)throw error;
    if(!data){await cloudRefresh({silent:true});throw Error('Questo appuntamento è stato modificato da un altro telefono. Aggiorna e riprova.');}
  }
  state.events=state.events.filter(e=>e.id!==event.id);
  if(state.mode==='demo')demoSave(state.events);
  render();
}
function periodShift(dir){
  const d=state.selected;
  if(state.view==='day')state.selected=shiftDay(d,dir);
  if(state.view==='week')state.selected=shiftDay(d,dir*7);
  if(state.view==='month'){
    const [y,m,day]=d.split('-').map(Number);
    const first=new Date(Date.UTC(y,m-1+dir,1));
    const yr=first.getUTCFullYear(),mo=first.getUTCMonth()+1;
    state.selected=`${yr}-${pad(mo)}-${pad(Math.min(day,monthLength(yr,mo)))}`;
  }
  render();
}
function switchView(view){
  if(!['month','week','day'].includes(view))return;
  state.view=view;writeStore(VIEW_KEY,view);render();
}
function headerRender(){
  const sel=state.selected;
  if(state.view==='month'){
    $('periodTitle').textContent=capital(humanDate(sel,{month:'long',year:'numeric'}));
    $('periodSubtitle').textContent='Una giornata alla volta.';
  }else if(state.view==='week'){
    const from=startOfWeek(sel),to=shiftDay(from,6);
    $('periodTitle').textContent=capital(humanDate(sel,{month:'long',year:'numeric'}));
    $('periodSubtitle').textContent=`Settimana ${humanDate(from,{day:'numeric',month:'short'})} – ${humanDate(to,{day:'numeric',month:'short'})}`;
  }else{
    $('periodTitle').textContent=capital(humanDate(sel,{month:'long',year:'numeric'}));
    $('periodSubtitle').textContent=capital(humanDate(sel,{weekday:'long',day:'numeric'}));
  }
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===state.view);b.setAttribute('aria-pressed',String(b.dataset.view===state.view));});
  const isCloud=state.mode==='cloud';
  $('connectionStatus').textContent=isCloud?'Sincronizzato':state.mode==='demo'?'Demo locale':'Non collegato';
  $('connectionStatus').classList.toggle('cloud',isCloud);
}
function getMonthSpan(){
  const first=state.selected.slice(0,7)+'-01';
  const firstDay=startOfWeek(first);
  const [y,m]=first.split('-').map(Number);
  const end=fromDayNumber(dayFromISO(`${y}-${pad(m)}-${pad(monthLength(y,m))}`)+1);
  const diff=dayFromISO(end)-dayFromISO(firstDay);
  return [firstDay,shiftDay(firstDay,Math.ceil(diff/7)*7)];
}
function dotMarkup(occ){
  const distinct=[...new Set(occ.map(x=>colors.includes(x.creator)?x.creator:'one'))].slice(0,3);
  return `<div class="event-dots">${distinct.map(c=>`<span class="event-dot ${c}"></span>`).join('')}${occ.length>distinct.length?'<span class="event-dot more"></span>':''}</div>`;
}
function monthRender(){
  const [from,to]=getMonthSpan();
  const occ=expandEvents(state.events,from,to);
  const total=dayFromISO(to)-dayFromISO(from);
  let cells='';
  for(let i=0;i<total;i++){
    const day=shiftDay(from,i);
    const list=occ.filter(x=>x.start_at.slice(0,10)<=day && x.end_at.slice(0,10)>=day && minuteNumber(x.end_at)>minuteNumber(`${day}T00:00`));
    cells+=`<button type="button" class="day-cell ${day.slice(0,7)===state.selected.slice(0,7)?'':'outside'} ${day===state.selected?'selected':''} ${day===dateString()?'today':''}" data-day="${day}" aria-label="${capital(humanDate(day))}: ${list.length} appuntamenti"><span class="day-number">${Number(day.slice(-2))}</span>${dotMarkup(list)}</button>`;
  }
  $('calendarPanel').innerHTML=`<div class="weekday-head">${WEEKDAYS.map(d=>`<span>${d}</span>`).join('')}</div><div class="month-grid">${cells}</div><div class="month-footer"><span>Tocca un giorno per vedere gli impegni</span><span>${occ.length} occorrenze</span></div>`;
}
function weekRender(){
  const from=startOfWeek(state.selected),to=shiftDay(from,7);
  const occ=expandEvents(state.events,from,to);
  let cols='';
  for(let i=0;i<7;i++){
    const date=shiftDay(from,i),items=occ.filter(o=>o.start_at.slice(0,10)<=date&&o.end_at.slice(0,10)>=date&&minuteNumber(o.end_at)>minuteNumber(`${date}T00:00`));
    cols+=`<button class="week-date ${date===state.selected?'selected':''} ${date===dateString()?'today':''}" data-day="${date}" aria-label="${WEEKDAYS[i]} ${Number(date.slice(-2))}, ${items.length} appuntamenti"><span class="day-label">${WEEKDAYS[i]}</span><span class="day-number">${Number(date.slice(-2))}</span>${dotMarkup(items)}</button>`;
  }
  $('calendarPanel').innerHTML=`<div class="week-grid">${cols}</div><div class="week-summary"><span>Trascina un impegno sul giorno desiderato</span><strong>${occ.length} appuntamenti</strong></div>`;
}
function dayRender(){
  const day=state.selected,occ=eventsOnDay(state.events,day),weekIndex=new Date(`${day}T12:00:00Z`).getUTCDay();
  const slots=Array.from({length:24},(_,h)=>`<div class="hour-slot" style="top:${h*48}px" data-hour="${h}"><span>${pad(h)}:00</span></div>`).join('');
  const dayNumber=minuteNumber(`${day}T00:00`);
  const entries=occ.map(o=>{
    state.occurrenceMap.set(o.uid,o);
    const start=minuteNumber(o.start_at)-dayNumber;
    const clipTop=clamp(start,0,1440);
    const totalVisible=clamp(o.duration_min+Math.min(start,0),0,1440-clipTop);
    const top=clipTop*48/60;
    const height=Math.max(25,totalVisible*48/60);
    const clashes=occ.some(q=>q.uid!==o.uid&&minuteNumber(q.start_at)<minuteNumber(o.end_at)&&minuteNumber(q.end_at)>minuteNumber(o.start_at));
    const creator=colors.includes(o.creator)?o.creator:'one';
    return `<div class="timeline-event color-${creator} ${clashes?'clashed':''}" data-draggable="${esc(o.uid)}" style="top:${top.toFixed(2)}px;height:${height.toFixed(2)}px"><div class="timeline-title" data-edit="${esc(o.uid)}">${esc(o.title)} ${o.recurrence_unit?'↻':''}</div><div class="timeline-time" data-edit="${esc(o.uid)}">${prettyTime(o.start_at)} – ${prettyTime(o.end_at)}</div><span class="resize-handle" data-resize="${esc(o.uid)}" role="button" tabindex="0" aria-label="Modifica la durata trascinando">⌄</span></div>`;
  }).join('');
  $('calendarPanel').innerHTML=`<div class="day-preview"><span class="big-date">${Number(day.slice(-2))}</span><div><div class="day-name">${daysOfWeek[weekIndex]}</div><div class="day-description">${occ.length?`${occ.length} appuntamenti nel calendario`:'Nessun appuntamento per questa giornata'}</div></div></div><div class="timeline-note"><span>Scorri per vedere le 24 ore</span><strong>Trascina per spostare · ⌄ durata</strong></div><div class="day-timeline-scroll" id="timelineScroller"><div class="day-timeline">${slots}${entries}</div></div></div>`;
  const timeline=$('timelineScroller');
  const pref=day===dateString()?clamp(Number(localNowString().slice(11,13))-2,6,18):7;
  timeline.scrollTop=state.timelineScroll??pref*48;
  state.timelineScroll=null;
}
function renderAgenda(){
  const sel=state.selected;
  const occ=eventsOnDay(state.events,sel);
  if(state.view==='day'){$('agendaSection').classList.add('hidden');return;}
  $('agendaSection').classList.remove('hidden');
  $('agendaTitle').textContent=sel===dateString()?'Oggi':capital(humanDate(sel,{weekday:'long',day:'numeric',month:'long'}));
  $('agendaCount').textContent=`${occ.length} ${occ.length===1?'impegno':'impegni'}`;
  state.occurrenceMap=new Map(occ.map(o=>[o.uid,o]));
  if(!occ.length){
    $('agendaList').innerHTML=`<div class="empty-state"><div class="empty-icon">✳</div><strong>Una giornata libera</strong><p>Non ci sono impegni programmati.</p><button data-add-day="${sel}">+ Aggiungi un appuntamento</button></div>`;return;
  }
  $('agendaList').innerHTML=occ.map(o=>{
    const creator=colors.includes(o.creator)?o.creator:'one';
    return `<article class="agenda-card color-${creator}" data-draggable="${esc(o.uid)}"><div class="time-column"><span class="start-time">${prettyTime(o.start_at)}</span><span class="end-time">${prettyTime(o.end_at)}</span><span class="color-bar"></span></div><div class="agenda-details"><button class="agenda-main" data-edit="${esc(o.uid)}"><div class="agenda-name">${esc(o.title)}</div><div class="agenda-extra">${o.recurrence_unit?'<span class="repeat">↻</span>Ricorrente · ':''}${durationLabel(o.duration_min)}${o.revised?' · Modificato':''}</div></button><div class="agenda-actions"><button type="button" data-duration="-15" data-uid="${esc(o.uid)}" aria-label="Riduci la durata di 15 minuti">−15 min</button><button type="button" data-duration="15" data-uid="${esc(o.uid)}" aria-label="Aumenta la durata di 15 minuti">+15 min</button><button type="button" class="drag-indicator" data-drag-handle="${esc(o.uid)}" aria-label="Tieni premuto per spostare">⠿</button></div></div></article>`;
  }).join('');
}
function render(){
  state.occurrenceMap=new Map();
  headerRender();
  if(state.view==='month')monthRender();
  else if(state.view==='week')weekRender();
  else dayRender();
  renderAgenda();
}
function setColor(c){
  state.edit.color=colors.includes(c)?c:'one';
  document.querySelectorAll('[data-color]').forEach(b=>{const s=b.dataset.color===state.edit.color;b.classList.toggle('selected',s);b.setAttribute('aria-pressed',String(s));});
}
function recurrenceVisible(){
  $('recurrenceDetails').classList.toggle('hidden',$('recurrenceType').value==='none');
  $('recurrenceUnitName').textContent=({days:'giorni',weeks:'settimane',months:'mesi',years:'anni'})[$('recurrenceType').value]||'';
}
function applyFormValues(value){
  $('eventTitle').value=value.title||'';
  $('eventDate').value=value.start_at?.slice(0,10)||state.selected;
  $('eventTime').value=value.start_at?.slice(11,16)||'09:00';
  $('durationHours').value=Math.floor((value.duration_min||60)/60);
  $('durationMinutes').value=(value.duration_min||60)%60;
  $('eventNotes').value=value.notes||'';
  $('recurrenceType').value=value.recurrence_unit||'none';
  $('recurrenceCount').value=value.recurrence_interval||1;
  $('recurrenceUntil').value=value.recurrence_until||'';
  recurrenceVisible();setColor(value.creator||'one');
}
function setScope(scope){
  if(!state.edit||state.edit.isNew)return;
  state.edit.scope=scope;
  document.querySelectorAll('[data-scope]').forEach(b=>b.classList.toggle('active',b.dataset.scope===scope));
  const event=state.events.find(e=>e.id===state.edit.id);
  if(!event)return;
  const value=scope==='series'?event:(state.edit.originalOccurrence||event);
  applyFormValues(value);
  $('recurrenceContainer').classList.toggle('hidden',scope==='occurrence');
  $('conflictNotice').classList.add('hidden');
}
function openNew(day=state.selected,clock='09:00'){
  state.edit={isNew:true,id:null,scope:'series',color:'one'};
  $('editorHeading').textContent='Nuovo appuntamento';
  $('scopeWrap').classList.add('hidden');$('deleteEventBtn').classList.add('hidden');
  $('recurrenceContainer').classList.remove('hidden');
  $('formError').classList.add('hidden');$('conflictNotice').classList.add('hidden');
  applyFormValues({title:'',start_at:`${day}T${clock}`,duration_min:60,creator:'one'});
  $('eventDialog').showModal();
}
function openEdit(occ){
  const ev=state.events.find(e=>e.id===occ.id);if(!ev)return;
  state.edit={isNew:false,id:ev.id,original:occ.original,originalOccurrence:occ,scope:ev.recurrence_unit?'occurrence':'series',color:occ.creator};
  $('editorHeading').textContent='Modifica appuntamento';
  $('scopeWrap').classList.toggle('hidden',!ev.recurrence_unit);
  $('deleteEventBtn').classList.remove('hidden');
  $('formError').classList.add('hidden');$('conflictNotice').classList.add('hidden');
  setScope(ev.recurrence_unit?'occurrence':'series');
  $('eventDialog').showModal();
}
function formPayload(){
  const title=$('eventTitle').value.trim();
  const day=$('eventDate').value,time=$('eventTime').value;
  const h=Number($('durationHours').value),m=Number($('durationMinutes').value);
  if(!title)throw Error('Inserisci un titolo.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!/^\d{2}:\d{2}$/.test(time))throw Error('Inserisci data e ora.');
  if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59||h*60+m<1)throw Error('La durata deve essere compresa tra 1 minuto e 23 ore e 59 minuti.');
  const start=`${day}T${time}`;
  const payload={title,start_at:start,duration_min:h*60+m,notes:$('eventNotes').value.trim(),creator:state.edit?.color||'one'};
  if(state.edit?.scope==='series'){
    const unit=$('recurrenceType').value==='none'?null:$('recurrenceType').value;
    const interval=unit?Number($('recurrenceCount').value):null;
    const until=unit?$('recurrenceUntil').value||null:null;
    if(unit&&!['days','weeks','months','years'].includes(unit))throw Error('Ripetizione non valida.');
    if(unit&&(!Number.isInteger(interval)||interval<1||interval>999))throw Error('La ripetizione deve essere tra 1 e 999.');
    if(until&&until<day)throw Error('La fine della ripetizione deve seguire la data iniziale.');
    Object.assign(payload,{recurrence_unit:unit,recurrence_interval:interval,recurrence_until:until});
  }
  return payload;
}
function updateConflictNotice(){
  if(!$('eventDialog').open)return;
  const box=$('conflictNotice');
  try{
    const payload=formPayload();
    const editing=state.edit;
    const ignored=editing?.isNew?'':editing.scope==='series'?'':`${editing.id}|${editing.original}`;
    const ignoredId=editing&&!editing.isNew&&editing.scope==='series'?editing.id:'';
    const conflicts=conflictMatches(payload,state.events,ignored,ignoredId);
    if(conflicts.length){
      const titles=[...new Set(conflicts.map(c=>c.title))].slice(0,2).join(', ');
      box.textContent=`Attenzione: questo orario si sovrappone a «${titles}». Puoi comunque salvare.`;
      box.classList.remove('hidden');
    }else box.classList.add('hidden');
  }catch{box.classList.add('hidden');}
}
function mergedForOccurrence(ev,original,changes){
  const overrides={...(ev.overrides||{})};
  const current=(Object.prototype.hasOwnProperty.call(overrides,original)&&overrides[original])||{
    title:ev.title,start_at:original,duration_min:ev.duration_min,notes:ev.notes||'',creator:ev.creator||'one'
  };
  overrides[original]={...current,...changes};
  return {...ev,overrides};
}
function mergeSeries(ev,payload){
  const ruleChanged=ev.start_at!==payload.start_at||ev.recurrence_unit!==payload.recurrence_unit||Number(ev.recurrence_interval||0)!==Number(payload.recurrence_interval||0)||ev.recurrence_until!==payload.recurrence_until;
  if(ruleChanged&&Object.keys(ev.overrides||{}).length){
    if(!confirm('La modifica di data o ripetizione eliminerà le eccezioni già create per le singole occorrenze. Continuare?'))return null;
  }
  return {...ev,...payload,overrides:ruleChanged?{}:(ev.overrides||{})};
}
async function saveEditor(e){
  e.preventDefault();
  $('formError').classList.add('hidden');
  let payload;
  try{payload=formPayload();}catch(err){$('formError').textContent=err.message;$('formError').classList.remove('hidden');return;}
  const edit=state.edit,button=$('saveEventBtn');
  let next;
  if(edit.isNew){next={id:uuid(),...payload,overrides:{},revision:1};}
  else{
    const event=state.events.find(x=>x.id===edit.id);
    if(!event){toast('Appuntamento non trovato.');return;}
    next=edit.scope==='occurrence'?mergedForOccurrence(event,edit.original,payload):mergeSeries(event,payload);
    if(!next)return;
  }
  button.disabled=true;
  try{
    await saveOne(next,edit.isNew);
    $('eventDialog').close();state.edit=null;
    state.selected=payload.start_at.slice(0,10);state.timelineScroll=null;
    render();
    const clashes=conflictMatches(payload,state.events,edit.scope==='occurrence'?`${next.id}|${edit.original}`:'',edit.scope==='series'?next.id:'');
    toast(clashes.length?'Salvato. Attenzione: c’è una sovrapposizione.':edit.isNew?'Appuntamento aggiunto.':'Appuntamento aggiornato.');
  }catch(err){$('formError').textContent=err.message||'Salvataggio non riuscito.';$('formError').classList.remove('hidden');}
  finally{button.disabled=false;}
}
async function deleteEditor(){
  const edit=state.edit;if(!edit||edit.isNew)return;
  const ev=state.events.find(x=>x.id===edit.id);if(!ev)return;
  const single=ev.recurrence_unit&&edit.scope==='occurrence';
  if(!confirm(single?'Eliminare solo questa occorrenza?':'Eliminare l’intero appuntamento e tutte le eventuali ricorrenze?'))return;
  $('deleteEventBtn').disabled=true;
  try{
    if(single){const next={...ev,overrides:{...(ev.overrides||{}),[edit.original]:null}};await saveOne(next);}
    else await removeOne(ev);
    $('eventDialog').close();state.edit=null;render();toast(single?'Singola occorrenza eliminata.':'Appuntamento eliminato.');
  }catch(err){$('formError').textContent=err.message||'Eliminazione non riuscita.';$('formError').classList.remove('hidden');}
  finally{$('deleteEventBtn').disabled=false;}
}
async function saveOccurrenceChange(occ,changes,successText){
  const ev=state.events.find(e=>e.id===occ.id);if(!ev)return;
  const next=ev.recurrence_unit?mergedForOccurrence(ev,occ.original,changes):{...ev,...changes};
  try{
    await saveOne(next);
    const revised={...occ,...changes};
    const clashes=conflictMatches(revised,state.events,`${occ.id}|${occ.original}`);
    toast(clashes.length?`${successText} Attenzione: orari sovrapposti.`:successText);
  }catch(err){toast(err.message||'Non è stato possibile salvare.');}
}
async function nudgeDuration(uid,delta){
  const occ=state.occurrenceMap.get(uid);if(!occ)return;
  const newMinutes=clamp(occ.duration_min+delta,1,1439);
  if(newMinutes===occ.duration_min)return;
  await saveOccurrenceChange(occ,{duration_min:newMinutes},`Durata: ${durationLabel(newMinutes)}`);
}
function clickInsideCalendar(e){
  const dur=e.target.closest('[data-duration]');
  if(dur){nudgeDuration(dur.dataset.uid,Number(dur.dataset.duration));return;}
  const edit=e.target.closest('[data-edit]');
  if(edit){const occ=state.occurrenceMap.get(edit.dataset.edit);if(occ)openEdit(occ);return;}
  const add=e.target.closest('[data-add-day]');
  if(add){openNew(add.dataset.addDay);return;}
  const day=e.target.closest('[data-day]');
  if(day){state.selected=day.dataset.day;state.timelineScroll=null;render();return;}
  if(state.view==='day'){
    const slot=e.target.closest('[data-hour]');
    if(slot)openNew(state.selected,`${pad(Number(slot.dataset.hour))}:00`);
  }
}
function dragEligible(el){
  if(!el)return null;
  if(el.closest('button:not([data-edit]):not([data-drag-handle])'))return null;
  return el.closest('[data-draggable]');
}
function beginDrag(){
  const d=state.drag;if(!d||d.active||d.kind!=='move')return;
  d.active=true;
  document.body.classList.add('dragging-ui');
  const ghost=$('dragGhost');ghost.textContent=d.occ.title;
  ghost.classList.remove('hidden');
  d.from.classList.add('dragging');
  ghostPosition(d.lastX,d.lastY);
  if(navigator.vibrate)navigator.vibrate(12);
  d.frame=requestAnimationFrame(autoScrollWhileDragging);
}
function autoScrollWhileDragging(){
  const d=state.drag;
  if(!d||!d.active||d.kind!=='move')return;
  if(state.view==='day'){
    const scroller=$('timelineScroller');
    if(scroller){
      const r=scroller.getBoundingClientRect();
      if(d.lastY<r.top+46&&d.lastY>r.top-25)scroller.scrollTop-=12;
      else if(d.lastY>r.bottom-46&&d.lastY<r.bottom+25)scroller.scrollTop+=12;
    }
  }else{
    if(d.lastY<135)window.scrollBy(0,-12);
    else if(d.lastY>window.innerHeight-125)window.scrollBy(0,12);
  }
  showDropTarget(findDrop(d.lastX,d.lastY));
  d.frame=requestAnimationFrame(autoScrollWhileDragging);
}
function ghostPosition(x,y){
  const ghost=$('dragGhost');ghost.style.left=`${x}px`;ghost.style.top=`${y}px`;
}
function findDrop(x,y){
  if(state.view==='day'){
    const timeline=document.querySelector('.day-timeline');
    if(!timeline)return null;
    const rect=timeline.getBoundingClientRect();
    if(x<rect.left||x>rect.right||y<rect.top-18||y>rect.bottom+18)return null;
    const offset=clamp(y-rect.top,0,1151);
    const minute=clamp(Math.round(offset/48*4)*15,0,1425);
    return {day:state.selected,minute,element:document.querySelector(`.hour-slot[data-hour="${Math.floor(minute/60)}"]`)};
  }
  const candidates=document.elementsFromPoint(x,y);
  const el=candidates.map(e=>e.closest?.('[data-day]')).find(Boolean);
  return el?{day:el.dataset.day,element:el}:null;
}
function showDropTarget(target){
  if(state.hover?.element===target?.element)return;
  state.hover?.element?.classList.remove('drop-hover');
  state.hover=target;
  target?.element?.classList.add('drop-hover');
}
function stopDrag(){
  const d=state.drag;
  if(d?.timer)clearTimeout(d.timer);
  if(d?.frame)cancelAnimationFrame(d.frame);
  d?.from?.classList.remove('dragging');
  $('dragGhost').classList.add('hidden');
  document.body.classList.remove('dragging-ui');
  state.hover?.element?.classList.remove('drop-hover');
  state.hover=null;state.drag=null;
}
function onPointerDown(e){
  if(e.button!==undefined&&e.button!==0)return;
  const resize=e.target.closest('[data-resize]');
  if(resize){
    const occ=state.occurrenceMap.get(resize.dataset.resize);
    if(!occ)return;
    const source=resize.closest('.timeline-event');
    state.drag={kind:'resize',pointer:e.pointerId,occ,from:source,active:true,lastX:e.clientX,lastY:e.clientY,startY:e.clientY,startDuration:occ.duration_min,newDuration:occ.duration_min};
    resize.setPointerCapture?.(e.pointerId);
    e.preventDefault();return;
  }
  const from=dragEligible(e.target);
  if(!from)return;
  const occ=state.occurrenceMap.get(from.dataset.draggable);
  if(!occ)return;
  const drag={kind:'move',pointer:e.pointerId,occ,from,active:false,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,timer:null};
  state.drag=drag;
  if(state.view==='day')beginDrag();
  else drag.timer=setTimeout(()=>{if(state.drag===drag)beginDrag();},300);
}
function onPointerMove(e){
  const d=state.drag;
  if(!d||d.pointer!==e.pointerId)return;
  d.lastX=e.clientX;d.lastY=e.clientY;
  if(d.kind==='resize'){
    const delta=Math.round((e.clientY-d.startY)/48*4)*15;
    const duration=clamp(d.startDuration+delta,1,1439);
    d.newDuration=duration;
    const startMinute=minuteNumber(d.occ.start_at)-minuteNumber(`${state.selected}T00:00`);
    const visible=Math.min(duration,1440-Math.max(0,startMinute));
    d.from.style.height=`${Math.max(25,visible*48/60)}px`;
    const label=d.from.querySelector('.timeline-time');
    if(label)label.textContent=`${prettyTime(d.occ.start_at)} – ${prettyTime(addMinutes(d.occ.start_at,duration))}`;
    e.preventDefault();return;
  }
  if(!d.active){
    if(Math.hypot(e.clientX-d.startX,e.clientY-d.startY)>12){clearTimeout(d.timer);state.drag=null;}
    return;
  }
  ghostPosition(e.clientX,e.clientY);
  showDropTarget(findDrop(e.clientX,e.clientY));
  e.preventDefault();
}
async function onPointerUp(e){
  const d=state.drag;
  if(!d||d.pointer!==e.pointerId)return;
  if(d.kind==='resize'){
    const changed=d.newDuration!==d.startDuration;
    stopDrag();
    if(changed)await saveOccurrenceChange(d.occ,{duration_min:d.newDuration},`Nuova durata: ${durationLabel(d.newDuration)}`);
    else render();
    return;
  }
  const active=d.active,hover=state.hover;
  stopDrag();
  if(!active||!hover)return;
  const hhmm=prettyTime(d.occ.start_at);
  const start=hover.minute!=null?`${hover.day}T${pad(Math.floor(hover.minute/60))}:${pad(hover.minute%60)}`:`${hover.day}T${hhmm}`;
  if(start===d.occ.start_at)return;
  state.timelineScroll=$('timelineScroller')?.scrollTop??null;
  await saveOccurrenceChange(d.occ,{start_at:start},'Appuntamento spostato.');
  if(state.view!=='day')state.selected=hover.day;
  render();
}
async function registerPwa(){
  if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
    try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});}catch(err){console.warn('Service worker non installato',err);}
  }
}
function bind(){
  $('prevPeriod').addEventListener('click',()=>periodShift(-1));
  $('nextPeriod').addEventListener('click',()=>periodShift(1));
  $('todayBtn').addEventListener('click',()=>{state.selected=dateString();state.timelineScroll=null;render();});
  $('weekBtn').addEventListener('click',()=>switchView('week'));
  $('newEventBtn').addEventListener('click',()=>openNew());
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  $('calendarPanel').addEventListener('click',clickInsideCalendar);
  $('agendaList').addEventListener('click',clickInsideCalendar);
  $('recurrenceType').addEventListener('change',recurrenceVisible);
  $('closeEditor').addEventListener('click',()=>$('eventDialog').close());
  $('eventForm').addEventListener('submit',saveEditor);
  $('deleteEventBtn').addEventListener('click',deleteEditor);
  document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>{setScope(b.dataset.scope);updateConflictNotice();}));
  document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>setColor(b.dataset.color)));
  ['eventTitle','eventDate','eventTime','durationHours','durationMinutes','recurrenceType','recurrenceCount','recurrenceUntil'].forEach(id=>{['change','input'].forEach(type=>$(id).addEventListener(type,updateConflictNotice));});
  $('refreshBtn').addEventListener('click',()=>state.mode==='cloud'?cloudRefresh():initializeData());

  $('eventDialog').addEventListener('click',e=>{if(e.target===$('eventDialog'))e.target.close();});
  document.addEventListener('pointerdown',onPointerDown,{passive:false});
  document.addEventListener('pointermove',onPointerMove,{passive:false});
  document.addEventListener('pointerup',onPointerUp,{passive:false});
  document.addEventListener('pointercancel',()=>stopDrag(),{passive:true});
  $('calendarPanel').addEventListener('touchstart',e=>{if(e.touches.length===1)state.swipe={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:true});
  $('calendarPanel').addEventListener('touchend',e=>{if(!state.swipe||state.drag?.active)return;const t=e.changedTouches[0];const dx=t.clientX-state.swipe.x,dy=t.clientY-state.swipe.y;state.swipe=null;if(Math.abs(dx)>80&&Math.abs(dy)<45)periodShift(dx<0?1:-1);},{passive:true});
  window.addEventListener('focus',()=>cloudRefresh({silent:true}));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')cloudRefresh({silent:true});});
  setInterval(()=>{if(document.visibilityState==='visible')cloudRefresh({silent:true});},20000);
}
async function initializeData(){
  if(!isConfigured()){
    state.mode='demo';state.events=demoLoad();
    setBanner('Modalità demo: gli appuntamenti rimangono soltanto su questo dispositivo. Per condividerli, collega Supabase nel file config.js.');
    render();return;
  }
  try{
    if(!window.supabase?.createClient)throw Error('Libreria Supabase non disponibile. Controlla la connessione a Internet.');
    if(!state.client){
      state.client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.publishableKey,{auth:{persistSession:false,autoRefreshToken:false}});
    }
    state.events=await getCloudEvents();
    state.mode='cloud';setBanner('');render();
    if(!state.channel){
      state.channel=state.client.channel('orbis-live-events')
        .on('postgres_changes',{event:'*',schema:'public',table:'orbis_events'},()=>cloudRefresh({silent:true}))
        .subscribe();
    }
  }catch(err){
    state.mode='error';state.events=[];
    setBanner(`Impossibile collegarsi a Supabase: ${err.message}. Controlla URL, chiave pubblicabile e tabella orbis_events, poi premi Aggiorna.`,true);
    render();
  }
}
async function initialize(){
  bind();registerPwa();
  const storedView=readStore(VIEW_KEY);
  state.view=['month','week','day'].includes(storedView)?storedView:'month';
  render();await initializeData();
}
initialize();
