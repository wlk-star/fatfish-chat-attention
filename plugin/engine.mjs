const defaults = {groupId:'',nicknames:['蓝蓝','大肥鱼'],windowMs:8*60_000,maxWindowMs:30*60_000,quietMs:8_000,maxBatchMs:25_000,cooldownMs:60_000,maxAutoReplies:3,unrelatedLimit:2,historyLimit:8,ignoredUserIds:[]}
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim().slice(0,600)
const compact = value => clean(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'')
function called(text,names){const value=compact(text);return names.some(name=>{const n=compact(name);return n&&value.includes(n)})}
function usable(text){return !!text && !/^\[(图片|语音|视频|表情\d*)\]$/.test(text)}
export function parseDecision(text){
  const raw=String(text??'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')
  let x;try{x=JSON.parse(raw)}catch{return null}
  if(!x||typeof x!=='object'||typeof x.related!=='boolean'||typeof x.reply!=='boolean'||typeof x.end!=='boolean')return null
  return {related:x.related,reply:x.reply,end:x.end}
}

/** Pure scheduling and policy engine; all I/O and timers are injected for testing. */
export function createAttentionEngine(options={}){
  const o={...defaults,...options}, now=o.now??Date.now, later=o.setTimeout??setTimeout, clear=o.clearTimeout??clearTimeout
  if(!o.groupId || typeof o.classify!=='function' || typeof o.requestWake!=='function')throw Error('groupId, classify and requestWake are required')
  let state={active:false,generation:0,openedAt:0,activeUntil:0,lastWakeAt:0,unrelated:0,autoReplies:0,history:[],batch:[],batchStartedAt:0,version:0}
  let timer=null,running=false,closed=false,lastClassifyAt=0
  const ignored=new Set((o.ignoredUserIds||[]).map(String)), seen=new Set(), seenOrder=[]
  function snapshot(){const {history,batch,...safe}=state;return {...safe,pending:batch.length}}
  function publish(){o.onState?.(snapshot())}
  function cancelTimer(){if(timer!==null){clear(timer);timer=null}}
  function stop(reason){cancelTimer();state={...state,active:false,generation:state.generation+1,activeUntil:0,history:[],batch:[],batchStartedAt:0,version:state.version+1};o.onEvent?.({type:'stopped',reason});publish()}
  function rememberId(id){if(!id)return false;if(seen.has(id))return false;seen.add(id);seenOrder.push(id);while(seenOrder.length>256)seen.delete(seenOrder.shift());return true}
  function start(message){const t=now();cancelTimer();state={active:true,generation:state.generation+1,openedAt:t,activeUntil:t+o.windowMs,lastWakeAt:t,unrelated:0,autoReplies:0,history:[{who:clean(message.nickname||message.userId),text:clean(message.text)}],batch:[],batchStartedAt:0,version:state.version+1};o.onEvent?.({type:'started'});publish()}
  function schedule(){if(closed||running||!state.active||!state.batch.length)return;cancelTimer();const elapsed=now()-state.batchStartedAt;const quietDelay=Math.max(0,Math.min(o.quietMs,o.maxBatchMs-elapsed));const rateDelay=Math.max(0,lastClassifyAt+(o.classifyIntervalMs??20_000)-now());const delay=Math.max(quietDelay,rateDelay);timer=later(()=>{timer=null;void evaluate()},delay);timer?.unref?.()}
  async function evaluate(){
    if(closed||running||!state.active||!state.batch.length)return
    const t=now();if(t>state.activeUntil||t-state.openedAt>=o.maxWindowMs){stop('timeout');return}
    running=true;lastClassifyAt=t;const generation=state.generation, version=state.version, batch=state.batch.slice(), history=state.history.slice();state.batch=[];state.batchStartedAt=0;publish()
    let verdict=null;try{verdict=await o.classify({history,batch,groupId:o.groupId})}catch(error){o.onEvent?.({type:'classifier-error',error:String(error?.message??error).slice(0,200)})}
    running=false;if(closed)return
    if(!state.active||state.generation!==generation){schedule();return}
    // A newer message supersedes the candidate: fold it into the next batch rather than send a stale reply.
    if(state.version!==version){state.batch=[...batch,...state.batch].slice(-o.historyLimit);if(!state.batchStartedAt)state.batchStartedAt=now();schedule();return}
    if(now()>state.activeUntil||now()-state.openedAt>=o.maxWindowMs){stop('timeout');return}
    if(!verdict||typeof verdict.related!=='boolean'||typeof verdict.reply!=='boolean'||typeof verdict.end!=='boolean'){o.onEvent?.({type:'classifier-invalid'});schedule();return}
    if(verdict.end){stop('topic-ended');return}
    if(!verdict.related){state.unrelated++;if(state.unrelated>=o.unrelatedLimit){stop('unrelated');return};publish();schedule();return}
    state.unrelated=0;state.activeUntil=Math.min(now()+o.windowMs,state.openedAt+o.maxWindowMs)
    const candidate=[...batch].reverse().find(item=>item.token)
    if(verdict.reply && candidate && state.autoReplies<o.maxAutoReplies && now()-state.lastWakeAt>=o.cooldownMs){
      state.lastWakeAt=now();state.autoReplies++;publish()
      try{await o.requestWake({candidateToken:candidate.token})}catch(error){o.onEvent?.({type:'wake-error',error:String(error?.message??error).slice(0,200)})}
    }else publish()
    schedule()
  }
  function onEvent(event){
    if(closed||event?.transport!==true)return
    const m=event.message, decision=event.decision??{}, id=String(m?.groupId??'')
    if(!m||id!==String(o.groupId)||ignored.has(String(m.userId??''))||decision.reason==='attention')return
    const text=clean(m.text),named=m.atSelf===true||called(text,o.nicknames)
    if(named&&decision.action==='wake'){if(m.messageId&&!rememberId(String(m.messageId)))return;start(m);return}
    if(decision.action!=='record'||!state.active)return
    const t=now();if(t>state.activeUntil||t-state.openedAt>=o.maxWindowMs){stop('timeout');return}
    if(!usable(text)||!event.candidateToken||!m.messageId||!rememberId(String(m.messageId)))return
    const item={who:clean(m.nickname||m.userId),text,token:String(event.candidateToken)}
    state.history.push({who:item.who,text:item.text});state.history=state.history.slice(-o.historyLimit)
    if(!state.batch.length)state.batchStartedAt=t
    state.batch.push(item);state.batch=state.batch.slice(-o.historyLimit);state.version++;publish();schedule()
  }
  function onReply(event){
    if(closed||!state.active||String(event?.groupId??'')!==String(o.groupId))return
    const text=clean(event?.text);if(!text)return
    state.history.push({who:'蓝蓝',text});state.history=state.history.slice(-o.historyLimit);state.version++;publish()
  }
  return {onEvent,onReply,snapshot,stop,dispose(){closed=true;cancelTimer();state.history=[];state.batch=[]}}
}
