# Zotero Memory

在 [Zotero](https://www.zotero.org/) PDF 页边阅读并修改批注评论，内容写回 Zotero 原有批注字段。

[English](README.md)

| 项目 | 说明 |
| --- | --- |
| 版本 | 1.5.12 |
| 作者 | jsg |
| 兼容 | Zotero 7.x – 10.* |
| 许可证 | MIT |

---

## 用途

批注评论通常集中在阅读器侧栏。Memory 把它们放在当前 PDF 页两侧，阅读时可以直接查看和修改，少切换视线。

---

## 行为说明

### 页边卡片

对每条可见且有评论的批注（便签，或临时固定显示的批注也会显示），Memory 会在左或右页边绘制一张卡片，并用短引线连到原文标记。

| | |
| --- | --- |
| 卡片边框 | 四边使用批注颜色 |
| 位置 | 靠近批注；按标记在页面上的位置决定左右 |
| 溢出 | 单侧放不下时，在页边列内滚动查看其余卡片 |
| 低缩放 | 缩放低于 80% 时，非编辑状态的卡片收成单行 |

### 阅读与编辑

| | |
| --- | --- |
| 较短评论 | 卡片高度随内容变化 |
| 较长评论 | 最高约九行，超出部分在卡片内滚动 |
| 滚动条 | 细条，颜色与批注一致；闲置时偏暗，滚动时变亮 |
| 单击 | 进入原地编辑 |
| 颜色按钮 | 在编辑工具栏末尾，用于切换批注颜色 |
| 拖动 | 选中文字以便复制（Ctrl/Cmd+C） |
| 自动保存 | 停止输入约 700 ms 后保存 |
| 立即保存 | Ctrl/Cmd+Enter |
| 取消 | Esc 恢复上次已保存文本 |
| 格式工具栏 | 仅在正在编辑该卡片时显示 |

支持的格式：加粗、斜体、下划线、删除线、上标、下标、字号 11 / 13 / 15 / 18、无序列表、清除格式。

编辑时的快捷键：Ctrl/Cmd+B / I / U 对应加粗、斜体、下划线；Ctrl/Cmd+A 全选评论。预览状态下 Ctrl/Cmd+A 全选卡片文字，Ctrl/Cmd+C 复制选中内容。

### 与阅读器的配合

| | |
| --- | --- |
| 工具栏按钮 | 显示或隐藏全部页边卡片 |
| 右键菜单 | 对选中的批注使用 **页边标注** |
| 悬停 | 悬停卡片时高亮页内对应批注 |
| 选中 | 选中批注时高亮对应卡片 |
| 原生弹窗 | 新建评论时使用；已有页边卡片后隐藏 |
| 偏好设置 | 选择要显示的批注类型；显示当前版本、检查更新并查看更新日志 |
| 导出 / 导入 | 条目右键可备份单个 PDF；偏好设置中可按分类勾选 PDF 批量导出，或多选备份 JSON 按文件名/题名匹配导入。同一文件直接还原；文件不一致时按文本重新定位，无法定位的批注在导入前列出 |

评论写入 Zotero 的批注评论字段。

---

## 安装

1. 从 [Releases](https://github.com/JiangShuguo/zotero-memory/releases) 下载 `memory-x.y.z.xpi`，或本地构建：

```text
cd memory
npm install
npm run build
```

需要 Node.js 18+ 与 Python 3.8+。输出：`memory/build/memory-<version>.xpi`。

2. Zotero → 工具 → 插件 → 齿轮 → **从文件安装插件…** → 选择该 XPI。
3. 启用 **Memory**，然后重启 Zotero。

升级后请重启一次 Zotero。

---

## 开发

```text
cd memory
npm install
npm run typecheck
npm run build
```

---

## 仓库结构

```text
memory/
  addon/           bootstrap、manifest、prefs、偏好界面、图标
  src/             TypeScript 源码（打包进 XPI）
  tools/           build_xpi.py
  updates.json     Zotero 更新清单
  build/           memory-<version>.xpi（已 gitignore）
```

---

## 许可证

MIT
