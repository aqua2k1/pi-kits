# 使用

## ask_user_question

工具向用户收集一组相关问题的回答；模型调用参数示例：

```json
{
  "questions": [
    {
      "question": "<请选择方案>",
      "multiSelect": false,
      "options": [
        { "label": "<方案甲>", "description": "<方案甲说明>" },
        { "label": "<方案乙>" }
      ]
    }
  ]
}
```

| 参数 | 说明 |
|---|---|
| `questions` | 本次问卷的问题 |
| `question` | 问题正文 |
| `options` | 候选选项；自定义回答入口由工具添加 |
| `label` | 选项文字 |
| `description` | 可选的选项说明 |
| `multiSelect` | 设为 `true` 收集多选回答；默认 `false` |

参数与结果契约、校验规则见 [core.ts](../core.ts)。工具按顺序执行；[入口](../index.ts)在每轮代理开始前依据界面可用性更新活动工具列表。

### 终端交互界面（TUI）

```text
↑/↓ 选择 <方案甲> → Enter 确认 → Submit 页 → Enter 提交
```

| 操作 | 结果 |
|---|---|
| Tab / Shift+Tab | 切换问题与 Submit 审阅页，保留选项位置、勾选和自定义草稿 |
| ↑ / ↓ | 移动选项；审阅页切换 Submit、Cancel 按钮 |
| Space | 多选题切换当前选项的勾选；自定义输入中输入空格 |
| Enter | 确认当前题并前进；审阅页执行当前按钮 |
| PgUp / PgDn | 在审阅页浏览已答或待答问题 |
| Shift+↑ / Shift+↓ | 滚动长题目或当前选项说明 |
| ← / → | 在自定义回答中移动光标 |
| Esc / Ctrl+C | 取消问卷，保留已确认答案 |

选择 Custom answer 行后输入自定义回答；该回答替代本题的勾选回答。修改草稿或选项后按 Enter 才更新已确认答案；全部问题确认后，Submit 按钮完成提交。Cancel 按钮随时结束问卷。

全屏终端模式下可点击标签和审阅按钮，滚轮由宿主滚动上方会话记录；常规终端模式使用键盘。布局与停靠行为见[共享 UI](../../../shared/docs/ui.md)。

### 远程调用界面（RPC）

RPC 按问题顺序显示原生选择框或输入框，回答完最后一题即返回结果。

```text
1,2
text: 123
```

单选题通过选择框选取选项或 Type something. 自定义入口；多选题通过输入框输入选项编号（逗号或空格分隔）或自定义文字，纯数字自定义文字使用 `text:` 前缀。空输入与无效数字选择会重新询问；关闭对话框取消问卷。

### 结果

结果同时放入 `details` 和 `structuredContent`；字段定义见 [core.ts](../core.ts)。

| 字段 | 含义 |
|---|---|
| `answers` | 按问题顺序排列的已确认答案 |
| `cancelled` | 用户取消时为 `true` |
| `kind` | `option` 为单选、`custom` 为自定义、`multi` 为多选 |
| `questionIndex`、`optionIndex`、`optionIndices` | 从零开始的问题或选项索引；区分重复标签 |
| `selected` | 多选回答的标签，按选项顺序保留重复标签 |
| `answer` | 回答文字；多选标签以逗号和空格连接 |

取消时工具文本为 `User cancelled`，结构化结果仍保留已确认答案；未确认草稿不计入答案。

### 事件

`pi.events` 是扩展发送生命周期消息的事件总线；问卷事件定义见 [events.ts](../events.ts)，发送路径见 [index.ts](../index.ts)。

| 事件 | 时机 |
|---|---|
| `workflow:ask-user-question:start` | 进入对话交互前 |
| `workflow:ask-user-question:end` | 回答、取消、中止或交互错误后 |

开始事件携带调用标识、界面模式和题数；结束状态为 `answered`、`cancelled`、`aborted` 或 `error`，前两者携带结果。无界面或交互前已中止的调用直接抛错。

TUI 入口还转发共享面板生命周期回调，面板标识为 `ask-user-question`，实例标识为工具调用 ID；共享事件语义见[共享 UI](../../../shared/docs/ui.md)及[事件定义](../../../shared/ui/docked-panel/events.ts)。正常打开时顺序为问卷开始、面板打开、面板关闭、问卷结束。

TUI 开始交互时按[配置](configuration.md)发送等待回答通知；RPC 仅发送问卷事件。
