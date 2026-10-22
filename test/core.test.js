import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, loadStore, addField, updateField, editValue, derive, foreignPrivateText, privateFragments,
    fingerprint, suppressChanges, recordAnalysis, updateSummary } from '../core.js';
import { WORLD_BOOK_NAME, PRESET_ID, DARK_WORLD_BOOK_NAME, DARK_PRESET_ID, hasPresetMembers,
    isWorldbookChat, isDarkWorldbookChat, missingWorldbookFields, missingDarkFields,
    visiblePresetField, applyWorldbookPreset, applyDarkPreset } from '../worldbook-preset.js';

const members = [{ id: 'a.png', name: '艾琳' }, { id: 'b.png', name: '洛安' }, { id: 'c.png', name: '米拉' }];
const reply = (name, id, text, reasoning = '', genId = 1, when = '2026-01-01T00:00:00Z') => ({
    name, original_avatar: id, is_user: false, mes: text, gen_finished: when,
    extra: { gen_id: genId, reasoning },
});

test('同轮只更新发言者与明确提及者，思考只属于本人', () => {
    const store = newStore();
    const chat = [
        { is_user: true, mes: '艾琳和洛安，你们在哪？' },
        reply('艾琳', 'a.png', '心情：犹豫\n洛安的位置：茶馆', '内心：我想暂时保持沉默', 7),
    ];
    const result = derive(store, chat, members);
    assert.equal(result['a.png'].mood.value, '犹豫');
    assert.equal(result['a.png'].thought.value, '我想暂时保持沉默');
    assert.equal(result['b.png'].location.value, '茶馆');
    assert.equal(result['b.png'].thought.value, null);
    assert.equal(result['c.png'].updatedAt, null);
});

test('历史改写撤销自动状态，手动值留存，未来明确证据可更新', () => {
    const store = newStore();
    const chat = [reply('艾琳', 'a.png', '心情：开心')];
    assert.equal(derive(store, chat, members)['a.png'].mood.value, '开心');
    editValue(store, 'a.png', 'mood', '谨慎');
    chat[0].mes = '普通问候';
    assert.equal(derive(store, chat, members)['a.png'].mood.value, '谨慎');
    chat.push(reply('艾琳', 'a.png', '心情：平静', '', 2, new Date(Date.now() + 10000).toISOString()));
    assert.equal(derive(store, chat, members)['a.png'].mood.value, '平静');
});

test('字段重命名保值，数值边界和成人门槛生效', () => {
    const store = newStore();
    const field = addField(store, '信任度');
    editValue(store, 'a.png', field.id, 0, '初识');
    updateField(store, field.id, { name: '好感', kind: 'both', meaning: '程度' });
    assert.equal(derive(store, [], members)['a.png'].fields[field.id].value, 0);
    assert.throws(() => editValue(store, 'a.png', field.id, 101), /0–100/);
    updateField(store, field.id, { name: '好感', kind: 'both', adult: true });
    assert.equal(derive(store, [], members)['a.png'].fields[field.id], undefined);
    assert.throws(() => editValue(store, 'b.png', field.id, 50), /成年/);
    store.adult['a.png'] = true;
    assert.equal(derive(store, [], members)['a.png'].fields[field.id].value, 0);
});

