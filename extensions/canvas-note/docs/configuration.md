# 配置

配置位置：`<agent-dir>/pi-kits.json`，配置键 `canvas-note`；修改后 `/reload` 生效。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 注册三个内容工具 |
| `host` | string | 自动选择 | 省略时，检测到 `SSH_CONNECTION`、`SSH_CLIENT` 或 `SSH_TTY` 则监听 `0.0.0.0`，本地监听 `localhost`；显式值覆盖自动选择 |
| `portRange` | [integer, integer] | `[10000, 20000]` | 包含上下界的端口区间，端点范围 1–65535；从随机起点寻找空闲端口，全部占用时报错 |

## 示例

```json
{
  "canvas-note": {
    "enabled": true,
    "portRange": [10000, 20000]
  }
}
```

字段校验规则见 [JSON Schema](../../../pi-kits.schema.json)。

## 网页配色

配色资源位置：`extensions/canvas-note/theme.json`（扩展安装目录内）。修改后刷新网页生效，无需 `/reload`。各键均为字符串，接受 `#RGB`、`#RGBA`、`#RRGGBB`、`#RRGGBBAA`；省略或无效的值沿用默认配色，JSON 损坏或文件缺失时整页沿用默认配色。

| 键 | 默认值 | 说明 |
|---|---|---|
| `background` | `#ebe7e4` | 网页背景 |
| `surface` | `#f3f2f0` | 纸面、工具栏和弹窗 |
| `text` | `#252f3d` | 正文与标题 |
| `muted` | `#5c5752` | 辅助文字和占位提示 |
| `accent` | `#4b607c` | 链接、主按钮、选中边框与焦点环 |
| `accentHover` | `#354961` | 主按钮悬停背景 |
| `onAccent` | `#ffffff` | 主按钮文字 |
| `border` | `#8b847d59` | 分隔线与边框 |
| `success` | `#47745b` | 已连接指示灯 |
| `warning` | `#98642f` | 连接中指示灯与反馈提示 |
| `error` | `#a04736` | 断连指示灯与渲染错误 |

```json
{
  "background": "#ebe7e4",
  "surface": "#f3f2f0",
  "text": "#252f3d",
  "muted": "#5c5752",
  "accent": "#4b607c",
  "accentHover": "#354961",
  "onAccent": "#ffffff",
  "border": "#8b847d59",
  "success": "#47745b",
  "warning": "#98642f",
  "error": "#a04736"
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
