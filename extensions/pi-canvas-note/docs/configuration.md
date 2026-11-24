# 配置

服务监听地址自动选择（检测到 `SSH_CONNECTION`、`SSH_CLIENT` 或 `SSH_TTY` 时监听 `0.0.0.0`，本地监听 `localhost`），端口从 `10000`–`20000` 升序分配。

## 网页配色

默认采用 Gruvbox 深色配色。

配色资源位置：`extensions/pi-canvas-note/theme.json`（扩展安装目录内）。修改后刷新网页生效，无需 `/reload`。各键均为字符串，接受 `#RGB`、`#RGBA`、`#RRGGBB`、`#RRGGBBAA`；省略或无效的值沿用默认配色，JSON 损坏或文件缺失时整页沿用默认配色。

| 键 | 默认值 | 说明 |
|---|---|---|
| `background` | `#1d2021` | 网页背景 |
| `surface` | `#282828` | 纸面、工具栏和弹窗 |
| `text` | `#ebdbb2` | 正文与标题 |
| `muted` | `#a89984` | 辅助文字和占位提示 |
| `accent` | `#fe8019` | 链接、主按钮、选中边框与焦点环 |
| `accentHover` | `#d65d0e` | 主按钮悬停背景 |
| `onAccent` | `#1d2021` | 主按钮文字 |
| `border` | `#665c54` | 分隔线与边框 |
| `success` | `#b8bb26` | 已连接指示灯 |
| `warning` | `#fabd2f` | 连接中指示灯与反馈提示 |
| `error` | `#fb4934` | 断连指示灯与渲染错误 |

```json
{
  "background": "#1d2021",
  "surface": "#282828",
  "text": "#ebdbb2",
  "muted": "#a89984",
  "accent": "#fe8019",
  "accentHover": "#d65d0e",
  "onAccent": "#1d2021",
  "border": "#665c54",
  "success": "#b8bb26",
  "warning": "#fabd2f",
  "error": "#fb4934"
}
```

代码块、网格和选择底色从以上配色派生；图表仍使用内容中的 ECharts 配色。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CANVAS_NOTE_PUBLIC_HOST` | 监听地址；监听所有网卡时使用 `localhost` | 覆盖工具结果和状态栏 URL 的主机部分；支持 IP 或域名，不含协议、路径和端口；不改变监听地址、不写入配置文件，每次启动服务时读取；SSH 环境未设置时，会话启动检查显示一次警告，服务仍可启动 |

```sh
CANVAS_NOTE_PUBLIC_HOST=192.0.2.10 pi
```
