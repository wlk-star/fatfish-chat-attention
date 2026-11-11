import assert from 'node:assert/strict'
import test from 'node:test'
import {createAttentionEngine,parseDecision} from './engine.mjs'

function setup(classify,extra={}) {
  let clock=1_000_000, next=0;const timers=new Map(),requests=[],events=[]
  const o={groupId:'g',nicknames:['蓝蓝','大肥鱼'],quietMs:1000,maxBatchMs:3000,classifyIntervalMs:0,cooldownMs:5000,windowMs:30_000,maxWindowMs:120_000,maxAutoReplies:3,unrelatedLimit:2,...extra,now:()=>clock,
    setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{at:clock+delay,fn});return id},clearTimeout:id=>timers.delete(id),classify,requestWake:r=>requests.push(r),onEvent:e=>events.push(e)}
  const engine=createAttentionEngine(o)
  async function advance(ms){clock+=ms;for(const [id,t] of [...timers])if(t.at<=clock){timers.delete(id);t.fn()};await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))}
  const mention=(text='蓝蓝，聊烤肉')=>engine.onEvent({transport:true,message:{groupId:'g',userId:'1',messageId:'mention',text},decision:{action:'wake',reason:'nickname'}})
  const msg=(id,text='这种肉好吃吗',groupId='g')=>engine.onEvent({transport:true,message:{groupId,userId:'2',messageId:id,text},candidateToken:'token-'+id,decision:{action:'record',reason:'sampled-out'}})
  return {engine,requests,events,advance,mention,msg}
}

test('classifier response must be a complete boolean JSON object',()=>{
  assert.deepEqual(parseDecision('```json\n{"related":true,"reply":false,"end":false}\n```'),{related:true,reply:false,end:false})
  for(const x of ['yes','{}','{"related":true,"reply":"yes","end":false}',''])assert.equal(parseDecision(x),null)
})

test('only a named group turn starts attention; later messages batch and respect cooldown',async()=>{
  const seen=[];const h=setup(async x=>{seen.push(x);return {related:true,reply:true,end:false}})
  h.msg('outside');await h.advance(2000);assert.equal(seen.length,0)
  h.mention();h.msg('a');h.msg('b','蘸料怎么配');await h.advance(1000)
  assert.equal(seen.length,1);assert.equal(seen[0].batch.length,2);assert.equal(h.requests.length,0)
  await h.advance(5000);h.msg('c','加点辣椒');await h.advance(1000)
  assert.deepEqual(h.requests,[{candidateToken:'token-c'}]);assert.equal(h.engine.snapshot().autoReplies,1)
  h.engine.dispose()
})

test('unrelated topics end attention without emitting',async()=>{
  const h=setup(async()=>({related:false,reply:false,end:false}));h.mention();h.msg('a','天气如何');await h.advance(1000)
  assert.equal(h.engine.snapshot().active,true);h.msg('b','去哪里玩');await h.advance(1000)
  assert.equal(h.engine.snapshot().active,false);assert.equal(h.requests.length,0)
})

test('stale classifier result never wakes and is reconsidered with newer messages',async()=>{
  let resolveFirst,calls=0;const h=setup(()=>++calls===1?new Promise(r=>{resolveFirst=r}):Promise.resolve({related:true,reply:true,end:false}))
  h.mention();await h.advance(6000);h.msg('a');await h.advance(1000);h.msg('b','新消息')
  resolveFirst({related:true,reply:true,end:false});await new Promise(r=>setImmediate(r))
  assert.equal(h.requests.length,0);await h.advance(1000);assert.deepEqual(h.requests,[{candidateToken:'token-b'}])
})

test('duplicates, other groups, missing tokens and non-transport messages are ignored',async()=>{
  const h=setup(async()=>({related:true,reply:true,end:false}));h.mention();await h.advance(6000)
  h.msg('a');h.msg('a');h.msg('b','蓝蓝','other');h.engine.onEvent({transport:false,message:{groupId:'g',messageId:'c',text:'测试'},candidateToken:'forged',decision:{action:'record'}})
  await h.advance(1000);assert.deepEqual(h.requests,[{candidateToken:'token-a'}])
})

