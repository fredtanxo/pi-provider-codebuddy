# Pi Provider CodeBuddy

[![npm](https://img.shields.io/npm/v/pi-provider-codebuddy)](https://www.npmjs.com/package/pi-provider-codebuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 [pi](https://github.com/earendil-works/pi) 和 [oh-my-pi](https://github.com/can1357/oh-my-pi) 里使用你的 CodeBuddy 订阅：登录 CodeBuddy 账号后，pi / omp 会自动列出账号可用的模型，对话消耗和剩余额度直接显示在状态栏里。

- **多站点登录**：国内站、国际站、iOA、企业自建站点分别登录、互不影响，可同时使用
- **模型目录自动同步**：登录后自动拉取账号可用的模型，含企业自定义模型
- **思考档位**：`low` / `medium` / `high` / `xhigh` / `max`，自动跟随模型声明收敛
- **额度显示**：状态栏实时显示会话消耗与账号周期额度，`/codebuddy-usage` 查看明细

## 安装

```bash
pi install npm:pi-provider-codebuddy    # pi
omp plugin install pi-provider-codebuddy   # omp
```

或从源码安装：

```bash
git clone https://github.com/fredtanxo/pi-provider-codebuddy
cd pi-provider-codebuddy
npm install          # 会自动构建 dist/

pi install "$PWD"           # pi
omp plugin install "$PWD"   # omp
```

更新用 `pi update --extensions`（pi）或 `omp plugin upgrade`（omp）。

## 登录

在 pi 或 omp 里执行 `/login`，选择要登录的入口：

| Provider               | 显示名                    | 地址                                                       |
| ---------------------- | ------------------------- | ---------------------------------------------------------- |
| `codebuddy-cn`         | CodeBuddy (CN)            | `https://copilot.tencent.com`                              |
| `codebuddy-intl`       | CodeBuddy (International) | `https://www.codebuddy.ai`                                 |
| `codebuddy-ioa`        | CodeBuddy iOA             | `https://copilot.tencent.com`（与 CN 同地址，走企业 SSO）  |
| `codebuddy-enterprise` | CodeBuddy Enterprise      | 登录时手动输入，例如 `https://<enterprise>.copilot.qq.com` |

- 选好入口后会给出登录链接，在浏览器里完成登录即可。
- 同一入口重复 `/login` 会替换该站点的账号；不同站点互不影响，可以同时登录多个。

## 选择模型

模型按入口寻址，不同站点的同名模型不会混淆：

```bash
pi --list-models codebuddy-cn
pi --model codebuddy-cn/glm-5.3:high

omp models codebuddy-intl
omp --model codebuddy-intl/glm-5.3 --thinking high
```

模型名末尾的 `(x0.79 credits)` 是 CodeBuddy 标注的计费倍率；`:high` / `--thinking high` 是思考档位，支持 `low` 到 `max`，不指定则由模型声明决定。

## 额度

状态栏显示两项：

```
CodeBuddy session: 0.14 credits · CodeBuddy cycle: 21.14 / 10000 credits
```

- **session**：本次会话所有计费请求的消耗
- **cycle**：账号当前计费周期的额度，与 CodeBuddy 网页控制台的用量页一致；包含其他客户端的消耗，刷新失败时显示 `[stale]`

会话消耗按每次回复持久化在 `usage.codebuddyCredit` 字段上（CodeBuddy 返回的计费数值，非标准 `usage` 字段），因此跨会话累计依赖宿主原样保存 `usage` 的行为。若宿主将来裁剪未知字段，历史会话的消耗会归入「无计费信息」计数。

`/codebuddy-usage` 可查看会话明细、周期起止与重置时间，以及其他已登录站点的额度快照。

## 常见问题

- **提示登录过期**：长期闲置（约 24 天以上）后登录会失效，重新 `/login` 对应入口即可，不影响其他站点。
- **omp 下切换模型后状态栏没更新**：这是 omp 的已知差异，发送下一条消息后就会刷新。

## 已知限制

- 每个站点一个账号槽位；企业入口只支持一个域名，再次输入会覆盖前一个。
- omp 的同站点多账号轮换尚未支持；多站点请分别登录对应入口。
- 国际站与 iOA 入口尚缺真实环境验证，遇到问题欢迎提 issue。

## 开发

```bash
npm run check   # 类型检查
npm test        # 单元测试
npm run build   # 构建到 dist/
```

欢迎 issue 和 PR，改动请配套单测。

## License

[MIT](LICENSE)
