import test from 'node:test';
import assert from 'node:assert/strict';
import { bookNamesFor, visibleMessagesFor, selectLore, panelRules, safeSettingsText } from '../lore.js';

test('角色绑定世界书只选择当前角色，激活只扫描可见消息', () => {
    const shared = { name: '公共', entries: { 1: { uid: 1, key: ['广场'], content: '广场在北边。' } } };
    const a = { name: '甲专属', entries: { 2: { uid: 2, key: ['密语'], content: '甲知道密语。' } } };
    const b = { name: '乙专属', entries: { 3: { uid: 3, constant: true, content: '乙喜欢喝茶。' } } };
    assert.deepEqual(bookNamesFor({ global: ['公共'], primary: '甲专属' }), ['公共', '甲专属']);
    assert.deepEqual(bookNamesFor({ global: ['公共'], primary: '乙专属' }), ['公共', '乙专属']);
    const visibleForB = [{ speaker: 'player', text: '我到了广场' }];
    const result = selectLore([shared, b], visibleForB);
    assert.deepEqual(result.selected.map(item => item.content), ['广场在北边。', '乙喜欢喝茶。']);
    assert.doesNotMatch(JSON.stringify(result), /甲知道密语/);
    assert.deepEqual(selectLore([a], visibleForB).selected, []);
    const history = [
        { speaker: 'player', text: '密语 BLUE-CANARY', audience: ['player', 'A'] },
        { speaker: 'player', text: '我到了广场', audience: ['player', 'A', 'B'] },
    ];
    assert.deepEqual(selectLore([a], visibleMessagesFor(history, 'B')).selected, []);
    assert.deepEqual(selectLore([a], visibleMessagesFor(history, 'A')).selected.map(item => item.content), ['甲知道密语。']);
});

test('启用的面板规则按模型接口读取，未知宏拒绝', () => {
    const manager = {
        activeCharacter: { id: 1 },
        getPromptOrderForCharacter: () => [{ identifier: 'main', enabled: true }, { identifier: 'off', enabled: false }],
        getPromptById: id => ({ identifier: id, content: id === 'main' ? '遵守 {{char}} 的性格' : '禁用', marker: false }),
        shouldTrigger: () => true,
    };
    assert.deepEqual(panelRules('openai', null, manager), ['遵守 {{char}} 的性格']);
    assert.deepEqual(panelRules('kobold', { enabled: true, content: '纯文本', post_history: '不代写玩家' }), ['纯文本', '不代写玩家']);
    assert.equal(safeSettingsText('遵守 {{char}} 的性格', { character: '甲', player: '玩家' }), '遵守 甲 的性格');
    assert.throws(() => safeSettingsText('{{lastMessage}}', { character: '甲' }), /未支持的宏/);
});