test('隐藏字段只因有效关键词、阈值或手动节点解锁', () => {
    const store = newStore();
    const trust = addField(store, '信任');
    const secret = addField(store, '线索');
    updateField(store, trust.id, { name: '信任', kind: 'score' });
    updateField(store, secret.id, { name: '线索', kind: 'text', hidden: true,
        partial: { kind: 'threshold', fieldId: trust.id, value: 60 }, full: { kind: 'keyword', value: '钥匙' } });
    let chat = [reply('艾琳', 'a.png', '普通问候')];
    assert.equal(derive(store, chat, members)['a.png'].stages[secret.id], 0);
    chat.push(reply('艾琳', 'a.png', '信任：62', '', 2, '2026-01-02T00:00:00Z'));
    const partial = derive(store, chat, members)['a.png'];
    assert.equal(partial.stages[secret.id], 1);
    assert.equal(partial.unlockEvidence[secret.id].source.index, 1);
    chat.push(reply('艾琳', 'a.png', '我找到钥匙。', '', 3, '2026-01-03T00:00:00Z'));
    assert.equal(derive(store, chat, members)['a.png'].stages[secret.id], 2);
    updateField(store, secret.id, { name: '线索', kind: 'text', hidden: true, full: { kind: 'node', value: '揭晓' } });
    store.nodes['a.png'] = { '揭晓': Date.now() };
    assert.equal(derive(store, [], members)['a.png'].stages[secret.id], 2);
});

test('其他角色的可见思考会被请求审计识别', () => {
    const store = newStore();
    const chat = [reply('艾琳', 'a.png', '你好', '私有标记 BLUE-CANARY-72841')];
    const fragments = privateFragments(store, chat, members);
    assert.equal(foreignPrivateText(JSON.stringify({ prompt: '私有标记 BLUE-CANARY-72841' }), 'b.png', fragments).id, 'a.png');
    assert.equal(foreignPrivateText(JSON.stringify({ prompt: '普通回复' }), 'b.png', fragments), null);
    assert.equal(foreignPrivateText(JSON.stringify({ prompt: '私有标记 BLUE-CANARY-72841' }), 'a.png', fragments), null);
    chat[0].extra.tool_invocations = [{ reasoning: '私有工具推理 TOOL-CANARY-99111' }];
    assert.equal(foreignPrivateText('私有工具推理 TOOL-CANARY-99111', 'b.png', privateFragments(store, chat, members)).id, 'a.png');
    chat[0].extra.reasoning = '私有"标记 BLUE-CANARY-72841';
    assert.equal(foreignPrivateText(JSON.stringify({ prompt: '私有"标记 BLUE-CANARY-72841' }), 'b.png', privateFragments(store, chat, members)).id, 'a.png');
});

test('停止生成的消息快照不会推进状态，之后改写仍可重新计算', () => {
    const store = newStore();
    const chat = [reply('艾琳', 'a.png', '心情：焦虑')];
    suppressChanges(store, [], chat);
    assert.equal(derive(store, chat, members)['a.png'].mood.value, null);
    chat[0].mes = '心情：平静';
    assert.equal(derive(store, chat, members)['a.png'].mood.value, '平静');
    assert.notEqual(fingerprint(chat[0]), store.suppressed[0].fingerprint);
});

test('成人字段只由玩家录入，普通回复不会改写', () => {
    const store = newStore();
    const field = addField(store, '身体资料');
    updateField(store, field.id, { name: field.name, kind: 'text', adult: true });
    store.adult['a.png'] = true;
    editValue(store, 'a.png', field.id, null, '玩家确认的描述');
    const chat = [reply('艾琳', 'a.png', '身体资料：模型生成的描述')];
    assert.equal(derive(store, chat, members)['a.png'].fields[field.id].description, '玩家确认的描述');
});

test('角色卡中的固定秘密不会从可见思考直接抄入面板', () => {
    const store = newStore();
    const chat = [reply('艾琳', 'a.png', '你好', '内心：SECRET-CANARY-73109')];
    assert.equal(derive(store, chat, members, { 'a.png': '隐藏身世 SECRET-CANARY-73109' })['a.png'].thought.value, null);
});

test('普通非空回复更新最近发言，空白回复不覆盖它', () => {
    const chat = [reply('艾琳', 'a.png', '我先想一想。'), reply('艾琳', 'a.png', '', '', 2, '2026-01-02T00:00:00Z')];
    const npc = derive(newStore(), chat, members)['a.png'];
    assert.equal(npc.recentReply.value, '我先想一想。');
    assert.equal(npc.thought.value, null);
    assert.equal(npc.updatedAt, Date.parse(chat[0].gen_finished));
});

