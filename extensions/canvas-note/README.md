# canvas-note

Canvas Note 将 Pi 生成的文字、图表、公式和代码展示为浏览器中的纸张式文档，并把多选内容的回复交回 Pi。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

```text
/canvas-note 分析当前项目架构，并绘制模块关系图
/canvas-note-server
```

`/canvas-note <msg>` 将请求交给 Canvas Note 工具处理；不带参数时先询问需求。`/canvas-note-server` 启动或复用当前会话的画布服务，地址只显示在状态栏；恢复会话后沿用原文档，空会话展示空画布。更新安装后运行 `/reload` 加载命令与模板。

让 Pi 创建一份包含 Markdown、ECharts 图表和 LaTeX 公式的报告。文档固定保存到当前项目的 `docs/canvas-notes/<UTC时间>-<UUID>/doc.json`，重载后沿用同一文档。首次插入内容时启动服务，工具返回访问地址和 JSON 文件路径。

服务运行时，Pi 状态栏显示 `Canvas Note: <URL>`；服务关闭后自动清除。网页顶部和浏览器标题显示与文档目录名一致的时间戳和 UUID。远端访问地址通过环境变量指定，不写入配置文件：

```sh
CANVAS_NOTE_PUBLIC_HOST=192.0.2.10 pi
```

SSH 环境未设置该变量时，启动检查显示一次警告，提示配置可访问地址或使用端口转发。

网页采用 Gruvbox 深色配色、衬线标题、等宽工具栏和细网格背景，纸面居中且随屏幕宽度自适应。左侧固定目录可切换 Structure（页与内容块）和 Outline（正文标题大纲），支持整体收展、层级折叠、全部展开或折叠和内容跳转。独立的 `theme.json` 管理配色，修改后刷新网页生效。图表默认采用 Gruvbox 暖色主题，打印时自动切换浅色纸面配色；图表中显式指定的样式优先。勾选页左上角“Select page”或 Block 左上角选择框，在顶部点击“回复”。页独立选择，支持多页及与 Block 混选。

使用 `update_page({ pageId, change: { kind: "rename", title: "新标题" } })` 重命名页，或 `update_page({ pageId, change: { kind: "delete" } })` 删除整页及其全部内容。页修改同步正在运行的网页，不启动服务。

点击顶部“Export”，选择“Save PDF”在浏览器打印窗口保存 PDF，或选择“Save HTML”下载单文件网页。HTML 内嵌样式、字体、图片和 ECharts，离线打开保留目录跳转、目录折叠和图表交互；两种格式均导出全部页面正文，移除回复等在线操作控件，PDF 隐藏目录。

点击网页的“Close server”按钮，弹窗确认后停止服务。关闭最后一个 Canvas Note 网页后，服务在 1.5 秒内自动停止；刷新或立即重连保留服务。关闭网页前由浏览器请求确认，提示需先与页面交互。

代码块使用 `{ type: "code", spec: { code: "const answer = 42;", language: "javascript" } }` 插入，只读展示，不执行代码。显式指定受支持的语言时使用 Gruvbox 配色高亮；省略语言、空语言或未知语言均按纯文本展示，代码也可为空。

关闭服务保留文档，下次插入或更新时重新启动。公式、图表、Markdown 和代码高亮资源随扩展安装，浏览器无需访问 CDN。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
