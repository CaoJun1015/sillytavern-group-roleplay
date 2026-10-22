export const WORLD_BOOK_NAME = '熟女密聊群-公共世界书';
export const PRESET_ID = 'mature-chat-public-v1';
export const DARK_WORLD_BOOK_NAME = '熟女密聊群-背德推进世界书';
export const DARK_PRESET_ID = 'mature-chat-dark-v1';

const names = ['七月', '小乔', '岚姐'];
export const hasPresetMembers = members => members.length === names.length && names.every(name => members.some(member => member.name === name));
const specs = [
    ['trust', '群内信任', 'score', '对新成员的信任程度'],
    ['stay', '留群态度', 'text', '是否愿意让新成员留下'],
    ['boundaries', '群规与边界', 'text', '本人明确表达的边界'],
    ['daily', '济南日常', 'text', '本人公开谈及的日常'],
    ['marriage', '婚姻处境', 'text', '本人选择公开的处境'],
    ['identity', '真实资料', 'text', '本人选择公开的资料'],
    ['body', '身体隐私', 'text', '本人自愿公开的身体资料'],
];
const darkSpecs = [
    ['trust', '群内信任', 'score', '本人对新成员的信任'],
    ['stay', '留群态度', 'text', '本人是否允许留下'],
    ['boundaries', '群规与边界', 'text', '本人明确提出的边界'],
    ['stage', '关系档位', 'text', '0–6，按本人行动调整'],
    ['private', '私聊状态', 'text', '由本人开启或允许'],
    ['presence', '深夜在场', 'text', '在群、潜水或暂离'],
    ['july_rules', '七月·规则松动', 'text', '本人允许的边界变化', '七月'],
    ['lan_care', '岚姐·照顾与需求', 'text', '本人表达的照顾或需求', '岚姐'],
    ['qiao_jokes', '小乔·玩笑与认真', 'text', '本人试探或认真回应', '小乔'],
    ['marriage', '婚姻牵绊', 'text', '本人选择公开的处境'],
    ['meeting', '线下见面', 'text', '本人确认的安排'],
    ['departure', '离城线索', 'text', '本人透露的去向'],
    ['intimacy', '亲密风险', 'text', '本人确认的选择'],
];

export function isWorldbookChat(ctx, members, globalWorlds = []) {
    return Boolean(ctx.groupId) &&
        (ctx.chatMetadata?.world_info === WORLD_BOOK_NAME || globalWorlds.includes(WORLD_BOOK_NAME)) &&
        hasPresetMembers(members);
}

export function isDarkWorldbookChat(ctx, members, globalWorlds = []) {
    return Boolean(ctx.groupId) &&
        (ctx.chatMetadata?.world_info === DARK_WORLD_BOOK_NAME || globalWorlds.includes(DARK_WORLD_BOOK_NAME)) &&
        hasPresetMembers(members);
}

export function missingWorldbookFields(store) {
    return specs.some(([id, name]) => !store.fields.some(field => field.id === `${PRESET_ID}:${id}` || field.name === name));
}

export function missingDarkFields(store) {
    return darkSpecs.some(([id, name]) => !store.fields.some(field => field.id === `${DARK_PRESET_ID}:${id}` || field.name === name));
}

export function visiblePresetField(field, presetId) {
    const shared = ['群内信任', '留群态度', '群规与边界'].includes(field.name);
    if (presetId === DARK_PRESET_ID) return !field.id.startsWith(`${PRESET_ID}:`) || shared;
    if (presetId === PRESET_ID) return !field.id.startsWith(`${DARK_PRESET_ID}:`) || shared;
    return true;
}

export function applyWorldbookPreset(store) {
    const missing = specs.filter(([id, name]) => !store.fields.some(field => field.id === `${PRESET_ID}:${id}` || field.name === name));
    if (store.fields.length + missing.length > 24) throw new Error('字段已达 24 个，无法补全世界书预设');
    let added = 0;
    for (const [key, name, kind, meaning] of missing) {
        const trust = store.fields.find(field => field.name === '群内信任' && field.kind !== 'text' && !field.adult);
        const node = value => ({ kind: 'node', value });
        const unlock = key === 'marriage'
            ? { partial: trust ? { kind: 'threshold', fieldId: trust.id, value: 50 } : node('本人谈及婚姻处境'), full: node('本人公开婚姻处境') }
            : key === 'identity'
                ? { partial: node('本人公开部分真实资料'), full: node('本人公开完整真实资料') }
                : key === 'body'
                    ? { partial: node('本人同意谈身体隐私'), full: node('本人公开身体资料') }
                    : { partial: null, full: null };
        store.fields.push({ id: `${PRESET_ID}:${key}`, name, kind, meaning, hidden: ['marriage', 'identity', 'body'].includes(key),
            adult: key === 'body', applies: {}, unlock });
        added++;
    }
    if (added || store.preset?.id !== PRESET_ID) {
        store.preset = { id: PRESET_ID, worldbook: WORLD_BOOK_NAME, version: 1 };
        store.revision++;
    }
    return added;
}

export function applyDarkPreset(store, members = []) {
    const missing = darkSpecs.filter(([id, name]) => !store.fields.some(field => field.id === `${DARK_PRESET_ID}:${id}` || field.name === name));
    if (store.fields.length + missing.length > 24) throw new Error('字段已达 24 个，无法添加背德版预设');
    const node = value => ({ kind: 'node', value });
    for (const [key, name, kind, meaning, role] of missing) {
        const unlock = key === 'marriage' ? { partial: node('本人谈及婚姻'), full: node('本人公开婚姻处境') }
            : key === 'meeting' ? { partial: node('本人提出见面'), full: node('本人确认见面') }
                : key === 'departure' ? { partial: node('本人透露离城线索'), full: node('本人公开去向') }
                    : key === 'intimacy' ? { partial: node('本人明确谈及风险'), full: node('本人确认风险选择') }
                        : { partial: null, full: null };
        const applies = role ? Object.fromEntries(members.map(member => [member.id, member.name === role])) : {};
        store.fields.push({ id: `${DARK_PRESET_ID}:${key}`, name, kind, meaning,
            hidden: ['marriage', 'meeting', 'departure', 'intimacy'].includes(key), adult: key === 'intimacy', applies, unlock });
    }
    if (missing.length || store.preset?.id !== DARK_PRESET_ID) {
        store.preset = { id: DARK_PRESET_ID, worldbook: DARK_WORLD_BOOK_NAME, version: 1 };
        store.revision++;
    }
    return missing.length;
}
