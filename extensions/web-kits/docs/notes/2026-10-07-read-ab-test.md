# 抓取后读取的对照实验方法

日期：2026-10-07（原记录的 Git 提交日期）
结论：实验分别检查完整审查的 `read` 行覆盖与定点查询的检索行为，判定逻辑保存在[模型读取测试](../../fetch/model-read.test.ts)。

## 过程与数据

测试夹具（测试用的固定输入）通过本地 HTTP 返回 4501 行记录，在第 11、2301、4401 行放入异常代码，在第 2303 行放入保留天数与适用范围；构造见[测试源码](../../fetch/model-read.test.ts)。

完整审查任务要求回答所有异常代码，测试按实际 `read` 返回范围累计覆盖行；定点任务检查保留天数 37、归档发票范围、检索调用及小于全文的读取覆盖。

两个任务各启动新 Pi 进程，暴露 `web_fetch`、`read` 和 `grep` 工具；测试通过独立子测试断言两个任务，并记录调用、读取范围和最终答案。

对照版本通过 `PI_KITS_TEST_EXTENSION` 选择，异常代码通过 `PI_KITS_TEST_TOKENS` 固定；变量读取与报告生成均位于[测试源码](../../fetch/model-read.test.ts)。

```sh
PI_KITS_MODEL_READ=1 \
PI_KITS_TEST_MODEL="<model-id>" \
PI_KITS_TEST_PROVIDER="<provider>" \
PI_KITS_TEST_THINKING=low \
PI_KITS_TEST_TOKENS="<code-a>,<code-b>,<code-c>" \
PI_KITS_TEST_EXTENSION="/<checkout>/extensions/web-kits/index.ts" \
node --import tsx --test extensions/web-kits/fetch/model-read.test.ts
```

测试把 JSONL（逐行 JSON）事件、标准错误和任务报告写入系统临时目录下的 `pi-kits-model-read-` 前缀目录，报告包含请求的推理级别及模型实际返回的标识。
