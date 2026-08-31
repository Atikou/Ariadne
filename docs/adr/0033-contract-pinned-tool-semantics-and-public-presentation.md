# ADR-0033：固定 Tool 模型语义与公开静态展示

- 状态：Accepted
- 日期：2026-08-29

## 背景

第一方 Tool 的执行 schema、权限、生命周期和实现工件已由 immutable Catalog 固定，但 Provider 请求仍从 `toolName/toolVersion` 临时合成描述，Renderer 也只能按名称显示通用活动。这使模型语义、执行合同和产品展示可以分别漂移，并诱导 UI 建立按名称分支的第二份 Tool catalog。

Tool input 和 result 属于受保护 Agent Control 边界，不能为了展示便利直接复制到 Public Projection。

## 决策

Tool contract document 升级为 V2，并要求每个家族在注册边界声明：

- 有界、受信的 model `description` 和 `guidance`；
- 可公开的静态 `kind` 和 `label`；
- 固定为 `protected` 的 result visibility。

这些字段与 schema、permission、scope/lifecycle 和 implementation artifact digest 一起进入 contract digest。Inference descriptor V2 只使用合同中的 model semantics 构造 Provider Tool description，不再从名称合成语义。

Immutable Catalog Registry 只用 complete pinned Tool identity 解析展示元数据。Projection 端口不依赖 control layer 合同，只接收裁剪后的 public-static `kind/label`。Public Projection 不携带 `resultVisibility`、Tool input 或 result；Renderer 直接显示这份静态意图，历史 Catalog 不可用时才降级为 `toolName`。

## 后果

- 修改模型描述、guidance、kind 或 label 会像修改 schema/实现一样导致 contract/catalog digest 漂移。
- Provider request、Runtime activity projection 和 Renderer 标题使用同一 immutable pin，不再存在中央 tool-name 映射。
- 结果正文仍由受保护 Effect result owner 持有。终态 Effect 只把 `detailAvailable` 和固定 kind/label 发布到 Public Projection；Renderer 点击后必须用 Run/Workspace/effect owner 通过只读命令分页获取，read/search/diff/terminal 详情不得复制进公开投影。
- 当前第一方 Catalog 升级为 revision 18，36 个 Tool 的实现工件与 V2 合同共同固定。

## 验证

- compiler 测试覆盖 description/guidance 上限、protected-only visibility 与 digest 漂移；
- Catalog/Registry 测试覆盖 complete pin 解析和任一 identity 漂移的 `null` 降级；
- exact engine 测试证明 Provider 只收到受信描述/guidance；
- Public Projection 和 Renderer 测试证明只发布/消费 kind/label，不暴露 input/result。
