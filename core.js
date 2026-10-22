import { DARK_PRESET_ID } from './worldbook-preset.js';

export const META_KEY = 'npcStatusPanel';
export const CORE_KEYS = ['thought', 'mood', 'relation', 'location', 'physical'];
export const MAX_FIELDS = 24;

const clean = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const scoreOk = value => value === null || (Number.isInteger(value) && value >= 0 && value <= 100);
const blank = () => ({ value: null, description: '', source: null, updatedAt: null });

export function newStore() {
    return { version: 1, preset: null, fields: [], adult: {}, nodes: {}, manual: [], generated: [], suppressed: [], summaries: {}, current: {}, revision: 0 };
}

export function loadStore(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.fields) || !Array.isArray(raw.manual)) return newStore();
    return { version: 1, preset: raw.preset || null, fields: raw.fields, adult: raw.adult || {}, nodes: raw.nodes || {},
        manual: raw.manual, generated: raw.generated || [], suppressed: raw.suppressed || [], summaries: raw.summaries || {}, current: raw.current || {}, revision: Number(raw.revision) || 0 };
}

export function membersFor(ctx) {
    const ids = ctx.groupId
        ? ctx.groups.find(group => String(group.id) === String(ctx.groupId))?.members || []
        : [ctx.characters[ctx.characterId]?.avatar].filter(Boolean);
    return ids.map(id => ctx.characters.find(character => character.avatar === id)).filter(Boolean)
        .map(character => ({ id: character.avatar, name: character.name, character }));
}

export function bindingFor(ctx) {
    const owner = ctx.groupId || ctx.characters[ctx.characterId]?.avatar;
    return owner && ctx.chatId ? `${ctx.groupId ? 'group' : 'single'}:${owner}/${ctx.chatId}` : null;
}

export function addField(store, input) {
    const name = clean(input, 24);
    if (!name || store.fields.length >= MAX_FIELDS || store.fields.some(f => f.name.toLowerCase() === name.toLowerCase()))
        throw new Error('字段名不能为空、重复或超过 24 个字段');
    const field = { id: crypto.randomUUID(), name, kind: 'both', meaning: '程度', hidden: false, adult: false,
        applies: {}, unlock: { partial: null, full: null } };
    store.fields.push(field);
    store.revision++;
    return field;
}

export function condition(input) {
    if (!input?.kind) return null;
    if (input.kind === 'keyword' || input.kind === 'node') {
        const value = clean(input.value, 60);
        if (!value) throw new Error('解锁条件不能为空');
        return { kind: input.kind, value };
    }
    if (input.kind === 'threshold') {
        const value = Number(input.value);
        if (!input.fieldId || input.value === '' || !scoreOk(value)) throw new Error('阈值须在 0–100 之间');
        return { kind: input.kind, fieldId: input.fieldId, value };
    }
    throw new Error('解锁条件类型无效');
}

