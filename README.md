<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、能够在证据和安全边界内持续优化自身 harness 的轻量 Agent 项目。

当前仓库处于 **v0.1.0 架构基线**：只提供可编译的 Node.js + TypeScript 工程、稳定品牌接口和设计边界，尚未实现 Agent 运行时、模型接入或自主修改能力。

## 设计方向

- 根据语言、框架、仓库规模、任务类型和质量门槛生成项目画像。
- 为每个项目组合最小必要 harness，避免把单一重型框架套用到所有场景。
- 通过可回放评测、隔离实验、审计记录和回滚机制控制自我进化。
- 从官方文档、代码仓库和包注册表发现候选框架，但绝不直接执行未经验证的网络内容。
- 保持核心零运行时依赖、无常驻守护进程，并按需加载未来适配器。

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

## 品牌资产

| 用途 | 文件 |
| --- | --- |
| 主系统 Logo | `alphion-logo.svg` |
| 图标 | `alphion-icon.svg` |
| 文字标识 | `alphion-wordmark.svg` |

代码通过 `ALPHION_BRAND` 暴露稳定、只读的品牌名称、定位与资产角色。

## 许可

[Apache License 2.0](./LICENSE)
