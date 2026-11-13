# 推送模式与会话控制

## 模式

**未登记的会话默认不限长**（`enabled=true`、`mode=long`、`maxChars=0`），即保持改动前的行为；只有显式选过模式才限长。

- 摘要模式（`/push <码> mode summary`）：固定 800 字，先提炼内容再应用 800 上限。
- 长文模式（`/push <码> mode long 800|1600|3000|full`）：保留正文，应用所选上限；`full` 等于 0（不限长）。

当前实现通过 `state/session-notification-controls.json` 持久化。写入只落显式设置过的字段，不把继承来的默认值写死。

## 与 legacy 长度表的优先级（2026-11-09 裁决 Q1=B / Q2=A）

`state/session-notification-limits.json` 是旧的「按会话 + 按 kind（result/approval/decision）」长度表，语义是 **0 = 不限长**。合并口径只有一处（`limitNotificationText`）：

1. **legacy 显式值优先**，包括显式 0（不限长）；未配置的 kind 不会出现在 legacy 表里。
2. 只有 legacy 没配该 kind 时，才用上面的 controls 上限；controls 未登记时默认不限长。
3. 显式 `summary` 模式的 800 是 controls 的取值，同样只在该 kind 未被 legacy 显式配置时生效。

## 会话控制命令

- `/push <会话码> on`：打开一个会话的推送。
- `/push <会话码> off`：关闭一个会话的推送。
- `/push all on`：一键打开所有会话推送。
- `/push all off`：一键关闭所有会话推送。
- `/push <会话码> mode summary`：摘要模式，固定 800 字。
- `/push <会话码> mode long 800`：长文 800 字。
- `/push <会话码> mode long 1600`：长文 1600 字。
- `/push <会话码> mode long 3000`：长文 3000 字。
- `/push <会话码> mode long full`：全文推送。

一键全开/全关会覆盖已有会话的开关例外；模式设置会保留。会话关闭后，回合摘要、权限请求和逐个询问都不会由微信/飞书回环插件生成外部推送，但 DSH 原生前端仍可按自己的事件链处理。

## 生效

状态层和插件代码通过当前 web profile 的 junction 加载。修改插件代码后需重启 DSH Web 并新开会话，才能让已缓存的模块加载新版本。