export function updateField(store, id, patch) {
    const field = store.fields.find(f => f.id === id);
    if (!field) throw new Error('字段不存在');
    const name = clean(patch.name, 24);
    if (!name || store.fields.some(f => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) throw new Error('字段名不能为空或重复');
    if (!['score', 'text', 'both'].includes(patch.kind)) throw new Error('字段类型无效');
    for (const rule of [patch.partial, patch.full]) if (rule?.kind === 'threshold' &&
        !store.fields.some(f => f.id === rule.fieldId && f.kind !== 'text' && !f.adult)) throw new Error('阈值来源字段无效');
    Object.assign(field, { name, kind: patch.kind, meaning: clean(patch.meaning, 20) || '程度',
        hidden: Boolean(patch.hidden), adult: Boolean(patch.adult),
        unlock: { partial: condition(patch.partial), full: condition(patch.full) } });
    store.revision++;
}

export function editValue(store, npcId, key, value, description = '', stage = undefined) {
    const field = store.fields.find(f => f.id === key);
    if (!field && !CORE_KEYS.includes(key)) throw new Error('字段不存在');
    if (field?.adult && !store.adult[npcId]) throw new Error('尚未确认角色成年');
    if (field && field.kind !== 'text' && !scoreOk(value)) throw new Error('数值须在 0–100 之间');
    if (stage !== undefined && ![0, 1, 2].includes(stage)) throw new Error('解锁阶段无效');
    store.manual.push({ id: crypto.randomUUID(), npcId, key,
        value: field ? (field.kind === 'text' ? null : value) : clean(value, key === 'thought' ? 240 : 120),
        description: clean(description), stage, at: Date.now() });
    store.revision++;
}

const emptyNpc = () => ({ thought: blank(), mood: blank(), relation: blank(), location: blank(), physical: blank(), semen: blank(), recentReply: blank(), fields: {}, milestones: [], stages: {}, unlockEvidence: {}, updatedAt: null });
export const fingerprint = m => `${m.mes || ''}\u0000${m.extra?.reasoning || ''}\u0000${m.swipe_id ?? ''}`;

const stageNames = ['围观者', '私聊开启', '夜色语音', '照片与荤话', '见面', '肉体关系', '内射与风险'];
const stageDescription = stage => `${stage}·${stageNames[stage]}`;
function milestoneStage(value) {
    if (/接受.{0,8}内射|射在体内|明确承认.{0,20}内射/.test(value)) return 6;
    if (/第一次身体结合|确认.{0,12}肉体关系|发生.{0,4}性关系/.test(value)) return 5;
    return 0;
}

export function updateSummary(store, chat, member, npc, interval = 12) {
    const replies = chat.filter(m => !m.is_user && !m.is_system && m.gen_finished && m.mes?.trim() &&
        (m.original_avatar === member.id || m.name === member.name)).length;
    const through = Math.floor(replies / interval) * interval;
    const previous = store.summaries?.[member.id];
    const stale = previous?.sources?.some(source => fingerprint(chat[source.index] || {}) !== source.fingerprint);
    if (!through || (through <= (previous?.through || 0) && !stale)) return false;
    const stage = npc.fields[`${DARK_PRESET_ID}:stage`]?.description || '0·围观者';
    const recent = npc.milestones.slice(-3);
    const nodes = recent.map(item => item.value).join('；');
    const text = [`关系${stage}`, npc.relation.value && `当前${npc.relation.value}`, nodes && `近况：${nodes}`].filter(Boolean).join('；').slice(0, 220);
    const sources = [npc.fields[`${DARK_PRESET_ID}:stage`], npc.relation, ...recent]
        .map(item => item?.source).filter(source => Number.isInteger(source?.index) && source.fingerprint)
        .map(source => ({ index: source.index, fingerprint: source.fingerprint }));
    (store.summaries ||= {})[member.id] = { through, text, sources };
    store.revision++;
    return true;
}

export function recordAnalysis(store, chat, npcId, raw, indices, previousStage = 0, backfill = false) {
    const json = String(raw || '').match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('模型未返回状态数据');
    const result = JSON.parse(json);
    const sourceMessages = indices.filter(index => chat[index]?.mes?.trim());
    const anchor = sourceMessages.at(-1);
    if (anchor === undefined) return 0;
    const at = index => Date.parse(chat[index].gen_finished || chat[index].send_date) || Date.now();
    store.generated ||= [];
    if (typeof result.thought === 'string' && result.thought.trim()) {
        store.generated = store.generated.filter(item => item.npcId !== npcId || item.index !== anchor || item.key !== 'thought');
        store.generated.push({ npcId, key: 'thought', value: clean(result.thought, 240), index: anchor,
            fingerprint: fingerprint(chat[anchor]), at: at(anchor) });
    }
    let count = 0;
    for (const change of Array.isArray(result.changes) ? result.changes.slice(0, 12) : []) {
        const quote = String(change?.evidence || '').trim();
        const index = sourceMessages.findLast(i => quote.length >= 4 && chat[i].mes.includes(quote));
        if (index === undefined) continue;
        let key = change.key;
        let value = clean(change.value, 120);
        if (key === 'stage') {
            if (store.preset?.id !== DARK_PRESET_ID) continue;
            const stage = Number(change.value);
            if (!Number.isInteger(stage) || stage < 0 || stage > 6 || stage < previousStage || (!backfill && stage > previousStage + 2)) continue;
            if (stage > previousStage && stage === 5 && !/发生关系|性事|做爱|上床|亲密|身体结合|射进|射在|内射|灌进体内/.test(quote)) continue;
            if (stage > previousStage && stage === 6 && !/(?:接受|发生|已经|刚才|这次|喜欢).{0,12}内射|射在.{0,6}(?:体内|里面)|射进(?:来|去|体内)|灌进体内/.test(quote)) continue;
            key = `${DARK_PRESET_ID}:stage`;
            value = stageDescription(stage);
        } else if (!['mood', 'relation', 'location', 'physical', 'milestone'].includes(key)) continue;
        if (!value || /^(未知|无变化|不确定)$/.test(value)) continue;
        if (key !== 'milestone') store.generated = store.generated.filter(item =>
            item.npcId !== npcId || item.index !== index || item.key !== key);
        else if (store.generated.some(item => item.npcId === npcId && item.index === index &&
            item.fingerprint === fingerprint(chat[index]) && item.key === key && item.value === value)) continue;
        store.generated.push({ npcId, key, value: key === 'milestone' ? value : key.endsWith(':stage') ? null : value,
            description: key.endsWith(':stage') ? value : '', index, fingerprint: fingerprint(chat[index]), at: at(index) });
        if (key.endsWith(':stage')) previousStage = Number(change.value);
        count++;
    }
    store.revision++;
    return count;
}

export function suppressChanges(store, before, chat) {
    store.suppressed = store.suppressed.filter(item => chat[item.index] && fingerprint(chat[item.index]) === item.fingerprint);
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (!message?.gen_finished || fingerprint(message) === before[index]) continue;
        if (!store.suppressed.some(item => item.index === index && item.fingerprint === fingerprint(message)))
            store.suppressed.push({ index, fingerprint: fingerprint(message) });
    }
    store.revision++;
}

