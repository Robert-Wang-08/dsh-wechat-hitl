# 飞书会话回信修正与验收记录

根任务：task-20261110T120055372408Z-9f713c8e9e01。原根任务已完成原因分析；用户随后明确授权 GPT-6.1-sol 独立复核后实施修正。本文记录该授权后续，不改写原分析契约或完成历史。

## 复核与结论

独立 worker 为 codex-relay/gpt-6.1-sol，effort=high，工具 subagent，无降级；先核实源码和历史运行错误，再独立复核最终 diff。确认普通绑定消息同时排队和 headless，后者因 ptc-multi-agent preset 不受 one-shot runner 支持而失败，调用方又忽略 type:error。

## 已修正

- 普通绑定与会话码消息统一队列路径，不再启动第二个 headless 回合。
- 去重键为通道、来源 chat ID、message ID，同一事务锁内查重与保存；拿不到锁或落盘失败明确拒绝。相同文字、不同 message ID 仍为不同指令。
- 入队和发送回执分开；回执发送失败不会伪称排队失败，不会因此重执行。
- daemon 区分排队、宿主接收及未确认/过期；超时不会自动取消或重放；投递失败不再假称已完成。
- 新插件仅对飞书请求跨进程 claim。成功接收才写 deliveredAt；异常记为未确认，不自动重试。进程在 claim 后退出需人工核对。该保证不覆盖旧宿主、微信网关或其他 CLI。
- 根据真实 user/message 的 rpcId 关联远程回合，短于 3 秒也发送最终结果，保留超过 900 字的正文；远程成功和异常通知均携带来源聊天，并贯穿发件箱至飞书出口。现有开关与长度设置继续生效。
- NDJSON 保留 type:error；/new 非零退出、超时或 preset 错误保持原绑定并报告实际错误。/new 的 preset 新建能力尚未实现。
- daemon drain 串行；重启脚本不再将 spawn-failed 心跳误报为启动成功，需本次新实例、心跳新鲜且 inbound=running。

## 验证

修复前，真实 daemon 入站函数的三个确定性回归均失败；修复后通过。最终完整八文件回归通过 105 项（含新增异常回复来源聊天断言），测试退出码 0；启动脚本 PowerShell 解析错误 0。完整输出保存在工作区 .ptc/tmp/feishu-relay-final-tests.log。测试入口：

```powershell
pwsh -NoProfile -File ./test/run-tests.ps1
```

测试状态隔离于 state-test，不向真实聊天发消息。独立 reviewer 实际运行纯内存入站 8/8 并检查 diff；会写测试状态的全套由主控运行。

## 当前生产限制

本会话内重启 daemon 的 WMI 调用被拒绝，Start-Process 回退所起入站子进程报 spawn EPERM。更宽权限申请没有返回执行结果；重新读取心跳仍为 spawn-failed，不能认定部署成功。3080 未重启，新插件尚未重新加载。没有完成真实飞书入站至最终回信验收，没有主动发送测试消息。

## 下一步唯一动作：在宿主维护窗口部署并验收

在独立宿主 PowerShell（非 DSH 受限工具进程）运行：

```powershell
pwsh -NoProfile -File D:/src/dsh/dsh-wechat-hitl/tools/restart-feishu-daemon.ps1 -Action restart
node D:/src/dsh/dsh-wechat-hitl/bin/fx-hitl.mjs status
```

确认新心跳、inbound=running、入站长连接连接日志。等待 3080 所有活动回合结束后，以既有运维入口安全重启宿主，新开会话加载插件。随后用户在飞书发送一条带唯一标记的新指令；核对只有一次宿主执行，准确接收回执，最终正文回原聊天且不丢尾部，异常回合同样回原聊天。

跨设备源码更新后无需重新 add 插件；重载流程相同。本次未改 profile 或凭据；源码尚未提交/推送。回滚仅恢复本次源码与测试/文档，之后同序重载；不要覆盖 state 或认证配置。
