import {randomUUID} from 'node:crypto'

/** Short-lived references to actual OneBot messages; tokens are consumed exactly once. */
export function createAttentionCandidates({ttlMs=120000,max=128,clock=Date.now,makeToken=randomUUID}={}) {
  const values=new Map()
  function prune(now){for(const [key,value] of values)if(now-value.at>ttlMs)values.delete(key);while(values.size>max)values.delete(values.keys().next().value)}
  return {
    add(message){if(!message?.groupId||message.messageId==null||String(message.messageId)==='')return null;const now=clock();prune(now);const token=makeToken();values.set(token,{message,at:now});prune(now);return token},
    consume(token,allowed){if(typeof token!=='string'||!token)return null;const entry=values.get(token);if(!entry)return null;values.delete(token);const now=clock();if(now-entry.at>ttlMs||typeof allowed!=='function'||!allowed(entry.message))return null;return entry.message},
    get size(){return values.size},
  }
}
export function attentionDigestItems(items,message,forced){
  if(!forced||message?.messageId==null)return items
  const id=String(message.messageId)
  return items.filter(item=>item?.sourceMessageId!==id)
}
