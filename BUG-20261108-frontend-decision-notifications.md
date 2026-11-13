# BUG-20261108：权限与逐个询问事件未到 DSH 前端

- 状态：OPEN
- 优先级：P1（会阻塞需要人工处理的会话）
- 影响范围：web profile 的前端事件提示；外部微信/飞书回环推送是另一条链路

## 用户现象

1. “权限不足/需要授权”的信息推送，前端没有收到。
2. “逐个询问要求返回”的推送，前端没有收到。

## 已确认事实

- `dsh-notify-bell` 已实现 `approval/asked` → permission 通知分类。
- `dsh-notify-bell` 已实现 `tool/call + ask_user_question` → question 通知分类。
- `dsh-wechat-hitl` 监听 `approval/request`、`approval/asked` 和 `tool/call`，并把请求写入自己的回环状态/外部发件箱。
- 当前回环插件的外部推送成功与否不能证明 DSH 前端收到同一个事件；两者必须分别验证。
- 代码中同时存在 `ask_user_question` 和 `request_user_input` 两种工具名，事件载荷字段也有多个兼容形态，需用真实事件样本确认前端桥接是否丢在归一化、SSE、还是前端订阅过滤阶段。

## 复现与证据要求

1. 在 web profile 创建一个会触发权限请求的工具调用，记录 session/event 原始载荷。
2. 在同一会话调用 `ask_user_question` 和 `request_user_input` 各一次。
3. 同时检查 `dsh-notify-bell` 分类日志、SSE/WebSocket 事件和前端通知状态。
4. 验收条件：前端分别收到 permission 和 question 通知，且不依赖微信/飞书通道是否开启。

## 预计修复位置

- 先在 `dsh-notify-bell/src/events.js` 与 `src/sse.js` 对照真实事件字段，确认事件是否被归一化或转发丢失。
- 再检查前端订阅过滤和 profile bundle 的版本是否一致。
- 修复后为 approval 和两种 question tool 各增加一条前端事件回归测试。

本次变更只登记该缺陷；没有把前端修复标记为完成。
