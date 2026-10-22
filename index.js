import { META_KEY, CORE_KEYS, newStore, loadStore, membersFor, bindingFor, addField, updateField, editValue, derive,
    fingerprint, suppressChanges, privateFragments, foreignPrivateText, recordAnalysis, updateSummary } from './core.js';
import { selected_world_info } from '../../../world-info.js';
import { generateRaw, setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { WORLD_BOOK_NAME, PRESET_ID, DARK_PRESET_ID, hasPresetMembers, isWorldbookChat, isDarkWorldbookChat,
    visiblePresetField, applyWorldbookPreset, applyDarkPreset } from './worldbook-preset.js';

if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));

const context = () => SillyTavern.getContext();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = selector => root.querySelector(selector);
const coreNames = { thought: '此刻心绪', mood: '心情', relation: '与你的关系', location: '位置', physical: '亲密后状态' };
const physicalProfiles = {
    '七月': { '身材': '身高165厘米，体重52公斤，三围84/63/88厘米', '手部': '手长17.5厘米，右拇指有墨迹', '乳房': '70B罩杯', '小穴': '无穿孔或纹身', '臀部': '臀围88厘米', '足部': '37码鞋，脚踝纤细' },
    '岚姐': { '身材': '身高168厘米，体重66公斤，三围96/76/101厘米', '手部': '手长18厘米，指腹有裁布留下的薄茧', '乳房': '80C罩杯', '小穴': '无穿孔或纹身', '臀部': '臀围101厘米', '足部': '39码鞋' },
    '小乔': { '身材': '身高160厘米，体重49公斤，三围82/61/86厘米', '手部': '手长16.5厘米，指尖常沾铅笔灰', '乳房': '70B罩杯', '小穴': '无穿孔或纹身', '臀部': '臀围86厘米', '足部': '36码鞋' },
};
const hasScenarioProfile = member => Boolean(physicalProfiles[member.name] &&
    `${member.character.description || ''}\n${member.character.scenario || ''}`.includes('熟女密聊群'));
let binding = null;
let members = [];
let store = newStore();
let selected = null;
let editKey = 'thought';
let editing = false;
let opened = false;
let status = '';
let epoch = 0;
let saveChain = Promise.resolve();
let groupTurn = null;
let singleTurn = null;
let singleStopped = false;
const milestoneOpen = new Map();
let renderedMilestoneKey = null;
const unsaved = new Map();
const thoughtRequests = new Set();

const root = document.createElement('div');
root.id = 'npcsp';
root.innerHTML = `<button class="npcsp-tab" type="button" aria-controls="npcsp-panel" aria-expanded="false">角色状态</button>
  <aside id="npcsp-panel" class="npcsp-panel" aria-label="NPC 状态面板" hidden>
    <header class="npcsp-head"><div class="npcsp-headline"><strong>角色状态</strong><button class="npcsp-close" type="button" aria-label="关闭面板">×</button></div>
      <p class="npcsp-chat"></p><p class="npcsp-status" role="status" aria-live="polite"></p></header>
    <nav class="npcsp-members" aria-label="选择 NPC"></nav>
    <div class="npcsp-scroll"></div>
    <footer class="npcsp-footer"><span>仅玩家查看 · 当前聊天</span><button class="npcsp-retry" type="button" hidden>重试保存</button><button class="npcsp-edit" type="button">编辑状态栏</button></footer>
  </aside>`;
document.body.append(root);

