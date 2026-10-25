# 展示站

Subagent 与 Canvas Note 的静态介绍页，包含使用场景、架构概览、安装入口和明确标注的演示占位。无构建依赖。

## 本地预览

在仓库根目录执行：

```sh
python3 -m http.server 8080 --directory site --bind 127.0.0.1
```

打开 http://127.0.0.1:8080/。页面资源使用相对路径，同时适用于 Pages 项目子路径。

## 发布

在仓库根目录使用 GitHub CLI 启用 Actions 发布源（只需执行一次）：

```sh
gh api --method POST repos/aqua2k1/pi-kits/pages -f build_type=workflow
```

提交并推送站点与工作流到 main 后，Pages 工作流自动发布；已存在的站点使用 PUT 更新发布源。查看状态：

```sh
gh run list --workflow pages.yml
gh api repos/aqua2k1/pi-kits/pages --jq '.html_url'
```

工作流仅上传 site 目录。页面不调用本地插件服务。README 随静态文件一起公开，不在此目录存放会话数据或敏感素材。

## 内容维护

- index.html：产品文案、架构示意、演示占位和文档链接。
- styles.css：Gruvbox 配色、响应式布局和焦点样式。
- 演示录制完成后替换对应 figure，保留文字说明；架构变更时同步插件文档。
