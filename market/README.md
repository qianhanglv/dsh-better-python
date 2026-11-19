# 插件索引（Discover 用）

DSH 的「插件广场」不是上传入口，而是**索引文档**：用户在 **插件 → Discover → 索引源** 里配置一个 URL，Discover 就去读这份 JSON。

- `index.json`：格式 1，已用 DSH 自带的 `parseMarketIndex` 校验通过。
- 图标是相对路径 `../icon.svg`，会按索引 URL 解析——所以把 `index.json` 放在仓库的 `market/` 下、`icon.svg` 放在仓库根目录即可（GitHub Pages 的站点根就是仓库根）。

## 发布前要改一处

`plugins[0].repository.url` 现在是 `https://github.com/REPLACE-ME/python-env-guard`，改成真实仓库地址。这个字段只用于展示，不是安装来源。

## 两种上架方式

**npm（推荐）**：`versions[0].source` 用 `{"type": "npm"}`，安装时拉 `dsh-better-python@1.0.0`。前提是先 `npm publish`。

**Git（不依赖 npm）**：改成

```json
{ "type": "git", "url": "https://github.com/<你>/python-env-guard.git", "commit": "<40 位小写 sha>" }
```

commit 必须是完整的 40 位 SHA，不能用分支名。这种方式适合还没发布 npm 阶段试用。

## 托管与分发

1. 推到 GitHub，开启 Pages（或用 `raw.githubusercontent.com` 的直链，但不能有重定向）。
2. 索引必须能直接 200 返回，**不允许重定向**（DSH 的抓取器拒绝跟随跳转）。
3. 把索引 URL 发给使用者，或自己在 **Discover → 索引源** 里添加。

## 版本升级时

新增一条 `versions[]`：`version` 精确 SemVer、`publishTimestamp` 为 Unix 秒、`source` 指向新版本。同一 `name` 下版本号不能重复，阅读器会按 SemVer 降序排列。

`engines.dsh` 目前留空表示不限版本。如果要收紧，注意预发布版本（如 `0.2.2-rc.2`）低于 `0.2.2`，写 `^0.2.2` 会把当前版本判为不兼容。
