# 抓取后读取的对照实验方法

日期：2026-10-07
结论：实验设计以实际 `read` 行覆盖检查完整审查，以检索调用和局部读取检查定点查询。

## 过程与数据

实验夹具与判定逻辑见[模型读取测试](../../fetch/model-read.test.ts)。

本地 HTTP 返回 4501 行记录，第 11、2301、4401 行含异常代码，第 2303 行含保留天数 37 与归档发票范围。

完整审查任务要求回答全部异常代码，断言累计 `read` 覆盖全部行；定点任务断言答案包含保留天数与范围、调用过 `grep`，且读取覆盖少于全文。

每个任务启动独立 Pi 进程，暴露 `web_fetch`、`read` 和 `grep`，测试过程观察工具调用，不追加提示或读取偏移。

从仓库根目录运行：

```sh
PI_KITS_MODEL_READ=1 \
PI_KITS_TEST_MODEL="<model-id>" \
PI_KITS_TEST_PROVIDER="<provider>" \
PI_KITS_TEST_THINKING=low \
PI_KITS_TEST_TOKENS="<code-a>,<code-b>,<code-c>" \
PI_KITS_TEST_EXTENSION="/<checkout>/extensions/web-kits/index.ts" \
node --import tsx --test extensions/web-kits/fetch/model-read.test.ts
```

| 环境变量 | 实验用途 |
|---|---|
| `PI_KITS_MODEL_READ` | `1` 启用真实模型实验 |
| `PI_KITS_TEST_PI` | Pi 可执行文件，默认 `pi` |
| `PI_KITS_TEST_MODEL`、`PI_KITS_TEST_PROVIDER` | 模型与服务；未设置时分别取 `PI_MODEL`、`PI_PROVIDER`，服务参数仅在指定模型时传递 |
| `PI_KITS_TEST_THINKING` | 推理级别，默认 `low` |
| `PI_KITS_TEST_TOKENS` | 三个逗号分隔的异常代码，默认随机生成 |
| `PI_KITS_TEST_EXTENSION` | 对照版本的扩展入口，默认当前扩展 |
| `PI_KITS_TEST_SCENARIO` | `full` 或 `targeted`，省略时运行两个任务 |

JSONL 事件、标准错误和任务报告写入系统临时目录的 `pi-kits-model-read-` 前缀目录。报告记录实际模型标识、请求的推理级别、工具调用、读取范围、覆盖行数和最终答案。
