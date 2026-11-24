# 学习通全自动作业助手 · 绿色版（免安装）启动与准备

> 版本：bootstrap v1.0.0 · 目标平台：Windows 10 / 11（x64；ARM64 自动适配下载地址）
> 运行时：便携 Node.js v24.21.0 + DeepSeek Harness CLI `@deepseek-ai/dsh@0.1.7-rc.2`
> 设计原则：**只写程序目录**。不写系统 PATH、不写注册表、不需要管理员权限、不动用户级 npm 全局目录。

---

## 1. 这是什么

本目录（`bootstrap\`）是绿色版的「启动器 + 一次性环境准备」模板。打包时把这 7 个文件
复制到程序根目录，与 `app\`、`cx\`、`engine\`、`ui\` 并列即可：

```
<程序目录>\
├─ 启动.cmd                     ← 唯一入口（双击即用）
├─ 环境准备.cmd                 ← 可选的一次性准备（联网时执行一次）
├─ start.ps1                    ← 启动逻辑（纯 ASCII）
├─ prepare.ps1                  ← 环境准备逻辑（纯 ASCII）
├─ env-detect.ps1               ← 环境检测，输出 JSON（供 app 调用）
├─ messages.json                ← 全部中文文案（UTF-8）
├─ README.md                    ← 本文件
├─ app\                         ← 应用本体（Lead 提供）
├─ cx\  engine\  ui\            ← 业务模块（Lead / T1 / T2 / T4 提供）
├─ runtime\node\                ← 便携 Node.js（环境准备生成）
├─ dsh\                         ← DSH CLI（环境准备生成）
├─ data\                        ← 运行时数据（首次运行自动创建）
└─ logs\                        ← 日志（首次运行自动创建）
```

**为什么 `.ps1` / `.cmd` 里没有中文**：Windows PowerShell 5.1 按 ANSI（GBK）读取 `.ps1`，
脚本内直接写中文会乱码甚至解析失败（AGENTS.md 的规定）。所有中文都在 `messages.json`，
脚本运行时用 `Get-Content -Encoding UTF8 | ConvertFrom-Json` 读取，因此脚本本身可以随便
编辑而不会破坏中文显示。

---

## 2. 快速开始（3 步）

1. 把整个绿色版目录解压/拷贝到**有写权限**的位置（桌面、D 盘等；**不要**放 `Program Files`）。
2. **第一次使用**：双击 `环境准备.cmd`（需联网，约 2-5 分钟），等待出现「环境准备完成」。
   完成后目录里会多出 `runtime\node\`（约 102 MB）和 `dsh\`（约 450 MB）。
3. 双击 `启动.cmd`。看到「服务已在后台运行 / 访问地址 http://127.0.0.1:8765/」并自动打开
   浏览器即成功。窗口可以关闭，服务继续在后台运行。

> 之后每次使用都只要双击 `启动.cmd`；重复运行是安全的（已在运行时会直接打开浏览器）。
> `环境准备.cmd` 只需执行一次；换电脑时把**整个目录**拷过去即可，无需再次准备（见第 6 节）。

---

## 3. 环境准备.cmd 做了什么 / 没做什么

做的事（全部在程序目录内）：

| 步骤 | 内容 | 产物 |
| --- | --- | --- |
| 1/3 root | 创建 `runtime\`、`dsh\`、`app\`、`data\`、`logs\`、`data\tmp`、`data\npm-cache`，检查可写 | 目录 |
| 2/3 node | 已存在可用的 `runtime\node\node.exe`（≥ v22）则跳过；否则下载 `node-v24.21.0-win-x64.zip` → 解压 → 校验版本 | `runtime\node\` |
| 3/3 dsh | 已存在 `dsh\dsh.cmd` 且版本为 `0.1.7-rc.2` 则跳过；否则 `npm install --global --prefix <root>\dsh @deepseek-ai/dsh@0.1.7-rc.2` | `dsh\dsh.cmd`（519 个包） |

**不做的事**：不安装 Node 到系统、不写 PATH（只在自身进程内拼接）、不写注册表、不写
`%APPDATA%\npm`、不需要管理员。npm 的缓存与临时目录都被重定向到 `data\npm-cache`、
`data\tmp`，不会污染用户目录。

**网络与镜像回退**：

- Node 下载：`https://nodejs.org/dist/...` → 失败回退 `https://npmmirror.com/mirrors/node/...`
- 每个地址内部还有 3 级下载方式回退：`Invoke-WebRequest`（.NET TLS）→ `curl.exe` → 系统 `node` 的 `fetch`。
- npm 安装：默认 registry → 失败回退 `https://registry.npmmirror.com`。
- 若 npm 生命周期脚本被安全软件/受限环境拦截（`EPERM`，常见于 `@google/genai` 的 no-op
  `preinstall`），自动改用 `--ignore-scripts` 重试并给出中文提示；本产品的 DSH 是纯 JavaScript，
  跳过生命周期脚本不影响运行。

