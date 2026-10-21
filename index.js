import { createNewGroupChat } from '../../../group-chats.js';
import { loadWorldInfo, selected_world_info, world_info, world_info_budget, world_info_depth } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { promptManager } from '../../../openai.js';
import {
    PLAYER, createSession, audience, beginRound, contextFor, parseJson, validatePlan,
    validateReply, completeRound, rewind, recover, forbiddenInRequest, sameTurn, saveGroupSnapshot,
} from './core.js';
import { bookNamesFor, visibleMessagesFor, selectLore, panelRules, safeSettingsText } from './lore.js';

if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));

const KEY = 'plainGroupRoleplay';
const $ = selector => document.querySelector(selector);
const context = () => SillyTavern.getContext();
let session = null;
let messages = [];
let saved = true;
let saving = false;
let busy = false;
let savingRound = false;
let starting = false;
let epoch = 0;
let activeRequest = null;
let isolationReady = false;
let errorText = '';
let audit = [];

const root = document.createElement('section');
root.id = 'pgrp';
root.hidden = true;
root.innerHTML = `
  <header><strong>纯文本群聊角色扮演</strong><span id="pgrp-title"></span><span id="pgrp-clock"></span><span id="pgrp-status"></span>
    <button id="pgrp-leave" type="button">离开视图</button></header>
  <div class="pgrp-layout"><aside><div id="pgrp-channels"></div><details open><summary>人物资料</summary><div id="pgrp-profiles"></div></details>
    <details><summary>运行记录</summary><pre id="pgrp-audit"></pre></details></aside>
    <main><div id="pgrp-messages" role="log" aria-live="polite"></div><div id="pgrp-error" role="status"></div>
      <div class="pgrp-actions"><select id="pgrp-target" aria-label="点名对象"></select><button id="pgrp-private" type="button">私聊</button>
        <button id="pgrp-group" type="button">返回群聊</button><button id="pgrp-continue" type="button">继续</button>
        <button id="pgrp-stop" type="button">停止</button><button id="pgrp-retry" type="button">重试本轮</button>
        <button id="pgrp-back" type="button">回退</button><button id="pgrp-save" type="button">保存</button>
        <button id="pgrp-export" type="button">导出</button><button id="pgrp-import" type="button">导入</button>
        <input id="pgrp-file" type="file" accept="application/json,.json" hidden></div>
      <form id="pgrp-form"><textarea id="pgrp-input" rows="3" maxlength="4000" placeholder="输入你的话；点名只影响回应优先级"></textarea>
        <button id="pgrp-send" type="submit">发送</button></form></main></div>`;
document.body.append(root);

const launcher = document.createElement('button');
launcher.id = 'pgrp-launcher';
launcher.type = 'button';
launcher.textContent = '群聊角色扮演';
document.body.append(launcher);
const minutesInput = document.createElement('input');
minutesInput.id = 'pgrp-minutes';
minutesInput.type = 'number';
minutesInput.min = '1';
minutesInput.max = '60';
minutesInput.value = '1';
minutesInput.title = '每轮推进的游戏分钟数';
minutesInput.setAttribute('aria-label', '每轮推进的游戏分钟数');
document.body.append(minutesInput);
const launcherError = document.createElement('div');
launcherError.id = 'pgrp-launcher-error';
launcherError.setAttribute('role', 'status');
document.body.append(launcherError);

function memberName(member) {
    return context().characters.find(character => character.avatar === member)?.name || member;
}

function currentKey() {
    const ctx = context();
    return `${ctx.groupId || ''}/${ctx.chatId || ''}`;
}

function assertCurrent() {
    if (!session || currentKey() !== `${session.groupId}/${session.chatId}`) throw new Error('已切换群聊存档');
}

function nativeMessage(message) {
    const ctx = context();
    const isUser = message.speaker === PLAYER;
    const { text, ...metadata } = message;
    return {
        name: isUser ? ctx.name1 : memberName(message.speaker),
        is_user: isUser, is_system: false, mes: text, send_date: message.time,
        ...(!isUser ? { original_avatar: message.speaker, force_avatar: ctx.getThumbnailUrl('avatar', message.speaker) } : {}),
        extra: { pgrp: metadata },
    };
}

