# Changelog

## [0.1.1] - 2026-11-02

### 修复

- **omp 下新开会话 session credits 不重置**：omp 只在进程启动时发一次 `session_start`，此后新建/恢复/fork/树导航分别发其私有事件 `session_switch` / `session_branch` / `session_tree`；插件此前只监听 `session_start`，导致累计值跨会话带入。现在这些事件都会重建会话累计（pi 不受影响，pi 在每次会话切换时都会重发 `session_start`）。

## [0.1.0] - 2026-10-31

首个公开发布。

### 新增

- **多站点登录**：`/login` 选择 CodeBuddy（CN）、CodeBuddy（International）、CodeBuddy iOA、CodeBuddy Enterprise 四个入口之一，浏览器完成 OAuth 登录；每个站点独立账号槽位，互不影响，可同时登录多个站点。企业入口登录时手动输入站点地址。
- **模型目录自动同步**：登录后自动拉取账号可用的模型目录并缓存（本地缓存 24h TTL），启动与每次会话开始时刷新；含企业自定义模型，支持 pi 的 `--model`、`--list-models` 与 omp 的模型选择。
- **思考档位**：模型名后缀 `:low` / `:medium` / `:high` / `:xhigh` / `:max`（omp 用 `--thinking`），支持范围自动跟随模型声明收敛。
- **额度显示**：状态栏实时显示会话消耗与账号周期额度，`/codebuddy-usage` 查看明细（会话明细、周期起止与重置时间、其他已登录站点额度快照）。
- **兼容旧版凭据**：读取多站点改造前的单 `codebuddy` 凭据槽位，旧登录无需重新认证。

### 限制

- 每个站点一个账号槽位；企业入口仅支持一个域名，重复输入会覆盖。
- omp 的同站点多账号轮换尚未支持。
- 国际站与 iOA 入口尚缺真实环境验证。