function setStatus(message) {
    status = message;
    const node = $('.npcsp-status');
    if (node) node.textContent = message;
    const retry = $('.npcsp-retry');
    if (retry) retry.hidden = !binding || !unsaved.has(binding) || !message.startsWith('未保存');
}
function currentNpc() { return store.current?.[selected] || null; }
function currentField() { return store.fields.find(field => field.id === editKey); }
function presetAvailable() { return isWorldbookChat(context(), members, selected_world_info); }
function darkPresetAvailable() { return isDarkWorldbookChat(context(), members, selected_world_info); }
function shownFields() { return store.fields.filter(field => visiblePresetField(field, store.preset?.id)); }
function applyInitialPreset() {
    if (!context().groupId && members.length === 1 && hasScenarioProfile(members[0]) &&
        members[0].character.description?.includes('关系档位')) return applyDarkPreset(store, members);
    if (context().chatMetadata?.world_info === WORLD_BOOK_NAME && presetAvailable()) return applyWorldbookPreset(store);
    if (darkPresetAvailable()) return applyDarkPreset(store, members);
    return presetAvailable() ? applyWorldbookPreset(store) : 0;
}
function cardText() {
    return Object.fromEntries(members.map(member => [member.id,
        [member.character.description, member.character.personality, member.character.scenario,
            JSON.stringify(member.character.data?.extensions || {})].filter(Boolean).join('\n')]));
}
function recalculate() {
    store.current = derive(store, context().chat, members, cardText());
    for (const member of members) updateSummary(store, context().chat, member, store.current[member.id]);
    const npc = !context().groupId && members.length === 1 ? store.current[members[0].id] : null;
    const stage = npc?.fields?.[`${DARK_PRESET_ID}:stage`]?.description || '';
    const summary = npc && store.summaries?.[members[0].id];
    const lines = npc ? [stage && `当前关系档位：${stage}`, npc.relation.value && `当前关系：${npc.relation.value}`,
        npc.semen.value && `当前身体状态：${npc.semen.value}`,
        summary?.text && `每12轮关系摘要：${summary.text}`,
        ...npc.milestones.slice(summary ? -2 : -3).map(item => `近期节点：${item.value}`)].filter(Boolean) : [];
    setExtensionPrompt('npcsp-memory', lines.length ? `【${members[0].name}与玩家的已确认记忆；当前记录优先于角色卡的初始档位】\n${lines.join('\n')}` : '',
        extension_prompt_types.IN_PROMPT, 0);
}

function chatLabel() {
    const ctx = context();
    if (!binding) return '请先打开原生单聊或群聊';
    return `${ctx.groupId ? '群聊' : '单聊'} · ${ctx.chatId}`;
}