function parseLines(text, owner, members, fields, isPrivate) {
    const out = [];
    for (let line of String(text || '').split(/\r?\n/)) {
        line = line.trim().replace(/^【(?:NPC)?状态】\s*/, '');
        if (!line || line.length > 360) continue;
        let target = owner;
        let named = false;
        const prefix = members.find(m => line.startsWith(`${m.name}的`) || line.startsWith(`${m.name}：`) || line.startsWith(`${m.name}:`));
        if (prefix) {
            target = prefix.id;
            named = true;
            line = line.slice(prefix.name.length).replace(/^(?:的|[:：])\s*/, '');
        }
        if (isPrivate && target !== owner) continue;
        const match = line.match(/^([^：:=]{1,24})\s*[：:=]\s*(.{1,300})$/);
        if (!match) continue;
        const label = match[1].trim();
        const raw = match[2].trim();
        const key = { '内心': 'thought', '心绪': 'thought', '心情': 'mood', '关系': 'relation', '位置': 'location', '亲密后状态': 'physical' }[label];
        if (key) {
            if (key === 'thought' && (target !== owner || /身世|血统|真实身份|出生秘密|其实我是/.test(raw))) continue;
            out.push({ npcId: target, key, value: clean(raw, key === 'thought' ? 240 : 120), named, private: isPrivate });
            continue;
        }
        const field = fields.find(f => f.name === label);
        if (!field || field.applies[target] === false) continue;
        const score = raw.match(/^(\d{1,3})(?:\s*\/\s*100)?(?:\s*[|｜,，;；]\s*(.*))?$/);
        if (field.kind !== 'text' && score && Number(score[1]) <= 100)
            out.push({ npcId: target, key: field.id, value: Number(score[1]), description: clean(score[2]), named, private: isPrivate });
        else if (field.kind === 'text')
            out.push({ npcId: target, key: field.id, value: null, description: clean(raw), named, private: isPrivate });
    }
    return out;
}

function matches(rule, npc, text, store, id, at) {
    if (!rule) return false;
    if (rule.kind === 'keyword') return text.toLowerCase().includes(rule.value.toLowerCase());
    if (rule.kind === 'node') return Boolean(store.nodes[id]?.[rule.value]) && store.nodes[id][rule.value] <= at;
    if (rule.kind === 'threshold') {
        const value = npc.fields[rule.fieldId]?.value;
        return value !== null && value !== undefined && value >= rule.value;
    }
    return false;
}