test('only replies from the configured group enter classifier context',async()=>{
  const seen=[];const h=setup(async x=>{seen.push(x);return {related:true,reply:false,end:false}});h.mention()
  h.engine.onReply({groupId:'other',text:'外群不应进入'})
  h.engine.onReply({groupId:'g',text:'番茄汤加点盐'})
  h.msg('a','那要煮多久');await h.advance(1000)
  assert.ok(seen[0].history.some(x=>x.who==='蓝蓝'&&x.text==='番茄汤加点盐'))
  assert.ok(!seen[0].history.some(x=>x.text==='外群不应进入'))
})

test('classifier errors fail closed, and explicit end exits attention',async()=>{
  let n=0;const h=setup(async()=>{if(!n++)throw Error('offline');return {related:false,reply:false,end:true}});h.mention();await h.advance(6000)
  h.msg('a');await h.advance(1000);assert.equal(h.requests.length,0);assert.equal(h.engine.snapshot().active,true)
  assert.equal(h.events.at(-1)?.type,'classifier-error')
  assert.ok(!h.events.some(e=>e.type==='classifier-invalid'))
  h.msg('b');await h.advance(1000);assert.equal(h.engine.snapshot().active,false);assert.equal(h.requests.length,0)
})

test('batch is not duplicated at tail of history and topicAnchor survives >8 turns',async()=>{
  const seen=[]
  const h=setup(async x=>{seen.push(x);return {related:true,reply:false,end:false}},{historyLimit:8})
  h.mention('蓝蓝，周末烤肉买什么肉')
  h.msg('m1','五花肉不错')
  h.msg('m2','牛肋条也要')
  await h.advance(1000)
  assert.equal(seen.length,1)
  assert.deepEqual(seen[0].history,[{who:'1',text:'蓝蓝，周末烤肉买什么肉'}])
  assert.equal(seen[0].batch.length,2)
  assert.ok(!seen[0].history.some(x=>x.text==='五花肉不错'||x.text==='牛肋条也要'))

  for(let i=3;i<=12;i++){
    h.msg('m'+i,'第'+i+'条讨论')
    await h.advance(1000)
  }
  const lastCall=seen.at(-1)
  assert.equal(lastCall.history[0].text,'蓝蓝，周末烤肉买什么肉')
  assert.ok(lastCall.history.length<=8)
  assert.ok(!lastCall.history.some(x=>x.text===lastCall.batch[0].text))
  h.engine.dispose()
})

test('multi-tag pure media placeholders are ignored and onReply uses configured nickname without cancelling in-flight classify',async()=>{
  let resolveClassify
  const seen=[]
  const h=setup(x=>{seen.push(x);return new Promise(r=>{resolveClassify=r})},{nicknames:['小肥鱼','蓝蓝']})
  h.mention('小肥鱼，在吗')
  await h.advance(6000)
  h.msg('img1','[图片][图片]')
  h.msg('img2','[表情1] [图片] [语音]')
  await h.advance(1500)
  assert.equal(seen.length,0)

  h.msg('real1','帮我看看配料表')
  await h.advance(1000)
  assert.equal(seen.length,1)
  h.engine.onReply({groupId:'g',text:'好呀发来看看'})
  resolveClassify({related:true,reply:true,end:false})
  await new Promise(r=>setImmediate(r))
  assert.deepEqual(h.requests,[{candidateToken:'token-real1'}])

  await h.advance(6000)
  h.msg('real2','钠含量高不高')
  await h.advance(1000)
  assert.ok(seen[1].history.some(x=>x.who==='小肥鱼'&&x.text==='好呀发来看看'))
  h.engine.dispose()
})

test('post-reply cooldown defers wake instead of dropping follow-up context',async()=>{
  const seen=[]
  const h=setup(async x=>{seen.push(x);return {related:true,reply:true,end:false}})
  h.mention('蓝蓝，聊火锅')
  await h.advance(6000)
  h.msg('first','毛肚涮几秒')
  await h.advance(1000)
  assert.deepEqual(h.requests,[{candidateToken:'token-first'}])

  await h.advance(1000)
  h.msg('followup','鸭肠呢')
  await h.advance(1000)
  assert.equal(h.requests.length,1)
  await h.advance(4000)
  assert.deepEqual(h.requests,[{candidateToken:'token-first'},{candidateToken:'token-followup'}])
  h.engine.dispose()
})