async function readSavedChat(savedBinding) {
    const ctx = context();
    if (binding !== savedBinding) throw new Error('已切换聊天，保存结果未确认');
    const group = Boolean(ctx.groupId);
    const member = members[0];
    const url = group ? '/api/chats/group/get' : '/api/chats/get';
    const body = group ? { id: ctx.chatId } : { ch_name: member?.name, file_name: ctx.chatId, avatar_url: member?.id };
    const response = await fetch(url, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`保存校验失败：HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('服务器未返回聊天记录');
    return data;
}
async function verifySave(expected, savedBinding) {
    const data = await readSavedChat(savedBinding);
    if (!Array.isArray(data) || data[0]?.chat_metadata?.[META_KEY]?.revision !== expected)
        throw new Error('服务器尚未确认状态栏保存');
}

function save() {
    if (!binding) return Promise.resolve();
    const ticket = epoch;
    const savedBinding = binding;
    const snapshot = structuredClone(store);
    const revision = ++snapshot.revision;
    store.revision = revision;
    unsaved.set(savedBinding, snapshot);
    setStatus('保存中…');
    saveChain = saveChain.catch(() => {}).then(async () => {
        if (epoch !== ticket || binding !== savedBinding) return;
        const ctx = context();
        ctx.updateChatMetadata({ [META_KEY]: snapshot });
        await ctx.saveMetadata();
        await verifySave(revision, savedBinding);
        if (epoch !== ticket || binding !== savedBinding) return;
        if (unsaved.get(savedBinding)?.revision === revision) unsaved.delete(savedBinding);
        setStatus('已保存');
    }).catch(error => {
        if (binding === savedBinding) setStatus(`未保存：${error.message}`);
    });
    return saveChain;
}

function refresh({ persist = false } = {}) {
    if (!binding) return;
    const previous = JSON.stringify(store.current);
    recalculate();
    render();
    if (persist && JSON.stringify(store.current) !== previous) save();
}

function loadCurrent() {
    epoch++;
    const ctx = context();
    binding = bindingFor(ctx);
    members = binding ? membersFor(ctx) : [];
    store = binding ? loadStore(unsaved.get(binding) || ctx.chatMetadata?.[META_KEY]) : newStore();
    setExtensionPrompt('npcsp-memory', '', extension_prompt_types.IN_PROMPT, 0);
    const newPreset = binding && store.fields.length === 0 ? applyInitialPreset() : 0;
    selected = members.some(member => member.id === selected) ? selected : members[0]?.id || null;
    editKey = 'thought';
    editing = false;
    groupTurn = null;
    singleTurn = null;
    singleStopped = false;
    setStatus(binding ? (unsaved.has(binding) ? '未保存：可重试' : '') : '');
    if (binding) {
        const previous = JSON.stringify(store.current);
        recalculate();
        const hasEvidence = Object.values(store.current).some(npc =>
            CORE_KEYS.some(key => npc[key]?.source) || Object.values(npc.fields).some(item => item.source) ||
            Object.values(npc.stages).some(stage => stage > 0));
        if (newPreset || (hasEvidence && JSON.stringify(store.current) !== previous)) save();
    }
    render();
}

function valueText(value) { return value === null || value === undefined || value === '' ? '未知' : String(value); }
function sourceText(item) {
    if (!item?.source) return '暂无可靠来源';
    return { manual: '手动编辑', message: '公开回复', reasoning: '该角色的可见思考', generated: '模型分析，需核对',
        interaction: '本轮公开互动', node: '手动剧情节点' }[item.source.type] || '互动证据';
}
function fieldHtml(field, npc) {
    const item = npc?.fields?.[field.id];
    const stage = npc?.stages?.[field.id] || 0;
    const evidence = npc?.unlockEvidence?.[field.id];
    if (store.preset?.id === DARK_PRESET_ID && field.name === '关系档位' && !item?.source)
        return `<section class="npcsp-field"><div class="npcsp-row"><b>关系档位</b></div><p>${npc?.recentReply?.value ? '待分析（角色卡初始为0·围观者）' : '0·围观者'}</p><small>来源：角色卡起始设定；后续按本人行动更新</small></section>`;
    if (field.hidden && stage < 2) return `<section class="npcsp-field"><div class="npcsp-row"><b>${esc(field.name)}</b><span class="npcsp-lock">${stage ? '部分了解' : '尚未了解'}</span></div>
      <p>${stage ? '已有互动线索，完整资料仍待解锁。' : '尚无满足解锁条件的互动。'}</p>${evidence ? `<small>依据：${esc(sourceText({ source: evidence.source }))}</small>` : ''}</section>`;
    const value = field.kind === 'text' ? '' : `<strong>${esc(valueText(item?.value))}${item?.value == null ? '' : ' / 100'}</strong>`;
    return `<section class="npcsp-field"><div class="npcsp-row"><b>${esc(field.name)}</b>${value}</div>
      <p>${esc(item?.description || (item?.value == null ? '等待明确证据或手动填写。' : field.meaning))}</p><small>${esc(sourceText(item))}</small></section>`;
}
function renderView(member, npc, milestonesExpanded = false) {
    const thought = npc?.thought;
    const core = CORE_KEYS.filter(key => key !== 'thought' && (key !== 'physical' || !hasScenarioProfile(member))).map(key => {
        const stage = store.preset?.id === DARK_PRESET_ID && key === 'relation' ?
            npc?.fields?.[`${DARK_PRESET_ID}:stage`]?.description || (npc?.recentReply?.value ? '待分析（初始0）' : '0·围观者') : '';
        const value = stage ? `${stage}${npc?.relation?.value ? ` · ${npc.relation.value}` : ''}` : valueText(npc?.[key]?.value);
        return `<div class="npcsp-state"><span>${coreNames[key]}</span><strong>${esc(value)}</strong></div>`;
    }).join('');
    const fields = shownFields().filter(field => field.applies[member.id] !== false && (!field.adult || store.adult[member.id]));
    const profile = hasScenarioProfile(member) ? physicalProfiles[member.name] : null;
    const hasReply = context().chat.some((message, index, chat) => !message.is_user && !message.is_system && message.mes?.trim() &&
        chat.slice(0, index).some(previous => previous.is_user && !previous.is_system && previous.mes?.trim()) &&
        (message.original_avatar === member.id || message.name === member.name));
    const bodyState = [npc?.semen?.value, npc?.physical?.value].filter(Boolean).join('；');
    const physical = profile ? `<section class="npcsp-section"><h3>身材与身体参数</h3><small>静态参数来自角色卡；当前状态来自本聊天</small><dl class="npcsp-physical">${Object.entries(profile).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}${label === '小穴' ? `<br><small>当前：${esc(valueText(bodyState))}</small>` : ''}</dd></div>`).join('')}</dl></section>` : '';
    const memories = npc?.milestones?.slice().reverse() || [];
    return `<div class="npcsp-person"><span class="npcsp-avatar" aria-hidden="true">${esc(member.name.slice(0, 1))}</span><div><h2>${esc(member.name)}</h2><small>${npc?.updatedAt ? `更新于 ${esc(new Date(npc.updatedAt).toLocaleString())}` : '尚无状态更新'}</small></div></div>
      ${store.preset?.id === PRESET_ID ? '<p class="npcsp-preset-note">公共版 · 只记录本人公开的线索，私密资料从未知开始。</p>' : ''}
      ${store.preset?.id === DARK_PRESET_ID ? '<p class="npcsp-preset-note">背德版 · 三人关系各自推进：0围观 → 1私聊 → 2语音 → 3越界 → 4见面 → 5亲密 → 6风险。未公开线索只按本人披露解锁。</p>' : ''}
      ${hasPresetMembers(members) ? `<div class="npcsp-preset-choices" aria-label="切换当前聊天的状态栏预设"><button type="button" data-preset="public" aria-pressed="${store.preset?.id === PRESET_ID}">公共版</button><button type="button" data-preset="dark" aria-pressed="${store.preset?.id === DARK_PRESET_ID}">背德版</button></div>` : ''}
      <section class="npcsp-section"><h3>内心心声</h3>${thought?.value ? `<blockquote>${esc(thought.value)}</blockquote><small>${esc(sourceText(thought))}</small>` : '<p class="npcsp-empty">目前未知。玩家与角色对话后可生成。</p>'}<div class="npcsp-thought-actions"><button class="npcsp-thought-button" type="button" ${hasReply ? '' : 'disabled'}>根据最近对话生成心声</button>${thought?.source?.type === 'generated' ? '<button class="npcsp-thought-clear" type="button">清除推测</button>' : ''}</div></section>
      ${physical}
      <section class="npcsp-section"><h3>当前状态</h3><div class="npcsp-states">${core}</div><button class="npcsp-backfill" type="button" ${hasReply ? '' : 'disabled'}>分析最近6条角色回复并更新</button></section>
      <section class="npcsp-section"><details class="npcsp-milestone-details" ${milestonesExpanded ? 'open' : ''}><summary>关键节点 <small>（${memories.length} 条）</small></summary>${memories.length ? `<ol class="npcsp-milestones">${memories.map(item => `<li>${esc(item.value)}</li>`).join('')}</ol>` : '<p class="npcsp-empty">尚无已确认节点。</p>'}</details></section>
      <section class="npcsp-section"><h3>最近公开回复摘录</h3>${npc?.recentReply?.value ? `<p class="npcsp-empty">${esc(npc.recentReply.value)}</p><small>来源：公开回复</small>` : '<p class="npcsp-empty">暂无已完成的非空回复。</p>'}</section>
      <section class="npcsp-section"><h3>自定义字段</h3>${fields.length ? fields.map(field => fieldHtml(field, npc)).join('') : '<p class="npcsp-empty">暂无字段。可以在编辑界面添加。</p>'}</section>`;
}

function option(value, label, selectedValue) { return `<option value="${esc(value)}" ${value === selectedValue ? 'selected' : ''}>${esc(label)}</option>`; }
function ruleHtml(stage, rule) {
    const scoreFields = shownFields().filter(field => field.kind !== 'text' && !field.adult);
    return `<div class="npcsp-rule"><label>${stage === 'partial' ? '部分了解' : '完全了解'}条件
      <select name="${stage}Kind">${option('', '手动调整', rule?.kind || '')}${option('keyword', '明确关键词', rule?.kind || '')}${option('threshold', '数值达到阈值', rule?.kind || '')}${option('node', '剧情节点', rule?.kind || '')}</select></label>
      <label>关键词／节点名／阈值<input name="${stage}Value" maxlength="60" value="${esc(rule?.value ?? '')}"></label>
      <label>阈值来源字段<select name="${stage}Field">${option('', '请选择', rule?.fieldId || '')}${scoreFields.map(f => option(f.id, f.name, rule?.fieldId || '')).join('')}</select></label></div>`;
}
function renderEdit(member, npc) {
    const field = currentField();
    const core = CORE_KEYS.includes(editKey);
    const item = field ? npc?.fields?.[field.id] : npc?.[editKey];
    const choices = [...CORE_KEYS.map(key => ({ id: key, name: coreNames[key] })), ...shownFields()];
    return `<div class="npcsp-person"><div><h2>编辑 ${esc(member.name)}</h2><small>字段名在当前聊天共享；值仅属于此角色</small></div></div>
      <div class="npcsp-choices">${choices.map(choice => `<button type="button" data-key="${esc(choice.id)}" aria-pressed="${choice.id === editKey}">${esc(choice.name)}</button>`).join('')}</div>
      <form class="npcsp-form" id="npcsp-form"><label class="npcsp-check"><input name="adultConfirmed" type="checkbox" ${store.adult[member.id] ? 'checked' : ''}>已明确确认 ${esc(member.name)} 为成年人</label>
      ${field ? `<label>字段名称<input name="name" maxlength="24" required value="${esc(field.name)}"></label>
        <label>字段类型<select name="kind">${option('score', '数值', field.kind)}${option('text', '描述', field.kind)}${option('both', '数值与描述', field.kind)}</select></label>
        <label>数值含义<input name="meaning" maxlength="20" value="${esc(field.meaning)}"></label>
        <label class="npcsp-check"><input name="applies" type="checkbox" ${field.applies[member.id] !== false ? 'checked' : ''}>适用于当前角色</label>
        <label class="npcsp-check"><input name="hidden" type="checkbox" ${field.hidden ? 'checked' : ''}>逐步解锁</label>
        <label class="npcsp-check"><input name="adult" type="checkbox" ${field.adult ? 'checked' : ''}>成人字段</label>
        ${ruleHtml('partial', field.unlock?.partial)}${ruleHtml('full', field.unlock?.full)}` : ''}
      ${field?.kind !== 'text' && field || core ? `<label>${field ? '数值（0–100）' : coreNames[editKey]}${editKey === 'thought' ? `<textarea name="value" maxlength="240">${esc(item?.value || '')}</textarea>` : `<input name="value" ${field ? 'type="number" min="0" max="100" step="1"' : ''} value="${esc(valueText(item?.value) === '未知' ? '' : item.value)}">`}</label>` : ''}
      ${field ? `<label>描述<textarea name="description" maxlength="240">${esc(item?.description || '')}</textarea></label>` : ''}
      ${field?.hidden ? `<label>当前阶段<select name="stage">${option('0', '尚未了解', String(npc?.stages?.[field.id] || 0))}${option('1', '部分了解', String(npc?.stages?.[field.id] || 0))}${option('2', '完全了解', String(npc?.stages?.[field.id] || 0))}</select></label>` : ''}
      ${field?.hidden ? `<label>标记剧情节点<input name="node" maxlength="60" placeholder="与上方节点条件同名"></label>` : ''}
      <div class="npcsp-actions"><button type="button" class="npcsp-cancel">取消</button><button type="submit" class="npcsp-primary">保存修改</button></div></form>
      <div class="npcsp-add"><label>添加字段<input class="npcsp-newname" maxlength="24" placeholder="字段名称"></label><button class="npcsp-addbutton" type="button">添加字段</button></div>
      ${field ? '<button class="npcsp-remove" type="button">删除此字段</button>' : ''}`;
}

function render() {
    const previousDetails = $('.npcsp-milestone-details');
    if (previousDetails && renderedMilestoneKey) milestoneOpen.set(renderedMilestoneKey, previousDetails.open);
    const tab = $('.npcsp-tab');
    const panel = $('.npcsp-panel');
    tab.hidden = !binding || opened;
    tab.setAttribute('aria-expanded', String(opened));
    panel.hidden = !binding || !opened;
    document.body.classList.toggle('npcsp-open', Boolean(binding && opened));
    $('.npcsp-chat').textContent = chatLabel();
    $('.npcsp-status').textContent = status;
    $('.npcsp-retry').hidden = !binding || !unsaved.has(binding);
    $('.npcsp-members').hidden = members.length <= 1;
    $('.npcsp-members').innerHTML = members.length <= 1 ? '' : members.map(member => `<button type="button" data-id="${esc(member.id)}" aria-current="${member.id === selected}">${esc(member.name)}</button>`).join('');
    const member = members.find(item => item.id === selected);
    renderedMilestoneKey = member ? `${binding}/${member.id}` : null;
    $('.npcsp-scroll').innerHTML = member ? (editing ? renderEdit(member, currentNpc()) :
        renderView(member, currentNpc(), milestoneOpen.get(renderedMilestoneKey))) : '<p class="npcsp-empty">当前聊天没有可用角色。</p>';
    $('.npcsp-edit').textContent = editing ? '返回查看' : '编辑状态栏';
}

function closePanel() { opened = false; editing = false; render(); $('.npcsp-tab').focus(); }
$('.npcsp-tab').addEventListener('click', () => { opened = true; render(); $('.npcsp-close').focus(); });
$('.npcsp-close').addEventListener('click', closePanel);
$('.npcsp-retry').addEventListener('click', save);
$('.npcsp-edit').addEventListener('click', () => { editing = !editing; render(); (editing ? $('.npcsp-choices button') : $('.npcsp-edit'))?.focus(); });
$('.npcsp-members').addEventListener('click', event => {
    const button = event.target.closest('[data-id]');
    if (!button) return;
    selected = button.dataset.id;
    editKey = 'thought';
    render();
});
$('.npcsp-scroll').addEventListener('click', event => {
    if (event.target.closest('.npcsp-thought-clear')) {
        const source = currentNpc()?.thought?.source;
        store.generated = (store.generated || []).filter(item => item.index !== source?.index || item.npcId !== selected || item.key !== 'thought');
        store.revision++;
        refresh();
        save();
        return;
    }
    if (event.target.closest('.npcsp-thought-button')) {
        const index = context().chat.findLastIndex((message, position, chat) => !message.is_user && !message.is_system &&
            (message.original_avatar === selected || message.name === members.find(member => member.id === selected)?.name) && message.mes?.trim() &&
            chat.slice(0, position).some(previous => previous.is_user && !previous.is_system && previous.mes?.trim()));
        if (index >= 0) void generateThought(index, true);
        return;
    }
    if (event.target.closest('.npcsp-backfill')) {
        const index = context().chat.findLastIndex(message => !message.is_user && !message.is_system && message.mes?.trim() &&
            (message.original_avatar === selected || message.name === members.find(member => member.id === selected)?.name));
        if (index >= 0) void generateThought(index, true, true);
        return;
    }
    const presetButton = event.target.closest('[data-preset]');
    if (presetButton) {
        try {
            const next = structuredClone(store);
            const previous = next.preset?.id;
            const added = presetButton.dataset.preset === 'dark' ? applyDarkPreset(next, members) : applyWorldbookPreset(next);
            store = next;
            editKey = 'thought';
            refresh();
            if (added || previous !== store.preset?.id) save();
        } catch (error) { setStatus(error.message); }
        return;
    }
    const key = event.target.closest('[data-key]');
    if (key) { editKey = key.dataset.key; render(); $('.npcsp-choices [aria-pressed="true"]')?.focus(); return; }
    if (event.target.closest('.npcsp-cancel')) { editing = false; render(); return; }
    if (event.target.closest('.npcsp-addbutton')) {
        try { const field = addField(store, $('.npcsp-newname').value); editKey = field.id; refresh(); save(); $('.npcsp-form [name="name"]')?.focus(); }
        catch (error) { setStatus(error.message); $('.npcsp-newname')?.focus(); }
    }
    if (event.target.closest('.npcsp-remove')) {
        const field = currentField();
        if (!field || !confirm(`删除字段“${field.name}”及其当前聊天的值？`)) return;
        store.fields = store.fields.filter(item => item.id !== field.id);
        store.manual = store.manual.filter(item => item.key !== field.id);
        store.revision++;
        editKey = 'thought';
        refresh(); save();
    }
});

function readRule(form, stage) {
    const kind = form.elements[`${stage}Kind`].value;
    return { kind, value: form.elements[`${stage}Value`].value,
        fieldId: form.elements[`${stage}Field`].value };
}
$('.npcsp-scroll').addEventListener('submit', event => {
    if (event.target.id !== 'npcsp-form') return;
    event.preventDefault();
    const form = event.target;
    const next = structuredClone(store);
    const field = next.fields.find(item => item.id === editKey);
    try {
        next.adult[selected] = form.elements.adultConfirmed.checked;
        if (field) {
            updateField(next, field.id, { name: form.elements.name.value, kind: form.elements.kind.value,
                meaning: form.elements.meaning.value, hidden: form.elements.hidden.checked, adult: form.elements.adult.checked,
                partial: readRule(form, 'partial'), full: readRule(form, 'full') });
            field.applies[selected] = form.elements.applies.checked;
            if (!field.adult || next.adult[selected]) {
                const value = field.kind === 'text' ? null : form.elements.value.value === '' ? null : Number(form.elements.value.value);
                editValue(next, selected, field.id, value, form.elements.description.value,
                    field.hidden ? Number(form.elements.stage?.value || 0) : undefined);
            }
            const node = form.elements.node?.value.trim();
            if (node) { (next.nodes[selected] ||= {})[node] = Date.now(); next.revision++; }
        } else {
            editValue(next, selected, editKey, form.elements.value.value);
        }
        next.revision++;
        store = next;
        editing = false;
        refresh();
        save();
    } catch (error) { setStatus(error.message); }
});

document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { closePanel(); return; }
    if (event.key !== 'Tab' || !matchMedia('(max-width:1100px)').matches) return;
    const focusable = [...$('.npcsp-panel').querySelectorAll('button:not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')]
        .filter(element => element.getClientRects().length);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
});
window.addEventListener('beforeunload', event => { if (unsaved.size) { event.preventDefault(); event.returnValue = ''; } });