test('生成心声只跟随原回复，改写后撤销且不传给其他角色', () => {
    const store = newStore();
    const chat = [reply('艾琳', 'a.png', '我先想一想。')];
    store.generated.push({ npcId: 'a.png', key: 'thought', value: '我还拿不准。', index: 0,
        fingerprint: fingerprint(chat[0]), at: Date.parse(chat[0].gen_finished) });
    assert.equal(derive(store, chat, members)['a.png'].thought.value, '我还拿不准。');
    store.current = derive(store, chat, members);
    assert.equal(foreignPrivateText('我还拿不准。', 'b.png', privateFragments(store, chat, members)).id, 'a.png');
    chat[0].mes = '我已经决定了。';
    assert.equal(derive(store, chat, members)['a.png'].thought.value, null);
});

test('公共世界书预设只匹配绑定或全局启用的三人原生群聊', () => {
    const group = { groupId: 'group-1', chatMetadata: { world_info: WORLD_BOOK_NAME } };
    assert.equal(hasPresetMembers([{ name: '七月' }, { name: '小乔' }, { name: '岚姐' }]), true);
    assert.equal(isWorldbookChat(group, members.map((member, index) => ({ ...member, name: ['七月', '小乔', '岚姐'][index] }))), true);
    assert.equal(isWorldbookChat({ ...group, chatMetadata: {} }, members, [WORLD_BOOK_NAME]), false);
    assert.equal(isWorldbookChat({ ...group, chatMetadata: {} }, [
        { name: '七月' }, { name: '小乔' }, { name: '岚姐' },
    ], [WORLD_BOOK_NAME]), true);
    assert.equal(isWorldbookChat({ ...group, groupId: null }, members), false);
});

test('公共世界书预设只建立未知字段，重复应用保留玩家记录', () => {
    const store = newStore();
    assert.equal(applyWorldbookPreset(store), 7);
    assert.equal(missingWorldbookFields(store), false);
    assert.equal(store.preset.id, PRESET_ID);
    assert.equal(store.adult['a.png'], undefined);
    const npc = derive(store, [], members)['a.png'];
    assert.equal(npc.fields[`${PRESET_ID}:trust`], undefined);
    assert.equal(npc.stages[`${PRESET_ID}:identity`], 0);
    editValue(store, 'a.png', `${PRESET_ID}:trust`, 40);
    assert.equal(applyWorldbookPreset(store), 0);
    assert.equal(derive(loadStore(structuredClone(store)), [], members)['a.png'].fields[`${PRESET_ID}:trust`].value, 40);
});

test('补全预设沿用已有同名数值字段，字段上限失败不产生部分修改', () => {
    const store = newStore();
    const trust = addField(store, '群内信任');
    applyWorldbookPreset(store);
    assert.equal(store.fields.find(field => field.name === '婚姻处境').unlock.partial.fieldId, trust.id);
    const full = newStore();
    for (let index = 0; index < 23; index++) addField(full, `字段${index}`);
    assert.throws(() => applyWorldbookPreset(full), /24/);
    assert.equal(full.fields.length, 23);
});

