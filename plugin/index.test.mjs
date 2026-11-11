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
  h.msg('b');await h.advance(1000);assert.equal(h.engine.snapshot().active,false);assert.equal(h.requests.length,0)
})