function autoEvents(store, chat, members, cardText) {
    const byName = new Map(members.map(m => [m.name, m.id]));
    const known = new Set(members.map(m => m.id));
    const events = [];
    let before = [];
    let batch = [];
    let batchId;
    const flush = () => {
        if (!batch.length) return;
        const publicText = [...before, ...batch].map(m => m.mes || '').join('\n');
        const speakers = new Set(batch.map(m => m.original_avatar || byName.get(m.name)).filter(id => known.has(id)));
        const involved = new Set([...speakers, ...members.filter(m => publicText.includes(m.name)).map(m => m.id)]);
        const at = Math.max(...batch.map(m => Date.parse(m.gen_finished || m.send_date) || 0));
        for (const m of batch) {
            const owner = m.original_avatar || byName.get(m.name);
            if (!speakers.has(owner)) continue;
            const source = { index: m.index, fingerprint: fingerprint(m), type: 'message' };
            events.push({ npcId: owner, key: 'recentReply', value: clean(m.mes, 240), at, source });
            for (const change of [...parseLines(m.mes, owner, members, store.fields, false),
                ...parseLines(m.extra?.reasoning, owner, members, store.fields, true)]) {
                if (!involved.has(change.npcId) || (change.npcId !== owner && (!change.named || change.key === 'thought'))) continue;
                const field = store.fields.find(f => f.id === change.key);
                // 成人字段的稳定资料只接受玩家录入，普通对话不会改写。
                if (field?.adult) continue;
                if (field?.hidden && change.private) continue;
                if (field && store.preset?.id === DARK_PRESET_ID && change.npcId !== owner) continue;
                if (change.key === 'thought' && cardText?.[owner]) {
                    const chunks = change.value.split(/[，。；,;\s]+/).filter(x => x.length >= 8);
                    if (chunks.some(x => cardText[owner].includes(x))) continue;
                }
                events.push({ ...change, at, source: { ...source, type: change.private ? 'reasoning' : 'message' } });
            }
        }
        for (const id of involved) events.push({ npcId: id, key: '__unlock', at, text: publicText,
            source: { index: batch.at(-1).index, fingerprint: fingerprint(batch.at(-1)), type: 'interaction' } });
        before = [];
        batch = [];
    };
    for (let index = 0; index < chat.length; index++) {
        const m = { ...chat[index], index };
        if (store.suppressed.some(item => item.index === index && item.fingerprint === fingerprint(m))) {
            flush();
            before = [];
            continue;
        }
        if (m.is_user && !m.is_system) { flush(); before.push(m); continue; }
        if (m.is_system || !m.gen_finished || !m.mes?.trim()) continue;
        const owner = m.original_avatar || byName.get(m.name);
        if (!known.has(owner)) continue;
        const id = m.extra?.gen_id || `single:${index}`;
        if (batch.length && id !== batchId) flush();
        batchId = id;
        batch.push(m);
    }
    flush();
    return events;
}

