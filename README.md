# Better Python for DSH

> 让 AI 在装 Python 包之前，先问一句。

一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的插件：**在动 Python 之前先探测本机已有的环境和依赖库**，优先复用你已经装好的东西；真的缺包时，用一个确认框让你选安装源，然后才装。

![工作流程](docs/preview.svg)

---

## 它解决什么问题

AI 写代码时有两个很难自知的坏习惯：

1. **不看本机有什么就直接装。** 你系统里明明有 `matplotlib 3.10.8`，它还是会跑一遍 `pip install matplotlib`——下载、占时间、还可能把你的版本升级掉。
2. **装进全局环境，而不是临时环境。** 一次实验留下几百 MB 的依赖，几周后你已经不记得哪些是自己要的。

这个插件把这两件事变成**需要你点头**的动作，而不是 AI 的默认动作。

## 三个能力

### 1. `python_env` —— 先查

扫描并去重这几类解释器（最多 8 个）：

- `$VIRTUAL_ENV` 指向的环境
- 工作区里的 `.dsh-venv` / `.venv` / `venv` / `env`
- `PATH` 上的 `python3` / `python`
- `~/.dsh/dsh-runtimes/*/dependencies/python`（DSH 自带运行时）
- `/usr/bin/python3`

每个解释器只起一个子进程，一次问清：Python 版本、是否虚拟环境、`site-packages` 路径，以及每个被请求的包**是否可导入、版本多少**。返回里直接给出 `servedBy`（已满足全部要求的解释器）和 `missingEverywhere`（所有解释器都没有的包）。

常见「导入名 ≠ 分发包名」的情况已内置映射：`PIL` → `Pillow`、`docx` → `python-docx`、`sklearn` → `scikit-learn`、`yaml` → `PyYAML` 等。

`action: "create_venv"` 会在工作区创建虚拟环境，**默认带 `--system-site-packages`**——这样 torch、matplotlib 这类你已经装好的库在新环境里仍然可见，不用重装。

### 2. `python_install` —— 一次确认，一个框

1. 先探测目标解释器：**全部已存在 → 什么都不装**，直接回报现成版本。
2. 有缺包 → 弹**一个**确认框（一次装多个包也只有一个），列出：目标解释器与版本、需要安装的包、已存在的包、当前默认源，以及源列表（默认源 / 清华 TUNA / 阿里云 / 中科大 / 腾讯云 / 豆瓣 / 取消）。
3. 想用别的镜像，直接在回答框里填 URL（会覆盖选中的那一项）。
4. 按你的选择执行 `pip install -i <源>`，把输出回给模型。

取消、跳过、没有回答 → **一律不安装**。

`action: "uninstall"` 走同一条通道：先探测实际安装的版本，弹同一个确认框，确认后才卸载。

### 3. 拦截门 —— 裸命令一律拒绝

检查 `bash` / `pwsh` / `terminal` 里的 `pip install`、`pip uninstall`、`uv pip install`、`python -m pip install`：

| 情况 | 结果 |
|---|---|
| 包全部已存在 | **拒绝**，回报现成版本与解释器路径 |
| 缺包 / 装 `-r` 依赖文件 / `-e .` | **拒绝**，并指明改走 `python_install` |
| `pip uninstall` | **拒绝**，并指明改走 `python_install` 的 `uninstall` |
| `sudo pip install` | 单调 guard **硬拒绝**（其它插件无法放行） |
| `--dry-run` / `--help` | 放行 |

也就是说：**没有不经你确认的安装路径**。

## 安装

### 从 Git（当前唯一可用的远程方式）

在 DSH 的 **Plugins → Add plugin** 里输入：

```
git+https://github.com/qianhanglv/dsh-better-python.git#6ea76871c2f04b8b28df7a1b375d1a8b97c1b91c
```

这个 commit 就是当前的发布版本（`v1.0.0`，也是插件索引里指向的同一个）。Git 安装需要本机有 `git`。

想跟随最新代码，可以把 `#<commit>` 换成 `#main`；但钉死 commit 更稳定——分支会漂移。

### 从本地目录（开发时）

Add plugin 里填这个包的绝对路径即可，改代码即时生效，不用重新发布。

### 从 npm（尚未发布）

计划发布为 `dsh-better-python`。发布后可以直接在 Add plugin 里输入包名，比 Git 方式快；**在此之前请用上面两种方式**。

## 通过插件广场（索引）发现

