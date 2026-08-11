<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、能够在证据和安全边界内持续优化自身 harness 的轻量 Agent 项目。

当前仓库处于 **v0.2.0 架构与工程化设计基线**：提供可编译的 Node.js + TypeScript 工程、稳定品牌接口，以及面向 Agent 生命周期、合同、质量评测、可观测运行、发布供应链和治理的设计边界；尚未实现 Agent 运行时、模型接入或自主修改能力。

## 设计方向

- 根据语言、框架、仓库规模、任务类型和质量门槛生成项目画像。
- 为每个项目组合最小必要 harness，避免把单一重型框架套用到所有场景。
- 通过可回放评测、隔离实验、审计记录和回滚机制控制自我进化。
- 从官方文档、代码仓库和包注册表发现候选框架，但绝不直接执行未经验证的网络内容。
- 保持核心零运行时依赖、无常驻守护进程，并按需加载未来适配器。
- 把 prompt、模型、工具 schema、记忆规则、评测集和 harness 配方作为可版本化、可评测、可回滚的工程产物。
- 以确定性质量门约束概率型模型行为，从设计、交付、发布、观测到事故响应形成闭环。

## 工程基线

- Node.js 22+
- TypeScript 5.9+
- ESM
- 零运行时依赖

```bash
npm install
npm run build
```

编译产物写入 `dist/`，包括 ESM JavaScript、类型声明和 source map。

## 项目边界

```text
src/       核心包；只放与交互界面无关的领域合同和运行逻辑
tui/       未来终端界面适配器；当前只有边界说明
webui/     未来 Web 界面适配器；当前只有边界说明
```

`src/` 不能导入 `tui/` 或 `webui/`。未来两种界面都将消费由核心拥有的同一套类型化命令和事件协议：TUI 可通过进程内适配器连接，WebUI 可通过 HTTP 加 SSE/WebSocket 连接。当前版本没有可运行界面，也没有引入 Ink、React、Vite 或服务端依赖。

当前唯一代码级公共接口仍是 `ALPHION_BRAND`；Agent、SubAgent、记忆、进化和 UI 协议仍处于设计阶段。

## 品牌资产

| 用途 | 文件 |
| --- | --- |
| 主系统 Logo | `alphion-logo.svg` |
| 图标 | `alphion-icon.svg` |
| 文字标识 | `alphion-wordmark.svg` |

代码通过 `ALPHION_BRAND` 暴露稳定、只读的品牌名称、定位与资产角色。

## 许可

[Apache License 2.0](./LICENSE)
