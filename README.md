<p align="center">
  <img src="./assets/wordmark.svg" width="360" alt="dsh-community-plugins">
</p>

<p align="center">
  <strong>发现社区插件，拓展 DeepSeek Harness 的能力。</strong><br>
  从搜索、安装到更新与管理，在设置页轻松完成。
</p>

<p align="center">
  <a href="https://github.com/funcodingdev/dsh-community-plugins/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/funcodingdev/dsh-community-plugins/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;color=18181b"></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-18181b?style=flat-square"></a>
  <img alt="Node.js 22.19+ or 24+" src="https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-18181b?style=flat-square">
</p>

<p align="center">
  <a href="./README.en.md">English</a> ·
  <a href="https://dshpluginhub.com/">访问插件网站</a> ·
  <a href="https://github.com/funcodingdev/dsh-community-plugins/issues">反馈问题</a>
</p>

![DeepSeek Harness 社区插件：搜索、分类筛选与安装](./assets/community-plugins-preview.png)

## 主要功能

- **发现插件**：按名称、作者或功能搜索，按分类浏览，支持仅看已验证插件。
- **灵活排序**：按推荐、最近更新或最多 Stars 排序，快速找到感兴趣的插件。
- **流畅浏览**：卡片列表自动加载更多，搜索框和分类始终固定在顶部。
- **集中管理**：安装、更新、卸载、启用或停用插件，已安装页面同样支持搜索和分类筛选。
- **任务进度**：查看安装与更新进度，取消任务或重试失败操作。
- **兼容与恢复**：安装前检查兼容性，支持操作失败后的回滚恢复。
- **中英界面**：跟随 DeepSeek Harness 的语言设置自动切换。

## 安装

先安装 DeepSeek Harness，并确保终端可以运行 `dsh` 和 `pnpm`。

执行以下命令，将社区插件管理器安装到 Web profile：

```sh
dsh plugin --profile web add dsh-community-plugins
```

安装完成后，重启 DeepSeek Harness，打开 **设置 → 社区插件**。

在 **发现** 页面搜索并安装插件，在 **已安装** 页面更新和管理插件。

## 参与贡献

- 产品缺陷和功能建议请提交到[本仓库 Issues](https://github.com/funcodingdev/dsh-community-plugins/issues)。
- 新增或修改插件收录，请向 [`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins) 贡献。
- 欢迎提交 Pull Request。请保持改动聚焦，为行为变化补充测试，并在提交前运行 `npm run check && npm test`。

## 许可证

MIT © 2026 funcodingdev 与贡献者。参见 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
