# Hermes-Agent 源码教程（独立仓库）

从入门到精通的 [hermes-agent](https://github.com/NousResearch/hermes-agent) 系统性代码教程 —— 中文，架构精读版。

> **关于源码仓库**：本仓库**不 fork** 源码仓库。上游 `NousResearch/hermes-agent` 以 **git 子模块** 链接挂在本仓库 `source/` 路径下（只读引用），教程中的文件路径、行号均对应上游 `main` 分支（见子模块指针）。

## 内容一览

- **122 篇文档 / 约 2.5 万行**，覆盖约 2,600 个产品源文件：核心承重文件逐一精讲（真实代码走读 + 行号出处），其余文件全部纳入各模块清单表。
- 17 个模块：背景知识、系统架构专题、核心门面层、agent 核心循环、工具系统、消息网关、命令行层、状态持久化、TUI 网关、插件系统、定时任务、包管理、技能系统、平台事实层、ACP 适配器、TypeScript 端、开发实践。

## 在线阅读

GitHub Pages：https://jigangbo.github.io/hermes-agent-tutorial/

## 本地构建

```bash
pip install mkdocs mkdocs-material mkdocs-awesome-pages-plugin jieba
mkdocs serve     # 本地预览 http://127.0.0.1:8000
mkdocs build     # 产物输出到 site/
```

## 克隆（含源码子模块，可选）

```bash
git clone https://github.com/jigangbo/hermes-agent-tutorial.git
cd hermes-agent-tutorial
git submodule update --init --depth 1   # 需要对照源码时才拉取
```

不初始化子模块也能完整阅读教程 —— 所有文档自带代码摘录与行号出处。

## 推荐入口

1. [背景知识](tutorial/00_background_knowledge.md) → [阅读指南](tutorial/00_reading_guide.md)
2. [全局架构总览](tutorial/01_architecture/big_picture.md) → [一次对话的完整生命周期](tutorial/01_architecture/turn_lifecycle.md)
3. [提示词缓存不变量](tutorial/01_architecture/caching_invariants.md) —— 全项目最重要的设计