function scheduleRefresh() {
    if (singleStopped && singleTurn) return;
    const ticket = epoch;
    setTimeout(() => { if (ticket === epoch && binding) refresh({ persist: true }); }, 80);
}
async function generateThought(index, force = false, backfill = false) {
    const chat = context().chat;
    const message = chat[index];
    const member = members.find(item => item.id === (message?.original_avatar || members.find(item => item.name === message?.name)?.id));
    if (!member || !message?.mes?.trim() || (!force && !message.gen_finished)) return;
    const mark = fingerprint(message);
    const requestKey = `${binding}/${index}/${mark}/${backfill}`;
    if (thoughtRequests.has(requestKey) || (!force && (store.generated || []).some(item => item.index === index && item.fingerprint === mark))) return;
    const savedBinding = binding;
    const ticket = epoch;
    const user = chat.slice(0, index).reverse().find(item => item.is_user && !item.is_system)?.mes || '';
    if (!user.trim()) return;
    const indices = backfill ? chat.map((item, position) => ({ item, position }))
        .filter(({ item, position }) => position <= index && !item.is_user && !item.is_system && item.mes?.trim() &&
            (item.original_avatar === member.id || item.name === member.name)).slice(-6).map(({ position }) => position) : [index];
    const stageKey = `${DARK_PRESET_ID}:stage`;
    const priorStage = Number(store.current?.[member.id]?.fields?.[stageKey]?.description?.match(/^[0-6]/)?.[0] || 0);
    thoughtRequests.add(requestKey);
    setStatus(backfill ? '正在分析最近对话…' : '正在更新角色状态…');
    try {
        const response = await generateRaw({
            systemPrompt: `只分析${member.name}本人已发出的回复，输出严格JSON：{"thought":"一句第一人称心声或空串","changes":[{"key":"mood|relation|location|physical|stage|milestone","value":"简短的新状态或节点","evidence":"该角色回复中连续照抄的原句"}]}。证据必须来自该角色自己的叙述或表态，不可只引用玩家台词。stage为0到6，只记录已实现的关系事件：5为已发生肉体关系，6为已发生内射；已有档位不自动倒退，普通更新最多前进两档。milestone只记已发生的关键节点，不重复旧节点。physical记录明确的当前身体近况，已发生内射时可写明体内有精液；不得推断怀孕或伤病。无新证据则changes为空。不要Markdown。`,
            prompt: `角色性格：${String(member.character.personality || '').slice(0, 180)}\n此前关系档位：${priorStage}\n${store.summaries?.[member.id]?.text ? `关系短摘要：${store.summaries[member.id].text}\n` : ''}玩家最近一句：${String(user).slice(0, 240)}\n${backfill ? '最近该角色的回复（按时间顺序）：' : '该角色本轮回复：'}\n${indices.map(i => String(chat[i].mes).slice(0, 650)).join('\n---\n')}\n只从上述角色回复提取变化。`,
            responseLength: 650,
        });
        if (ticket !== epoch || binding !== savedBinding || fingerprint(context().chat[index] || {}) !== mark) return;
        recordAnalysis(store, context().chat, member.id, response, indices, priorStage, backfill);
        refresh();
        await save();
    } catch (error) {
        if (ticket === epoch && binding === savedBinding) setStatus(`状态分析失败：${error.message}`);
    } finally { thoughtRequests.delete(requestKey); }
}
async function confirmTurn(turn) {
    if (!turn || turn.binding !== binding) return;
    const ticket = epoch;
    const changed = context().chat.flatMap((message, index) =>
        !message.is_user && !message.is_system && message.gen_finished && message.mes?.trim() &&
        fingerprint(message) !== turn.before[index] ? [{ index, fingerprint: fingerprint(message) }] : []);
    if (!changed.length) return;
    let confirmed = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        if (ticket !== epoch || binding !== turn.binding) return;
        try {
            const saved = await readSavedChat(turn.binding);
            confirmed = changed.filter(item => fingerprint(saved[item.index + 1] || {}) === item.fingerprint);
            if (confirmed.length === changed.length) break;
        } catch (error) {
            if (attempt === 4) setStatus(`本轮待确认：${error.message}`);
        }
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (ticket !== epoch || binding !== turn.binding) return;
    if (confirmed.length !== changed.length) {
        const before = [...turn.before];
        for (const item of confirmed) before[item.index] = item.fingerprint;
        suppressChanges(store, before, context().chat);
        refresh();
        await save();
        if (status === '已保存') setStatus('本轮未确认保存的回复未更新状态');
    } else {
        refresh({ persist: true });
        if ([PRESET_ID, DARK_PRESET_ID].includes(store.preset?.id) || members.some(hasScenarioProfile))
            for (const item of confirmed) await generateThought(item.index);
    }
}
const events = context().eventTypes;
const source = context().eventSource;
source.on(events.CHAT_CHANGED, loadCurrent);
function worldbookChanged() {
    if (binding && store.fields.length === 0 && (darkPresetAvailable() || presetAvailable())) loadCurrent();
    else render();
}
source.on(events.WORLDINFO_UPDATED, worldbookChanged);
source.on(events.SETTINGS_UPDATED, worldbookChanged);
source.on(events.GROUP_WRAPPER_STARTED, () => {
    groupTurn = { binding, started: 0, stopped: false, before: context().chat.map(fingerprint) };
});
source.on(events.GENERATION_STARTED, () => {
    if (groupTurn && groupTurn.binding === binding) groupTurn.started++;
    else {
        singleStopped = false;
        singleTurn = { binding, before: context().chat.map(fingerprint) };
    }
});
source.on(events.GENERATION_STOPPED, () => { singleStopped = true; if (groupTurn) groupTurn.stopped = true; });
source.on(events.GROUP_WRAPPER_FINISHED, () => {
    const turn = groupTurn;
    groupTurn = null;
    if (turn?.binding !== binding) return;
    if (!turn.stopped && turn.started > 0) void confirmTurn(turn);
    else if (turn.stopped) {
        suppressChanges(store, turn.before, context().chat);
        refresh(); save();
    }
});
source.on(events.GENERATION_ENDED, () => {
    if (context().groupId) return;
    const turn = singleTurn;
    singleTurn = null;
    if (!turn || turn.binding !== binding) return;
    if (singleStopped) {
        suppressChanges(store, turn.before, context().chat);
        refresh(); save();
        singleStopped = false;
    } else void confirmTurn(turn);
});
for (const type of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'MESSAGE_UPDATED']) {
    source.on(events[type], scheduleRefresh);
}

