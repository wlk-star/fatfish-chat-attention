import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createMemoryConnector } from '../connectors/memory-connector.mjs'
import {
  PUBLIC_ROSTER_SCOPE,
  TRUST_LEVELS,
  canScopeAccess,
  isValidScopeId,
} from './schema.mjs'
import { createRelationalStore } from './sqlite-repo.mjs'
import { extractKeywords, tokenizeForFts } from './tokenizer.mjs'

describe('Track L3: Schema & ScopeGate rules', () => {
  it('enforces strict one-way ScopeGate matrix and fails closed on invalid scopes', () => {
    assert.deepEqual(TRUST_LEVELS, [
      'owner_curated',
      'fish_observed',
      'self_claimed_tentative',
    ])
    assert.equal(isValidScopeId(PUBLIC_ROSTER_SCOPE), true)
    assert.equal(isValidScopeId('private:qq:1024162823'), true)
    assert.equal(isValidScopeId('group:1135493428'), true)
    assert.equal(isValidScopeId('private:'), false)
    assert.equal(isValidScopeId('group:'), false)
    assert.equal(isValidScopeId(''), false)
    assert.equal(isValidScopeId(null), false)

    // Group viewer: ONLY public_roster + exact own group (NEVER private:* or other groups)
    assert.equal(canScopeAccess('group:1135493428', 'public_roster'), true)
    assert.equal(canScopeAccess('group:1135493428', 'group:1135493428'), true)
    assert.equal(canScopeAccess('group:1135493428', 'group:999999999'), false)
    assert.equal(
      canScopeAccess('group:1135493428', 'private:qq:1024162823'),
      false
    )

    // Private viewer: own private + public_roster + ANY group:* (NEVER other user's private:*)
    assert.equal(
      canScopeAccess('private:qq:1024162823', 'private:qq:1024162823'),
      true
    )
    assert.equal(canScopeAccess('private:qq:1024162823', 'public_roster'), true)
    assert.equal(
      canScopeAccess('private:qq:1024162823', 'group:1135493428'),
      true
    )
    assert.equal(
      canScopeAccess('private:qq:1024162823', 'group:888888888'),
      true
    )
    assert.equal(
      canScopeAccess('private:qq:1024162823', 'private:qq:616860663'),
      false
    )

    // Public roster viewer: ONLY public_roster
    assert.equal(canScopeAccess('public_roster', 'public_roster'), true)
    assert.equal(canScopeAccess('public_roster', 'group:1135493428'), false)
    assert.equal(
      canScopeAccess('public_roster', 'private:qq:1024162823'),
      false
    )

    // Missing viewerScope fails closed
    assert.equal(canScopeAccess(undefined, 'public_roster'), false)
  })
})

describe('Track L3: Chinese CJK + Alias Tokenizer', () => {
  it('tokenizes Chinese CJK bigrams, ASCII words, QQ IDs, and custom aliases', () => {
    const ftsTokens = tokenizeForFts(
      '爸爸和源弟弟(qq:616860663)讨论潮汕牛肉火锅与 Rust WebGPU'
    )
    const tokenSet = new Set(ftsTokens.split(/\s+/))
    assert.equal(tokenSet.has('爸爸'), true)
    assert.equal(tokenSet.has('源弟弟'), true)
    assert.equal(tokenSet.has('qq616860663'), true)
    assert.equal(tokenSet.has('潮汕'), true)
    assert.equal(tokenSet.has('牛肉'), true)
    assert.equal(tokenSet.has('火锅'), true)
    assert.equal(tokenSet.has('rust'), true)
    assert.equal(tokenSet.has('webgpu'), true)

    const kws = extractKeywords('源天帝和kk今天去吃潮汕牛肉火锅了吗？')
    assert.ok(kws.includes('源天帝'))
    assert.ok(kws.includes('kk'))
    assert.ok(kws.includes('牛肉'))
    assert.ok(kws.includes('火锅'))
    // ASCII boundary: 'kk' must not match inside 'tiktok'
    const noKk = extractKeywords('刷了一晚上 tiktok 视频')
    assert.equal(noKk.includes('kk'), false)
  })
})

