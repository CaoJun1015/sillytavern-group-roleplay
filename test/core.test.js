import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSession, beginRound, makeMessage, contextFor, validatePlan, validateReply,
    completeRound, rewind, recover, applyChanges, parseJson, forbiddenInRequest, sameTurn, saveGroupSnapshot,
} from '../core.js';

const newSession = () => createSession('group', 'chat', ['A', 'B'], { startTime: '2026-10-20T00:00:00.000Z' });

test('私聊仅进入参与者上下文，公开转述才进入其他角色上下文', () => {
    let session = newSession();
    session.channel = 'private:A';
    const started = beginRound(session, [], '私密标记 BLUE-CANARY');
    const privateMessage = started.messages[0];
    const reply = { action: 'reply', text: '我记住了 BLUE-CANARY', changes: [] };
    const response = validateReply(reply, started.session, 'A');
    const done = completeRound(started.session, started.messages, [{ speaker: 'A', reply, message: response }]);
    assert.doesNotMatch(JSON.stringify(contextFor(done.session, done.messages, 'B')), /BLUE-CANARY/);
    assert.match(JSON.stringify(contextFor(done.session, done.messages, 'A')), /BLUE-CANARY/);
    done.session.channel = 'group';
    const publicStart = beginRound(done.session, done.messages, '聊点别的');
    const publicReply = { action: 'reply', text: '我听过 BLUE-CANARY。', changes: [] };
    const publicMessage = validateReply(publicReply, publicStart.session, 'A');
    const published = completeRound(publicStart.session, publicStart.messages, [{ speaker: 'A', reply: publicReply, message: publicMessage }]);
    assert.match(JSON.stringify(contextFor(published.session, published.messages, 'B')), /BLUE-CANARY/);
    assert.equal(privateMessage.audience.includes('B'), false);
    assert.equal(forbiddenInRequest(done.messages, 'B', 'group', '角色', JSON.stringify({ prompt: privateMessage.text })).id, privateMessage.id);
    assert.equal(forbiddenInRequest(done.messages, 'A', 'group', '角色', JSON.stringify({ prompt: privateMessage.text })), undefined);
    assert.equal(forbiddenInRequest(done.messages, 'player', 'group', '调度', JSON.stringify({ prompt: privateMessage.text })).id, privateMessage.id);
    const duplicate = makeMessage(session, 'r2', 'A', '收到。', 'group');
    const privateDuplicate = makeMessage(session, 'r3', 'A', '收到。', 'private:A');
    assert.equal(forbiddenInRequest([duplicate, privateDuplicate], 'player', 'group', '调度', JSON.stringify({ prompt: duplicate.text })), undefined);
    const escaped = makeMessage(session, 'r4', 'player', '私聊"标记\nX', 'private:A');
    assert.equal(forbiddenInRequest([escaped], 'B', 'group', '角色', JSON.stringify({ messages: [{ content: escaped.text }] })).id, escaped.id);
});

test('提交、重试和跨频道回退恢复时间与状态', () => {
    let session = newSession();
    let messages = [];
    let round = beginRound(session, messages, '大家好');
    ({ session, messages } = completeRound(round.session, round.messages, []));
    const firstId = session.rounds[0].id;
    assert.equal(session.state.time, '2026-10-20T00:01:00.000Z');
    session.channel = 'private:A';
    round = beginRound(session, messages, '你好吗');
    const reply = { action: 'reply', text: '我有点累。', changes: [] };
    const npc = validateReply(reply, round.session, 'A');
    reply.changes.push({ kind: 'body', subject: 'A', value: '累', sourceId: npc.id, quote: '我有点累。', confidence: 'explicit' });
    ({ session, messages } = completeRound(round.session, round.messages, [{ speaker: 'A', reply, message: npc }]));
    assert.equal(session.state.npcs.A.body, '累');
    const retry = rewind(session, messages, session.rounds[1].id, true);
    assert.equal(retry.session.state.time, '2026-10-20T00:01:00.000Z');
    assert.equal(retry.session.state.npcs.A.body, '未知');
    assert.equal(retry.messages.filter(m => m.speaker === 'player' && m.channel === 'private:A').length, 1);
    assert.equal(retry.session.pending.inputId, round.messages.at(-1).id);
    const rollback = rewind(session, messages, firstId);
    assert.equal(rollback.messages.length, 0);
    assert.equal(rollback.session.state.time, '2026-10-20T00:00:00.000Z');
    assert.equal(rollback.session.state.npcs.A.body, '未知');
});

test('非法计划、坏 JSON 和无证据状态变化均被拒绝', () => {
    const session = newSession();
    assert.throws(() => validatePlan({ speakers: ['A', 'A'] }, session));
    assert.throws(() => validatePlan({ intent: '测试', target: null, clarify: false, speakers: [], hidden: 'x' }, session));
    assert.throws(() => parseJson('```json\n{}\n```'));
    const pending = beginRound(session, [], '你好');
    assert.throws(() => validateReply({ action: 'reply', text: '你好', changes: [], hidden: 'x' }, pending.session, 'A'));
    const source = makeMessage(session, 'r', 'A', '今天天气不错');
    const state = applyChanges(session.state, [{
        kind: 'body', subject: 'A', value: '受伤', sourceId: source.id,
        quote: '我受伤了', confidence: 'explicit',
    }], [source], 'A');
    assert.equal(state.npcs.A.body, '未知');
    const unsupported = applyChanges(session.state, [{
        kind: 'relation', subject: 'A', value: '亲密', sourceId: source.id,
        quote: '今天天气不错', confidence: 'explicit',
    }], [source], 'A');
    assert.equal(unsupported.npcs.A.relation, '陌生');
});

test('重载保留待完成输入并舍弃不完整回合', () => {
    const session = newSession();
    const started = beginRound(session, [], '你好');
    const restored = recover(started.session, started.messages);
    assert.equal(restored.messages.length, 1);
    assert.equal(restored.session.pending.inputId, started.messages[0].id);
    const done = completeRound(started.session, started.messages, []);
    done.session.rounds[0].messageIds.push('missing');
    const broken = recover(done.session, done.messages);
    assert.equal(broken.session.rounds.length, 0);
    assert.equal(broken.messages.length, 0);
});

test('晚到结果和保存失败不能被当成有效提交', async () => {
    const started = beginRound(newSession(), [], '你好');
    const current = started.session;
    const binding = `${current.id}/${current.branchId}/${current.revision}/${current.pending.id}`;
    assert.equal(sameTurn(1, 1, binding, current), true);
    assert.equal(sameTurn(1, 2, binding, current), false);
    assert.equal(sameTurn(1, 1, binding, { ...current, revision: current.revision + 1 }), false);
    await assert.rejects(saveGroupSnapshot(async () => ({ ok: false, status: 500 }), {}, 'chat', []), /HTTP 500/);
    await assert.rejects(saveGroupSnapshot(async () => ({ ok: true, json: async () => ({ ok: false }) }), {}, 'chat', []), /响应未确认/);
});

test('过长的最新输入不会从角色上下文中静默消失', () => {
    const session = newSession();
    const message = makeMessage(session, 'r', 'player', 'x'.repeat(3500));
    assert.throws(() => contextFor(session, [message], 'A', 3000), /上下文预算/);
});
