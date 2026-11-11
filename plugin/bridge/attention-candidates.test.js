import assert from 'node:assert/strict'
import test from 'node:test'
import {createAttentionCandidates,attentionDigestItems} from './attention-candidates.js'

test('only real-group-shaped candidates can be consumed once',()=>{
 let t=10,n=0;const c=createAttentionCandidates({clock:()=>t,makeToken:()=>String(++n)})
 assert.equal(c.add({userId:'u',messageId:'1'}),null);assert.equal(c.add({groupId:'g'}),null)
 const msg={groupId:'g',messageId:'m',text:'hello'},token=c.add(msg)
 assert.equal(c.consume('forged',()=>true),null);assert.equal(c.consume(token,x=>x.groupId==='g'),msg);assert.equal(c.consume(token,()=>true),null)
})
test('expired and no longer authorized candidates fail closed',()=>{
 let t=10,n=0;const c=createAttentionCandidates({ttlMs:100,clock:()=>t,makeToken:()=>String(++n)})
 const a=c.add({groupId:'g',messageId:'1'});t=111;assert.equal(c.consume(a,()=>true),null)
 const b=c.add({groupId:'g',messageId:'2'});assert.equal(c.consume(b,()=>false),null);assert.equal(c.consume(b,()=>true),null)
})
test('bounded candidate cache and digest excludes only triggering message',()=>{
 let n=0;const c=createAttentionCandidates({max:2,makeToken:()=>String(++n)});const a=c.add({groupId:'g',messageId:'1'});c.add({groupId:'g',messageId:'2'});c.add({groupId:'g',messageId:'3'});assert.equal(c.size,2);assert.equal(c.consume(a,()=>true),null)
 const buffer=[{sourceMessageId:'a'},{sourceMessageId:'b'},{sourceMessageId:null}];assert.deepEqual(attentionDigestItems(buffer,{messageId:'b'},true),[buffer[0],buffer[2]]);assert.equal(attentionDigestItems(buffer,{messageId:'b'},false),buffer)
})