function setLocal(nextSession, nextMessages) {
    session = nextSession;
    messages = nextMessages;
    render();
}

async function saveExact() {
    assertCurrent();
    const ctx = context();
    const binding = currentKey();
    const metadata = { ...ctx.chatMetadata, [KEY]: session, tainted: true };
    const chat = [{ chat_metadata: metadata, user_name: 'unused', character_name: 'unused' }, ...messages.map(nativeMessage)];
    await saveGroupSnapshot(fetch, ctx.getRequestHeaders(), session.chatId, chat);
    if (binding !== currentKey()) throw new Error('保存期间已切换群聊');
    ctx.chat.splice(0, ctx.chat.length, ...chat.slice(1));
    Object.assign(ctx.chatMetadata, metadata);
    saved = true;
    errorText = '';
    render();
}

async function persist() {
    if (saving) return false;
    saving = true;
    const sessionId = session?.id;
    saved = false;
    render();
    try {
        await saveExact();
        return true;
    } catch (error) {
        if (session?.id === sessionId) {
            errorText = error.message;
            render();
        }
        return false;
    } finally {
        saving = false;
        render();
    }
}

function setAutoModeOff() {
    const checkbox = $('#rm_group_automode');
    if (checkbox?.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

async function start() {
    if (starting) return;
    starting = true;
    launcher.disabled = true;
    try {
        const ctx = context();
        if (!ctx.groupId) throw new Error('请先在 SillyTavern 中选择群组');
        const group = ctx.groups.find(item => item.id === ctx.groupId);
        if (!group?.members?.length) throw new Error('群组中没有角色');
        const minutes = Number(minutesInput.value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('每轮时间须为 1 至 60 分钟');
        setAutoModeOff();
        await createNewGroupChat(ctx.groupId);
        const fresh = context();
        const next = createSession(fresh.groupId, fresh.chatId, group.members, { minutes });
        setLocal(next, []);
        root.hidden = false;
        launcherError.textContent = '';
        await persist();
    } finally {
        starting = false;
        launcher.disabled = false;
    }
}

function loadCurrent() {
    const ctx = context();
    const loaded = ctx.chatMetadata?.[KEY];
    if (!loaded) {
        isolationReady = false;
        document.body.classList.remove('pgrp-locked');
        session = null;
        messages = [];
        root.hidden = true;
        document.body.classList.remove('pgrp-session');
        render();
        return;
    }
    try {
        const native = ctx.chat.filter(item => item.extra?.pgrp).map(item => ({ ...item.extra.pgrp, text: item.mes }));
        const restored = recover(loaded, native);
        session = restored.session;
        isolationReady = false;
        messages = restored.messages;
        saved = restored.messages.length === native.length && restored.session.rounds.length === loaded.rounds.length;
        errorText = saved ? '' : '检测到不完整写入；已恢复到最后完整回合，请保存或导出';
        launcherError.textContent = '';
        setAutoModeOff();
        root.hidden = false;
        document.body.classList.add('pgrp-session');
        document.body.classList.remove('pgrp-locked');
        render();
    } catch (error) {
        session = null;
        root.hidden = false;
        document.body.classList.add('pgrp-locked');
        errorText = `存档读取失败：${error.message}`;
        $('#pgrp-error').textContent = errorText;
    }
}

function addAudit(entry) {
    audit.push(`${new Date().toLocaleTimeString()} ${entry}`);
    audit = audit.slice(-30);
    render();
}

const originalFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (activeRequest && /\/api\/(?:backends\/)?[^?]*generate(?:\?|$)/.test(url)) {
        const body = String(init?.body || '');
        const found = forbiddenInRequest(messages, activeRequest.recipient, activeRequest.channel, activeRequest.mode, body);
        if (found) {
            addAudit(`请求阻断：${activeRequest.recipient} 的请求包含不可见消息 ${found.id}`);
            throw new Error('请求包含其他频道的私聊内容，已阻止发送');
        }
        activeRequest.count++;
        addAudit(`请求检查通过：${activeRequest.mode} / ${activeRequest.recipient} / ${url}`);
    }
    return originalFetch(input, init);
};

async function askModel(prompt, recipient, mode, ticket) {
    if (ticket !== epoch) throw new Error('生成已停止');
    const guard = { recipient, mode, channel: session.pending.channel, count: 0 };
    activeRequest = guard;
    try {
        const text = await context().generateRaw({ prompt, trimNames: false, responseLength: 1024 });
        if (ticket !== epoch) throw new Error('生成已停止');
        if (!guard.count) throw new Error('未观察到最终模型请求，无法确认信息隔离');
        if (guard.mode === '调度' && guard.channel === 'group') isolationReady = true;
        return parseJson(text);
    } finally {
        if (activeRequest === guard) activeRequest = null;
    }
}

function plannerPrompt() {
    const group = context().groups.find(item => item.id === session.groupId);
    const history = messages.filter(message => message.channel === session.pending.channel).slice(-12)
        .map(message => ({ id: message.id, speaker: message.speaker, text: message.text }));
    const members = audience(session, session.pending.channel).filter(member => member !== PLAYER)
        .map(member => ({ id: member, name: memberName(member) }));
    return [
        { role: 'system', content: '你是群聊回合调度器。只根据当前频道对话选择 0 至 3 位不同的 NPC，允许无人回应。点名提高优先级但不强制回应。仅从玩家本轮亲自说出的原文提取明确的个人资料，不能推断。输出单个 JSON：{"intent":"简短标签","target":null,"clarify":false,"speakers":["角色ID"],"playerFacts":[{"value":"原文中的资料值","quote":"包含资料值的玩家原文短句"}]}。不要输出推理过程。' },
        { role: 'user', content: JSON.stringify({ group: group?.name || '', channel: session.pending.channel, members, mentioned: session.pending.target, history }) },
    ];
}

async function characterPrompt(member, draft) {
    const ctx = context();
    const character = ctx.characters.find(item => item.avatar === member);
    if (!character) throw new Error(`角色已缺失：${member}`);
    const data = character.data || character;
    const card = {
        name: character.name, description: data.description || '', personality: data.personality || '',
        scenario: data.scenario || '', example: data.mes_example || '',
    };
    const budget = Math.min(12000, Math.max(3000, Math.floor(Number(ctx.maxContext || 6000) * 2)));
    const group = ctx.groups.find(item => item.id === session.groupId);
    const names = bookNamesFor({
        global: selected_world_info, chat: ctx.chatMetadata.world_info,
        primary: data.extensions?.world,
        extra: world_info.charLore?.find(item => item.name === member.replace(/\.[^/.]+$/, ''))?.extraBooks || [],
    });
    const books = await Promise.all(names.map(async name => {
        const data = await loadWorldInfo(name);
        if (!data?.entries) throw new Error(`世界书无法读取：${name}`);
        return { name, entries: data.entries };
    }));
    const visible = visibleMessagesFor(draft, member);
    const lore = selectLore(books, visible, {
        scanDepth: world_info_depth,
        maxChars: Math.min(4000, Math.max(800, Math.floor(Number(ctx.maxContext || 6000) * 2 * world_info_budget / 100))),
    });
    if (lore.skipped.length) addAudit(`世界书跳过 ${lore.skipped.length} 条：${lore.skipped.slice(0, 3).join('、')}`);
    const variables = { character: character.name, player: ctx.name1, group: group?.name || '' };
    const rules = panelRules(ctx.mainApi, power_user.sysprompt, promptManager,
        power_user.prefer_character_prompt ? data : null)
        .map(rule => safeSettingsText(rule, variables));
    const loreText = lore.selected.map(entry => `[${entry.book}] ${safeSettingsText(entry.content, variables)}`);
    if (rules.join('').length > 4000) throw new Error('提示词面板规则超过 4000 字，请精简后重试');
    addAudit(`角色配置：${character.name}，规则 ${rules.length} 条，世界书 ${loreText.length} 条`);
    return [
        { role: 'system', content: `已启用的 SillyTavern 规则：\n${rules.join('\n')}\n已激活的世界书条目：\n${loreText.join('\n')}\n你只扮演 ${character.name}。保留角色卡身份和性格。仅写该角色在当前频道说出的纯文本；可以拒绝、沉默、反对、接话。不能代写玩家言行或内心。只能使用下方可见上下文。输出单个 JSON：{"action":"reply"或"silent","text":"发言文本，沉默时为空","changes":[]}。变更格式：{"kind":"player_fact|npc_fact|relation|body","subject":"角色ID或player","value":"简短确定内容","sourceId":"消息ID或self","quote":"来源原文中的精确短句","confidence":"explicit或uncertain"}。只提出明确表达的变化；没有依据时用空数组。不要输出推理过程。\n角色卡：${JSON.stringify(card)}` },
        { role: 'user', content: JSON.stringify({ channel: session.pending.channel, context: contextFor(session, draft, member, budget), mentioned: session.pending.target === member }) },
    ];
}

async function runPending() {
    if (!session?.pending || busy || !saved) return;
    assertCurrent();
    busy = true;
    const ticket = ++epoch;
    const binding = `${session.id}/${session.branchId}/${session.revision}/${session.pending.id}`;
    const draft = [...messages];
    const replies = [];
    render();
    try {
        let speakers;
        let plan;
        let repair = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const prompt = plannerPrompt();
            if (repair) prompt.push({ role: 'user', content: `上次结果不合格：${repair}。只输出符合格式的 JSON。` });
            try {
                plan = await askModel(prompt, session.pending.channel === 'group' ? PLAYER : session.pending.channel.slice(8), '调度', ticket);
                speakers = validatePlan(plan, session);
                break;
            } catch (error) {
                if (attempt || !repairable(error)) throw error;
                repair = error.message;
            }
        }
        addAudit(`回合 ${session.pending.id}：${session.pending.channel}，意图 ${String(plan.intent || '未分类').slice(0, 30)}，候选 ${speakers.join(', ') || '无人'}`);
        for (const speaker of speakers) {
            let reply;
            let message;
            repair = '';
            for (let attempt = 0; attempt < 2; attempt++) {
                const prompt = await characterPrompt(speaker, draft);
                if (repair) prompt.push({ role: 'user', content: `上次结果不合格：${repair}。只输出符合格式的 JSON。` });
                try {
                    reply = await askModel(prompt, speaker, '角色', ticket);
                    message = validateReply(reply, session, speaker);
                    break;
                } catch (error) {
                    if (attempt || !repairable(error)) throw error;
                    repair = error.message;
                }
            }
            if (message) {
                reply.changes = reply.changes.map(change => change.sourceId === 'self' ? { ...change, sourceId: message.id } : change);
                draft.push(message);
            }
            replies.push({ speaker, reply, message });
            if (ticket !== epoch) throw new Error('生成已停止');
        }
        if (!sameTurn(ticket, epoch, binding, session)) throw new Error('回合已变更');
        const playerChanges = (plan.playerFacts || []).map(fact => ({
            kind: 'player_fact', subject: PLAYER, value: fact.value,
            quote: fact.quote, sourceId: session.pending.inputId, confidence: 'explicit',
        }));
        const done = completeRound(session, messages, replies, playerChanges);
        setLocal(done.session, done.messages);
        savingRound = true;
        render();
        if (!await persist()) throw new Error(errorText);
        addAudit(`提交：${replies.filter(item => item.message).length} 条 NPC 消息；状态与时间已保存`);
    } catch (error) {
        if (ticket === epoch) {
            errorText = error.message === '生成已停止' ? '已停止；玩家输入保留，可重试或撤回' : `回合失败：${error.message}`;
            addAudit(errorText);
        }
    } finally {
        if (ticket === epoch) {
            savingRound = false;
            busy = false;
            render();
        }
    }
}

async function send(input) {
    if (!session || busy || !saved) return;
    assertCurrent();
    if (session.pending) return runPending();
    const target = $('#pgrp-target').value || null;
    const started = beginRound(session, messages, input, target);
    setLocal(started.session, started.messages);
    if (await persist()) {
        $('#pgrp-input').value = '';
        await runPending();
    }
}

function repairable(error) {
    return error instanceof SyntaxError || /计划|结构|消息过长|HTML|代写玩家/.test(error.message);
}

function stop() {
    if (!busy || savingRound) return;
    epoch++;
    activeRequest = null;
    context().stopGeneration();
    busy = false;
    errorText = '已停止；待完成输入保留';
    render();
}

async function switchChannel(channel) {
    if (!session || busy || !saved || session.pending) return;
    if (channel !== 'group' && !isolationReady) throw new Error('尚未观察到可审计的模型请求，私聊暂不可用');
    audience(session, channel);
    session = { ...session, channel, revision: session.revision + 1 };
    await persist();
}

async function rewindSelected(retry) {
    if (!session?.rounds.length || busy || !saved) return;
    const round = session.rounds.at(-1);
    const removed = messages.filter(message => message.roundId === round.id);
    const counts = [...new Set(removed.map(message => message.channel))].join('、');
    if (!window.confirm(`将撤销 ${counts} 中的 ${removed.length} 条消息及对应状态。${retry ? '保留玩家输入并重新生成？' : '确定回退？'}`)) return;
    const result = rewind(session, messages, round.id, retry);
    setLocal(result.session, result.messages);
    if (await persist() && retry) await runPending();
}

function exportArchive() {
    if (!session) return;
    const blob = new Blob([JSON.stringify({ version: 1, session, messages }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pgrp-${session.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importArchive(file) {
    if (!file || file.size > 20_000_000 || busy || !saved) throw new Error('导入文件无效或当前会话未保存');
    const archive = JSON.parse(await file.text());
    if (archive.version !== 1 || !archive.session || !Array.isArray(archive.messages) ||
        !Array.isArray(archive.session.members) || !archive.session.members.length ||
        !Array.isArray(archive.session.rounds) || !archive.session.state?.npcs ||
        !Number.isFinite(Date.parse(archive.session.state.time))) throw new Error('不支持的存档格式');
    const ctx = context();
    const group = ctx.groups.find(item => item.id === ctx.groupId);
    if (!group) throw new Error('请先选择目标群组');
    const missing = archive.session.members.filter(member => !group.members.includes(member));
    if (missing.length) throw new Error(`目标群组缺少角色：${missing.join(', ')}`);
    if (group.members.length !== archive.session.members.length ||
        !Array.isArray(archive.session.state.playerFacts) ||
        archive.session.members.some(member => !archive.session.state.npcs[member])) throw new Error('目标群组角色或状态与存档不一致');
    audience(archive.session, archive.session.channel);
    for (const message of archive.messages) {
        if (!message?.id || !message.roundId || typeof message.text !== 'string' || message.text.length > 4000 ||
            !['group', ...archive.session.members.map(member => `private:${member}`)].includes(message.channel) ||
            ![PLAYER, ...archive.session.members].includes(message.speaker) ||
            !Array.isArray(message.audience) ||
            message.audience.length !== audience(archive.session, message.channel).length ||
            message.audience.some(person => !audience(archive.session, message.channel).includes(person)) ||
            (message.speaker !== PLAYER && !message.audience.includes(message.speaker))) throw new Error('消息格式或角色映射无效');
    }
    const restored = recover(archive.session, archive.messages);
    if (restored.messages.length !== archive.messages.length) throw new Error('存档包含不完整回合');
    await createNewGroupChat(group.id);
    const fresh = context();
    restored.session.groupId = fresh.groupId;
    restored.session.chatId = fresh.chatId;
    restored.session.id = crypto.randomUUID();
    restored.session.branchId = crypto.randomUUID();
    restored.session.revision++;
    setLocal(restored.session, restored.messages);
    root.hidden = false;
    await persist();
}

function button(label, click) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', click);
    return element;
}

function render() {
    const ctx = context();
    const active = !!session && currentKey() === `${session.groupId}/${session.chatId}`;
    document.body.classList.toggle('pgrp-session', active);
    launcher.textContent = active ? '打开角色扮演' : '新建角色扮演';
    minutesInput.hidden = active;
    if (!session) return;
    $('#pgrp-title').textContent = session.channel === 'group' ? '群聊' : `与 ${memberName(session.channel.slice(8))} 私聊`;
    $('#pgrp-clock').textContent = new Date(session.state.time).toLocaleString();
    $('#pgrp-status').textContent = savingRound ? '保存中' : busy ? '生成中' : saved ? '已保存' : '未保存';
    $('#pgrp-error').textContent = errorText;
    $('#pgrp-audit').textContent = audit.join('\n');
    const channels = $('#pgrp-channels');
    channels.replaceChildren(button('群聊', () => switchChannel('group')));
    for (const member of session.members) {
        const entry = button(`私聊 · ${memberName(member)}`, () => switchChannel(`private:${member}`).catch(handleError));
        entry.disabled = !isolationReady;
        channels.append(entry);
    }
    const target = $('#pgrp-target');
    const previousTarget = target.value;
    target.replaceChildren(new Option('不点名', ''));
    for (const member of audience(session).filter(item => item !== PLAYER)) target.add(new Option(memberName(member), member));
    target.value = [...target.options].some(option => option.value === previousTarget) ? previousTarget : '';
    const shown = messages.filter(message => message.channel === session.channel);
    const list = $('#pgrp-messages');
    list.replaceChildren();
    for (const message of shown) {
        const item = document.createElement('article');
        item.className = message.speaker === PLAYER ? 'pgrp-player' : 'pgrp-npc';
        item.dataset.messageId = message.id;
        const speaker = document.createElement('strong');
        speaker.textContent = message.speaker === PLAYER ? ctx.name1 : memberName(message.speaker);
        const text = document.createElement('p');
        text.textContent = message.text;
        item.append(speaker, text);
        list.append(item);
    }
    const lastRound = session.rounds.at(-1);
    if (lastRound?.channel === session.channel && !messages.some(message =>
        message.roundId === lastRound.id && message.speaker !== PLAYER)) {
        const notice = document.createElement('p');
        notice.textContent = '本轮无人回应';
        list.append(notice);
    }
    const profiles = $('#pgrp-profiles');
    profiles.replaceChildren();
    const player = document.createElement('section');
    player.textContent = `${ctx.name1 || '玩家'} · 新成员\n${session.state.playerFacts.map(f => `• ${f.value}`).join('\n') || '其他资料：未知'}`;
    profiles.append(player);
    for (const fact of session.state.playerFacts) player.append(button('查看来源', () => {
        const source = messages.find(message => message.id === fact.sourceId);
        if (source) switchChannel(source.channel).then(() => document.querySelector(`[data-message-id="${source.id}"]`)?.scrollIntoView());
    }));
    for (const member of session.members) {
        const state = session.state.npcs[member];
        const section = document.createElement('section');
        const lastRelation = state.relationEvents.at(-1);
        const relationSource = messages.find(message => message.id === lastRelation?.sourceId);
        section.textContent = `${memberName(member)}\n身份：未知\n关系：${state.relation}\n${relationSource ? `最近变化：${relationSource.text.slice(0, 80)}\n` : ''}身体状态：${state.body}\n${state.facts.map(f => `• ${f.value}`).join('\n') || '其他资料：未知'}`;
        const sources = [...state.facts.map(f => f.sourceId), ...state.relationEvents.map(e => e.sourceId), state.bodySource].filter(Boolean);
        for (const sourceId of [...new Set(sources)]) section.append(button('查看来源', async () => {
            const source = messages.find(message => message.id === sourceId);
            if (source) { await switchChannel(source.channel); document.querySelector(`[data-message-id="${sourceId}"]`)?.scrollIntoView(); }
        }));
        profiles.append(section);
    }
    for (const id of ['pgrp-send', 'pgrp-continue', 'pgrp-retry', 'pgrp-back', 'pgrp-private', 'pgrp-group', 'pgrp-import']) {
        $(`#${id}`).disabled = busy || !saved;
    }
    $('#pgrp-stop').disabled = !busy || savingRound;
    $('#pgrp-private').disabled ||= !isolationReady;
    $('#pgrp-save').disabled = saving || busy || saved;
    $('#pgrp-retry').disabled ||= !session.rounds.length && !session.pending;
    $('#pgrp-back').disabled ||= !session.rounds.length && !session.pending;
    $('#pgrp-input').disabled = busy || !saved;
}

function handleError(error) {
    errorText = error.message;
    launcherError.textContent = error.message;
    render();
}

launcher.addEventListener('click', () => {
    if (session && currentKey() === `${session.groupId}/${session.chatId}`) root.hidden = false;
    else if (session && !saved) handleError(new Error('当前会话未保存，请先导出结果'));
    else start().catch(handleError);
});
$('#pgrp-leave').addEventListener('click', () => { if (busy) stop(); root.hidden = true; });
$('#pgrp-form').addEventListener('submit', event => { event.preventDefault(); send($('#pgrp-input').value).catch(handleError); });
$('#pgrp-continue').addEventListener('click', () => send('').catch(handleError));
$('#pgrp-stop').addEventListener('click', stop);
$('#pgrp-private').addEventListener('click', () => {
    const member = $('#pgrp-target').value;
    if (!member) return handleError(new Error('请先选择私聊对象'));
    switchChannel(`private:${member}`).catch(handleError);
});
$('#pgrp-group').addEventListener('click', () => switchChannel('group').catch(handleError));
$('#pgrp-retry').addEventListener('click', () => {
    if (session.pending) runPending().catch(handleError);
    else rewindSelected(true).catch(handleError);
});
$('#pgrp-back').addEventListener('click', () => {
    if (session.pending) {
        if (!window.confirm('撤回待完成的玩家输入？')) return;
        const next = structuredClone(session);
        const kept = messages.filter(message => message.roundId !== next.pending.id);
        next.state = next.pending.before;
        next.pending = null;
        next.revision++;
        setLocal(next, kept);
        persist();
    } else rewindSelected(false).catch(handleError);
});
$('#pgrp-save').addEventListener('click', () => persist());
$('#pgrp-export').addEventListener('click', exportArchive);
$('#pgrp-import').addEventListener('click', () => $('#pgrp-file').click());
$('#pgrp-file').addEventListener('change', event => importArchive(event.target.files[0]).catch(handleError));

window.addEventListener('beforeunload', event => {
    if (!saved) { event.preventDefault(); event.returnValue = ''; }
});
context().eventSource.on(context().eventTypes.CHAT_CHANGED, () => {
    epoch++;
    if (busy) context().stopGeneration();
    activeRequest = null;
    busy = false;
    savingRound = false;
    if (!saved && session) { errorText = '未保存的结果仍在内存中；请先导出'; root.hidden = false; render(); return; }
    loadCurrent();
});
context().eventSource.on(context().eventTypes.GROUP_CHAT_CREATED, () => {
    if (!session) render();
});
for (const type of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
    context().eventSource.on(context().eventTypes[type], () => {
        if (!session || currentKey() !== `${session.groupId}/${session.chatId}`) return;
        epoch++;
        context().stopGeneration();
        saved = false;
        errorText = '检测到原生消息操作，游戏已暂停；请保存以恢复扩展记录，或导出后重新载入';
        addAudit(errorText);
    });
}
setAutoModeOff();
document.addEventListener('input', event => {
    if (event.target?.id === 'rm_group_automode' && session && event.target.checked) queueMicrotask(setAutoModeOff);
});
document.addEventListener('click', event => {
    if (!session || currentKey() !== `${session.groupId}/${session.chatId}`) return;
    if (event.target.closest('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate, .swipe_left, .swipe_right, .mes_edit, .mes_del')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        errorText = '游戏存档请使用扩展中的受控操作';
        render();
    }
}, true);
loadCurrent();