**完全离线 / 内网**：在一台能联网的电脑上把同一目录准备好（运行 `环境准备.cmd`），
然后把**整个程序目录**（含 `runtime\node\` 与 `dsh\`）拷贝到目标机，直接双击 `启动.cmd`。

---

## 4. 启动.cmd 做了什么

1. 解析程序目录：默认 = `启动.cmd` 所在目录（`%~dp0`，支持中文/空格路径）；可用参数
   `-Root <目录>` 或环境变量 `CX_APP_ROOT` 覆盖。
2. 选 Node.js：优先 `<root>\runtime\node\node.exe`（≥ v22）；否则系统 `node.exe`（PATH /
   `Program Files\nodejs` / `App Paths`，需 ≥ v22）。都不可用 → 中文提示先运行 `环境准备.cmd`。
3. 选 DSH：优先 `<root>\dsh\dsh.cmd`；否则系统 PATH / `%APPDATA%\npm\dsh.cmd` 等常见位置。
   校验 `dsh --version` 可执行；都不可用 → 中文提示先运行 `环境准备.cmd`。
4. 设置环境变量并写 `data\env.json`：
   `CX_APP_ROOT`、`CX_NODE`、`CX_DSH`、`CX_DSH_HOME`（`data\dsh-home`，私有 DSH 主目录，
   避免 DSH 写用户目录 `~\.dsh`），同时把 node/dsh 目录加进**本进程** PATH 后启动
   `node app\server.mjs`（工作目录 `app\`，隐藏窗口，stdout/stderr 重定向到 `logs\app-*.log`）。
5. 轮询 `data\server.json`（app 监听成功后写入 `{port,url,pid,startedAt}`，端口 8765 被占用时
   app 会自动 +1）最多 20 秒：
   - 读到 → 打开浏览器（`start "" <url>`）；`-NoBrowser` 可跳过；
   - 超时或进程提前退出 → 中文提示并给出 `logs\` 路径，退出码 1。
6. 若 `server.json` 已存在且进程存活、端口在监听 → 视为「已在运行」，直接打开浏览器，不重复启动。

窗口行为：`启动.cmd` / `环境准备.cmd` 出错会 `pause` 保持窗口；成功时提示「按任意键关闭
本窗口（关闭窗口不会停止服务）」。自动化场景可设 `CX_NO_PAUSE=1` 跳过暂停。

---

## 5. 命令行参数

### 启动.cmd（转给 `start.ps1`）

| 参数 | 说明 |
| --- | --- |
| `-Root <目录>` / `-AppRoot <目录>` | 指定程序目录（优先于环境变量） |
| `-Port <端口>` | 默认端口提示（实际端口以 `data\server.json` 为准） |
| `-NoBrowser` | 启动服务但不打开浏览器 |
| `-Help` | 显示帮助 |
| 环境变量 `CX_APP_ROOT` | 覆盖程序目录（默认 `start.ps1` 所在目录） |

### 环境准备.cmd（转给 `prepare.ps1`）

| 参数 | 说明 |
| --- | --- |
| `-Root <目录>` / `-AppRoot <目录>` | 指定程序目录 |
| `-ForceNode` | 重新下载便携 Node.js（即使已有） |
| `-ForceDsh` | 重新安装 DSH（即使版本已匹配） |
| `-NoDsh` | 只准备 Node.js，不安装 DSH |
| `-Registry <url>` | 指定 npm 源（默认官方，失败自动 npmmirror） |
| `-Help` | 显示帮助 |

### env-detect.ps1

```
powershell -NoProfile -ExecutionPolicy Bypass -File env-detect.ps1 [-Root <目录>] [ -Json | -Human ] [-Save] [-Deep]
```

- 默认向 stdout 输出**紧凑 JSON**（供 app 解析）；`-Human` 输出中文可读信息；`-Save` 同时写
  `<root>\data\env.json`；`-Deep` 额外检查 `dsh headless --help`。
- JSON 字段：`root`、`os{version,arch,is64}`、`admin`、`node{found,version,major,path,source,meetsMinimum}`、
  `npm{found,version,path}`、`dsh{found,version,path,source,headlessOk}`、`python`、`git`、`msvc`、
  `app{dir,serverExists,port}`、`ready`。`source` 取值 `portable` / `system`。

---

## 6. 机器可读输出（供 app 呈现进度）

stdout 被重定向（或加 `-Machine`）时，脚本会输出固定格式行，app 只需解析带前缀的行：

```
STEP|<序号>|<总数>|<步骤ID>|<running|done|skipped|warning|failed>
DONE|<dsh版本>
FAIL|<原因>
```

- `prepare.ps1` 步骤 ID：`root`、`node`、`dsh`（总数 3）。
- `start.ps1` 步骤 ID：`launch`（总数 1）。
- `messages.json` 的 `progressSteps` 提供步骤 ID → 中文名的映射：
  `root=检查程序目录`、`node=准备便携 Node.js`、`dsh=准备 DSH CLI`、`launch=启动服务`。
- 重定向时脚本会把 stdout 编码设为 UTF-8，`FAIL|` 后的中文可直接按 UTF-8 解码。
- 其余普通日志照常输出，app 可忽略或作为日志展示。

---

## 7. 与 app 的接口契约（集成时注意）

| 项目 | 约定 |
| --- | --- |
| 应用入口 | `<root>\app\server.mjs`（由 Lead 提供） |
| 端口 | 默认 8765，被占用时 app 自动 +1 |
| 服务发现 | app 监听成功后写 `<root>\data\server.json`：`{port,url,pid,startedAt}` |
| 环境变量 | `CX_APP_ROOT`（根目录）、`CX_NODE`（node.exe 路径）、`CX_DSH`（dsh.cmd 路径）、`CX_DSH_HOME`（`data\dsh-home`）、`DSH_HOME`（同 `CX_DSH_HOME`） |
| 环境快照 | `start.ps1` 写 `<root>\data\env.json`（node/dsh 至少含 `{version,path,source}`，与 `env-detect.ps1` 的 JSON 字段一致）；app 用它兜底 |
| 未就绪时 | `POST /api/setup/install` 返回「绿色版请在程序目录双击运行『环境准备.cmd』」 |
| 日志 | `<root>\logs\`：`prepare-*.log`、`npm-*.log`、`start-*.log`、`app-out-*.log`、`app-err-*.log` |
| 进度文件 | `prepare.ps1` 每步写 `<root>\data\install-progress.json`（`{step,status,message,ts,history}`） |
| 数据目录 | `data\` 首次运行自动创建；也可预先放空目录 |

---

## 8. 卸载

**直接删除整个程序目录即可**，没有任何系统级残留（不写 PATH、不写注册表、不装服务、不建快捷方式）。

- 先关闭「启动.cmd」窗口不足以停止服务：在任务管理器结束 `node.exe`（命令行含 `<root>\app\server.mjs`），
  或先删除 `data\server.json` 再删除目录。
- 个人数据（账号、API Key、学习通 Cookie、作业记录）都在 `data\` 内：想保留可先备份
  `data\secrets.dat`、`data\session.json`、`data\jobs\`；删除目录即全部清除。
- 本脚本不提供「卸载器」：绿色版不需要。

---

## 9. 常见问题（FAQ）

**Q：双击后闪一下窗口就没了？**
A：正常成功路径窗口会停住并提示「按任意键关闭本窗口」。若闪退，检查 `logs\start-*.log`；
多为 `app\server.mjs` 不存在或 Node/DSH 未准备（先运行 `环境准备.cmd`）。

**Q：杀毒软件报毒 / npm 安装时 `EPERM`？**
A：`环境准备.cmd` 会自动检测 npm 生命周期脚本被拒（`EPERM / errno -4048`）并改用
`--ignore-scripts` 重试；如仍失败，把程序目录加入杀软白名单后重试（已完成的步骤会自动跳过）。

**Q：下载很慢 / 连不上 nodejs.org？**
A：脚本自带 `npmmirror.com` 镜像回退；npm 也会自动回退 `registry.npmmirror.com`。若都不可用，
用另一台联网电脑准备后整目录拷贝（见第 3 节）。

**Q：端口 8765 被占用？**
A：app 会自动 +1（8766、8767…），`启动.cmd` 读取 `data\server.json` 后打开**实际**地址，不会开错页面。

**Q：没有管理员权限能装吗？**
A：可以。全程只写程序目录，需要管理员权限的只是「装到 Program Files」这种目录选择，别选即可。

**Q：系统已经装了 Node.js，还需要 `环境准备.cmd` 吗？**
A：`启动.cmd` 可直接用系统 Node（需 ≥ v22）。但绿色版要想「拷到别的电脑就能用」，建议仍运行一次
`环境准备.cmd`，把便携 Node 与 DSH 放进程序目录。

**Q：日志在哪？**
A：`<程序目录>\logs\`；安装/准备失败时窗口里会直接打印日志文件完整路径。

**Q：怎么确认环境状态？**
A：`powershell -NoProfile -ExecutionPolicy Bypass -File env-detect.ps1 -Human`，或看
`data\env.json`；也可以访问运行中服务的 `GET /api/env`。

**Q：DSH 会不会往用户目录写东西？**
A：不会。`start.ps1` / `prepare.ps1` 都会设置私有 `DSH_HOME`（`data\dsh-home`）后再调用 dsh。

---

## 10. 实测验证记录（2026-11-22，本机 Windows 10.0.26200 / PowerShell 5.1 / 系统 Node v24.21.0）

测试根目录：`中间产物\学习通作业助手\portable-test`（模拟绿色版程序目录，含 Lead 提供的
`app\`+`cx\`+`engine\`+`ui\`），以及含空格路径的 `中间产物\学习通作业助手\portable space test`。

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 首次完整准备（强制重下 Node + 重装 DSH） | `prepare.ps1 -ForceNode -ForceDsh`（`CX_APP_ROOT=portable-test`） | 退出码 0，总耗时 **184.8 s**；`DONE\|0.1.7-rc.2` |
| 便携 Node 下载 | 同上 | `node-v24.21.0-win-x64.zip` **35.9 MB**，本机两次实测 103 s / 6 s（沙箱内 IWR 与 curl 被 TLS 环境拦截，自动回退 node fetch 成功） |
| 便携 Node 解压校验 | 同上 | `runtime\node\node.exe` → **v24.21.0**（102 MB） |
| DSH 安装 | 同上 | `npm install --global --prefix <root>\dsh @deepseek-ai/dsh@0.1.7-rc.2` → **519 个包**，耗时 169 s（含 1 次 EPERM 失败 → `--ignore-scripts` 重试成功） |
| DSH 校验 | `<root>\dsh\dsh.cmd --version` | **0.1.7-rc.2** |
| DSH headless 校验 | 设 `DSH_HOME=<root>\data\dsh-home` 后 `dsh.cmd headless --help` | 退出码 0，输出 `Usage: dsh --profile headless ...` |
| 二次运行幂等 | 再跑 `环境准备.cmd` | 退出码 0，**4.85 s**（Node、DSH 均 skipped） |
| 首次启动 | `启动.cmd -NoBrowser`（`CX_APP_ROOT=portable-test`） | 退出码 0，**2.07 s** 就绪；`STEP\|1\|1\|launch\|done`、`DONE\|0.1.7-rc.2` |
| 启动后服务 | `server.json` + HTTP 探测 | `{port:8765, url:http://127.0.0.1:8765/, pid, startedAt}`；`HTTP 200`，UI 首页 4005 字节 |
| 已在运行时再次启动 | 再跑 `启动.cmd -NoBrowser` | 退出码 0，**1.18 s**，提示「检测到服务已在运行（端口 8765）」 |
| 含空格路径 | `portable space test\启动.cmd -NoBrowser`（不设 CX_APP_ROOT，靠 `%~dp0`） | 退出码 0，**2.13 s**，服务正常，HTTP 200；日志/配置均落在空格目录内 |
| 含空格路径准备 | `portable space test\环境准备.cmd` | 退出码 0，6.07 s（Node/DSH 已就绪，跳过） |
| `-Root` 参数 | `start.ps1 -Root <portable-test> -NoBrowser` | 退出码 0，1.5 s，程序目录解析正确 |
| 缺 DSH 失败路径 | 隔离环境启动 `start.ps1` | 退出码 1，中文「未找到可用的 DSH…请先双击运行『环境准备.cmd』」，日志保留 |
| 缺应用文件失败路径 | 空目录启动 `start.ps1` | 退出码 1，中文「应用文件未就位：…\app\server.mjs」 |
| 断网失败路径 | `prepare.ps1 -ForceNode -NodeUrl http://127.0.0.1:9/... -NodeMirrorUrl http://127.0.0.1:9/...` | 退出码 1，9.4 s，中文「Node.js 下载失败（官方源与镜像均不可用）…可先联网机器准备再拷贝」，`logs\prepare-*.log` 与 `install-progress.json` 均保留 |
| 零系统改动 | 准备/启动前后对比 | 用户 PATH、机器 PATH、HKCU\Environment、`%APPDATA%\npm` 内容**均未变化**；`%LOCALAPPDATA%\ChaoxingHomework` 未创建 |
| 与 app 集成 | 启动后 `GET /api/env`、`GET /api/state` | `/api/env` 返回 `node{v24.21.0,portable}`、`dsh{0.1.7-rc.2,portable}`、`dshHome=data\dsh-home`；`/api/state` 中 `setup.dsh.installed=true, source=portable` |
| 脚本编码 | 字节扫描 | 5 个脚本（3 个 `.ps1` + 2 个 `.cmd`）**非 ASCII 字节 = 0**；PowerShell 5.1 解析全部通过 |

补充说明（本开发会话沙箱限制，不影响真实用户）：

- 本会话无法使用 Windows TLS 栈（Schannel）访问 HTTPS，故 `Invoke-WebRequest`/`curl.exe` 下载失败，
  实测走了第 3 级 `node fetch` 回退；真实用户机上第 1 级 `Invoke-WebRequest` 会直接成功。
- 系统 Node 无法通过改环境变量「藏掉」——Node 安装时注册了 `App Paths`，`Get-Command node.exe`
  仍能找到；因此「完全没有系统 Node」的分支以「便携版优先 + 隔离环境缺 DSH」方式验证，
  逻辑与中文提示均已覆盖。
- npm 生命周期脚本在本沙箱内 `spawn` 被拒（`EPERM`），触发 `--ignore-scripts` 回退；真实用户机
  通常第一次即成功（该回退只增加一次重试，不影响结果）。

---

## 11. 版本与依赖

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js（便携） | v24.21.0 win-x64（ARM64 自动换 `win-arm64`） | 下载源 nodejs.org / npmmirror |
| DSH | `@deepseek-ai/dsh@0.1.7-rc.2` | 用 `npm --prefix` 装进 `dsh\`，不写系统全局 |
| PowerShell | 5.1（Windows 10/11 自带） | 脚本兼容 PS 5.1 与 PS 7 |
| 编码约定 | `.ps1` / `.cmd` 纯 ASCII；中文只在 `messages.json` / 本 README | AGENTS.md 要求 |

> 学术诚信提示：本工具只辅助完成本人账号的作业，使用者需自行承担提交内容与学术规范责任。