本项目自带一份插件市场索引，托管在 GitHub Pages：

```
https://qianhanglv.github.io/dsh-better-python/market/index.json
```

在 DSH 的 **Plugins → Discover → 索引源** 里添加这个 URL，就能搜到本插件并一键安装。

> **Discover 是实验性功能**，由 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供，默认安装里没有。需要先在 **Add plugin** 里安装它，才能看到 Discover 标签页。

索引内容维护在 [`market/index.json`](market/index.json)：新增版本时同步追加一条 `versions[]`（精确 SemVer、Unix 秒的 `publishTimestamp`、指向该版本的 `source`）。当前条目使用 Git 源并钉在具体 commit 上；发布到 npm 后可改成 `{"type": "npm"}`。

## 在插件管理页里配置

打开 **Plugins → Better Python for DSH**，页面中间会出现设置区：

| 设置 | 作用 |
|---|---|
| **默认安装源** | `python_install` 确认框里预先选中的源；同一次确认里仍可临时切换 |
| **自定义 index URL** | 选「自定义镜像」时出现，只接受 http/https |
| **额外的 pip 参数** | 内置白名单不够用时由**你**补充，空格分隔 |

关于「额外的 pip 参数」的三条规则：

- **只有人能改**：模型只能读这份列表，不能追加；
- **改安装源或安装目标的参数永远不允许**（`-i`、`--index-url`、`--find-links`、`--target`、`--user`、`--break-system-packages` 等），填了也不生效；
- 按 flag 名匹配，所以 `--only-binary=:all:` 里的值由调用方决定。

设置存在 profile 配置里，重装也不丢。

## 设计取舍

这个插件的目标不是「关住 AI」，而是让 AI 的安装行为**在执行前可读**。三条原则：

**① 确认框必须是可信契约。** 框里写「源 = 清华、目标 = 解释器 X」，实际执行就不能被 `-i` 或 `--target` 改写。所以改源改目标的参数被永久拉黑——它们一旦放行，你点的「确认」就是对一个被掉包操作的确认，比没有框更糟。

**② 每个拒绝都要点名下一步。** 拒绝信息里会明确说：改用哪个工具、去哪个设置项加参数、**不要**换别的命令绕过。留一个封闭回路，才是真正逼人绕路的原因。

**③ 扩展权交给用户，不交给弹框。** 白名单不够用时，由人去设置页添加，而不是在干活途中点一次「记住」。前者是显式决定，后者会变成习惯性的摩擦消除——权限面会在你不注意时长起来。

## 安全与隐私

发布后陌生人会运行这段代码，所以说明白它会做什么：

- **会**扫描本机 Python 解释器、读取它们的 `site-packages` 元数据（只读）；
- **会**在你确认后执行 `pip install` / `pip uninstall`，写入目标解释器的环境；
- **会**在你的 profile 配置里保存那三个设置项；
- **不会**联网（除了 `pip` 自身按你选的源下载）、不会上传任何数据、没有遥测。

## 兼容性

针对 **DSH 0.2.2-rc.2** 开发与测试。它依赖 `ctx.userQuestions`、`tools/pre-execute`、`plugins.bundle.config` 这几个接口；更早的 DSH 版本可能没有。

`package.json` 里没有写死 `engines.dsh`：DSH 用 SemVer 判断兼容性，而预发布版本（`0.2.2-rc.2`）低于 `0.2.2`，写 `^0.2.2` 反而会把当前版本判为不兼容。

## 开发

```bash
pnpm install          # 装依赖
node parse-test.mjs   # 跑解析与校验的单元测试（54 项）
pnpm pack --dry-run   # 看会打进 tarball 的文件
```

代码只有两个文件，没有构建步骤：

- `index.js` —— Host 半：工具注册、探测、拦截门、确认框
- `client.js` —— 浏览器半：手写 `window.__ModuleLoader__` 模块，渲染设置区

## 已知限制

- 拦截门认的是**字面量命令**。`python -c "subprocess.run(['pip','install','x'])"` 这类间接调用、`make` 里封装的安装、`conda` / `poetry` 的其它子命令，它认不出来。它是防手滑，不是防越狱。
- 探测的解释器上限 8 个；每次装包多花一次探测（约 0.1–0.5 秒/解释器），结果缓存 30 秒。
- 确认框依赖 `ctx.userQuestions` 服务；不可用时工具会明确报「未安装」，不会静默降级。

## License

[MIT](LICENSE)