function guardPrompt(data) {
    const ctx = context();
    if (!ctx.groupId || !binding) return;
    const recipient = ctx.characters[ctx.characterId]?.avatar;
    if (!recipient) return;
    const fragments = privateFragments(store, ctx.chat, members);
    const redact = value => {
        if (typeof value === 'string') {
            for (const [id, lines] of Object.entries(fragments)) if (id !== recipient)
                for (const line of lines) value = value.replaceAll(line, '[其他角色的私有内容已移除]');
            return value;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = redact(value[key]);
        return value;
    };
    if (data.chat) redact(data.chat);
    if (typeof data.prompt === 'string') data.prompt = redact(data.prompt);
}
source.on(events.CHAT_COMPLETION_PROMPT_READY, guardPrompt);
source.on(events.GENERATE_AFTER_COMBINE_PROMPTS, guardPrompt);

const nativeFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (binding && context().groupId && /\/api\/(?:backends\/[^/]+|novelai)\/generate(?:\?|$)|\/api\/horde\/generate-text(?:\?|$)/.test(url)) {
        const recipient = context().characters[context().characterId]?.avatar;
        if (recipient && typeof init?.body === 'string') {
            const leak = foreignPrivateText(init.body, recipient, privateFragments(store, context().chat, members));
            if (leak) {
                setStatus('已阻止请求：包含其他角色的私有内容');
                return Promise.reject(new Error('NPC 状态面板阻止了跨角色私有内容泄漏'));
            }
        }
    }
    return nativeFetch(input, init);
};

loadCurrent();
