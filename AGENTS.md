# Memory（zotero-memory）开发与协作规范

本文档汇总作者在实际开发中对 AI / 协作者的全部硬性要求。  
任何新会话、新工具、新模型，**先读完本文再动手**。冲突时以本文为准；临时口头指令可覆盖单次任务，但不要默默改掉规范本身。

---

## 1. 项目身份

| 项 | 值 |
| --- | --- |
| 仓库 | `JiangShuguo/zotero-memory` |
| 插件名 | Memory |
| 作者 / 唯一维护者 | JiangShuguo（插件内可写 `jsg`） |
| 插件 ID | `memory@jsg.local` |
| 兼容 | Zotero 7.x – 10.* |
| 源码根目录 | `memory/`（TypeScript → esbuild IIFE → XPI） |

- 不要添加 Cursor、协作者或其他人为作者、contributor、Co-author（除非用户当场明确要求）。
- GitHub 上能用英文的地方用英文；面向作者本人的对话用中文。

---

## 2. 沟通方式

- 直接、简短；不要复述任务、不要「我来继续…」式开场。
- 长回答先给结论；少用加粗；无关失败路径不要展开。
- 用户用中文提需求 → 用中文回复；给用户审阅的**插件内文案**用中文；给 GitHub 的公开说明用英文。
- 拿不准版本号或发行文案时：**先提出建议请用户确认，再打包发布**。不要自行定稿就发。

---

## 3. 本地优先与发布许可（最重要）

默认工作模式是 **local-first**：

1. 改代码 → 本地构建 → 用户自己装 XPI 验证。
2. **未经用户明确同意，禁止**：`git push`、创建/删除 GitHub Release、改远程 tag、把仓库设为公开以外的敏感操作。
3. 用户说「发布」「发新版本」「帮我发布」等 → 才允许：改版本号、写 changelog、commit、push、`gh release create`。
4. 用户只说「修好」「改一下」「本地试试」→ **只做到本地可测**，并明确「需要发版再说一声」。
5. 发版后应确认：**本地 `main` 与 GitHub `origin/main` 提交一致**；Release 资源与 `updates.json` 指向一致。

撤回 / 重发：

- 发错了可以删 Release / tag 再重发；**删掉错误版本后，下一个正式号不要无故跳号**（例如删了错误的 1.5.5 后应仍发 1.5.5，而不是直接 1.5.6），除非用户另有指定。
- 撤回后若更新检查仍显示旧「可安装」版本：优先查 CDN/缓存与「可安装」状态是否未重新校验，而不是只改文案糊弄。

---

## 4. 仓库卫生

- **只保留与插件相关的内容。** 设计稿 HTML、预览页、临时诊断脚本、测试笔记、实验目录不要进仓库，也不要上传到 Release。
- 测试 / 设计 / 临时文件：本地可建，测完删除；已进 git 的要清掉并推送清理提交（仅在用户要求推送时推）。
- **XPI 规则：**
  - 永远不要提交 `*.xpi`（已在 `.gitignore`）。
  - 本地测试 XPI **只放在** `memory/build/`，不要放仓库根目录或其他目录。
  - **测完删除** `memory/build/` 下的 XPI；发版上传完成后同样删掉本地构建产物。
  - 发版资产从 `memory/build/` 直接上传，不要先拷到根目录。
- 不要把 `notes-*.md`、`memtest/`、`design/`、prefs 预览 HTML 当正式交付物。

---

## 5. 版本号与构建

- 版本格式：`X.Y.Z`（semver）。补丁修 bug → 改 Z；小功能 → 改 Y；大改 → 改 X（与用户确认）。
- 改版本用：`memory/tools/set_version.py X.Y.Z`（同步 `package.json` / lock / `build_xpi.py` 默认 VERSION）。
- 构建：`cd memory && npm run build`（或 `python tools/build_xpi.py`）。
- **产物文件名必须带版本号**：`memory/build/memory-{VERSION}.xpi`  
  例：`memory-1.5.10.xpi`。历史 Release 与今后发布一律如此；代码里下载链接、`updates.json` 的 `update_link` 必须指向带版本号的文件名。
- 同步更新（发版时）：
  - `memory/updates.json` → 最新版本与 `update_link`
  - `memory/addon/content/changelog.json` → 插件内日志
  - `memory/addon/manifest.json`（构建时写入）
  - 必要时 `README.md` / `README.zh-CN.md` 中的版本说明

---

## 6. 发行说明与语言分区

| 位置 | 语言 | 要求 |
| --- | --- | --- |
| 插件内 `changelog.json` | **中文** | 用户可见； bundled 副本优先于远程，防止 CDN 旧英文盖掉中文 |
| GitHub Release body | **英文** | 简洁；标题如 `Memory X.Y.Z` |
| `README.md` | 英文 | 主文档 |
| `README.zh-CN.md` | 中文 | 与英文结构对应 |

Changelog 文案：

