# canvas-note

Canvas Note 将 Pi 生成的文字、图表和公式展示为浏览器中的纸张式文档，并把多选内容的回复交回 Pi。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
```

## 快速开始

让 Pi 创建一份包含 Markdown、ECharts 图表和 LaTeX 公式的报告。文档固定保存到当前项目的 `docs/canvas-notes/<UTC时间>-<UUID>/doc.json`，重载后沿用同一文档。首次插入内容时启动服务，工具返回访问地址和 JSON 文件路径。

服务运行时，Pi 状态栏显示 `Canvas Note: <URL>`；服务关闭后自动清除。网页顶部和浏览器标题显示与文档目录名一致的时间戳和 UUID。远端访问地址通过环境变量指定，不写入配置文件：

```sh
CANVAS_NOTE_PUBLIC_HOST=192.0.2.10 pi
```

SSH 环境未设置该变量时，启动检查显示一次警告，提示配置可访问地址或使用端口转发。

网页使用居中的 60% 宽纸面。勾选 Block 左上角选择框，在顶部点击“回复”，提交针对多个内容块的反馈。

点击网页的“Close server”按钮，弹窗确认后停止服务。关闭最后一个 Canvas Note 网页后，服务在 1.5 秒内自动停止；刷新或立即重连保留服务。关闭网页前由浏览器请求确认，提示需先与页面交互。

关闭服务保留文档，下次插入或更新时重新启动。公式、图表和 Markdown 渲染资源随扩展安装，浏览器无需访问 CDN。

## 文档

- [使用](docs/usage.md)
- [配置](docs/configuration.md)
- [架构](docs/architecture.md)