test('背德版按世界书匹配，切换预设保留公共版的手动记录', () => {
    const trio = members.map((member, index) => ({ ...member, name: ['七月', '小乔', '岚姐'][index] }));
    assert.equal(isDarkWorldbookChat({ groupId: 'g', chatMetadata: { world_info: DARK_WORLD_BOOK_NAME } }, trio), true);
    assert.equal(isDarkWorldbookChat({ groupId: 'g', chatMetadata: { world_info: WORLD_BOOK_NAME } }, trio), false);
    const store = newStore();
    applyWorldbookPreset(store);
    editValue(store, 'a.png', `${PRESET_ID}:trust`, 40);
    assert.equal(applyDarkPreset(store, trio), 10);
    assert.equal(store.preset.id, DARK_PRESET_ID);
    assert.equal(missingDarkFields(store), false);
    assert.equal(derive(store, [], members)['a.png'].fields[`${PRESET_ID}:trust`].value, 40);
    assert.equal(visiblePresetField(store.fields.find(f => f.name === '群内信任'), DARK_PRESET_ID), true);
    assert.equal(visiblePresetField(store.fields.find(f => f.name === '济南日常'), DARK_PRESET_ID), false);
    assert.equal(store.fields.find(f => f.name === '七月·规则松动').applies['b.png'], false);
    assert.equal(store.fields.find(f => f.name === '七月·规则松动').applies['a.png'], true);
    editValue(store, 'a.png', `${DARK_PRESET_ID}:july_rules`, null, '她主动解释了群规');
    applyWorldbookPreset(store);
    assert.equal(store.preset.id, PRESET_ID);
    assert.equal(derive(store, [], members)['a.png'].fields[`${PRESET_ID}:trust`].value, 40);
    applyDarkPreset(store, trio);
    assert.equal(derive(store, [], members)['a.png'].fields[`${DARK_PRESET_ID}:july_rules`].description, '她主动解释了群规');
});

test('背德版不把别人的说法或私有思考写成该角色的隐藏线索', () => {
    const store = newStore();
    applyDarkPreset(store);
    const chat = [reply('小乔', 'b.png', '七月的私聊状态：已开放\n私聊状态：只谈日常',
        '离城线索：我想离开济南')];
    const current = derive(store, chat, [
        { id: 'a.png', name: '七月' }, { id: 'b.png', name: '小乔' }, { id: 'c.png', name: '岚姐' },
    ]);
    assert.equal(current['a.png'].fields[`${DARK_PRESET_ID}:private`], undefined);
    assert.equal(current['b.png'].fields[`${DARK_PRESET_ID}:private`].description, '只谈日常');
    assert.equal(current['b.png'].fields[`${DARK_PRESET_ID}:departure`], undefined);
    assert.equal(current['b.png'].stages[`${DARK_PRESET_ID}:departure`], 0);
});

test('私聊分析记录关系节点和身体近况，原话改写后撤销', () => {
    const store = newStore();
    applyDarkPreset(store, [{ id: 'a.png', name: '小乔' }]);
    const chat = [reply('小乔', 'a.png', '我愿意和你见面。现在需要休息，我们明天再谈后续。')];
    const analysis = JSON.stringify({ thought: '我需要想一想。', changes: [
        { key: 'stage', value: 4, evidence: '我愿意和你见面' },
        { key: 'physical', value: '亲密后需要休息', evidence: '现在需要休息' },
        { key: 'milestone', value: '两人确认见面', evidence: '我愿意和你见面' },
        { key: 'location', value: '酒店', evidence: '玩家说在酒店' },
    ] });
    assert.equal(recordAnalysis(store, chat, 'a.png', analysis, [0], 0, true), 3);
    const npc = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(npc.fields[`${DARK_PRESET_ID}:stage`].description, '4·见面');
    assert.equal(npc.physical.value, '亲密后需要休息');
    assert.equal(npc.location.value, null);
    assert.equal(npc.milestones[0].value, '两人确认见面');
    chat[0].mes = '改写后的普通问候';
    const revised = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(revised.physical.value, null);
    assert.equal(revised.milestones.length, 0);
    assert.equal(revised.fields[`${DARK_PRESET_ID}:stage`], undefined);
});

test('自动推进最多两档，引用玩家话语不能写入状态', () => {
    const store = newStore();
    applyDarkPreset(store, [{ id: 'a.png', name: '小乔' }]);
    const chat = [reply('小乔', 'a.png', '我愿意私聊。')];
    const analysis = JSON.stringify({ changes: [
        { key: 'stage', value: 6, evidence: '我愿意私聊' },
        { key: 'relation', value: '愿意私聊', evidence: '我愿意私聊' },
        { key: 'mood', value: '激动', evidence: '玩家说她激动' },
    ] });
    assert.equal(recordAnalysis(store, chat, 'a.png', analysis, [0], 0), 1);
    const npc = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(npc.relation.value, '愿意私聊');
    assert.equal(npc.mood.value, null);
    assert.equal(npc.fields[`${DARK_PRESET_ID}:stage`], undefined);
});