- **短、正式、只写用户能感知的变化。**
- 不要写实现细节、内部重构、CDN/缓存技术债、诊断过程、对作者自己的提醒。
- 用户明确说「这条不重要 / 不用写」→ 删掉，不要塞进正式日志。
- 分类常用：`added` / `changed` / `fixed`（与现有 JSON 一致）。
- 发版前把拟用中文条目 + 英文 Release 草稿给用户确认（用户若已给出最终文案则照抄）。

---

## 7. 更新检查与安装行为（产品约定）

- 有更新时：**提示 + 用户点击安装**（类似 Style），不要静默自动安装。
- 仅在确实有更新时显示安装按钮；文案简洁，少重复版本号；进度用**真实百分比**，不要假进度条。
- 「当前版本 / 最新 / NOW / NEW」类标记要清晰；装完后偏好设置应留在 Memory 面板，不要无故跳回「常规」。
- 版本判定：**以 GitHub（raw / releases / API）为准**；jsDelivr 等 CDN 仅作回退。CDN 可能缓存已撤回版本 → 信任源优先，必要时 purge，并在 UI 安装前重新校验「是否仍可更新」。
- 插件内 changelog 合并时：**本地（XPI 内）中文优先于远程**。

---

## 8. UI / 文案与交互偏好

- 插件 UI 文案用**规范中文**（书面、克制），不要口语堆砌或营销腔。
- 按钮文案不要无意义省略号（用户反感「…」装饰）。
- 偏好设置与批量导入导出：弹层要盖在偏好窗口之上，不能沉到后面点不到；导出/导入必须真正可用。
- 批量界面：尽量整行可点（展开/收起/选中），不要强迫用户只点小三角或小方框。
- 匹配结果展示保持克制（例如文件名 + 匹配/未匹配），不要堆多余字段。
- 改视觉/交互前，若用户只要「修行为」，不要顺手大改无关样式。

---

## 9. 编码与改动范围

- 只改完成任务所需的文件；不做无关重构、不顺手「清理」大片格式、不乱加文档。
- 不擅自新增 README/规范文件，除非用户要求（本 `AGENTS.md` 即用户要求的产物）。
- 保持与现有栈一致：Bootstrap 插件、`memory/src` TypeScript、esbuild 打包、`tools/build_xpi.py` 打 XPI。
- 修复阅读器/页边卡片类 bug 时注意：多标签、关闭标签、导入后会话、dead object；按会话隔离错误，避免误毁仍存活的 session。
- Windows + PowerShell 环境下注意：不要用 bash heredoc；`gh` / `git` 命令按 PowerShell 语法书写。

---

## 10. 标准发版清单（用户下令「发布」后执行）

按顺序：

1. 与用户确认版本号 + 中文 changelog 条目 + 英文 Release 说明（若尚未确认）。
2. `python tools/set_version.py X.Y.Z`
3. 更新 `changelog.json`、`updates.json`（及必要 README）。
4. `npm run build` / `build_xpi.py` → 得到 `memory/build/memory-X.Y.Z.xpi`
5. 本地可先请用户装包验证（若用户要求跳过测试则按其要求）。
6. `git add` 相关文件 → commit（信息简洁说明「为什么发这版」）→ `git push origin main`
7. `gh release create vX.Y.Z memory/build/memory-X.Y.Z.xpi --title "Memory X.Y.Z" --notes "..."`  
   资产名必须是 `memory-X.Y.Z.xpi`。
8. 确认 GitHub Latest = 该版本；`updates.json` 的 link 可下载；本地 HEAD == `origin/main`。
9. 删除本地 `memory/build/*.xpi`；需要时 purge jsDelivr 上 `updates.json` / `changelog.json`。
10. 回复用户：版本号、Release 链接、本地与远程是否一致。

---

## 11. 明确禁止

- 未经允许 push / 发 Release / 删别人的远程历史。
- 把设计预览、测试垃圾、根目录 XPI 推进仓库或挂到 Release。
- 用英文覆盖插件内用户可见更新日志。
- 在 changelog 里写用户说「不用写」的条目。
- 发布资产仍使用无版本号的 `memory.xpi`。
- 假进度、静默强更、发版后不管 GitHub 与本地是否一致。
- 把 AI 工具或无关第三方写成作者。

---

## 12. 给「下一个 AI」的最短操作备忘

```text
1. 读 AGENTS.md
2. 默认只改本地，构建到 memory/build/memory-{ver}.xpi，测完删除
3. 用户说「发布」才 bump + changelog(中) + Release(英) + push + gh release
4. XPI 文件名永远带版本号；发完核对 GitHub == 本地
5. 仓库保持干净；changelog 短而正式；UI 中文、文档英文为主+中文版 README
```

---

## 13. 关键命令

```text
cd memory
npm install
python tools/set_version.py X.Y.Z
npm run build
# 产物: build/memory-X.Y.Z.xpi

# 仅在用户要求发布时：
git push origin main
gh release create vX.Y.Z build/memory-X.Y.Z.xpi --title "Memory X.Y.Z" --notes "..."
```

更新检查权威 URL 形态（构建写入）：

- `updates.json` →  
  `https://github.com/JiangShuguo/zotero-memory/releases/download/v{VERSION}/memory-{VERSION}.xpi`
