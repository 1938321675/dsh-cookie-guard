# dsh-cookie-guard

预防 DeepSeek Harness（DSH）桌面端启动时报 `Web authentication failed`（HTTP 431）的 Cookie 清理工具。

## 背景

DSH 每次启动都会给本地 Web 宿主（`127.0.0.1`）下发一个新的 `dsh-auth-*` 认证 Cookie，Cookie 名里嵌每次随机的端口，而 Chromium 按域名（不区分端口）存 Cookie，于是**每次启动净增一条、30 天不回收**。积累到约 70 条后，请求头超过 Node 默认 16KB 上限，宿主返回 `431`，外壳抛出 `desktop welcome: Web authentication failed`，应用无法启动。

上游 deepseek-harness 讨论 [#11293](https://github.com/deepseek-ai/deepseek-harness/discussions/11293)、[#11366](https://github.com/deepseek-ai/deepseek-harness/discussions/11366) 已确认同病，官方 0.2.x 尚未合并修复，因此在本地做预防。

## 文件说明

| 文件 | 用途 |
|------|------|
| `dsh-cookie-guard.mjs` | 守卫脚本（Node 原生 sqlite，无第三方依赖） |
| `dsh-cookie-guard.cmd` | 双击/命令行包裹，自动寻找 `node.exe` |
| `launch-dsh.cmd` | DSH 启动器：启动前自动清旧 Cookie，无 node 时退化为直接启动 |

## 使用方法

### 1. 只读体检（运行中也能看）

```cmd
dsh-cookie-guard.cmd --check
```

输出当前 `dsh-auth-*` 数量与 Cookie 头估算长度，超过预算会提示预警/超限。

### 2. 直接清理（需先完全退出 DSH）

```cmd
dsh-cookie-guard.cmd --clean --keep 0
```

删除所有历史 `dsh-auth-*`，自动备份原库到同目录 `.bak-<时间戳>`，只保留最近 5 份；不登出账号、不动会话/插件/登录态。

### 3. 日常启动（推荐）

把桌面 / 开始菜单 / 任务栏的 `DeepSeek Harness.lnk` 改为指向 `launch-dsh.cmd`，工作目录设为脚本所在目录。以后每次点图标启动前都会自动清一次旧 Cookie，累积永远不会超过 1 条，从根上杜绝 431。

### 4. 定时兜底（可选）

每天开机后若 DSH 未运行，可用计划任务跑一次：

```cmd
dsh-cookie-guard.cmd --clean-if-idle --quiet --keep 0
```

## 实现说明

- Cookie 库在 DSH 运行期间被 Chromium 独占锁，只能在**启动前**或**退出后**清理，因此脚本不在 DSH 运行时触碰真实库。
- 只删 `host_key='127.0.0.1'` 且 `name LIKE 'dsh-auth-%'` 的行，不删除其他站点 Cookie。
- 每次改动前自动备份；若 DSH 正在运行，`--clean-if-idle` 会跳过本次，安全可重复调用。

## License

MIT
