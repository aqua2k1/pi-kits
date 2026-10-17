# 架构

[index.ts](../index.ts) 收集会话快照，经 [report.ts](../report.ts) 一次生成报告，供终端面板和 HTML 使用；[core.ts](../core.ts) 负责扫描聚合。配置、停靠面板与桌面启动分别依赖[共享配置](../../../shared/config/README.md)、[共享 UI](../../../shared/docs/ui.md) 和[共享库](../../../shared/README.md)。

## 文件地图

| 文件 | 职责 |
|---|---|
| [index.ts](../index.ts) | 命令注册、扫描范围、进度和展示编排 |
| [core.ts](../core.ts) | 会话文件发现、逐行扫描、去重和聚合 |
| [report.ts](../report.ts) | 生成日历摘要、逐日统计及滚动时间段数据 |
| [calendar.ts](../calendar.ts) | 年度网格、日期用量与热力等级 |
| [tui.ts](../tui.ts) | 面板交互、年度缓存、布局和命中区域 |
| [html.ts](../html.ts) | 模板注入、临时快照写入和打开 |
| [template.html](../template.html) | 浏览器摘要、模型过滤、条形图和每日热力图 |
| [package.json](../package.json) | 扩展入口、资源名与测试脚本 |

## 数据流

1. 命令确定会话扫描范围；范围规则见[使用](usage.md#stats)（[index.ts](../index.ts)）。
2. 核心模块递归查找 JSONL 文件，逐行读取、去重并累计模型、日期和时间戳索引（[core.ts](../core.ts)）。
3. 报告模块从快照生成日历摘要、每日数据、模型列表及滚动窗口数据（[report.ts](../report.ts)）。
4. TUI 使用报告展示面板，按访问年份缓存日历网格；用户操作返回详情动作或取消（[tui.ts](../tui.ts)、[calendar.ts](../calendar.ts)）。
5. 详情动作或 RPC 路径把报告注入 HTML 模板、写入临时文件，再调用共享桌面启动器（[index.ts](../index.ts)、[html.ts](../html.ts)）。

## 约束

- 扫描多个文件共用去重集合，以记录身份和用量内容共同判重，避免分叉复制历史重复累计，同时保留同 ID 的不同贡献（[core.ts](../core.ts)、[测试](../core.test.ts)）。
- 日历日期键、报告的今日与本月以及年度网格都使用本地日期，年度遍历从本地正午开始，避免日期边界与夏令时转换错位（[core.ts](../core.ts)、[report.ts](../report.ts)、[calendar.ts](../calendar.ts)、[测试](../tui.test.ts)）。
- 日期无效的用量仍进入累计和模型统计，仅有效时间戳进入日期与时间段索引，以免日期解析失败丢失累计贡献（[core.ts](../core.ts)、[report.ts](../report.ts)）。
- TUI 和 HTML 使用同一次构建的报告，HTML 渲染不重算快照，保持终端摘要与打开的静态快照属于同一次统计（[index.ts](../index.ts)、[report.test.ts](../report.test.ts)）。
- 年度网格按年份缓存，普通重绘只读取缓存，避免每次按键或窗口变化重新计算全年用量（[tui.ts](../tui.ts)、[测试](../tui.test.ts)）。
- 面板失效、重绘和结束时清除旧命中区域，每次绘制重新读取主题，避免缩放后点击旧位置或保留旧主题颜色（[tui.ts](../tui.ts)、[测试](../tui.test.ts)）。
- 详情动作先结束面板，再由入口打开 HTML，以便共享面板清理完成后恢复编辑器（[tui.ts](../tui.ts)、[index.ts](../index.ts)、[测试](../tui.test.ts)）。
- HTML 注入保留模板占位符并转义 JSON 中的 HTML 特殊字符及行分隔符，避免数据提前结束嵌入脚本（[html.ts](../html.ts)、[模板](../template.html)）。
- 浏览器模板与核心模块保持全部模型标识 `__all__` 一致，模板读取报告中的模型、逐日与时间段字段，以维持过滤结果与聚合结果一致（[core.ts](../core.ts)、[report.ts](../report.ts)、[template.html](../template.html)）。

## 测试

在仓库根目录执行（脚本见 [package.json](../package.json)）：

```sh
npm test --workspace=pi-stats
```

- [core.test.ts](../core.test.ts)：模型与日期聚合、响应模型优先、去重、滚动窗口、递归扫描及进度。
- [report.test.ts](../report.test.ts)：本地日期摘要、空报告、HTML 使用预计算报告且不修改报告。
- [tui.test.ts](../tui.test.ts)：年度网格、闰日、尺寸、颜色、键鼠交互、缓存和面板清理。
- [html.test.ts](../html.test.ts)：报告序列化、时间段统计、独立 HTML、临时文件及打开失败。
- [index.test.ts](../index.test.ts)：取消流程、面板失败、交互前提与配置开关。
