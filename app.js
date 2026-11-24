import {CONFIG} from './config.js';
import {dateString, shiftDay, startOfWeek, dayFromISO, fromDayNumber, minuteNumber, expandEvents, eventsOnDay, conflictMatches, monthLength} from './recurrence.js';

/* Orbis Lite — static PWA + Supabase Data API. Shared publicly, without accounts. */
const $ = id => document.getElementById(id);
const DEMO_STORE='orbis-lite-local-v1';
const WEEKDAYS=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const colors=['one','two','three'];
const state={
  selected:dateString(), events:[], mode:'demo', client:null, version:0,
  occurrenceMap:new Map(), edit:null, toastTimer:null, syncBusy:false,
  drag:null, hover:null, swipe:null, dayHold:null, preventDayClick:null, animatingMonth:false, animateAgendaNext:false, recentlySavedId:null,
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
function changeMonth(dir){
  const [y,m,day]=state.selected.split('-').map(Number);
  const first=new Date(Date.UTC(y,m-1+dir,1));
  const yr=first.getUTCFullYear(), mo=first.getUTCMonth()+1;
  state.selected=`${yr}-${pad(mo)}-${pad(Math.min(day,monthLength(yr,mo)))}`;
  state.animateAgendaNext=true;
  render();
}
function reducedMotion(){return window.matchMedia('(prefers-reduced-motion: reduce)').matches;}
function shiftMonthAnimated(dir){
  if(state.animatingMonth)return;
  const panel=$('calendarPanel');
  if(reducedMotion() || !panel.animate){changeMonth(dir);return;}
  state.animatingMonth=true;
  const distance=Math.min(55,window.innerWidth*.15);
  const options={duration:145,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'};
  const outgoing=panel.animate([{opacity:1,transform:'translateX(0)'},{opacity:0,transform:`translateX(${-dir*distance}px)`}],options);
  outgoing.finished.then(()=>{
    outgoing.cancel();
    changeMonth(dir);
    const incoming=panel.animate([{opacity:0,transform:`translateX(${dir*distance}px)`},{opacity:1,transform:'translateX(0)'}],{duration:265,easing:'cubic-bezier(.2,.75,.2,1)'});
    incoming.finished.catch(()=>{}).finally(()=>{state.animatingMonth=false;});
  }).catch(()=>{state.animatingMonth=false;changeMonth(dir);});
}
function headerRender(){
  $('periodTitle').textContent=capital(humanDate(state.selected,{month:'long',year:'numeric'}));
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
  $('calendarPanel').innerHTML=`<div class="weekday-head">${WEEKDAYS.map(d=>`<span>${d}</span>`).join('')}</div><div class="month-grid">${cells}</div>`;
}
function renderAgenda(){
  const sel=state.selected;
  const occ=eventsOnDay(state.events,sel);
  $('agendaTitle').textContent=sel===dateString()?'Oggi':capital(humanDate(sel,{weekday:'long',day:'numeric',month:'long'}));
  state.occurrenceMap=new Map(occ.map(o=>[o.uid,o]));
  const shouldAnimate=state.animateAgendaNext;
  $('agendaList').classList.toggle('animated',shouldAnimate);
  if(!occ.length){
    $('agendaList').innerHTML='<div class="empty-state">Nessun appuntamento</div>';
    state.animateAgendaNext=false;
    return;
  }
  $('agendaList').innerHTML=occ.map((o,index)=>{
    const creator=colors.includes(o.creator)?o.creator:'one';
    return `<article class="agenda-card color-${creator} ${o.id===state.recentlySavedId?'just-saved':''}" style="--row-order:${Math.min(index,9)}" data-draggable="${esc(o.uid)}"><span class="start-time">${prettyTime(o.start_at)}</span><button type="button" class="agenda-main" data-edit="${esc(o.uid)}"><span class="agenda-name">${esc(o.title)}</span><span class="agenda-extra">${durationLabel(o.duration_min)}${o.recurrence_unit?' · ↻ Ricorrente':''}${o.revised?' · Modificato':''}</span></button><span class="agenda-mark" aria-hidden="true"></span></article>`;
  }).join('');
  state.animateAgendaNext=false;
}
function render(){
  state.occurrenceMap=new Map();
  headerRender();
  monthRender();
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
    state.recentlySavedId=next.id;
    await saveOne(next,edit.isNew);
    $('eventDialog').close();state.edit=null;
    state.selected=payload.start_at.slice(0,10);state.animateAgendaNext=true;
    render();
    window.setTimeout(()=>{state.recentlySavedId=null;},700);
    const clashes=conflictMatches(payload,state.events,edit.scope==='occurrence'?`${next.id}|${edit.original}`:'',edit.scope==='series'?next.id:'');
    toast(clashes.length?'Salvato. Attenzione: c’è una sovrapposizione.':edit.isNew?'Appuntamento aggiunto.':'Appuntamento aggiornato.');
  }catch(err){state.recentlySavedId=null;$('formError').textContent=err.message||'Salvataggio non riuscito.';$('formError').classList.remove('hidden');}
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
function clickInsideCalendar(e){
  const edit=e.target.closest('[data-edit]');
  if(edit){const occ=state.occurrenceMap.get(edit.dataset.edit);if(occ)openEdit(occ);return;}
  const day=e.target.closest('[data-day]');
  if(day){
    if(state.preventDayClick===day.dataset.day){state.preventDayClick=null;return;}
    if(state.skipClickUntil && Date.now()<state.skipClickUntil)return;
    if(state.selected!==day.dataset.day){
      state.selected=day.dataset.day;
      state.animateAgendaNext=true;
      render();
    }
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
  if(d.lastY<135)window.scrollBy(0,-12);
  else if(d.lastY>window.innerHeight-125)window.scrollBy(0,12);
  showDropTarget(findDrop(d.lastX,d.lastY));
  d.frame=requestAnimationFrame(autoScrollWhileDragging);
}
function ghostPosition(x,y){
  const ghost=$('dragGhost');ghost.style.left=`${x}px`;ghost.style.top=`${y}px`;
}
function findDrop(x,y){
  const el=document.elementsFromPoint(x,y).map(e=>e.closest?.('[data-day]')).find(Boolean);
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
function cancelDayHold(){
  if(!state.dayHold)return;
  clearTimeout(state.dayHold.timer);
  state.dayHold=null;
}
function onPointerDown(e){
  if(e.button!==undefined&&e.button!==0)return;
  const day=e.target.closest('[data-day]');
  if(day && !e.target.closest('[data-draggable]')){
    cancelDayHold();
    const hold={id:e.pointerId,day:day.dataset.day,x:e.clientX,y:e.clientY,timer:null};
    hold.timer=setTimeout(()=>{
      if(state.dayHold!==hold)return;
      state.preventDayClick=hold.day;
      state.swipe=null;
      cancelDayHold();
      state.selected=hold.day;
      openNew(hold.day);
      window.setTimeout(()=>{if(state.preventDayClick===hold.day)state.preventDayClick=null;},700);
    },600);
    state.dayHold=hold;
  }
  const from=dragEligible(e.target);
  if(!from)return;
  const occ=state.occurrenceMap.get(from.dataset.draggable);
  if(!occ)return;
  const drag={kind:'move',pointer:e.pointerId,occ,from,active:false,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,timer:null};
  state.drag=drag;
  drag.timer=setTimeout(()=>{if(state.drag===drag)beginDrag();},340);
}
function onPointerMove(e){
  const hold=state.dayHold;
  if(hold?.id===e.pointerId && Math.hypot(e.clientX-hold.x,e.clientY-hold.y)>10)cancelDayHold();
  const d=state.drag;
  if(!d||d.pointer!==e.pointerId)return;
  d.lastX=e.clientX;d.lastY=e.clientY;
  if(!d.active){
    if(Math.hypot(e.clientX-d.startX,e.clientY-d.startY)>12){clearTimeout(d.timer);state.drag=null;}
    return;
  }
  ghostPosition(e.clientX,e.clientY);
  showDropTarget(findDrop(e.clientX,e.clientY));
  e.preventDefault();
}
async function onPointerUp(e){
  if(state.dayHold?.id===e.pointerId)cancelDayHold();
  const d=state.drag;
  if(!d||d.pointer!==e.pointerId)return;
  const active=d.active,hover=state.hover;
  stopDrag();
  if(!active||!hover)return;
  const hhmm=prettyTime(d.occ.start_at);
  const start=hover.minute!=null?`${hover.day}T${pad(Math.floor(hover.minute/60))}:${pad(hover.minute%60)}`:`${hover.day}T${hhmm}`;
  if(start===d.occ.start_at)return;
  await saveOccurrenceChange(d.occ,{start_at:start},'Appuntamento spostato.');
  state.selected=hover.day;state.animateAgendaNext=true;
  render();
}
async function registerPwa(){
  if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
    try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});}catch(err){console.warn('Service worker non installato',err);}
  }
}
function bind(){
  $('goTodayBtn').addEventListener('click',()=>{
    state.selected=dateString();state.animateAgendaNext=true;render();
  });
  $('agendaNewBtn').addEventListener('click',()=>openNew());
  $('calendarPanel').addEventListener('click',clickInsideCalendar);
  $('agendaList').addEventListener('click',clickInsideCalendar);
  $('recurrenceType').addEventListener('change',recurrenceVisible);
  $('closeEditor').addEventListener('click',()=>$('eventDialog').close());
  $('eventForm').addEventListener('submit',saveEditor);
  $('deleteEventBtn').addEventListener('click',deleteEditor);
  document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>{setScope(b.dataset.scope);updateConflictNotice();}));
  document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>setColor(b.dataset.color)));
  ['eventTitle','eventDate','eventTime','durationHours','durationMinutes','recurrenceType','recurrenceCount','recurrenceUntil'].forEach(id=>{['change','input'].forEach(type=>$(id).addEventListener(type,updateConflictNotice));});
  $('eventDialog').addEventListener('click',e=>{if(e.target===$('eventDialog'))e.target.close();});
  document.addEventListener('pointerdown',onPointerDown,{passive:false});
  document.addEventListener('pointermove',onPointerMove,{passive:false});
  document.addEventListener('pointerup',onPointerUp,{passive:false});
  document.addEventListener('pointercancel',()=>{cancelDayHold();stopDrag();},{passive:true});
  $('calendarPanel').addEventListener('contextmenu',e=>{if(e.target.closest('[data-day]'))e.preventDefault();});
  $('calendarPanel').addEventListener('touchstart',e=>{if(e.touches.length===1)state.swipe={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:true});
  $('calendarPanel').addEventListener('touchend',e=>{
    if(!state.swipe||state.drag?.active)return;
    const t=e.changedTouches[0],dx=t.clientX-state.swipe.x,dy=t.clientY-state.swipe.y;
    state.swipe=null;
    if(Math.abs(dx)>70&&Math.abs(dy)<50){
      cancelDayHold();state.skipClickUntil=Date.now()+350;
      shiftMonthAnimated(dx<0?1:-1);
    }
  },{passive:true});
  $('calendarPanel').addEventListener('touchcancel',()=>{state.swipe=null;cancelDayHold();},{passive:true});
  $('calendarPanel').addEventListener('keydown',e=>{
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();shiftMonthAnimated(e.key==='ArrowRight'?1:-1);
    }
  });
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
    setBanner(`Impossibile collegarsi a Supabase: ${err.message}. Controlla URL, chiave pubblicabile e tabella orbis_events, poi ricarica la pagina.`,true);
    render();
  }
}
async function initialize(){
  bind();registerPwa();
  // Unica vista: mese.
  render();await initializeData();
}
initialize();
