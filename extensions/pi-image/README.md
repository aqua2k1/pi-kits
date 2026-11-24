# pi-image

接收 OpenAI / Codex Responses 服务端生成的图片，保存文件、显示终端预览，并通过响应引用编辑图片。

## 安装

```sh
pi install https://github.com/aqua2k1/pi-kits.git
pi config
```

启用 `pi-image` 和 `pi-server-tools`，选择支持生图的 OpenAI / Codex Responses 模型后正常对话：

```text
生成一张白底红圆图片。
```

`pi-server-tools` 注入生图工具；`pi-image` 接收结果并在支持图片的终端中显示预览，其他终端显示文件信息。
图片保存在 Pi 会话存储目录的 `images/<会话 ID>/` 中。会话只记录文件路径和响应元数据，不记录图片 base64；恢复会话时从文件重新显示。

## 编辑图片

```text
/image-edit 把红圆改成蓝圆，其他保持不变
```

命令使用当前分支中与当前模型匹配的图片；一张时直接编辑，多张时在交互界面选择。任务空闲时执行。
编辑使用原图片的响应引用，生成结果另存为新图片。引用失效时直接报告服务端错误，不回传原图或重新生成。
文件缺失时显示提示，已保存的其他图片保持不变。

## 文档

- [架构](docs/architecture.md)
