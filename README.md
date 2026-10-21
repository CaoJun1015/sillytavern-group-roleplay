# 纯文本群聊角色扮演

适配 SillyTavern 1.19.0。扩展使用现有群组、角色卡、玩家昵称和模型连接；不安装其他扩展依赖。源码由本仓库管理，SillyTavern 自身仓库保持原样。

## 安装与启动

将本目录复制到 `SillyTavern/public/scripts/extensions/third-party/plain-group-roleplay`，重启或刷新 SillyTavern。Windows PowerShell 开发安装示例（在外层仓库执行）：

```powershell
$target = '.\SillyTavern\public\scripts\extensions\third-party\plain-group-roleplay'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath .\extension\manifest.json, .\extension\core.js, .\extension\lore.js, .\extension\index.js, .\extension\style.css -Destination $target -Force
```

选择包含至少一名成员的群组，可先在右下角数字框设置每轮推进的游戏分钟数（默认 1），再点击“新建角色扮演”。扩展会新建专用群聊存档；已有原生群聊不被改写。点名通过下拉框选择；私聊、返回群聊和继续均在扩展界面操作。每次载入后先完成一轮群聊请求，确认能检查实际发往模型的请求，再开放私聊入口。离开视图后，可点击“打开角色扮演”返回；在游戏存档中，原生聊天区与输入区保持隐藏。

角色回复会读取 SillyTavern 当前启用的全局世界书、当前聊天绑定的世界书，以及**该角色自己**绑定的世界书；只用该角色可见的最近消息激活常驻或关键词条目。玩家身份绑定世界书可能包含尚未透露的个人资料，因此不自动送给 NPC。Text Completion 读取已启用的 System Prompt 与 Post-History；Chat Completion 读取 Prompt Manager 中当前群组已启用的非标记提示。角色卡的主提示词覆盖遵循酒馆的“优先使用角色提示词”设置。配置中的 `{{char}}`、`{{charIfNotGroup}}`、`{{user}}`、`{{group}}` 会按当前角色替换。未支持的宏会明确报错，避免错误地展开为其他频道的信息。

停止后，玩家输入保留为待完成回合，可点“重试本轮”或“回退”撤回。保存失败会显示“未保存”，请重试保存或立即导出；刷新前浏览器会提示。导入时先选目标群组，扩展会检查角色 ID 并新建存档。缺失角色不会自动映射。

## 数据格式

每个游戏会话对应一个原生群聊 JSONL 文件。消息正文仍是原生消息，扩展字段 `extra.pgrp` 保存稳定消息 ID、回合 ID、频道、发言人、时间和受众。聊天元数据 `plainGroupRoleplay` 保存数据版本、会话与分支 ID、修订号、角色 ID、当前频道、游戏时间、已确认事实、回合快照及待完成输入。导出文件包含同一会话元数据与消息。当前格式版本为 1；不支持旧版自动迁移。

上下文由扩展逐角色筛选。群聊调度器只读取群频道消息；私聊仅供玩家与对应 NPC 使用。每次模型请求会检查最终发往 SillyTavern 后端的请求体中是否包含该角色不可见消息的原文，发现时阻止请求。其他扩展若把私聊改写、摘要或另行发送，超出本扩展的检查能力；正式使用私聊前应按验收记录检查实际请求。

状态变更仅接受有来源消息 ID、原文短句且值直接出现在短句中的明确陈述。含糊语义保持原状态。长期记录保留原文；超出提示预算时只送最近可见消息及带来源的已确认事实，不生成独立的私聊摘要。

## 开发检查

在仓库根目录执行 `node --test extension/test/core.test.js extension/test/lore.test.js` 和 `node --check extension/index.js`。人工场景使用 `test-data/neutral-scenario.md`，结果记录在 `ACCEPTANCE.md`。

## 已知限制

- 只接管新建专用存档，不迁移原生群聊历史。游戏模式需始终使用扩展输入；其他扩展若直接修改同一存档，可能破坏一致性。
- 自然语言的人设、拒绝和关系语义仍依赖模型。程序对无效结构最多修复一次，对不确定状态不自动写入。
- 模型请求审计匹配不可见消息原文；无法识别其他扩展生成的同义改写。当前工作区只完成模拟后端接入验收，真实模型连接的隔离与表现仍待验证。
- 世界书目前支持常驻条目、普通／正则关键词和次级关键词条件。向量检索、递归、定时效果、角色过滤、装饰器等高级激活条件会跳过并显示在运行记录中；世界书受 4000 字上限及当前世界书预算约束。请把所有 NPC 均可读取的内容放在全局或聊天世界书，私有内容绑定到对应角色。
