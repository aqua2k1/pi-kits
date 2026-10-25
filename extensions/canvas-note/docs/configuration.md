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

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CANVAS_NOTE_PUBLIC_HOST` | 监听地址；监听所有网卡时使用 `localhost` | 覆盖工具结果和状态栏 URL 的主机部分；支持 IP 或域名，不含协议、路径和端口；不改变监听地址、不写入配置文件，每次启动服务时读取；SSH 环境未设置时，会话启动检查显示一次警告，服务仍可启动 |

```sh
CANVAS_NOTE_PUBLIC_HOST=192.0.2.10 pi
```
