# Changelog

本项目的所有值得注意的变更都记录在这里，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-11-19

首个发布版本。

### 新增

- **`python_env` 工具**：探测本机的 Python 解释器（`$VIRTUAL_ENV`、工作区 venv、`PATH`、DSH 自带运行时、`/usr/bin`），报告每个请求包是否已安装及版本；`action: "create_venv"` 可创建带 `--system-site-packages` 的工作区虚拟环境，复用已装库。
- **`python_install` 工具**：缺包时弹出**一个**确认框，列出目标解释器、待装包、已存在包与六个镜像源（默认 / 清华 TUNA / 阿里云 / 中科大 / 腾讯云 / 豆瓣），支持在回答框里填自定义 index URL；支持 `editable`（`-e` 本地项目，校验构建文件）与受限的 `extraArgs`；`action: "uninstall"` 走同一条确认通道。
- **安装拦截门**：拦截 `pip install`、`pip uninstall`、`uv pip install`、`python -m pip install`；包已存在时直接拒绝并回报现成版本，缺包时引导改用 `python_install`。
- **单调 guard**：`sudo pip install` 永久拒绝，其它插件无法放行。
- **插件设置页**：默认安装源、自定义 index URL、额外的 pip 参数（人工维护的白名单扩展）。
- **插件市场索引**：`market/index.json`（format 1，Git 源，钉在具体 commit），已用 DSH 自带的 `parseMarketIndex` 校验。

### 设计约束

- **确认框是可信契约**：改安装源或安装目标的 pip 参数（`-i`、`--index-url`、`--find-links`、`--target`、`--user`、`--break-system-packages` 等）永久拉黑，包括用户自己填进设置的白名单——否则「确认了 A 却执行 B」比没有确认框更糟。
- **每个拒绝都点名下一步**：拒绝信息会说明改用哪个工具、去哪个设置项加参数，并明确禁止换别的命令绕过。
- **扩展权归用户**：白名单只能由人在设置页扩展，模型只能读。

### 已知限制

- 拦截门认的是字面量命令。`python -c "subprocess.run(['pip','install','x'])"` 这类间接调用、`make` 里封装的安装、`conda` / `poetry` 的其它子命令无法覆盖。它是防手滑，不是防越狱。
- 探测的解释器上限 8 个；每次装包多一次探测（约 0.1–0.5 秒/解释器），结果缓存 30 秒。
- 依赖 `ctx.userQuestions`、`tools/pre-execute`、`plugins.bundle.config`，针对 DSH `0.2.2-rc.2` 开发与测试。
- 尚未发布到 npm；插件广场（Discover）为实验性功能，默认安装不含。