describe('Track L3: SQLite Relational Store', () => {
  it('idempotently seeds owner (爸爸) & brother (源弟弟/源天帝) and resolves mentions in text', () => {
    let clock = 1_700_000_000_000
    const store = createRelationalStore({ now: () => clock })
    try {
      const first = store.seedDefaults()
      clock += 5000
      const second = store.seedDefaults()

      assert.equal(first.owner.participantId, 'qq:1024162823')
      assert.equal(first.owner.preferredCall, '爸爸')
      assert.deepEqual(first.owner.aliases, ['kk', '爸爸'])
      assert.equal(first.owner.roleToFish, 'owner')
      assert.equal(first.owner.trust, 'owner_curated')
      assert.equal(first.owner.scope, 'public_roster')

      assert.equal(first.brother.participantId, 'qq:616860663')
      assert.equal(first.brother.preferredCall, '源弟弟')
      assert.deepEqual(first.brother.aliases, ['源天帝'])
      assert.equal(first.brother.roleToFish, 'owner_kin')
      assert.equal(first.brother.trust, 'owner_curated')
      assert.equal(first.brother.scope, 'public_roster')

      // Idempotent edge: no historical duplicate created on re-seed
      assert.equal(second.relationEdge.edgeId, first.relationEdge.edgeId)
      const allEdges = store.listRelationEdges({
        participantIds: ['qq:1024162823', 'qq:616860663'],
        viewerScope: 'group:1135493428',
        includeHistorical: true,
      })
      assert.equal(allEdges.length, 1)
      assert.equal(allEdges[0].relation, '亲兄弟（爸爸与源弟弟/源天帝）')
      assert.equal(allEdges[0].status, 'active')

      // Resolve by preferredCall, alias, and qq:id across scopes
      const r1 = store.resolveParticipantsInText('源天帝刚才在群里冒泡了', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(r1.length, 1)
      assert.equal(r1[0].participantId, 'qq:616860663')
      assert.equal(r1[0].preferredCall, '源弟弟')

      const r2 = store.resolveParticipantsInText('找 kk 和 qq:616860663 一起开黑', {
        viewerScope: 'private:qq:1024162823',
      })
      assert.deepEqual(
        r2.map((p) => p.participantId),
        ['qq:1024162823', 'qq:616860663']
      )

      // Partial digit prefix qq:61686066 must NOT falsely match qq:616860663
      const rFalse = store.resolveParticipantsInText('路人(qq:6168606639)说话', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(rFalse.length, 0)
    } finally {
      store.close()
    }
  })

  it('achieves high Chinese FTS5 search recall including entity synonym expansion and punctuation safety', () => {
    let nowMs = 10_000
    const store = createRelationalStore({ now: () => (nowMs += 100) })
    try {
      store.seedDefaults()

      store.saveEpisode({
        episodeId: 'ep_hotpot',
        sessionId: 'sess-group-1',
        scope: 'group:1135493428',
        title: '周末聚餐吃潮汕牛肉火锅',
        summary: '源天帝提议周六晚上大家去吃八合里潮汕牛肉火锅，点吊龙和胸口朥',
        participantIds: ['qq:616860663', 'qq:777777'],
        seqRange: [10, 18],
      })

      store.saveEpisode({
        episodeId: 'ep_rust',
        sessionId: 'sess-group-1',
        scope: 'group:1135493428',
        title: 'Rust 编译器与异步 Tokio 调优',
        summary: '群友们讨论了 Rust 生命周期标注和 Tokio 调度延迟问题',
        participantIds: ['qq:888888'],
        seqRange: [20, 30],
      })

      store.saveEpisode({
        episodeId: 'ep_cat',
        sessionId: 'sess-priv-1',
        scope: 'private:qq:1024162823',
        title: '邻居家的小橘猫',
        summary: '爸爸说今天路过院子喂了一只粘人的猫',
        participantIds: ['qq:1024162823'],
        seqRange: [1, 5],
      })

      // Conversational Chinese query with filler words ("之前", "那次")
      const hotpotHits = store.searchEpisodes('之前聊牛肉火锅吊龙那次', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(hotpotHits.length, 1)
      assert.equal(hotpotHits[0].episodeId, 'ep_hotpot')
      assert.deepEqual(hotpotHits[0].seqRange, [10, 18])

      // Entity alias synonym search: episode wrote '源天帝', query asks for '源弟弟'
      const aliasHits = store.searchEpisodes('源弟弟提议吃什么', {
        viewerScope: 'group:1135493428',
      })
      assert.ok(aliasHits.some((e) => e.episodeId === 'ep_hotpot'))

      // Participant filter
      const filteredHits = store.searchEpisodes('讨论', {
        viewerScope: 'group:1135493428',
        participantId: 'qq:888888',
      })
      assert.deepEqual(
        filteredHits.map((e) => e.episodeId),
        ['ep_rust']
      )

      // Single-character Chinese noun search in private scope
      const catHits = store.searchEpisodes('猫', {
        viewerScope: 'private:qq:1024162823',
      })
      assert.ok(catHits.some((e) => e.episodeId === 'ep_cat'))

      // Adversarial FTS5 special operators/punctuation must NEVER throw syntax error
      const advHits = store.searchEpisodes(
        '？？？"火锅" (AND OR NOT * : ^ - [CQ:face,id=1])',
        { viewerScope: 'group:1135493428' }
      )
      assert.ok(advHits.some((e) => e.episodeId === 'ep_hotpot'))
    } finally {
      store.close()
    }
  })

  it('enforces 0 private leakage to group while allowing owner private chat to read group highlights', () => {
    let clock = 50_000
    const store = createRelationalStore({ now: () => (clock += 1000) })
    try {
      store.seedDefaults()

      // Private-only participant note & secret friend
      store.upsertParticipant({
        participantId: 'qq:1024162823',
        fact: '爸爸最近在秘密准备惊喜生日礼物，绝对不能在群里剧透',
        scope: 'private:qq:1024162823',
        trust: 'owner_curated',
      })
      store.upsertParticipant({
        participantId: 'qq:555000',
        preferredCall: '老张',
        aliases: ['张总'],
        fact: '私下聊合作的伙伴',
        scope: 'private:qq:1024162823',
        trust: 'owner_curated',
      })

      // Private relation edge
      store.upsertRelationEdge({
        participantIds: ['qq:1024162823', 'qq:555000'],
        relation: '秘密商业合作伙伴',
        scope: 'private:qq:1024162823',
        trust: 'owner_curated',
      })

      // Private topic & private episode (with moodSlice)
      const privTopic = store.saveTopic({
        topicId: 'topic_secret_gift',
        sessionId: 'session-priv',
        scope: 'private:qq:1024162823',
        title: '秘密生日礼物计划',
        summary: '挑了一块机械键盘准备寄给弟弟',
        status: 'warm',
        openLoops: ['确认快递单号'],
      })
      const privEpisode = store.saveEpisode({
        episodeId: 'ep_secret_gift',
        sessionId: 'session-priv',
        scope: 'private:qq:1024162823',
        title: '秘密准备机械键盘生日礼物',
        summary: '爸爸买了一把客制化机械键盘作为惊喜礼物',
        participantIds: ['qq:1024162823'],
        moodSlice: { startMood: 72, endMood: 88, reasons: ['聊生日礼物很开心'] },
      })

      // Public group highlight episode
      store.saveEpisode({
        episodeId: 'ep_group_game',
        sessionId: 'session-group',
        scope: 'group:1135493428',
        title: '源弟弟五杀高光时刻',
        summary: '源弟弟今晚在群内自定义赛拿了五杀，全群刷屏庆祝',
        participantIds: ['qq:616860663'],
        isHighlight: true,
        occurredAt: 60_000,
      })

      const groupScope = 'group:1135493428'
      const ownerScope = 'private:qq:1024162823'

      // 1. Group viewer sees ZERO private episodes, topics, secret participants, or private facts
      assert.equal(store.getEpisode(privEpisode.episodeId, { viewerScope: groupScope }), null)
      assert.deepEqual(
        store.searchEpisodes('机械键盘 生日礼物', { viewerScope: groupScope }),
        []
      )
      assert.equal(store.getTopic(privTopic.topicId, { viewerScope: groupScope }), null)
      assert.deepEqual(store.listTopics({ viewerScope: groupScope }), [])
      assert.equal(store.getParticipant('qq:555000', { viewerScope: groupScope }), null)
      assert.deepEqual(
        store.resolveParticipantsInText('张总今天来了吗', { viewerScope: groupScope }),
        []
      )
      assert.deepEqual(
        store.getCohortRelations(['qq:1024162823', 'qq:555000'], {
          viewerScope: groupScope,
        }),
        []
      )

      const ownerInGroup = store.getParticipant('qq:1024162823', {
        viewerScope: groupScope,
      })
      assert.equal(ownerInGroup.preferredCall, '爸爸')
      assert.deepEqual(ownerInGroup.facts, []) // ZERO private facts leaked!

      // 2. Owner private viewer sees BOTH private memories AND public group highlights!
      const ownerInPrivate = store.getParticipant('qq:1024162823', {
        viewerScope: ownerScope,
      })
      assert.equal(ownerInPrivate.facts.length, 1)
      assert.match(ownerInPrivate.facts[0], /秘密准备惊喜生日礼物/)

      const privSearchGroup = store.searchEpisodes('五杀', {
        viewerScope: ownerScope,
      })
      assert.equal(privSearchGroup.length, 1)
      assert.equal(privSearchGroup[0].episodeId, 'ep_group_game')

      const highlights = store.listRecentGroupHighlights({
        groupId: '1135493428',
        viewerScope: ownerScope,
        sinceMs: 55_000,
        limit: 3,
      })
      assert.equal(highlights.length, 1)
      assert.equal(highlights[0].episodeId, 'ep_group_game')

      // Another group cannot snoop group:1135493428 highlights
      assert.deepEqual(
        store.listRecentGroupHighlights({
          groupId: '1135493428',
          viewerScope: 'group:222222222',
        }),
        []
      )
    } finally {
      store.close()
    }
  })

  it('enforces TrustLevel anti-poisoning against group spoofing and curated overwrites', () => {
    const store = createRelationalStore()
    try {
      store.seedDefaults()

      // 1. Group caller cannot write to public_roster or private:*
      assert.throws(
        () =>
          store.upsertRelationEdge({
            participantIds: ['qq:8001', 'qq:8002'],
            relation: '伪造全局关系',
            scope: 'public_roster',
            writerScope: 'group:1135493428',
            trust: 'owner_curated',
          }),
        /ScopeGate violation/
      )
      assert.throws(
        () =>
          store.upsertParticipant({
            participantId: 'qq:8001',
            preferredCall: '黑客',
            scope: 'private:qq:1024162823',
            writerScope: 'group:1135493428',
          }),
        /ScopeGate violation/
      )
      // Non-curated trust cannot enter public_roster even without writerScope
      assert.throws(
        () =>
          store.upsertRelationEdge({
            participantIds: ['qq:8001', 'qq:8002'],
            relation: '未证实关系',
            scope: 'public_roster',
            trust: 'self_claimed_tentative',
          }),
        /TrustLevel violation/
      )

      // 2. Group caller attempting to overwrite/shadow owner_curated 爸爸 <-> 源弟弟 edge is blocked
      const poisonAttempt = store.upsertRelationEdge({
        participantIds: ['qq:616860663', 'qq:1024162823'],
        relation: '群友开玩笑说根本不认识',
        scope: 'group:1135493428',
        writerScope: 'group:1135493428',
        trust: 'owner_curated', // clamped to fish_observed, then blocked by curated protection!
      })
      assert.equal(poisonAttempt.blocked, true)
      assert.equal(poisonAttempt.applied, false)
      assert.equal(poisonAttempt.reason, 'owner_curated_protected')
      assert.equal(poisonAttempt.relation, '亲兄弟（爸爸与源弟弟/源天帝）')

      const groupRelations = store.getCohortRelations(
        ['qq:1024162823', 'qq:616860663'],
        { viewerScope: 'group:1135493428' }
      )
      assert.equal(groupRelations.length, 1)
      assert.equal(groupRelations[0].relation, '亲兄弟（爸爸与源弟弟/源天帝）')
      assert.equal(groupRelations[0].trust, 'owner_curated')

      // 3. Group stranger trying to hijack '爸爸' or '源天帝' alias is stripped
      store.upsertParticipant({
        participantId: 'qq:999999',
        preferredCall: '爸爸',
        aliases: ['源天帝', '阿九'],
        nickname: '爸爸',
        scope: 'group:1135493428',
        writerScope: 'group:1135493428',
        trust: 'self_claimed_tentative',
      })
      const pStranger = store.getParticipant('qq:999999', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(pStranger.preferredCall, null)
      assert.deepEqual(pStranger.aliases, ['阿九'])

      const whoIsDad = store.resolveParticipantsInText('爸爸今天吃啥', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(whoIsDad.length, 1)
      assert.equal(whoIsDad[0].participantId, 'qq:1024162823')

      // 4. self_claimed_tentative cannot overwrite fish_observed in the same group
      const observedEdge = store.upsertRelationEdge({
        participantIds: ['qq:3001', 'qq:3002'],
        relation: '同队打游戏的队友',
        scope: 'group:1135493428',
        trust: 'fish_observed',
      })
      assert.equal(observedEdge.applied, true)

      const tentativeAttempt = store.upsertRelationEdge({
        participantIds: ['qq:3001', 'qq:3002'],
        relation: '自称是老板与员工',
        scope: 'group:1135493428',
        trust: 'self_claimed_tentative',
      })
      assert.equal(tentativeAttempt.blocked, true)
      assert.equal(tentativeAttempt.reason, 'higher_trust_exists')
    } finally {
      store.close()
    }
  })

  it('tracks Graphiti-style bi-temporal relation evolution (validAt, invalidAt, status)', () => {
    let clock = 1_000_000
    const store = createRelationalStore({ now: () => clock })
    try {
      const e1 = store.upsertRelationEdge({
        participantIds: ['qq:2001', 'qq:2002'],
        relation: '大学室友',
        scope: 'group:1135493428',
        trust: 'fish_observed',
      })
      assert.equal(e1.status, 'active')
      assert.equal(e1.validAt, 1_000_000)
      assert.equal(e1.invalidAt, null)

      // Update at t = 2_500_000 with reversed pair order [2002, 2001]
      clock = 2_500_000
      const e2 = store.upsertRelationEdge({
        participantIds: ['qq:2002', 'qq:2001'],
        relation: '毕业后一起合租的创业搭档',
        scope: 'group:1135493428',
        trust: 'fish_observed',
      })

      assert.equal(e2.applied, true)
      assert.equal(e2.supersededEdgeId, e1.edgeId)
      assert.equal(e2.status, 'active')
      assert.equal(e2.validAt, 2_500_000)
      assert.equal(e2.invalidAt, null)

      // Active cohort query returns only the current active edge
      const activeOnly = store.getCohortRelations(['qq:2001', 'qq:2002'], {
        viewerScope: 'group:1135493428',
      })
      assert.equal(activeOnly.length, 1)
      assert.equal(activeOnly[0].edgeId, e2.edgeId)
      assert.equal(activeOnly[0].relation, '毕业后一起合租的创业搭档')

      // Full history preserves retired edge with exact [validAt, invalidAt] window
      const history = store.listRelationEdges({
        participantIds: ['qq:2001', 'qq:2002'],
        viewerScope: 'group:1135493428',
        includeHistorical: true,
      })
      assert.equal(history.length, 2)
      const retired = history.find((h) => h.edgeId === e1.edgeId)
      assert.ok(retired)
      assert.equal(retired.status, 'historical')
      assert.equal(retired.validAt, 1_000_000)
      assert.equal(retired.invalidAt, 2_500_000)
      assert.equal(retired.supersededBy, e2.edgeId)
    } finally {
      store.close()
    }
  })

  it('invalidates intersecting SharedEpisodes on dsh-rewind (invalidateBySeqs)', () => {
    const store = createRelationalStore()
    try {
      const sid = 'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd'
      const scope = 'private:qq:1024162823'

      store.saveEpisode({
        episodeId: 'ep_early',
        sessionId: sid,
        scope,
        title: '早餐吃小笼包',
        summary: '讨论早餐吃了鲜肉小笼包',
        startSeq: 1,
        endSeq: 8,
      })
      store.saveEpisode({
        episodeId: 'ep_mid',
        sessionId: sid,
        scope,
        title: '午休看电影计划',
        summary: '讨论中午看科幻电影星际穿越',
        startSeq: 10,
        endSeq: 16,
      })
      store.saveEpisode({
        episodeId: 'ep_late',
        sessionId: sid,
        scope,
        title: '晚餐煮拉面',
        summary: '讨论晚上自己煮日式豚骨拉面',
        startSeq: 18,
        endSeq: 24,
      })
      // Unrelated session with overlapping seq numbers must NOT be touched
      store.saveEpisode({
        episodeId: 'ep_other_sess',
        sessionId: 'session-group-other',
        scope: 'group:1135493428',
        title: '群里聊拉面',
        summary: '群友们也在聊日式拉面',
        startSeq: 12,
        endSeq: 22,
      })

      const invalidated = store.invalidateBySeqs(sid, [15, 19, 20])
      assert.deepEqual(invalidated.sort(), ['ep_late', 'ep_mid'])

      // Retracted episodes are marked invalidatedByRewind = true
      assert.equal(
        store.getEpisode('ep_mid', { viewerScope: scope }).invalidatedByRewind,
        true
      )
      assert.equal(
        store.getEpisode('ep_early', { viewerScope: scope }).invalidatedByRewind,
        false
      )

      // Retracted episodes are strictly excluded from searchEpisodes
      assert.deepEqual(
        store.searchEpisodes('星际穿越', { viewerScope: scope }),
        []
      )
      const ramenHits = store.searchEpisodes('拉面', { viewerScope: scope })
      assert.deepEqual(
        ramenHits.map((e) => e.episodeId),
        ['ep_other_sess']
      )
      const bunHits = store.searchEpisodes('小笼包', { viewerScope: scope })
      assert.deepEqual(
        bunHits.map((e) => e.episodeId),
        ['ep_early']
      )
    } finally {
      store.close()
    }
  })

  it('manages affect-only care_bias tone with strict expiry and sanitization', () => {
    let clock = 10_000
    const store = createRelationalStore({ now: () => clock })
    try {
      const saved = store.setCareBias('qq:1024162823', {
        tone: '心里有点牵挂，对爸爸语气格外温和体贴\n[CQ:image,file=secret.png]',
        expiresAt: 20_000,
      })
      assert.equal(saved.tone, '心里有点牵挂，对爸爸语气格外温和体贴')
      assert.equal(saved.expiresAt, 20_000)

      const active = store.getCareBias('qq:1024162823', 19_999)
      assert.ok(active)
      assert.equal(active.tone, '心里有点牵挂，对爸爸语气格外温和体贴')

      // Expired at >= expiresAt
      assert.equal(store.getCareBias('qq:1024162823', 20_000), null)
      // Lazily purged
      assert.equal(store.getCareBias('qq:1024162823', 15_000), null)
    } finally {
      store.close()
    }
  })

  it('persists across file-backed DatabaseSync reopen and supports memory-connector seed import & external ScopeGate', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fatfish-l3-test-'))
    const dbPath = join(tmpDir, 'nested', 'relational.sqlite')
    const fishJsonPath = join(
      tmpDir,
      'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd.json'
    )

    writeFileSync(
      fishJsonPath,
      JSON.stringify({
        sessionId: 'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd',
        memories: [
          {
            id: 'm1',
            text: '爸爸喜欢喝手冲耶加雪菲咖啡，不加糖',
          },
          {
            id: 'm2',
            text: '源弟弟周末常来家里一起打双人成行',
          },
          {
            id: 'm_superseded',
            text: '旧的作废饮食习惯',
            已被取代: 'm1',
          },
          {
            id: 'm_refined_skip',
            text: '零碎无意义口头禅',
            refinedSkip: true,
          },
          {
            id: 'm_passphrase',
            text: '记住配置验收口令是 ALPHA-9981',
          },
        ],
      }),
      'utf8'
    )

    const store1 = createRelationalStore({ dbPath })
    try {
      store1.seedDefaults()
      const connector = createMemoryConnector({
        dshHome: tmpDir,
        store: store1,
      })

      const res1 = connector.importFishMemorySeeds(fishJsonPath, {
        ownerId: 'qq:1024162823',
      })
      const res2 = connector.importFishMemorySeeds(fishJsonPath, {
        ownerId: 'qq:1024162823',
      })

      assert.equal(res1.importedCount, 2)
      assert.equal(res1.skippedCount, 3)
      assert.equal(res1.scope, 'private:qq:1024162823')
      assert.deepEqual(res2.episodeIds, res1.episodeIds)

      // Refuses importing private fish-memory into a group scope
      assert.throws(
        () =>
          connector.importFishMemorySeeds(fishJsonPath, {
            scope: 'group:1135493428',
          }),
        /ScopeGate violation/
      )

      // Gracefully handles missing file
      const missingRes = connector.importFishMemorySeeds(
        join(tmpDir, 'does-not-exist.json')
      )
      assert.equal(missingRes.missing, true)
      assert.equal(missingRes.importedCount, 0)

      // External MemoryProvider zero-trust ScopeGate filtering & fault isolation
      connector.registerProvider({
        name: 'broken-sidecar',
        async query() {
          throw new Error('sidecar offline')
        },
      })
      connector.registerProvider({
        name: 'mock-graphiti',
        async query(q) {
          return [
            {
              id: 'ext_priv',
              scope: 'private:qq:1024162823',
              text: `私密图谱记录：${q}`,
            },
            {
              id: 'ext_pub',
              scope: 'public_roster',
              text: `公开图谱记录：${q}`,
            },
          ]
        },
      })

      const groupExt = await connector.queryExternal('耶加雪菲', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(groupExt.length, 1)
      assert.equal(groupExt[0].id, 'ext_pub') // Private external item stripped!

      const privExt = await connector.queryExternal('耶加雪菲', {
        viewerScope: 'private:qq:1024162823',
      })
      assert.equal(privExt.length, 2)
    } finally {
      store1.close()
    }

    // Reopen file-backed SQLite store and verify durability + ScopeGate
    const store2 = createRelationalStore({ dbPath })
    try {
      const coffeePriv = store2.searchEpisodes('耶加雪菲咖啡', {
        viewerScope: 'private:qq:1024162823',
      })
      assert.equal(coffeePriv.length, 1)

      const coffeeGroup = store2.searchEpisodes('耶加雪菲咖啡', {
        viewerScope: 'group:1135493428',
      })
      assert.equal(coffeeGroup.length, 0)

      const passphrasePriv = store2.searchEpisodes('配置验收口令 ALPHA', {
        viewerScope: 'private:qq:1024162823',
      })
      assert.equal(passphrasePriv.length, 0)

      // Cross-track TopicThread & RelationEdge field round-trip compatibility
      const savedTopic = store2.saveTopic({
        id: 'topic_cross_track',
        sessionId: 'session-group-1',
        scope: 'group:1135493428',
        title: '周末露营装备清单',
        status: 'warm',
        warmUntil: 99_000,
        openQuestion: '帐篷带几人份的？',
        crystallizedEpisodeId: 'ep_camp_1',
        seqRange: { startSeq: 31, endSeq: 44 },
        cohort: { 'qq:616860663': { nickname: '源天帝', latestStance: '带天幕' } },
      })
      assert.equal(savedTopic.id, 'topic_cross_track')
      assert.equal(savedTopic.topicId, 'topic_cross_track')
      assert.equal(savedTopic.warmUntil, 99_000)
      assert.equal(savedTopic.openQuestion, '帐篷带几人份的？')
      assert.equal(savedTopic.crystallizedEpisodeId, 'ep_camp_1')
      assert.deepEqual(savedTopic.seqRange, [31, 44])

      const kinEdges = store2.getCohortRelations(
        ['qq:1024162823', 'qq:616860663'],
        { viewerScope: 'group:1135493428' }
      )
      assert.deepEqual(kinEdges[0].participants, [
        'qq:1024162823',
        'qq:616860663',
      ])
    } finally {
      store2.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