test('第六档需要角色回复确认事件已经发生', () => {
    const store = newStore();
    applyDarkPreset(store, [{ id: 'a.png', name: '小乔' }]);
    const chat = [reply('小乔', 'a.png', '我想清楚了。内射这件事，我们得认真谈。我接受了内射。')];
    const analysis = JSON.stringify({ changes: [
        { key: 'stage', value: 6, evidence: '我想清楚了' },
        { key: 'stage', value: 6, evidence: '内射这件事，我们得认真谈' },
        { key: 'stage', value: 6, evidence: '我接受了内射' },
    ] });
    assert.equal(recordAnalysis(store, chat, 'a.png', analysis, [0], 5), 1);
    assert.equal(derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'].fields[`${DARK_PRESET_ID}:stage`].description, '6·内射与风险');
});

test('已确认的亲密节点推进档位且旧档位不会覆盖，身体状态随证据撤销', () => {
    const store = newStore();
    applyDarkPreset(store, [{ id: 'a.png', name: '小乔' }]);
    const chat = [reply('小乔', 'a.png', '我接受了内射，这是我们已做的决定。'),
        reply('小乔', 'a.png', '我仍愿意和你见面。', '', 2, '2026-01-02T00:00:00Z')];
    recordAnalysis(store, chat, 'a.png', JSON.stringify({ changes: [
        { key: 'milestone', value: '接受了内射', evidence: '我接受了内射' },
    ] }), [0], 4);
    recordAnalysis(store, chat, 'a.png', JSON.stringify({ changes: [
        { key: 'stage', value: 4, evidence: '我仍愿意和你见面' },
    ] }), [1], 4);
    let npc = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(npc.fields[`${DARK_PRESET_ID}:stage`].description, '6·内射与风险');
    assert.equal(npc.semen.value, '内射后充满精液');
    chat[0].mes = '我想和你谈谈。';
    npc = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(npc.fields[`${DARK_PRESET_ID}:stage`].description, '4·见面');
    assert.equal(npc.semen.value, null);
});

test('重新分析不覆盖关键节点，12轮摘要只存短快照', () => {
    const store = newStore();
    applyDarkPreset(store, [{ id: 'a.png', name: '小乔' }]);
    const chat = Array.from({ length: 12 }, (_, i) => reply('小乔', 'a.png',
        i === 0 ? '我们第一次身体结合。' : `第${i + 1}次一起散步。`, '', i + 1));
    recordAnalysis(store, chat, 'a.png', JSON.stringify({ changes: [
        { key: 'milestone', value: '第一次身体结合', evidence: '第一次身体结合' },
    ] }), [0], 4);
    recordAnalysis(store, chat, 'a.png', JSON.stringify({ changes: [] }), [0], 5, true);
    const npc = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(npc.milestones.length, 1);
    assert.equal(npc.fields[`${DARK_PRESET_ID}:stage`].description, '5·肉体关系');
    assert.equal(updateSummary(store, chat, { id: 'a.png', name: '小乔' }, npc), true);
    assert.equal(store.summaries['a.png'].through, 12);
    assert.match(store.summaries['a.png'].text, /5·肉体关系/);
    assert.equal(updateSummary(store, chat, { id: 'a.png', name: '小乔' }, npc), false);
    chat[0].mes = '那天我们只是散步。';
    const revised = derive(store, chat, [{ id: 'a.png', name: '小乔' }])['a.png'];
    assert.equal(updateSummary(store, chat, { id: 'a.png', name: '小乔' }, revised), true);
    assert.doesNotMatch(store.summaries['a.png'].text, /5·肉体关系/);
});