export function derive(store, chat, members, cardText = {}) {
    const current = Object.fromEntries(members.map(m => [m.id, emptyNpc()]));
    const events = autoEvents(store, chat, members, cardText);
    for (const item of store.generated || []) if (chat[item.index] &&
        fingerprint(chat[item.index]) === item.fingerprint && current[item.npcId] &&
        !store.suppressed.some(entry => entry.index === item.index && entry.fingerprint === item.fingerprint)) {
        events.push({ ...item, source: { type: 'generated', index: item.index, fingerprint: item.fingerprint } });
    }
    for (const [id, nodes] of Object.entries(store.nodes)) for (const at of Object.values(nodes)) {
        if (current[id] && Number.isFinite(at)) events.push({ npcId: id, key: '__unlock', at, text: '', source: { type: 'node' } });
    }
    for (const manual of store.manual) if (current[manual.npcId]) events.push({ ...manual, manual: true });
    events.sort((a, b) => (a.at - b.at) || Number(Boolean(a.manual)) - Number(Boolean(b.manual)));
    for (const e of events) {
        const npc = current[e.npcId];
        if (!npc) continue;
        if (e.key === 'milestone') {
            if (!npc.milestones.some(item => item.value === e.value && item.source?.index === e.source?.index))
                npc.milestones.push({ value: e.value, at: e.at, source: e.source });
            if (store.preset?.id === DARK_PRESET_ID) {
                const stage = milestoneStage(e.value);
                const field = `${DARK_PRESET_ID}:stage`;
                const previous = Number(npc.fields[field]?.description?.match(/^[0-6]/)?.[0] || 0);
                if (stage > previous) npc.fields[field] = { value: null, description: stageDescription(stage), source: e.source, updatedAt: e.at };
                if (stage === 6) npc.semen = { value: '内射后充满精液', source: e.source, updatedAt: e.at };
            }
            continue;
        }
        if (e.key === '__unlock') {
            for (const field of store.fields) {
                if (!field.hidden || field.applies[e.npcId] === false || (field.adult && !store.adult[e.npcId])) continue;
                let stage = npc.stages[field.id] || 0;
                if (matches(field.unlock?.partial, npc, e.text, store, e.npcId, e.at)) stage = Math.max(stage, 1);
                if (matches(field.unlock?.full, npc, e.text, store, e.npcId, e.at)) stage = 2;
                if (stage > (npc.stages[field.id] || 0)) {
                    npc.unlockEvidence[field.id] = { stage, source: e.source, at: e.at };
                }
                npc.stages[field.id] = stage;
            }
            continue;
        }
        const field = store.fields.find(f => f.id === e.key);
        if (field && (field.applies[e.npcId] === false || (field.adult && !store.adult[e.npcId]))) continue;
        const target = field ? (npc.fields[e.key] ||= blank()) : npc[e.key];
        if (!target) continue;
        if (e.key === `${DARK_PRESET_ID}:stage` && !e.manual &&
            Number(e.description?.match(/^[0-6]/)?.[0] || 0) < Number(target.description?.match(/^[0-6]/)?.[0] || 0)) continue;
        Object.assign(target, { value: e.value, description: e.description || '', updatedAt: e.at,
            source: e.manual ? { type: 'manual', id: e.id } : e.source });
        if (e.key === 'physical' && /已清洗|已冲洗|已排出|体内已无/.test(e.value)) npc.semen = blank();
        if (e.manual && e.stage !== undefined) {
            npc.stages[e.key] = e.stage;
            npc.unlockEvidence[e.key] = { stage: e.stage, source: { type: 'manual', id: e.id }, at: e.at };
        }
        npc.updatedAt = Math.max(npc.updatedAt || 0, e.at || 0);
    }
    for (const m of members) for (const field of store.fields) if (field.hidden && current[m.id].stages[field.id] === undefined) current[m.id].stages[field.id] = 0;
    return current;
}

export function privateFragments(store, chat, members) {
    const out = Object.fromEntries(members.map(m => [m.id, []]));
    for (const m of chat) {
        const id = m.original_avatar || members.find(x => x.name === m.name)?.id;
        if (!out[id]) continue;
        for (const line of String(m.extra?.reasoning || '').split(/\r?\n/)) if (line.trim()) out[id].push(line.trim());
        for (const invocation of m.extra?.tool_invocations || []) {
            for (const text of [invocation.reasoning, invocation.signature]) if (typeof text === 'string')
                for (const line of text.split(/\r?\n/)) if (line.trim()) out[id].push(line.trim());
        }
    }
    for (const m of members) {
        const npc = store.current?.[m.id];
        if (!npc) continue;
        for (const item of [...CORE_KEYS.map(key => npc[key]), ...Object.values(npc.fields || {})])
            for (const value of [item?.value, item?.description])
                if (typeof value === 'string' && value.trim()) out[m.id].push(value.trim());
    }
    for (const id of Object.keys(out)) out[id] = [...new Set(out[id])].filter(value => !chat.some(m => String(m.mes || '').includes(value)));
    return out;
}

export function foreignPrivateText(body, recipientId, fragments) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    for (const [id, values] of Object.entries(fragments)) {
        if (id === recipientId) continue;
        const leak = values.find(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)));
        if (leak) return { id, leak };
    }
    return null;
}
